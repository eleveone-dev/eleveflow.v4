# Fases B+C — Motor do Agente Conversacional + Observabilidade: Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bloco `ai_agent` funcional de ponta a ponta (SDR virtual multi-turno com saídas goal/giveup/limit via OpenRouter) + toda chamada de API externa (LLM e SerpAPI) registrada em `api_calls` com tokens/custo/latência + página `/observabilidade`.

**Architecture:** Estado do agente em `flow_executions.context.agent` (sem tabela nova). `execute-flow` ganha case `ai_agent` (abertura); nova edge function `ai-agent-reply` processa turnos (delegada pelo `whatsapp-webhook`, mesmo padrão do modo `sequence`). Toda chamada LLM passa por `_shared/ai.ts` → OpenRouter; toda chamada SerpAPI por `_shared/serp.ts`; ambos gravam `api_calls` SEMPRE. Agregações via views SQL `security_invoker`; UI só exibe.

**Tech Stack:** Deno edge functions (Supabase), OpenRouter API (formato OpenAI-compatible), Vitest (módulos puros em `_shared/`), Playwright (e2e no staging), Recharts 3 (gráfico), TanStack Router/Query.

**Spec:** `docs/specs/2026-07-04-agente-ia-e2e-observabilidade-design.md` (Fase B = §4, Fase C = §5, critérios = §8, riscos = §9).

## Global Constraints

- Commits: Conventional Commits, PT-BR, atômicos, SEM Co-Authored-By ou qualquer menção a ferramenta de IA.
- PRODUÇÃO (`aoanpviozfabrrxjqayk`) INTOCADA até a Task 16: nenhum `db push`, `functions deploy` ou `secrets set` fora do staging. TODO comando supabase via `bash scripts/sb-staging.sh <args>` (blinda project-ref e TLS do Avast — ver `docs/staging.md`).
- Staging: projeto `cdnckhzqvqvrtaeyafon`.
- Dinheiro: `cost_usd_micros` bigint (microdólares, inteiro). Nunca float em coluna de dinheiro.
- Módulos novos em `_shared/` testados no Vitest: TypeScript puro, sem APIs Deno, sem imports por URL. Imports internos entre módulos `_shared` usam extensão `.ts` (obrigatório no Deno; `allowImportingTsExtensions` já ativo no tsconfig; `supabase/**` está fora do `tsc --noEmit`, e o Vitest resolve `.ts` sem problema).
- Todo módulo novo testável entra em `coverage.include` do `vitest.config.ts` na task que o cria (gate ≥80% ativo).
- TDD: teste vermelho antes da implementação em todo módulo puro.
- Caminhos aditivos: modo agente só ativa em execuções cujo fluxo tem bloco `ai_agent`; comportamento existente de `message`/`condition`/`sequence` intocado.
- Modelos OpenRouter: IDs abaixo foram validados contra `GET https://openrouter.ai/api/v1/models` em 2026-07-06 (342 modelos; preços conferidos). Econômico: `google/gemini-2.5-flash-lite` ($0.10/$0.40 por 1M, multimodal — serve para vision). Agente default: `google/gemini-2.5-flash` ($0.30/$2.50 por 1M). Se a implementação ocorrer semanas depois, revalidar com o mesmo curl antes da Task 4.
- UI (Tasks 4 e 13): invocar a skill `frontend-design` (e `dataviz` na Task 13) antes de escrever o código visual — pedido explícito do usuário; capricho máximo.
- `.env.staging` local contém as chaves do staging; e2e roda com `set -a; source .env.staging; set +a; npm run test:e2e` (Git Bash).

---

### Task 1: Migration — `api_calls`, settings de modelo/custo e `send_queue.sent_at`

**Files:**

- Create: `supabase/migrations/20260706160000_api_calls_e_settings.sql`

**Interfaces:**

- Produces: tabela `public.api_calls` (colunas exatamente como abaixo — Tasks 2, 10, 12 dependem); chaves `ai_model_economy`, `ai_model_agent_default`, `serpapi_cost_per_search_usd_micros` em `global_settings`; coluna `send_queue.sent_at timestamptz`.

- [ ] **Step 1: Escrever a migration**

```sql
-- Observabilidade de APIs externas (spec §5.1).
-- feature é enum aberto: valores documentados —
-- agent_reply | agent_opening | stage_classifier | photo_vision |
-- extract_search | enrich_details | enrich_photos | enrich_reviews | instagram_profile.
-- Nova feature exige novo valor documentado aqui.
CREATE TABLE IF NOT EXISTS public.api_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  flow_id uuid,
  execution_id uuid,
  block_id uuid,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'serpapi', 'evolution')),
  feature text NOT NULL,
  model text,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  error_message text,
  latency_ms integer NOT NULL DEFAULT 0,
  prompt_tokens integer,
  completion_tokens integer,
  -- microdólares (1 USD = 1.000.000). Centavos não têm precisão para LLM; float nunca.
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  request jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_calls_user_created ON public.api_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_calls_feature ON public.api_calls (feature);
CREATE INDEX IF NOT EXISTS idx_api_calls_lead ON public.api_calls (lead_id);
CREATE INDEX IF NOT EXISTS idx_api_calls_execution ON public.api_calls (execution_id);

ALTER TABLE public.api_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.api_calls TO authenticated;
GRANT ALL ON public.api_calls TO service_role;

-- Usuário lê apenas as próprias linhas; escrita só via service role (sem policy de INSERT/UPDATE).
CREATE POLICY "api_calls_select_own" ON public.api_calls
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Defaults de modelo (validados contra openrouter.ai/api/v1/models em 2026-07-06)
-- e custo derivado do SerpAPI (15000 micros = $0.015/busca; ajustável por ambiente).
INSERT INTO public.global_settings (key, value) VALUES
  ('ai_model_economy', 'google/gemini-2.5-flash-lite'),
  ('ai_model_agent_default', 'google/gemini-2.5-flash'),
  ('serpapi_cost_per_search_usd_micros', '15000')
ON CONFLICT (key) DO NOTHING;

-- Momento real do envio (views de saúde WhatsApp calculam tempo em fila).
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS sent_at timestamptz;
```

- [ ] **Step 2: Aplicar no staging e verificar**

Run: `bash scripts/sb-staging.sh db push`
Expected: migration aplicada sem erro. Verificar com uma consulta via Playwright/service-role ou SQL Editor do staging: `select count(*) from public.api_calls;` → `0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260706160000_api_calls_e_settings.sql
git commit -m "feat: tabela api_calls, settings de modelo e sent_at na fila"
```

---

### Task 2: `_shared/ai.ts` — `callLLM` via OpenRouter com registro obrigatório (TDD)

**Files:**

- Create: `supabase/functions/_shared/ai.ts`
- Create: `tests/unit/ai.test.ts`
- Modify: `vitest.config.ts` (coverage.include)

**Interfaces:**

- Produces (Tasks 3, 5, 6, 8, 9, 10 dependem — assinaturas exatas):
  - `interface ApiCallRecord { user_id: string | null; lead_id?: string | null; flow_id?: string | null; execution_id?: string | null; block_id?: string | null; provider: "openrouter" | "serpapi" | "evolution"; feature: string; model?: string | null; status: "ok" | "error"; error_message?: string | null; latency_ms: number; prompt_tokens?: number | null; completion_tokens?: number | null; cost_usd_micros: number; request?: unknown; response?: unknown }`
  - `type ApiCallRecorder = (row: ApiCallRecord) => Promise<unknown>`
  - `makeApiCallRecorder(client): ApiCallRecorder` — insere em `api_calls`; falha de insert NUNCA propaga (loga e segue).
  - `getGlobalSetting(client, key: string): Promise<string | null>`
  - `interface LLMMessage { role: "system" | "user" | "assistant"; content: string | Array<Record<string, unknown>> }`
  - `interface CallLLMParams { apiKey: string; model: string; messages: LLMMessage[]; feature: string; temperature?: number; maxTokens?: number; jsonResponse?: boolean; context?: Partial<Pick<ApiCallRecord, "user_id" | "lead_id" | "flow_id" | "execution_id" | "block_id">>; record: ApiCallRecorder; fetchFn?: typeof fetch }`
  - `interface CallLLMResult { ok: boolean; content: string; status: number; errorMessage: string | null; promptTokens: number | null; completionTokens: number | null; costUsdMicros: number; latencyMs: number }`
  - `callLLM(params: CallLLMParams): Promise<CallLLMResult>` — POST `https://openrouter.ai/api/v1/chat/completions`, body inclui `usage: { include: true }` (OpenRouter devolve `usage.cost` em USD); retry 1x em 429/5xx/erro de rede; grava `api_calls` SEMPRE (sucesso e erro).
  - `costToMicros(cost: unknown): number` — `Math.round(n * 1_000_000)`; não-finito/negativo → 0.
  - `sanitizeForLog(value: unknown, opts?: { maxString?: number; maxArray?: number }): unknown` — corta strings (default 2000), limita arrays (default 10), substitui valor de chave `image_url` por `"[imagem omitida]"`, profundidade máx. 6.

- [ ] **Step 1: Testes falhando**

`tests/unit/ai.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  callLLM,
  costToMicros,
  sanitizeForLog,
  makeApiCallRecorder,
  getGlobalSetting,
  type ApiCallRecord,
} from "../../supabase/functions/_shared/ai.ts";

const okResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const openrouterOk = {
  choices: [{ message: { content: '{"ola": true}' } }],
  usage: { prompt_tokens: 120, completion_tokens: 45, cost: 0.000123 },
};

describe("costToMicros", () => {
  it("converte USD para microdólares inteiros", () => {
    expect(costToMicros(0.000123)).toBe(123);
    expect(costToMicros(1.5)).toBe(1_500_000);
  });
  it("não-finito/negativo/ausente vira 0", () => {
    expect(costToMicros(undefined)).toBe(0);
    expect(costToMicros("abc")).toBe(0);
    expect(costToMicros(-1)).toBe(0);
  });
});

describe("sanitizeForLog", () => {
  it("corta strings longas e marca tamanho original", () => {
    const out = sanitizeForLog({ txt: "a".repeat(3000) }) as { txt: string };
    expect(out.txt.length).toBeLessThan(2100);
    expect(out.txt).toContain("[3000 chars]");
  });
  it("substitui image_url e limita arrays", () => {
    const out = sanitizeForLog(
      {
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        list: [1, 2, 3],
      },
      { maxArray: 2 },
    ) as { content: Array<{ image_url: string }>; list: unknown[] };
    expect(out.content[0].image_url).toBe("[imagem omitida]");
    expect(out.list).toHaveLength(3); // 2 itens + marcador
    expect(String(out.list[2])).toContain("+1");
  });
});

describe("callLLM", () => {
  it("sucesso: retorna conteúdo, tokens e custo em micros; grava api_calls ok", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi.fn().mockResolvedValue(okResponse(openrouterOk));
    const r = await callLLM({
      apiKey: "k",
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: "oi" }],
      feature: "stage_classifier",
      jsonResponse: true,
      context: { user_id: "u1", lead_id: "l1" },
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('{"ola": true}');
    expect(r.promptTokens).toBe(120);
    expect(r.costUsdMicros).toBe(123);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.usage).toEqual({ include: true });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "openrouter",
      feature: "stage_classifier",
      status: "ok",
      user_id: "u1",
      lead_id: "l1",
      cost_usd_micros: 123,
    });
  });

  it("retry 1x em 500 e sucesso na segunda", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(okResponse(openrouterOk));
    const r = await callLLM({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "oi" }],
      feature: "agent_reply",
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
  });

  it("400 não faz retry e registra erro", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ error: { message: "bad model" } }, 400));
    const r = await callLLM({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "oi" }],
      feature: "agent_reply",
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("400");
    expect(rows[0].status).toBe("error");
    expect(rows[0].cost_usd_micros).toBe(0);
  });

  it("resposta sem choices vira erro registrado", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ usage: {} }));
    const r = await callLLM({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "oi" }],
      feature: "agent_reply",
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(rows[0].status).toBe("error");
  });
});

describe("makeApiCallRecorder", () => {
  it("insere na tabela api_calls e engole falha de insert", async () => {
    const inserted: unknown[] = [];
    const clientOk = {
      from: (t: string) => ({
        insert: async (row: unknown) => {
          inserted.push({ t, row });
          return { error: null };
        },
      }),
    };
    const rec = makeApiCallRecorder(clientOk);
    await rec({
      user_id: null,
      provider: "openrouter",
      feature: "x",
      status: "ok",
      latency_ms: 1,
      cost_usd_micros: 0,
    });
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { t: string }).t).toBe("api_calls");

    const clientErr = { from: () => ({ insert: async () => ({ error: { message: "rls" } }) }) };
    await expect(
      makeApiCallRecorder(clientErr)({
        user_id: null,
        provider: "serpapi",
        feature: "x",
        status: "ok",
        latency_ms: 1,
        cost_usd_micros: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("getGlobalSetting", () => {
  it("devolve value ou null", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { value: "google/gemini-2.5-flash" } }) }),
        }),
      }),
    };
    expect(await getGlobalSetting(client, "ai_model_agent_default")).toBe(
      "google/gemini-2.5-flash",
    );
    const empty = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }),
    };
    expect(await getGlobalSetting(empty, "x")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — módulo `ai.ts` inexistente.

- [ ] **Step 3: Implementar `supabase/functions/_shared/ai.ts`**

```ts
export interface ApiCallRecord {
  user_id: string | null;
  lead_id?: string | null;
  flow_id?: string | null;
  execution_id?: string | null;
  block_id?: string | null;
  provider: "openrouter" | "serpapi" | "evolution";
  feature: string;
  model?: string | null;
  status: "ok" | "error";
  error_message?: string | null;
  latency_ms: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd_micros: number;
  request?: unknown;
  response?: unknown;
}

export type ApiCallRecorder = (row: ApiCallRecord) => Promise<unknown>;

interface MinimalClient {
  from: (table: string) => any;
}

export function makeApiCallRecorder(client: MinimalClient): ApiCallRecorder {
  return async (row) => {
    try {
      const { error } = await client.from("api_calls").insert(row);
      if (error) console.error("[api_calls] insert falhou:", error.message ?? error);
    } catch (e) {
      console.error("[api_calls] insert exception:", e);
    }
  };
}

export async function getGlobalSetting(client: MinimalClient, key: string): Promise<string | null> {
  const { data } = await client
    .from("global_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

export interface CallLLMParams {
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  feature: string;
  temperature?: number;
  maxTokens?: number;
  jsonResponse?: boolean;
  context?: Partial<
    Pick<ApiCallRecord, "user_id" | "lead_id" | "flow_id" | "execution_id" | "block_id">
  >;
  record: ApiCallRecorder;
  fetchFn?: typeof fetch;
}

export interface CallLLMResult {
  ok: boolean;
  content: string;
  status: number;
  errorMessage: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsdMicros: number;
  latencyMs: number;
}

export function costToMicros(cost: unknown): number {
  const n = Number(cost);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1_000_000);
}

export function sanitizeForLog(
  value: unknown,
  opts: { maxString?: number; maxArray?: number } = {},
): unknown {
  const maxString = opts.maxString ?? 2000;
  const maxArray = opts.maxArray ?? 10;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6) return "[profundidade excedida]";
    if (typeof v === "string") {
      return v.length > maxString ? `${v.slice(0, maxString)}…[${v.length} chars]` : v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = v.slice(0, maxArray).map((x) => walk(x, depth + 1));
      if (v.length > maxArray) out.push(`…[+${v.length - maxArray} itens]`);
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = k === "image_url" ? "[imagem omitida]" : walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function callLLM(params: CallLLMParams): Promise<CallLLMResult> {
  const {
    apiKey,
    model,
    messages,
    feature,
    temperature,
    maxTokens,
    jsonResponse,
    context = {},
    record,
    fetchFn = fetch,
  } = params;

  const body: Record<string, unknown> = { model, messages, usage: { include: true } };
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (jsonResponse) body.response_format = { type: "json_object" };

  const started = Date.now();
  let status = 0;
  let json: any = null;
  let errorMessage: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    try {
      const res = await fetchFn(OPENROUTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      status = res.status;
      const raw = await res.text();
      try {
        json = JSON.parse(raw);
      } catch {
        json = { raw };
      }
      if (res.ok) {
        errorMessage = null;
        break;
      }
      errorMessage = `HTTP ${res.status}: ${raw.slice(0, 300)}`;
      if (!(res.status === 429 || res.status >= 500)) break;
    } catch (e) {
      status = 0;
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  const latencyMs = Date.now() - started;
  const usage = json?.usage ?? {};
  const content = String(json?.choices?.[0]?.message?.content ?? "");
  if (!errorMessage && content.length === 0) errorMessage = "Resposta sem conteúdo";
  const ok = errorMessage === null;

  const result: CallLLMResult = {
    ok,
    content,
    status,
    errorMessage,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    costUsdMicros: ok ? costToMicros(usage.cost) : 0,
    latencyMs,
  };

  await record({
    user_id: context.user_id ?? null,
    lead_id: context.lead_id ?? null,
    flow_id: context.flow_id ?? null,
    execution_id: context.execution_id ?? null,
    block_id: context.block_id ?? null,
    provider: "openrouter",
    feature,
    model,
    status: ok ? "ok" : "error",
    error_message: errorMessage,
    latency_ms: latencyMs,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    cost_usd_micros: result.costUsdMicros,
    request: sanitizeForLog({ ...body, attempts }),
    response: sanitizeForLog(json),
  });

  return result;
}
```

- [ ] **Step 4: Coverage include + rodar verde**

`vitest.config.ts` → `coverage.include` ganha `"supabase/functions/_shared/ai.ts"`.

Run: `npm run test:coverage`
Expected: PASS, `ai.ts` ≥80% em todas as métricas.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/ai.ts tests/unit/ai.test.ts vitest.config.ts
git commit -m "feat: callLLM via OpenRouter com registro obrigatorio em api_calls"
```

---

### Task 3: `_shared/agent-prompt.ts` — prompt e parse do agente (TDD)

**Files:**

- Create: `supabase/functions/_shared/agent-prompt.ts`
- Create: `tests/unit/agent-prompt.test.ts`
- Modify: `vitest.config.ts` (coverage.include)

**Interfaces:**

- Consumes: `LLMMessage` de `./ai.ts`.
- Produces (Tasks 5 e 6 dependem):
  - `const AGENT_DEFAULTS = { maxTurns: 8, maxChars: 500, temperature: 0.7 }`
  - `interface AgentConfig { prompt?: string; rules?: string; temperature?: number; maxChars?: number; useHistory?: boolean; max_turns?: number; goal_description?: string; model?: string }`
  - `interface AgentLeadInfo { name?: string | null; company?: string | null; phone?: string | null }`
  - `interface AgentHistoryMessage { direction: "inbound" | "outbound"; content: string }`
  - `interface AgentDecision { reply: string; decision: "continue" | "goal" | "giveup"; reason: string }`
  - `buildAgentMessages(config: AgentConfig, lead: AgentLeadInfo, history: AgentHistoryMessage[], opts: { opening: boolean }): LLMMessage[]`
  - `parseAgentResponse(raw: string): AgentDecision | null` — tolera texto em volta do JSON (extrai do primeiro `{` ao último `}`); `decision` fora do conjunto → null; `continue` sem `reply` → null. `limit` NUNCA vem do LLM (é forçado pelo motor).

- [ ] **Step 1: Testes falhando**

`tests/unit/agent-prompt.test.ts`:

````ts
import { describe, it, expect } from "vitest";
import {
  buildAgentMessages,
  parseAgentResponse,
  AGENT_DEFAULTS,
} from "../../supabase/functions/_shared/agent-prompt.ts";

const lead = { name: "Ana", company: "Padaria Sol", phone: "5511999990001" };

describe("buildAgentMessages", () => {
  it("system contém guardrails fixos, regras, objetivo e formato JSON", () => {
    const msgs = buildAgentMessages(
      {
        prompt: "Qualifique {{nome}} da {{empresa}}",
        rules: "Não usar emojis\nMáximo 2 parágrafos",
        goal_description: "lead aceitou agendar uma conversa",
        maxChars: 300,
      },
      lead,
      [],
      { opening: true },
    );
    expect(msgs[0].role).toBe("system");
    const sys = String(msgs[0].content);
    expect(sys).toContain("Nunca invente preços");
    expect(sys).toContain("máximo 300 caracteres");
    expect(sys).toContain("Não usar emojis");
    expect(sys).toContain("lead aceitou agendar uma conversa");
    expect(sys).toContain('"decision"');
    expect(sys).toContain("Qualifique Ana da Padaria Sol");
    expect(sys).toContain("PRIMEIRA mensagem");
  });

  it("turno com histórico vira transcript LEAD/VOCÊ no user message", () => {
    const msgs = buildAgentMessages(
      {},
      lead,
      [
        { direction: "outbound", content: "Olá Ana!" },
        { direction: "inbound", content: "quem é?" },
      ],
      { opening: false },
    );
    const user = String(msgs[1].content);
    expect(user).toContain("VOCÊ: Olá Ana!");
    expect(user).toContain("LEAD: quem é?");
  });

  it("{{ultima_mensagem}} substitui pela última inbound", () => {
    const msgs = buildAgentMessages(
      { prompt: "Responda a: {{ultima_mensagem}}" },
      lead,
      [
        { direction: "inbound", content: "primeira" },
        { direction: "outbound", content: "oi" },
        { direction: "inbound", content: "qual o preço?" },
      ],
      { opening: false },
    );
    expect(String(msgs[0].content)).toContain("Responda a: qual o preço?");
  });

  it("defaults aplicados quando config vazia", () => {
    const msgs = buildAgentMessages({}, {}, [], { opening: true });
    expect(String(msgs[0].content)).toContain(`máximo ${AGENT_DEFAULTS.maxChars} caracteres`);
  });
});

describe("parseAgentResponse", () => {
  it("JSON puro válido", () => {
    expect(parseAgentResponse('{"reply":"Oi!","decision":"continue","reason":"abrir"}')).toEqual({
      reply: "Oi!",
      decision: "continue",
      reason: "abrir",
    });
  });

  it("JSON cercado de texto/markdown", () => {
    const raw = 'Claro! ```json\n{"reply":"Fechado","decision":"goal","reason":"aceitou"}\n```';
    expect(parseAgentResponse(raw)?.decision).toBe("goal");
  });

  it("decision inválida → null; continue sem reply → null; lixo → null", () => {
    expect(parseAgentResponse('{"reply":"x","decision":"limit","reason":""}')).toBeNull();
    expect(parseAgentResponse('{"reply":"","decision":"continue","reason":""}')).toBeNull();
    expect(parseAgentResponse("não sei")).toBeNull();
  });

  it("goal sem reply é aceito (despedida opcional)", () => {
    const r = parseAgentResponse('{"reply":"","decision":"goal","reason":"objetivo atingido"}');
    expect(r).toEqual({ reply: "", decision: "goal", reason: "objetivo atingido" });
  });
});
````

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `supabase/functions/_shared/agent-prompt.ts`**

```ts
import type { LLMMessage } from "./ai.ts";

export const AGENT_DEFAULTS = { maxTurns: 8, maxChars: 500, temperature: 0.7 };

export interface AgentConfig {
  prompt?: string;
  rules?: string;
  temperature?: number;
  maxChars?: number;
  useHistory?: boolean;
  max_turns?: number;
  goal_description?: string;
  model?: string;
}

export interface AgentLeadInfo {
  name?: string | null;
  company?: string | null;
  phone?: string | null;
}

export interface AgentHistoryMessage {
  direction: "inbound" | "outbound";
  content: string;
}

export interface AgentDecision {
  reply: string;
  decision: "continue" | "goal" | "giveup";
  reason: string;
}

export function buildAgentMessages(
  config: AgentConfig,
  lead: AgentLeadInfo,
  history: AgentHistoryMessage[],
  opts: { opening: boolean },
): LLMMessage[] {
  const maxChars = config.maxChars ?? AGENT_DEFAULTS.maxChars;
  const lastInbound = [...history].reverse().find((h) => h.direction === "inbound")?.content ?? "";
  const vars = (s: string) =>
    s
      .replace(/\{\{nome\}\}/g, lead.name || "")
      .replace(/\{\{empresa\}\}/g, lead.company || "")
      .replace(/\{\{telefone\}\}/g, lead.phone || "")
      .replace(/\{\{ultima_mensagem\}\}/g, lastInbound);

  const rules = (config.rules || "")
    .split("\n")
    .map((r) => r.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  const systemParts = [
    "Você é um SDR humano conversando com um lead pelo WhatsApp.",
    "REGRAS INEGOCIÁVEIS:",
    "- Nunca invente preços, prazos, descontos ou fatos que não estejam fornecidos aqui.",
    "- Responda no idioma do lead (padrão: português do Brasil).",
    `- O campo "reply" deve ter no máximo ${maxChars} caracteres.`,
    "- Nunca revele que existe um fluxo automatizado ou uma IA, a não ser que uma regra do operador instrua o contrário.",
    rules.length ? "REGRAS DO OPERADOR:\n" + rules.map((r) => `- ${r}`).join("\n") : "",
    config.goal_description
      ? `OBJETIVO DA CONVERSA (use decision="goal" quando claramente atingido): ${config.goal_description}`
      : "",
    `DADOS DO LEAD: nome=${lead.name || "desconhecido"}; empresa=${lead.company || "desconhecida"}.`,
    config.prompt ? `MISSÃO DADA PELO OPERADOR:\n${vars(config.prompt)}` : "",
    opts.opening
      ? 'TAREFA: gere a PRIMEIRA mensagem da conversa, alinhada à missão. Use decision="continue".'
      : "TAREFA: gere a próxima resposta ao lead e decida o rumo da conversa.",
    'FORMATO DA RESPOSTA — responda APENAS com JSON válido: {"reply": string, "decision": "continue" | "goal" | "giveup", "reason": string}.',
    '- "goal": o objetivo da conversa foi claramente atingido.',
    '- "giveup": o lead recusou explicitamente ou pediu para parar.',
    '- "continue": qualquer outro caso.',
  ].filter(Boolean);

  const convo = history
    .map((h) => `${h.direction === "inbound" ? "LEAD" : "VOCÊ"}: ${h.content}`)
    .join("\n");
  const userContent = opts.opening
    ? "Inicie a conversa agora."
    : `CONVERSA ATÉ AGORA:\n${convo || "(vazia)"}\n\nResponda à última mensagem do LEAD.`;

  return [
    { role: "system", content: systemParts.join("\n") },
    { role: "user", content: userContent },
  ];
}

export function parseAgentResponse(raw: string): AgentDecision | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(raw.trim());
  if (!obj) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryParse(raw.slice(start, end + 1));
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const decision = String(o.decision ?? "").toLowerCase();
  if (!["continue", "goal", "giveup"].includes(decision)) return null;
  const reply = typeof o.reply === "string" ? o.reply.trim() : "";
  if (decision === "continue" && !reply) return null;
  return { reply, decision: decision as AgentDecision["decision"], reason: String(o.reason ?? "") };
}
```

- [ ] **Step 4: Coverage include + verde**

`vitest.config.ts` → adicionar `"supabase/functions/_shared/agent-prompt.ts"`.

Run: `npm run test:coverage`
Expected: PASS, módulo ≥80%.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent-prompt.ts tests/unit/agent-prompt.test.ts vitest.config.ts
git commit -m "feat: montagem de prompt e parse de decisao do agente"
```

---

### Task 4: UI do bloco — modelos reais, `max_turns`, `goal_description`, 3 handles

**Files:**

- Modify: `src/components/flows/ConfigPanel.tsx:194-206` (select de modelo) e `:251` (novos campos após o grid temperatura/maxChars)
- Modify: `src/components/flows/FlowNode.tsx:29-82`

Antes de editar: invocar a skill `frontend-design` (diretriz do projeto para todo trabalho de UI).

**Interfaces:**

- Produces: `config.model` com IDs reais do OpenRouter; `config.max_turns` (number, default 8); `config.goal_description` (string). Handles de source do nó `ai_agent`: ids exatos `goal`, `giveup`, `limit` (Tasks 5/6/15 dependem desses ids nas edges).

- [ ] **Step 1: Substituir o select de modelo no ConfigPanel**

Trocar as `<option>` do select `config.model` (linhas 200-204) por (IDs validados contra `/models` em 2026-07-06):

```tsx
<select
  value={config.model || "google/gemini-2.5-flash"}
  onChange={(e) => update("model", e.target.value)}
  className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
>
  <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (recomendado)</option>
  <option value="google/gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (econômico)</option>
  <option value="google/gemini-3-flash-preview">Gemini 3 Flash Preview</option>
  <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
  <option value="openai/gpt-5-mini">GPT-5 Mini</option>
  <option value="openai/gpt-5">GPT-5</option>
  <option value="anthropic/claude-haiku-4.5">Claude Haiku 4.5</option>
</select>
```

- [ ] **Step 2: Adicionar `goal_description` e `max_turns`**

Inserir após o bloco do grid temperatura/máx. caracteres (linha ~251), antes do checkbox `useHistory`:

```tsx
<div className="space-y-2">
  <label className="text-xs font-semibold text-[#94a3b8] uppercase">Objetivo atingido quando…</label>
  <textarea
    value={config.goal_description || ''}
    onChange={e => update('goal_description', e.target.value)}
    className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[80px] focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
    placeholder="Ex: o lead aceitou agendar uma conversa ou pediu proposta"
  />
  <p className="text-[10px] text-[#475569]">Define quando a conversa sai pela saída OBJETIVO.</p>
</div>

<div className="space-y-2">
  <label className="text-xs font-semibold text-[#94a3b8] uppercase">Máx. de turnos</label>
  <input
    type="number"
    min="1"
    max="30"
    value={config.max_turns ?? 8}
    onChange={e => update('max_turns', parseInt(e.target.value))}
    className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
  />
  <p className="text-[10px] text-[#475569]">Atingido o limite, a conversa sai pela saída LIMITE.</p>
</div>
```

- [ ] **Step 3: Três handles nomeados no FlowNode**

Em `FlowNode.tsx`, adicionar `const isAiAgent = data.type === 'ai_agent';` junto a `isCondition` e trocar o ternário final por três ramos:

```tsx
{isCondition ? (
  /* bloco SIM/NÃO existente, inalterado */
) : isAiAgent ? (
  <div className="flex justify-around w-full pb-1 relative">
    <div className="flex flex-col items-center gap-1">
      <Handle type="source" position={Position.Bottom} id="goal" style={{ left: '20%' }}
        className="!w-3 !h-3 !bg-green-500 !border-2 !border-[#111118]" />
      <span className="text-[8px] text-green-500 font-bold mt-1">OBJETIVO</span>
    </div>
    <div className="flex flex-col items-center gap-1">
      <Handle type="source" position={Position.Bottom} id="giveup" style={{ left: '50%' }}
        className="!w-3 !h-3 !bg-red-500 !border-2 !border-[#111118]" />
      <span className="text-[8px] text-red-500 font-bold mt-1">DESISTIU</span>
    </div>
    <div className="flex flex-col items-center gap-1">
      <Handle type="source" position={Position.Bottom} id="limit" style={{ left: '80%' }}
        className="!w-3 !h-3 !bg-amber-500 !border-2 !border-[#111118]" />
      <span className="text-[8px] text-amber-500 font-bold mt-1">LIMITE</span>
    </div>
  </div>
) : (
  /* handle único existente, inalterado */
)}
```

- [ ] **Step 4: Verificar**

Run: `npm run typecheck && npm run build`
Expected: 0 erros. Verificação visual: `npm run dev -- --mode staging`, abrir um fluxo, arrastar bloco Agente de IA, conferir 3 saídas e novos campos.

- [ ] **Step 5: Commit**

```bash
git add src/components/flows/ConfigPanel.tsx src/components/flows/FlowNode.tsx
git commit -m "feat: bloco ai_agent com modelos reais, objetivo, max turnos e 3 saidas"
```

---

### Task 5: `execute-flow` — case `ai_agent` (abertura da conversa)

**Files:**

- Modify: `supabase/functions/execute-flow/index.ts` (imports no topo; novo case antes de `case 'classifier'` na linha ~414)

**Interfaces:**

- Consumes: `callLLM`, `makeApiCallRecorder`, `getGlobalSetting` (Task 2); `buildAgentMessages`, `parseAgentResponse`, `AGENT_DEFAULTS` (Task 3).
- Produces: `flow_executions.context.agent = { block_id, turns, status: 'active', started_at }` com execução em `waiting_response` — contrato lido pelas Tasks 6 e 7.

- [ ] **Step 1: Imports**

Adicionar no topo (após o import de `flow-routing.ts`):

```ts
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
import { buildAgentMessages, parseAgentResponse, AGENT_DEFAULTS } from "../_shared/agent-prompt.ts";
```

- [ ] **Step 2: Novo case no switch**

Inserir antes de `case 'classifier':`:

```ts
case 'ai_agent': {
  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    console.error('[ai_agent] OPENROUTER_API_KEY ausente — pausando sem abrir conversa')
    await supabaseClient.from('logs').insert({
      user_id, lead_id, flow_id, event: 'ai_agent_error',
      details: { block_id: block.id, error: 'OPENROUTER_API_KEY ausente' }
    })
    shouldPause = true
    break
  }

  const { data: lead } = await supabaseClient.from('leads').select('*').eq('id', lead_id).single()
  let history: any[] = []
  if (config.useHistory !== false) {
    const { data: h } = await supabaseClient
      .from('messages')
      .select('direction, content, created_at')
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: false })
      .limit(30)
    history = (h || []).reverse()
  }

  const model = config.model
    || (await getGlobalSetting(supabaseClient, 'ai_model_agent_default'))
    || 'google/gemini-2.5-flash'
  const record = makeApiCallRecorder(supabaseClient)
  const aiContext = { user_id, lead_id, flow_id, execution_id: execution.id, block_id: block.id }
  const messages = buildAgentMessages(config, lead || {}, history, { opening: true })

  // Resposta fora do JSON esperado → 1 retry; persistindo, fail-safe silencioso (spec §4.6).
  let parsed = null
  for (let i = 0; i < 2 && !parsed; i++) {
    const result = await callLLM({
      apiKey, model, messages, feature: 'agent_opening', jsonResponse: true,
      temperature: config.temperature ?? AGENT_DEFAULTS.temperature,
      maxTokens: 1024, context: aiContext, record,
    })
    if (!result.ok) break
    parsed = parseAgentResponse(result.content)
  }

  if (parsed?.reply) {
    const { data: slotRpc } = await supabaseClient.rpc('next_send_slot', {
      p_user_id: user_id, p_min_at: new Date().toISOString()
    })
    const scheduledAt = slotRpc || getNextValidQueueTime(userSettings)
    await supabaseClient.from('send_queue').insert({
      user_id, lead_id, flow_id, block_id: block.id,
      scheduled_at: scheduledAt, status: 'pending', content: parsed.reply,
    })
    await supabaseClient.from('messages').insert({
      user_id, lead_id, flow_id, block_id: block.id,
      content: parsed.reply, direction: 'outbound', status: 'pending',
    })
  } else {
    console.error('[ai_agent] abertura sem resposta válida — pausando em silêncio (fail-safe)')
  }

  await supabaseClient.from('flow_executions').update({
    status: 'waiting_response',
    context: {
      ...(execution.context || {}),
      agent: {
        block_id: block.id,
        turns: parsed ? 1 : 0,
        status: 'active',
        started_at: new Date().toISOString(),
      },
    },
  }).eq('id', execution.id)
  await supabaseClient.from('leads').update({ flow_waiting_reply: true }).eq('id', lead_id)
  await supabaseClient.from('logs').insert({
    user_id, lead_id, flow_id,
    event: parsed ? 'ai_agent_opened' : 'ai_agent_error',
    details: { block_id: block.id, execution_id: execution.id, opened: !!parsed }
  })
  shouldPause = true
  break
}
```

- [ ] **Step 3: Unit tests seguem verdes + commit**

Run: `npm test`
Expected: PASS (nenhum módulo compartilhado mudou de contrato).

```bash
git add supabase/functions/execute-flow/index.ts
git commit -m "feat: execute-flow abre conversa do agente e pausa aguardando lead"
```

---

### Task 6: Edge function `ai-agent-reply` — turno do agente

**Files:**

- Create: `supabase/functions/ai-agent-reply/index.ts`

**Interfaces:**

- Consumes: contrato `context.agent` (Task 5); `callLLM`/`makeApiCallRecorder`/`getGlobalSetting` (Task 2); `buildAgentMessages`/`parseAgentResponse`/`AGENT_DEFAULTS` (Task 3); `resolveExistingNextBlockId` (fase A) com handles `goal`/`giveup`/`limit` (Task 4).
- Produces: endpoint interno `POST /functions/v1/ai-agent-reply` com body `{ execution_id, lead_id, reply_content }` (Task 7 chama). Decisão final atualiza `context.agent.status` e roteia o fluxo pela edge do handle correspondente.

- [ ] **Step 1: Implementar `supabase/functions/ai-agent-reply/index.ts`**

```ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
import { buildAgentMessages, parseAgentResponse, AGENT_DEFAULTS } from "../_shared/agent-prompt.ts";
import { resolveExistingNextBlockId } from "../_shared/flow-routing.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let step = "init";
  try {
    step = "parse_body";
    const { execution_id, lead_id, reply_content } = await req.json().catch(() => ({}));
    if (!execution_id || !lead_id)
      return json({ success: false, error: "execution_id e lead_id obrigatórios" }, 400);

    step = "load_execution";
    const { data: execution } = await supabase
      .from("flow_executions")
      .select("*")
      .eq("id", execution_id)
      .maybeSingle();
    const agent = (execution?.context as any)?.agent;
    if (!execution || !agent || agent.status !== "active") {
      return json({ success: true, ignored: true, reason: "execução sem modo agente ativo" });
    }

    // ===== Lock otimista do turno (spec §4.5): duas invocações simultâneas não geram duas respostas =====
    step = "lock";
    const lockedContext = {
      ...(execution.context as any),
      agent: { ...agent, processing_since: new Date().toISOString() },
    };
    const first = await supabase
      .from("flow_executions")
      .update({ context: lockedContext })
      .eq("id", execution_id)
      .is("context->agent->>processing_since", null)
      .select("id");
    if (!first.data || first.data.length === 0) {
      // takeover apenas se um turno anterior travou há mais de 2 minutos
      const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const retaken = await supabase
        .from("flow_executions")
        .update({ context: lockedContext })
        .eq("id", execution_id)
        .lt("context->agent->>processing_since", cutoff)
        .select("id");
      if (!retaken.data || retaken.data.length === 0) {
        return json({ success: true, ignored: true, reason: "turno já em processamento" });
      }
    }

    const userId = execution.user_id;
    const flowId = execution.flow_id;
    const baseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Grava o contexto final SEM processing_since (libera o lock em toda saída).
    const finishAgent = async (
      agentPatch: Record<string, unknown>,
      executionPatch: Record<string, unknown> = {},
    ) => {
      const agentFinal: Record<string, unknown> = { ...agent, ...agentPatch };
      delete agentFinal.processing_since;
      await supabase
        .from("flow_executions")
        .update({
          context: { ...(execution.context as any), agent: agentFinal },
          ...executionPatch,
        })
        .eq("id", execution_id);
    };

    step = "load_data";
    const [{ data: block }, { data: blocks }, { data: flowRow }, { data: lead }] =
      await Promise.all([
        supabase.from("flow_blocks").select("*").eq("id", agent.block_id).maybeSingle(),
        supabase.from("flow_blocks").select("*").eq("flow_id", flowId),
        supabase.from("flows").select("canvas_state").eq("id", flowId).maybeSingle(),
        supabase.from("leads").select("*").eq("id", lead_id).maybeSingle(),
      ]);

    if (!block) {
      await finishAgent(
        { status: "giveup", ended_at: new Date().toISOString() },
        { status: "completed" },
      );
      await supabase.from("leads").update({ flow_waiting_reply: false }).eq("id", lead_id);
      return json({ success: true, ignored: true, reason: "bloco do agente não existe mais" });
    }

    const config: any = block.config || {};
    const maxTurns = config.max_turns ?? AGENT_DEFAULTS.maxTurns;
    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) {
      await finishAgent({});
      return json({ success: false, error: "OPENROUTER_API_KEY ausente" }, 500);
    }

    step = "llm";
    let history: any[] = [];
    if (config.useHistory !== false) {
      const { data: h } = await supabase
        .from("messages")
        .select("direction, content, created_at")
        .eq("lead_id", lead_id)
        .order("created_at", { ascending: false })
        .limit(30);
      history = (h || []).reverse();
    }

    const model =
      config.model ||
      (await getGlobalSetting(supabase, "ai_model_agent_default")) ||
      "google/gemini-2.5-flash";
    const record = makeApiCallRecorder(supabase);
    const aiContext = {
      user_id: userId,
      lead_id,
      flow_id: flowId,
      execution_id,
      block_id: block.id,
    };
    const messages = buildAgentMessages(config, lead || {}, history, { opening: false });

    // JSON inválido → 1 retry; persistindo, fail-safe: silêncio, agente segue aguardando (spec §4.6).
    let parsed = null;
    for (let i = 0; i < 2 && !parsed; i++) {
      const result = await callLLM({
        apiKey,
        model,
        messages,
        feature: "agent_reply",
        jsonResponse: true,
        temperature: config.temperature ?? AGENT_DEFAULTS.temperature,
        maxTokens: 1024,
        context: aiContext,
        record,
      });
      if (!result.ok) break;
      parsed = parseAgentResponse(result.content);
    }

    if (!parsed) {
      await finishAgent({});
      await supabase.from("logs").insert({
        user_id: userId,
        lead_id,
        flow_id: flowId,
        event: "ai_agent_error",
        details: {
          execution_id,
          block_id: block.id,
          error: "resposta inválida do modelo (fail-safe silencioso)",
        },
      });
      return json({ success: true, sent: false, reason: "resposta inválida do modelo" });
    }

    // Limite duro de turnos: forçado pelo motor, nunca decidido pelo LLM (spec §4.2.3).
    let decision: "continue" | "goal" | "giveup" | "limit" = parsed.decision;
    if (decision === "continue" && agent.turns >= maxTurns) decision = "limit";

    step = "queue_reply";
    let queueItemId: string | null = null;
    if (parsed.reply) {
      const { data: qItem } = await supabase
        .from("send_queue")
        .insert({
          user_id: userId,
          lead_id,
          flow_id: flowId,
          block_id: block.id,
          scheduled_at: new Date().toISOString(),
          status: "pending",
          content: parsed.reply,
        })
        .select("id")
        .single();
      queueItemId = qItem?.id ?? null;
      await supabase.from("messages").insert({
        user_id: userId,
        lead_id,
        flow_id: flowId,
        block_id: block.id,
        content: parsed.reply,
        direction: "outbound",
        status: "pending",
      });
    }

    step = "apply_decision";
    let nextBlockId: string | null = null;
    if (decision === "continue") {
      await finishAgent({ turns: agent.turns + 1 }, { status: "waiting_response" });
      await supabase.from("leads").update({ flow_waiting_reply: true }).eq("id", lead_id);
    } else {
      const canvasState: any = flowRow?.canvas_state || {};
      const edges: any[] = Array.isArray(canvasState.edges) ? canvasState.edges : [];
      nextBlockId = resolveExistingNextBlockId(block, blocks || [], edges, decision).nextId;
      await finishAgent(
        { status: decision, ended_at: new Date().toISOString() },
        nextBlockId
          ? { status: "running", current_block_id: nextBlockId }
          : { status: "completed" },
      );
      await supabase
        .from("leads")
        .update({
          flow_waiting_reply: false,
          ...(nextBlockId ? {} : { active_flow_id: null, active_flow_step: 0 }),
        })
        .eq("id", lead_id);
    }

    // Envia a reply ANTES de continuar o fluxo (ordem das mensagens no WhatsApp).
    step = "send_reply";
    if (queueItemId) {
      await fetch(`${baseUrl}/functions/v1/process-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ queueItemId }),
      }).catch((e) => console.error("[ai-agent-reply] erro process-queue:", e));
    }

    step = "continue_flow";
    if (nextBlockId) {
      await fetch(`${baseUrl}/functions/v1/execute-flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({
          flow_id: flowId,
          lead_id,
          execution_id,
          user_id: userId,
          trigger_type: "reply_received",
          reply_content,
          block_id: nextBlockId,
        }),
      }).catch((e) => console.error("[ai-agent-reply] erro execute-flow:", e));
    }

    await supabase.from("logs").insert({
      user_id: userId,
      lead_id,
      flow_id: flowId,
      event: "ai_agent_turn",
      details: {
        execution_id,
        decision,
        turns: decision === "continue" ? agent.turns + 1 : agent.turns,
        reason: parsed.reason,
        next_block_id: nextBlockId,
      },
    });

    return json({ success: true, decision, sent: !!queueItemId, next_block_id: nextBlockId });
  } catch (error: any) {
    console.error(`[ai-agent-reply] erro em step=${step}:`, error?.message || error);
    return json({ success: false, step, error: error?.message || String(error) }, 500);
  }
});
```

- [ ] **Step 2: Checagem Deno (se disponível) + commit**

Run: `deno check supabase/functions/ai-agent-reply/index.ts 2>/dev/null || echo "deno ausente — validação ocorre no deploy da Task 14"`

```bash
git add supabase/functions/ai-agent-reply/index.ts
git commit -m "feat: edge function ai-agent-reply processa turno com lock e decisao"
```

---

### Task 7: `whatsapp-webhook` delega ao modo agente

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts:301-320` (novo branch ANTES do branch `mode === 'sequence'`)

**Interfaces:**

- Consumes: endpoint `ai-agent-reply` (Task 6); `context.agent.status === 'active'` (Task 5).

- [ ] **Step 1: Novo branch**

Logo após `const execCtx: any = (execution as any).context || {}` e ANTES do `if (execCtx?.mode === 'sequence')`:

```ts
// ===== Modo agente de IA: delega o turno a ai-agent-reply =====
if (execCtx?.agent?.status === "active") {
  console.log("[Webhook] execução em modo agente — delegando a ai-agent-reply");
  const baseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${baseUrl}/functions/v1/ai-agent-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ execution_id: execution.id, lead_id: lead.id, reply_content: msg.text }),
  });
  const result = await res.json().catch(() => ({}));
  await safeLog(supabaseClient, {
    user_id: userId,
    lead_id: lead.id,
    flow_id: execution.flow_id,
    event: "webhook_ai_agent_turn",
    details: { execution_id: execution.id, result },
  });
  return new Response(JSON.stringify({ success: true, mode: "ai_agent", result }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Unit verde + commit**

Run: `npm test`
Expected: PASS.

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat: webhook delega inbound ao turno do agente de IA"
```

---

### Task 8: Classificador de etapa migra para OpenRouter instrumentado

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts:202-241` (bloco OpenAI do classificador) e imports no topo

**Interfaces:**

- Consumes: `callLLM`, `makeApiCallRecorder`, `getGlobalSetting` (Task 2). Comportamento funcional preservado (spec §4.4): mesmo prompt, mesma lógica de fallback.

- [ ] **Step 1: Imports**

```ts
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
```

- [ ] **Step 2: Substituir o bloco `if (openaiKey) { ... }`**

Trocar da linha `const openaiKey = Deno.env.get('OPENAI_API_KEY')` até o fechamento do `else` que loga chave ausente por:

```ts
const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
let chosenStageName: string | null = null;
let aiReason: string | null = null;

if (openrouterKey) {
  const prompt = `Você é um classificador de pipeline de vendas. Analise a conversa entre EMPRESA e CLIENTE e identifique em qual etapa do pipeline este lead se encontra AGORA.

ETAPAS DISPONÍVEIS (escolha exatamente UMA pelo nome):
${stagesList}

Etapa atual do lead: ${currentStage?.name || "nenhuma"}

CONVERSA:
${convo}

Responda APENAS com JSON: {"stage":"<nome exato da etapa>","reason":"<motivo curto>"}`;

  const model =
    (await getGlobalSetting(supabaseClient, "ai_model_economy")) || "google/gemini-2.5-flash-lite";
  const result = await callLLM({
    apiKey: openrouterKey,
    model,
    feature: "stage_classifier",
    jsonResponse: true,
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
    context: { user_id: userId, lead_id: lead.id },
    record: makeApiCallRecorder(supabaseClient),
  });
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.content);
      chosenStageName = parsed?.stage || null;
      aiReason = parsed?.reason || null;
      console.log("[IA Pipeline] sugerida:", parsed);
    } catch (e) {
      console.error("[IA Pipeline] erro parse:", e, result.content);
    }
  }
} else {
  console.log("[IA Pipeline] OPENROUTER_API_KEY ausente — pulando classificação");
}
```

O restante do bloco (`norm`, `target`, fallback `respondedStage`) permanece intocado.

- [ ] **Step 3: Verde + commit**

Run: `npm test`

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "refactor: classificador de etapa via OpenRouter com registro em api_calls"
```

---

### Task 9: Vision do `enrich-lead` migra para OpenRouter instrumentado

**Files:**

- Modify: `supabase/functions/enrich-lead/index.ts:14-17` (consts), `:117-175` (`classifyPhotos`), `:231` (call site)

**Interfaces:**

- Consumes: `callLLM`, `makeApiCallRecorder`, `getGlobalSetting` (Task 2). Formato de content parts `image_url` é OpenAI-compatible — OpenRouter aceita como está.

- [ ] **Step 1: Consts e imports**

Adicionar import:

```ts
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
```

Remover a linha `const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;` (única referência é o classifyPhotos).

- [ ] **Step 2: Reescrever `classifyPhotos`**

Nova assinatura recebe o client admin e o lead (para recorder e contexto):

```ts
async function classifyPhotos(
  photoUrls: string[],
  admin: any,
  lead: any,
): Promise<{
  logo?: string;
  professional?: string;
  facade?: string;
  structure?: string;
}> {
  const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
  if (photoUrls.length === 0 || !OPENROUTER_API_KEY) return {};

  const content: any[] = [
    {
      type: "text",
      text: `Analise as ${photoUrls.length} fotos numeradas de um negócio. Para cada uma, identifique a categoria:
- "logo": logo/marca da empresa
- "profissional": foto de pessoa(s) trabalhando ou retrato profissional
- "fachada": fachada externa do estabelecimento
- "estrutura": ambiente interno, equipamentos, decoração
- "outro": nenhuma das acima

Responda APENAS em JSON: {"categorias":[{"index":0,"categoria":"logo"},...]}`,
    },
    ...photoUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const model =
    (await getGlobalSetting(admin, "ai_model_economy")) || "google/gemini-2.5-flash-lite";
  const result = await callLLM({
    apiKey: OPENROUTER_API_KEY,
    model,
    feature: "photo_vision",
    jsonResponse: true,
    maxTokens: 800,
    messages: [{ role: "user", content }],
    context: { user_id: lead.user_id, lead_id: lead.id },
    record: makeApiCallRecorder(admin),
  });
  if (!result.ok) return {};

  try {
    const parsed = JSON.parse(result.content);
    const cats: any[] = Array.isArray(parsed.categorias) ? parsed.categorias : [];
    const out: any = {};
    for (const c of cats) {
      const url = photoUrls[c.index];
      if (!url) continue;
      const cat = String(c.categoria || "").toLowerCase();
      if (cat === "logo" && !out.logo) out.logo = url;
      else if (cat === "profissional" && !out.professional) out.professional = url;
      else if (cat === "fachada" && !out.facade) out.facade = url;
      else if (cat === "estrutura" && !out.structure) out.structure = url;
    }
    return out;
  } catch (e) {
    console.error("classifyPhotos parse err:", e);
    return {};
  }
}
```

Call site em `enrichOne`: `const cats = await classifyPhotos(photos, supabase, lead);`

- [ ] **Step 3: Verde + commit**

Run: `npm test`

```bash
git add supabase/functions/enrich-lead/index.ts
git commit -m "refactor: vision do enrich-lead via OpenRouter com registro em api_calls"
```

---

### Task 10: `_shared/serp.ts` + instrumentação de todas as chamadas SerpAPI (TDD)

**Files:**

- Create: `supabase/functions/_shared/serp.ts`
- Create: `tests/unit/serp.test.ts`
- Modify: `vitest.config.ts` (coverage.include)
- Modify: `supabase/functions/enrich-lead/index.ts` (5 call sites: `fetchPlaceDetails`, `lookupPlaceByText`, `fetchPhotos`, `fetchReviews`, bloco instagram)
- Modify: `supabase/functions/google-extractor/index.ts:66-107`
- Modify: `supabase/functions/serp-search/index.ts:44-52`

**Interfaces:**

- Consumes: `ApiCallRecorder`, `sanitizeForLog` (Task 2); custo em `global_settings.serpapi_cost_per_search_usd_micros` (Task 1).
- Produces:
  - `interface SerpFetchParams { url: string; feature: string; costUsdMicros: number; context?: { user_id?: string | null; lead_id?: string | null }; record: ApiCallRecorder; fetchFn?: typeof fetch; timeoutMs?: number }`
  - `interface SerpFetchResult { ok: boolean; status: number; json: any }`
  - `serpFetch(params: SerpFetchParams): Promise<SerpFetchResult>` — registra `api_calls` com provider `serpapi`; custo só em sucesso; `request.url` SEM `api_key`.
  - `stripApiKey(url: string): string`

- [ ] **Step 1: Testes falhando**

`tests/unit/serp.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { serpFetch, stripApiKey } from "../../supabase/functions/_shared/serp.ts";
import type { ApiCallRecord } from "../../supabase/functions/_shared/ai.ts";

describe("stripApiKey", () => {
  it("remove api_key preservando o resto", () => {
    const out = stripApiKey(
      "https://serpapi.com/search.json?engine=google_maps&q=padaria&api_key=SEGREDO",
    );
    expect(out).not.toContain("SEGREDO");
    expect(out).toContain("engine=google_maps");
  });
});

describe("serpFetch", () => {
  it("sucesso registra custo, latência e url sem chave", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ local_results: [{ title: "X" }] }), { status: 200 }),
      );
    const r = await serpFetch({
      url: "https://serpapi.com/search.json?q=teste&api_key=SEGREDO",
      feature: "extract_search",
      costUsdMicros: 15000,
      context: { user_id: "u1" },
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.json.local_results).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "serpapi",
      feature: "extract_search",
      status: "ok",
      cost_usd_micros: 15000,
      user_id: "u1",
    });
    expect(JSON.stringify(rows[0].request)).not.toContain("SEGREDO");
  });

  it("erro HTTP registra status error e custo 0", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi.fn().mockResolvedValue(new Response("quota", { status: 429 }));
    const r = await serpFetch({
      url: "https://serpapi.com/search.json?api_key=k",
      feature: "enrich_photos",
      costUsdMicros: 15000,
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(rows[0].status).toBe("error");
    expect(rows[0].cost_usd_micros).toBe(0);
  });

  it("exceção de rede registra error", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi.fn().mockRejectedValue(new Error("timeout"));
    const r = await serpFetch({
      url: "https://serpapi.com/x?api_key=k",
      feature: "instagram_profile",
      costUsdMicros: 15000,
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(rows[0].error_message).toContain("timeout");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `supabase/functions/_shared/serp.ts`**

```ts
import { sanitizeForLog, type ApiCallRecorder } from "./ai.ts";

export interface SerpFetchParams {
  url: string;
  feature: string;
  costUsdMicros: number;
  context?: { user_id?: string | null; lead_id?: string | null };
  record: ApiCallRecorder;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface SerpFetchResult {
  ok: boolean;
  status: number;
  json: any;
}

export function stripApiKey(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("api_key");
    return u.toString();
  } catch {
    return "[url inválida]";
  }
}

export async function serpFetch(params: SerpFetchParams): Promise<SerpFetchResult> {
  const { url, feature, costUsdMicros, context = {}, record, fetchFn = fetch, timeoutMs } = params;
  const started = Date.now();
  let status = 0;
  let json: any = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetchFn(
      url,
      timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
    );
    status = res.status;
    const raw = await res.text();
    try {
      json = JSON.parse(raw);
    } catch {
      json = { raw: raw.slice(0, 500) };
    }
    if (!res.ok) errorMessage = `HTTP ${res.status}`;
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  const ok = errorMessage === null;
  await record({
    user_id: context.user_id ?? null,
    lead_id: context.lead_id ?? null,
    provider: "serpapi",
    feature,
    model: null,
    status: ok ? "ok" : "error",
    error_message: errorMessage,
    latency_ms: Date.now() - started,
    prompt_tokens: null,
    completion_tokens: null,
    cost_usd_micros: ok ? costUsdMicros : 0,
    request: { url: stripApiKey(url) },
    response: sanitizeForLog(json, { maxString: 500, maxArray: 5 }),
  });

  return { ok, status, json };
}
```

- [ ] **Step 4: Coverage include + verde**

`vitest.config.ts` → adicionar `"supabase/functions/_shared/serp.ts"`.
Run: `npm run test:coverage` — PASS, ≥80%.

- [ ] **Step 5: Migrar `enrich-lead`**

Import: `import { serpFetch } from "../_shared/serp.ts";`

Em `enrichOne`, logo no início, construir o contexto de instrumentação:

```ts
const serpCost = parseInt(
  (await getGlobalSetting(supabase, "serpapi_cost_per_search_usd_micros")) || "15000",
  10,
);
const serp = {
  costUsdMicros: serpCost,
  record: makeApiCallRecorder(supabase),
  context: { user_id: lead.user_id, lead_id: lead.id },
};
```

As quatro funções ganham o parâmetro `serp` e trocam `fetch` por `serpFetch` (tipo do parâmetro: `serp: { costUsdMicros: number; record: ApiCallRecorder; context: { user_id: string; lead_id: string } }` — importar `ApiCallRecorder` de `../_shared/ai.ts`):

```ts
async function fetchPlaceDetails(placeId: string, serp: SerpCtx) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("hl", "pt");
  const r = await serpFetch({ url: url.toString(), feature: "enrich_details", ...serp });
  if (!r.ok) throw new Error(`SerpAPI place details ${r.status}`);
  return r.json;
}

async function lookupPlaceByText(query: string, serp: SerpCtx) {
  // mesma construção de URL do original (engine google_maps, q, hl, gl)
  const r = await serpFetch({ url: url.toString(), feature: "enrich_details", ...serp });
  if (!r.ok) return { place_id: null, data_id: null, thumbnail: null };
  const j = r.json;
  // resto igual ao original
}

async function fetchPhotos(dataId: string, serp: SerpCtx): Promise<string[]> {
  // URL igual ao original (engine google_maps_photos)
  const r = await serpFetch({ url: url.toString(), feature: "enrich_photos", ...serp });
  if (!r.ok) return [];
  const j = r.json;
  // resto igual
}

async function fetchReviews(dataId: string, serp: SerpCtx): Promise<any[]> {
  // URL igual ao original (engine google_maps_reviews, sort_by ratingHigh)
  const r = await serpFetch({ url: url.toString(), feature: "enrich_reviews", ...serp });
  if (!r.ok) return [];
  const j = r.json;
  // resto igual
}
```

Definir o tipo uma vez no topo do arquivo:

```ts
type SerpCtx = {
  costUsdMicros: number;
  record: ApiCallRecorder;
  context: { user_id: string; lead_id: string };
};
```

Bloco instagram (linhas ~262-277): trocar o `fetch(igUrl...)` por:

```ts
const r = await serpFetch({
  url: igUrl.toString(),
  feature: "instagram_profile",
  timeoutMs: 15000,
  ...serp,
});
if (r.ok) {
  const igJson = r.json;
  instagramPhoto =
    igJson?.profile_pic_url_hd ||
    igJson?.profile_pic_url ||
    igJson?.profile?.profile_pic_url ||
    null;
}
```

Atualizar todos os call sites em `enrichOne` para passar `serp`.

- [ ] **Step 6: Migrar `google-extractor`**

Adicionar imports (`createClient` de esm.sh, `serpFetch`, `makeApiCallRecorder`, `getGlobalSetting`). Após validar `SERPAPI_KEY`, montar admin client e user best-effort:

```ts
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
let callerUserId: string | null = null;
try {
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  const { data } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
  callerUserId = data?.user?.id ?? null;
} catch {
  /* segue com null */
}
```

Trocar o bloco `const serpResponse = await fetch(serpUrl)` até o parse por:

```ts
const serpCost = parseInt(
  (await getGlobalSetting(admin, "serpapi_cost_per_search_usd_micros")) || "15000",
  10,
);
const r = await serpFetch({
  url: serpUrl,
  feature: "extract_search",
  costUsdMicros: serpCost,
  context: { user_id: callerUserId },
  record: makeApiCallRecorder(admin),
});
if (!r.ok) {
  console.error("SerpAPI erro:", r.status);
  return new Response(JSON.stringify({ error: `SerpAPI retornou ${r.status}`, results: [] }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
const serpData = r.json;
```

(A checagem `serpData.error` existente permanece.)

- [ ] **Step 7: Migrar `serp-search`**

Adicionar imports (`serpFetch`, `makeApiCallRecorder`, `getGlobalSetting`) e admin client (service role). Trocar `const response = await fetch(url.toString()); const data = await response.json()` por:

```ts
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const serpCost = parseInt(
  (await getGlobalSetting(admin, "serpapi_cost_per_search_usd_micros")) || "15000",
  10,
);
const r = await serpFetch({
  url: url.toString(),
  feature: "extract_search",
  costUsdMicros: serpCost,
  context: { user_id: user.id },
  record: makeApiCallRecorder(admin),
});
const data = r.json;
```

- [ ] **Step 8: Verde + commit**

Run: `npm run test:coverage`

```bash
git add supabase/functions/_shared/serp.ts tests/unit/serp.test.ts vitest.config.ts supabase/functions/enrich-lead/index.ts supabase/functions/google-extractor/index.ts supabase/functions/serp-search/index.ts
git commit -m "feat: chamadas SerpAPI instrumentadas via serpFetch compartilhado"
```

---

### Task 11: Cron versionado (spec §9)

**Files:**

- Create: `supabase/migrations/20260706170000_cron_versionado.sql`

- [ ] **Step 1 (AÇÃO DO USUÁRIO ou Management API): inventariar cron da PRODUÇÃO — somente leitura**

Rodar no SQL Editor do dashboard de produção (`aoanpviozfabrrxjqayk`) — SELECT apenas, nada de escrita:

```sql
SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobid;
```

Registrar a saída aqui no plano (colar como comentário na migration). A migration abaixo assume os nomes `process-flows-cron` e `process-queue-cron`; se produção usar OUTROS nomes para jobs equivalentes, adicionar `cron.unschedule('<nome antigo>')` correspondentes antes dos `schedule` — decisão tomada com o inventário em mãos, antes de aplicar em qualquer ambiente.

- [ ] **Step 2: Escrever a migration (idempotente, parametrizada via `global_settings`)**

```sql
-- Versiona o agendamento de process-flows e process-queue (antes só existia
-- ad hoc no projeto de produção, irreproduzível a partir do repositório).
-- URL e chave vêm de global_settings (mesma parametrização do trigger de estágio).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-flows-cron') THEN
    PERFORM cron.unschedule('process-flows-cron');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-queue-cron') THEN
    PERFORM cron.unschedule('process-queue-cron');
  END IF;
END $$;

SELECT cron.schedule('process-flows-cron', '* * * * *', $$
  SELECT net.http_post(
    url := (SELECT value FROM public.global_settings WHERE key = 'edge_functions_base_url') || '/functions/v1/process-flows',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.global_settings WHERE key = 'edge_functions_anon_key')
    ),
    body := '{}'::jsonb
  )
$$);

SELECT cron.schedule('process-queue-cron', '* * * * *', $$
  SELECT net.http_post(
    url := (SELECT value FROM public.global_settings WHERE key = 'edge_functions_base_url') || '/functions/v1/process-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.global_settings WHERE key = 'edge_functions_anon_key')
    ),
    body := '{}'::jsonb
  )
$$);
```

- [ ] **Step 3: Aplicar no staging e verificar**

Run: `bash scripts/sb-staging.sh db push`
Verificar (SQL Editor do staging): `SELECT jobname, schedule FROM cron.job;` → 2 jobs. Após ~2 minutos, conferir que `process-flows` responde nos logs de função do staging sem erro.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260706170000_cron_versionado.sql
git commit -m "feat: versiona cron de process-flows e process-queue via global_settings"
```

---

### Task 12: `sent_at` no envio + views SQL de observabilidade

**Files:**

- Modify: `supabase/functions/process-queue/index.ts:376-380` (update de sucesso ganha `sent_at`)
- Create: `supabase/migrations/20260706180000_views_observabilidade.sql`

**Interfaces:**

- Produces (Task 13 consome via PostgREST): views `api_costs_daily`, `api_stats`, `whatsapp_health`, `agent_sessions` — todas `security_invoker` (RLS das tabelas base aplica ao usuário logado).

- [ ] **Step 1: `process-queue` grava `sent_at`**

No update de sucesso (linha ~376):

```ts
const { error: updErr } = await supabaseClient
  .from("send_queue")
  .update({
    status: "sent",
    attempts: (item.attempts || 0) + 1,
    scheduled_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
  })
  .eq("id", item.id);
```

- [ ] **Step 2: Escrever a migration de views**

```sql
-- Views de observabilidade (spec §5.2/§5.3). security_invoker: RLS de
-- api_calls / send_queue / flow_executions / leads aplica ao usuário logado.

create or replace view public.api_costs_daily with (security_invoker = on) as
select
  user_id,
  ((created_at at time zone 'America/Sao_Paulo')::date) as day,
  provider,
  feature,
  count(*)::bigint as calls,
  (count(*) filter (where status = 'error'))::bigint as errors,
  coalesce(sum(cost_usd_micros), 0)::bigint as cost_usd_micros,
  coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
  coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
from public.api_calls
where created_at >= now() - interval '35 days'
group by user_id, day, provider, feature;

create or replace view public.api_stats with (security_invoker = on) as
select
  user_id,
  coalesce(sum(cost_usd_micros) filter (
    where created_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
  ), 0)::bigint as cost_today_usd_micros,
  coalesce(sum(cost_usd_micros) filter (where created_at >= now() - interval '7 days'), 0)::bigint as cost_7d_usd_micros,
  coalesce(sum(cost_usd_micros) filter (where created_at >= now() - interval '30 days'), 0)::bigint as cost_30d_usd_micros,
  (count(*) filter (where created_at >= now() - interval '7 days'))::bigint as calls_7d,
  (count(*) filter (where status = 'error' and created_at >= now() - interval '7 days'))::bigint as errors_7d,
  percentile_cont(0.5) within group (order by latency_ms)
    filter (where created_at >= now() - interval '7 days') as latency_p50_ms,
  percentile_cont(0.95) within group (order by latency_ms)
    filter (where created_at >= now() - interval '7 days') as latency_p95_ms
from public.api_calls
group by user_id;

create or replace view public.whatsapp_health with (security_invoker = on) as
select
  user_id,
  (count(*) filter (where status = 'sent' and created_at >= now() - interval '7 days'))::bigint as sent_7d,
  (count(*) filter (where status = 'failed' and created_at >= now() - interval '7 days'))::bigint as failed_7d,
  (count(*) filter (where status = 'pending'))::bigint as pending_now,
  avg(extract(epoch from (sent_at - created_at))) filter (
    where sent_at is not null and created_at >= now() - interval '7 days'
  ) as avg_queue_delay_s
from public.send_queue
group by user_id;

create or replace view public.agent_sessions with (security_invoker = on) as
select
  fe.id as execution_id,
  fe.user_id,
  fe.lead_id,
  l.name as lead_name,
  l.phone as lead_phone,
  fe.flow_id,
  fe.context->'agent'->>'status' as agent_status,
  coalesce((fe.context->'agent'->>'turns')::int, 0) as turns,
  fe.context->'agent'->>'block_id' as block_id,
  fe.context->'agent'->>'started_at' as started_at,
  coalesce((
    select sum(ac.cost_usd_micros) from public.api_calls ac
    where ac.execution_id = fe.id
  ), 0)::bigint as cost_usd_micros,
  fe.created_at
from public.flow_executions fe
join public.leads l on l.id = fe.lead_id
where fe.context ? 'agent';
```

- [ ] **Step 3: Aplicar no staging**

Run: `bash scripts/sb-staging.sh db push`
Expected: sem erro. Smoke: `select * from public.api_stats;` no SQL Editor (vazio é ok).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/process-queue/index.ts supabase/migrations/20260706180000_views_observabilidade.sql
git commit -m "feat: views de observabilidade e sent_at no envio da fila"
```

---

### Task 13: Página `/observabilidade`

**Files:**

- Create: `src/pages/Observabilidade.tsx`
- Create: `src/routes/observabilidade.tsx`
- Modify: `src/components/layout/AppLayout.tsx:22-35` (navItems)

Antes de escrever o código visual: invocar as skills `frontend-design` E `dataviz` (pedido explícito do usuário; capricho máximo). O código abaixo define estrutura, queries e contratos; o refinamento visual (hierarquia, cores do gráfico, estados vazios) segue as skills.

**Interfaces:**

- Consumes: views da Task 12 via PostgREST; tabela `api_calls` (drill-down); `messages` (transcript).
- Produces: rota `/observabilidade` no app autenticado.

- [ ] **Step 1: Rota `src/routes/observabilidade.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import AppLayout from "@/components/layout/AppLayout";
import Observabilidade from "@/pages/Observabilidade";

export const Route = createFileRoute("/observabilidade")({
  head: () => ({
    meta: [
      { title: "Observabilidade — EleveFlow CRM" },
      {
        name: "description",
        content: "Custos de IA, conversas do agente e saúde dos envios WhatsApp.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <Observabilidade />
    </AppLayout>
  ),
});
```

- [ ] **Step 2: Item de navegação**

Em `AppLayout.tsx`, adicionar `Gauge` ao import de `lucide-react` e inserir em `navItems` após Logs:

```ts
{ icon: Gauge, label: "Observabilidade", to: "/observabilidade" },
```

- [ ] **Step 3: Página `src/pages/Observabilidade.tsx`**

Estrutura obrigatória (spec §5.3) — implementar com o padrão visual do app (dark, tokens atuais das outras páginas) e refinamento guiado pelas skills:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const fmtUsd = (micros: number | null | undefined) =>
  `$${(((micros ?? 0) as number) / 1_000_000).toFixed(4)}`;

export default function Observabilidade() {
  const [selectedSession, setSelectedSession] = useState<any>(null);
  const [selectedCall, setSelectedCall] = useState<any>(null);

  const { data: stats } = useQuery({
    queryKey: ["obs-stats"],
    queryFn: async () => (await supabase.from("api_stats").select("*").maybeSingle()).data,
  });

  const { data: daily } = useQuery({
    queryKey: ["obs-daily"],
    queryFn: async () =>
      (await supabase.from("api_costs_daily").select("*").order("day", { ascending: true })).data ??
      [],
  });

  const { data: wa } = useQuery({
    queryKey: ["obs-wa"],
    queryFn: async () => (await supabase.from("whatsapp_health").select("*").maybeSingle()).data,
  });

  const { data: sessions } = useQuery({
    queryKey: ["obs-sessions"],
    queryFn: async () =>
      (
        await supabase
          .from("agent_sessions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(20)
      ).data ?? [],
  });

  const { data: calls } = useQuery({
    queryKey: ["obs-calls"],
    queryFn: async () =>
      (
        await supabase
          .from("api_calls")
          .select(
            "id, created_at, provider, feature, model, status, error_message, latency_ms, prompt_tokens, completion_tokens, cost_usd_micros",
          )
          .order("created_at", { ascending: false })
          .limit(50)
      ).data ?? [],
  });

  // transcript + custo por turno da sessão selecionada
  const { data: transcript } = useQuery({
    queryKey: ["obs-transcript", selectedSession?.execution_id],
    enabled: !!selectedSession,
    queryFn: async () => {
      const [msgs, turnCalls] = await Promise.all([
        supabase
          .from("messages")
          .select("direction, content, created_at")
          .eq("lead_id", selectedSession.lead_id)
          .order("created_at", { ascending: true })
          .limit(80),
        supabase
          .from("api_calls")
          .select("created_at, feature, cost_usd_micros, status")
          .eq("execution_id", selectedSession.execution_id)
          .order("created_at", { ascending: true }),
      ]);
      return { messages: msgs.data ?? [], calls: turnCalls.data ?? [] };
    },
  });

  // drill-down de request/response só quando abre (payloads grandes)
  const { data: callDetail } = useQuery({
    queryKey: ["obs-call-detail", selectedCall?.id],
    enabled: !!selectedCall,
    queryFn: async () =>
      (
        await supabase
          .from("api_calls")
          .select("request, response")
          .eq("id", selectedCall.id)
          .maybeSingle()
      ).data,
  });

  // últimos 14 dias empilhados por feature (spec §5.3)
  const chartData = (() => {
    const days = new Map<string, Record<string, number | string>>();
    for (const row of (daily ?? []).filter(
      (d: any) => d.provider === "openrouter" || d.provider === "serpapi",
    )) {
      const key = String(row.day);
      if (!days.has(key)) days.set(key, { day: key });
      const entry = days.get(key)!;
      entry[row.feature] = ((entry[row.feature] as number) ?? 0) + row.cost_usd_micros / 1_000_000;
    }
    return Array.from(days.values()).slice(-14);
  })();
  const features = Array.from(new Set((daily ?? []).map((d: any) => d.feature)));

  return (
    <div className="space-y-8">
      {/* Cards de resumo: gasto hoje/7d/30d, chamadas, taxa de erro, p50/p95, SerpAPI, WhatsApp */}
      {/* Gráfico de gasto por dia (14 dias) empilhado por feature */}
      {/* Feed de conversas do agente (sessions → dialog com transcript + custo por turno + decisão) */}
      {/* Tabela de chamadas com drill-down (dialog com request/response formatados) */}
    </div>
  );
}
```

Conteúdo dos quatro blocos (o JSX final segue as skills de design; contratos obrigatórios):

1. **Cards**: `fmtUsd(stats?.cost_today_usd_micros)`, `cost_7d`, `cost_30d`; `calls_7d`; taxa de erro `errors_7d/calls_7d` em %; `latency_p50_ms`/`latency_p95_ms` (arredondar); buscas SerpAPI 7d (somar `calls` de `daily` com `provider === 'serpapi'`); WhatsApp `wa.sent_7d`/`wa.failed_7d`/`wa.pending_now`. Adicionar `data-testid="cost-30d"` no valor do card de gasto 30d (o e2e da Task 15 depende).
2. **Gráfico**: `BarChart` com `chartData`, um `<Bar stackId="cost" dataKey={feature}>` por item de `features`, tooltip formatando USD com 4 casas. Cores/estilo: seguir skill `dataviz`.
3. **Feed do agente**: lista de `sessions` (nome do lead, status com badge — `goal` verde, `giveup` vermelho, `limit` âmbar, `active` azul —, turnos, `fmtUsd(cost_usd_micros)`); clique abre `Dialog` com transcript (bolhas inbound/outbound de `transcript.messages`) e a lista `transcript.calls` com custo por turno. `data-testid="agent-session"` em cada item da lista.
4. **Tabela de chamadas**: colunas data, provider, feature, model, status, latência, tokens, custo (`fmtUsd`); linha com erro mostra `error_message` truncado; clique abre `Dialog` com `<pre className="text-xs overflow-auto max-h-[60vh]">{JSON.stringify(callDetail?.request, null, 2)}</pre>` e o mesmo para `response`.

Exibição de custo SEMPRE via `fmtUsd` (conversão de micros só na camada de exibição — spec §5.3).

- [ ] **Step 4: Verificar**

Run: `npm run typecheck && npm run build`
Expected: 0 erros (a rota nova entra no routeTree gerado). Visual: `npm run dev -- --mode staging`, login e2e, abrir `/observabilidade` — página renderiza com estados vazios decentes (sem dados ainda).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Observabilidade.tsx src/routes/observabilidade.tsx src/components/layout/AppLayout.tsx
git commit -m "feat: pagina de observabilidade com custos, agente e saude de envios"
```

---

### Task 14: Deploy no staging + secret OpenRouter + smoke

**Files:** nenhum novo (operações de ambiente).

- [ ] **Step 1 (AÇÃO DO USUÁRIO, se necessário): chave OpenRouter**

Se `OPENROUTER_API_KEY` não estiver em `.env.staging`, o usuário fornece uma chave real (criar em openrouter.ai → Keys, com limite de crédito baixo para testes).

- [ ] **Step 2: Secret + deploy**

Run:

```bash
bash scripts/sb-staging.sh secrets set OPENROUTER_API_KEY=<chave>
bash scripts/sb-staging.sh functions deploy
```

Expected: deploy de TODAS as functions sem erro de compilação (valida imports das Tasks 5-10 no runtime Deno real, incluindo a nova `ai-agent-reply`).

- [ ] **Step 3: Smoke de LLM real (1 chamada barata)**

Simular inbound de lead existente (seed fase A, telefone `5511999990000`) SEM execução de agente — exercita o classificador de etapa migrado (Task 8):

```bash
curl -s --ssl-no-revoke -X POST "https://cdnckhzqvqvrtaeyafon.supabase.co/functions/v1/whatsapp-webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ANON_KEY_STAGING>" \
  -d '{"event":"messages.upsert","instance":"e2e","data":{"key":{"remoteJid":"5511999990000@s.whatsapp.net","fromMe":false,"id":"SMOKE-BC-1"},"message":{"conversation":"tenho interesse, me conta mais"}}}'
```

Expected: HTTP 200. Verificar em seguida (service role ou SQL Editor): `select feature, status, model, cost_usd_micros, latency_ms from api_calls order by created_at desc limit 3;` → linha `stage_classifier` com `status='ok'` e `cost_usd_micros > 0`. Se `cost_usd_micros = 0` com status ok, investigar o parse de `usage.cost` (formato real da resposta OpenRouter) ANTES de seguir — critério §8.1 depende disso.

- [ ] **Step 4: Atualizar STATUS.md (staging com B+C deployado) + commit**

```bash
git add STATUS.md
git commit -m "docs: registra deploy de fases B e C no staging"
```

---

### Task 15: E2E — jornada completa do agente no staging

**Files:**

- Create: `tests/e2e/helpers/agent-seed.ts`
- Create: `tests/e2e/agent-journey.spec.ts`
- Create: `tests/e2e/observability.spec.ts`

**Interfaces:**

- Consumes: staging deployado (Task 14); usuário seed `e2e@eleveflow.test` (fase A); handles `goal`/`giveup`/`limit` (Task 4); `.env.staging` com `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `STAGING_SERVICE_ROLE_KEY`.
- Custo: chamadas LLM reais com `google/gemini-2.5-flash-lite` (~$0.001/rodada — aceito pela spec §9).

- [ ] **Step 1: Helper `tests/e2e/helpers/agent-seed.ts`**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SeededAgentFlow {
  userId: string;
  leadId: string;
  flowId: string;
  aiBlockId: string;
  goalStageId: string;
}

export function adminClient(): SupabaseClient {
  return createClient(process.env.VITE_SUPABASE_URL!, process.env.STAGING_SERVICE_ROLE_KEY!);
}

export async function seedAgentFlow(
  admin: SupabaseClient,
  opts: { phone: string; maxTurns: number; suffix: string },
): Promise<SeededAgentFlow> {
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === "e2e@eleveflow.test");
  if (!user) throw new Error("usuário e2e ausente — rodar scripts/seed-staging.mjs antes");

  let { data: stage } = await admin
    .from("pipeline_stages")
    .select("id")
    .eq("user_id", user.id)
    .eq("name", "Qualificado E2E")
    .maybeSingle();
  if (!stage) {
    const r = await admin
      .from("pipeline_stages")
      .insert({ user_id: user.id, name: "Qualificado E2E", position: 90 })
      .select("id")
      .single();
    stage = r.data!;
  }

  let { data: lead } = await admin
    .from("leads")
    .select("id")
    .eq("user_id", user.id)
    .eq("phone", opts.phone)
    .maybeSingle();
  if (!lead) {
    const r = await admin
      .from("leads")
      .insert({ user_id: user.id, name: `Lead Agente ${opts.suffix}`, phone: opts.phone })
      .select("id")
      .single();
    lead = r.data!;
  }

  // estado limpo: sem execuções/fila do lead de rodadas anteriores
  await admin.from("flow_executions").delete().eq("lead_id", lead.id);
  await admin.from("send_queue").delete().eq("lead_id", lead.id);
  await admin
    .from("leads")
    .update({ flow_waiting_reply: false, active_flow_id: null })
    .eq("id", lead.id);

  const { data: flow } = await admin
    .from("flows")
    .insert({ user_id: user.id, name: `Agente E2E ${opts.suffix} ${Date.now()}`, is_active: true })
    .select("id")
    .single();

  const mkBlock = async (type: string, position: number, config: Record<string, unknown>) =>
    (
      await admin
        .from("flow_blocks")
        .insert({ user_id: user.id, flow_id: flow!.id, type, position, config })
        .select("id")
        .single()
    ).data!.id as string;

  const triggerId = await mkBlock("trigger", 0, { trigger_type: "manual" });
  const aiId = await mkBlock("ai_agent", 1, {
    model: "google/gemini-2.5-flash-lite",
    prompt: "Você atende a {{empresa}}. Convide {{nome}} para agendar uma conversa de 15 minutos.",
    rules: "Seja breve\nSe o lead disser que quer agendar, considere o objetivo atingido",
    goal_description: "o lead aceitou agendar uma conversa",
    max_turns: opts.maxTurns,
    maxChars: 300,
    useHistory: true,
  });
  const moveId = await mkBlock("move_pipeline", 2, { target_stage_id: stage.id });
  const endId = await mkBlock("end", 3, {});

  await admin
    .from("flows")
    .update({
      canvas_state: {
        edges: [
          { id: "e-t-ai", source: triggerId, target: aiId },
          { id: "e-goal", source: aiId, target: moveId, sourceHandle: "goal" },
          { id: "e-giveup", source: aiId, target: endId, sourceHandle: "giveup" },
          { id: "e-limit", source: aiId, target: endId, sourceHandle: "limit" },
          { id: "e-move-end", source: moveId, target: endId },
        ],
      },
    })
    .eq("id", flow!.id);

  return {
    userId: user.id,
    leadId: lead.id,
    flowId: flow!.id,
    aiBlockId: aiId,
    goalStageId: stage.id,
  };
}

export const evolutionPayload = (phone: string, text: string, id: string) => ({
  event: "messages.upsert",
  instance: "e2e",
  data: {
    key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id },
    message: { conversation: text },
  },
});
```

- [ ] **Step 2: `tests/e2e/agent-journey.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import { adminClient, seedAgentFlow, evolutionPayload } from "./helpers/agent-seed";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.STAGING_SERVICE_ROLE_KEY!;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000); // chamadas LLM reais

const svcHeaders = { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

test("agente abre conversa, responde e sai por OBJETIVO com custo registrado", async ({
  request,
}) => {
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, { phone: "5511999990001", maxTurns: 5, suffix: "GOAL" });

  // 1. dispara o fluxo (abertura via LLM real)
  const ex = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(ex.ok()).toBeTruthy();

  // 2. abertura enfileirada + contexto de agente ativo
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 90_000 },
    )
    .toBe("active");
  const { data: q } = await admin
    .from("send_queue")
    .select("id")
    .eq("lead_id", seed.leadId)
    .eq("status", "pending");
  expect(q!.length).toBeGreaterThan(0);

  // 3. envia a abertura (mock Evolution)
  await request.post(`${SUPABASE_URL}/functions/v1/process-queue`, {
    headers: svcHeaders,
    data: { queueItemId: q![0].id },
  });

  // 4. lead aceita agendar → decision goal
  const wh = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: { Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    data: evolutionPayload(
      "5511999990001",
      "Sim! Quero agendar essa conversa, pode marcar amanhã às 10h.",
      `E2E-GOAL-${Date.now()}`,
    ),
  });
  expect(wh.ok()).toBeTruthy();

  // 5. decisão goal aplicada, fluxo seguiu pela saída Objetivo → move_pipeline
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 120_000 },
    )
    .toBe("goal");
  await expect
    .poll(
      async () =>
        (await admin.from("leads").select("stage_id").eq("id", seed.leadId).single()).data
          ?.stage_id,
      { timeout: 60_000 },
    )
    .toBe(seed.goalStageId);

  // 6. api_calls: tokens, latência e custo real > 0 (critério §8.1)
  const { data: calls } = await admin
    .from("api_calls")
    .select("feature, status, prompt_tokens, completion_tokens, latency_ms, cost_usd_micros")
    .eq("lead_id", seed.leadId)
    .in("feature", ["agent_opening", "agent_reply"]);
  expect(calls!.length).toBeGreaterThanOrEqual(2);
  for (const c of calls!) {
    expect(c.status).toBe("ok");
    expect(c.prompt_tokens).toBeGreaterThan(0);
    expect(c.latency_ms).toBeGreaterThan(0);
    expect(c.cost_usd_micros).toBeGreaterThan(0);
  }
});

test("limite de turnos força saída LIMITE", async ({ request }) => {
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, { phone: "5511999990002", maxTurns: 1, suffix: "LIMIT" });

  const ex = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(ex.ok()).toBeTruthy();

  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 90_000 },
    )
    .toBe("active");

  // resposta vaga: LLM tende a "continue", motor força "limit" (turns 1 >= max_turns 1)
  await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: { Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    data: evolutionPayload(
      "5511999990002",
      "hmm, me explica melhor o que vocês fazem?",
      `E2E-LIMIT-${Date.now()}`,
    ),
  });

  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context, status")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 120_000 },
    )
    .toBe("limit");
  const { data: exec } = await admin
    .from("flow_executions")
    .select("status")
    .eq("lead_id", seed.leadId)
    .maybeSingle();
  expect(exec!.status).toBe("completed"); // saída limit → end
});
```

Nota de flakiness: a decisão `goal` depende do LLM real. Mitigada por `goal_description` explícita + regra "se o lead disser que quer agendar…" + mensagem inequívoca do lead. Se falhar, investigar o transcript em `api_calls.response` (método científico) antes de mexer em timeout.

- [ ] **Step 3: `tests/e2e/observability.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("página de observabilidade mostra gasto agregado e conversas do agente", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("e2e@eleveflow.test");
  await page.getByLabel("Senha").fill("e2e-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });

  await page.goto("/observabilidade");

  // gasto 30d > $0 (as jornadas do agent-journey rodaram antes — mode serial do runner)
  const cost = page.getByTestId("cost-30d");
  await expect(cost).toBeVisible({ timeout: 15_000 });
  await expect(cost).not.toHaveText(/\$0\.0000/);

  // feed do agente tem sessão; transcript abre com mensagens
  const session = page.getByTestId("agent-session").first();
  await expect(session).toBeVisible();
  await session.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
```

Ordem: Playwright roda os specs em ordem alfabética por arquivo dentro do mesmo worker; `agent-journey` < `observability` alfabeticamente — ordem garantida com `workers: 1` (default do config atual sem `fullyParallel`). Confirmar no `playwright.config.ts`; se `fullyParallel` estiver ativo, desativar para estes specs.

- [ ] **Step 4: Rodar e2e completo**

Run: `set -a; source .env.staging; set +a; npm run test:e2e`
Expected: 5 specs PASS (2 da fase A + 3 novos). Colar a saída como evidência.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/
git commit -m "feat: e2e da jornada do agente e da pagina de observabilidade"
```

---

### Task 16: Fechamento B+C — bateria completa, STATUS.md e gate de produção

**Files:**

- Modify: `STATUS.md`

- [ ] **Step 1: Bateria completa com evidência**

Run:

```bash
npm run test:coverage && npm run typecheck && npm run build
npm run lint
set -a; source .env.staging; set +a; npm run test:e2e
```

Expected: coverage/typecheck/build verdes; e2e 5/5. Lint: baseline legado (~5,2k) pode permanecer, mas ZERO erro novo em arquivo tocado pelas fases B/C (política da fase A — corrigir por arquivo tocado). Qualquer vermelho fora do baseline = fase não fecha; corrigir causa raiz.

- [ ] **Step 2: Atualizar STATUS.md**

Verde: motor `ai_agent` e2e no staging (goal/limit reais), `api_calls` registrando LLM+SerpAPI com custo real, página `/observabilidade`, cron versionado. Próximo: aplicar em produção (gate abaixo) e fase D (UI/UX).

- [ ] **Step 3: GATE DE PRODUÇÃO — parar e pedir aprovação explícita**

Escrever normal (ação com impacto em produção viva):

Apresentar ao usuário o checklist do que será aplicado em produção (`aoanpviozfabrrxjqayk`) e aguardar aprovação explícita antes de executar qualquer item:

1. `supabase db push` com as migrations: `20260704160000` (trigger parametrizado — fase A), `20260706160000` (api_calls/settings/sent_at), `20260706170000` (cron — conferir inventário da Task 11 antes), `20260706180000` (views).
2. `supabase secrets set OPENROUTER_API_KEY=<chave de produção>` (chave separada da de staging).
3. `supabase functions deploy` (todas, incluindo `ai-agent-reply`).
4. Smoke pós-deploy: 1 inbound real de lead de teste → conferir `api_calls` com `stage_classifier` ok.

Riscos e reversibilidade: migrations aditivas (tabela/colunas/views novas — sem alteração destrutiva); modo agente só ativa em fluxos que tenham bloco `ai_agent`; classificador/vision mudam de provider (OpenAI→OpenRouter) — comportamento funcional igual, mas exige a secret nova configurada ANTES do deploy das functions, senão classificação de etapa e vision param silenciosamente (fail-safe existente).

SEM aprovação → produção fica como está e o trabalho encerra com staging verde.

- [ ] **Step 4: Commit final**

```bash
git add STATUS.md
git commit -m "docs: fecha fases B e C com agente e observabilidade verdes no staging"
```
