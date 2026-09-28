# Fase A — Harness de Teste: Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infra de teste completa (Vitest com gate de cobertura ≥80%, Playwright, staging Supabase com mock de Evolution) + fim da duplicação de roteamento de blocos.

**Architecture:** Lógica pura extraída para `supabase/functions/_shared/` (TS sem APIs Deno, testável no Node via Vitest); edge functions importam por caminho relativo. E2E roda contra projeto Supabase de staging; envio WhatsApp mockado por `EVOLUTION_MOCK=true`; inbound simulado por POST direto ao webhook.

**Tech Stack:** Vitest + @vitest/coverage-v8, Playwright (chromium), Supabase CLI (link/db push/functions deploy/secrets), TanStack Start dev server.

**Spec:** `docs/specs/2026-07-04-agente-ia-e2e-observabilidade-design.md` (Fase A = §3). Módulos `agent-prompt.ts` e helpers de custo nascem nas fases B/C (TDD lá) — este plano cobre o harness e `flow-routing.ts`.

## Global Constraints

- Commits: Conventional Commits, PT-BR, atômicos, SEM Co-Authored-By ou qualquer menção a ferramenta de IA.
- Gerenciador de pacotes: **npm** (package-lock.json é a fonte; ignorar bun.lock).
- Shell: Git Bash no Windows; caminhos com `/`.
- PRODUÇÃO INTOCADA nesta fase: nenhum `db push`, `functions deploy` ou `secrets set` no projeto de produção (`aoanpviozfabrrxjqayk`). Tudo aponta para o staging.
- Cobertura: `vitest run --coverage` FALHA abaixo de 80% (lines, branches, functions, statements) no escopo incluído.
- Edge functions Deno: imports de `_shared` por caminho relativo com extensão `.ts` (padrão já usado com `cors.ts`).
- Módulos em `_shared` que serão testados no Vitest não podem ter imports por URL nem APIs Deno.
- UI nova/alterada nesta fase: nenhuma.

---

### Task 1: Baseline do repositório

**Files:**

- Modify: `STATUS.md`

**Interfaces:**

- Produces: baseline registrado (lint/build/typecheck rodados, estado conhecido) — tasks seguintes assumem `node_modules` instalado.

- [ ] **Step 1: Instalar dependências**

Run: `cd "C:/Users/User/Desktop/eleve.flow2" && npm install`
Expected: conclui sem erro fatal (warnings ok). `node_modules/` criado.

- [ ] **Step 2: Rodar lint e build, registrar saída**

Run: `npm run lint; npm run build`
Expected: registrar resultado real (verde ou lista de erros). NÃO corrigir nada nesta task — só evidência.

- [ ] **Step 3: Rodar typecheck avulso e registrar**

Run: `npx tsc --noEmit`
Expected: registrar contagem de erros (codebase Lovable pode ter vários). Zero correções agora; meta de typecheck verde é critério de fim de fase do spec (§8), tratada quando os arquivos forem tocados.

- [ ] **Step 4: Atualizar STATUS.md com o baseline**

Adicionar em `## Verificado` o resultado real dos três comandos (com números). Atualizar `## Próximos passos` (fase A em andamento).

- [ ] **Step 5: Commit**

```bash
git add STATUS.md package-lock.json
git commit -m "chore: registra baseline de lint, build e typecheck"
```

---

### Task 2: Vitest + extração de `_shared/flow-routing.ts` (TDD)

**Files:**

- Create: `supabase/functions/_shared/flow-routing.ts`
- Create: `tests/unit/flow-routing.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts + devDependencies)

**Interfaces:**

- Produces (Task 3 e fase B dependem):
  - `interface FlowBlock { id: string; type: string; position?: number | null; next_block_id?: string | null; config?: Record<string, unknown> | null }`
  - `interface FlowEdge { id?: string; source?: string; target?: string; sourceHandle?: string | null }`
  - `interface RouteResult { nextId: string | null; edgeId: string | null; via: string }`
  - `findNextBlockId(currentBlock: FlowBlock, edges: FlowEdge[], output?: string): RouteResult`
  - `findFallbackBlockId(currentBlock: FlowBlock, blocks: FlowBlock[]): string | null`
  - `resolveExistingNextBlockId(currentBlock: FlowBlock, blocks: FlowBlock[], edges: FlowEdge[], output?: string): RouteResult`
  - `HANDLE_ALIASES: Record<string, string[]>` — `true`/`false` hoje; fase B adiciona `goal`/`giveup`/`limit` sem mudar assinatura (output é string genérica: handle custom casa por igualdade).

- [ ] **Step 1: Instalar Vitest e coverage**

Run: `npm install -D vitest @vitest/coverage-v8`
Expected: adicionados a devDependencies.

- [ ] **Step 2: Criar `vitest.config.ts`**

Arquivo separado do `vite.config.ts` (o wrapper Lovable não deve ser tocado):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["supabase/functions/_shared/flow-routing.ts"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
```

Regra: todo módulo novo testável criado nas fases B/C entra em `coverage.include` na task que o cria.

- [ ] **Step 3: Adicionar scripts ao `package.json`**

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 4: Escrever os testes (falhando)**

`tests/unit/flow-routing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  findNextBlockId,
  findFallbackBlockId,
  resolveExistingNextBlockId,
  type FlowBlock,
  type FlowEdge,
} from "../../supabase/functions/_shared/flow-routing";

const b = (id: string, type = "message", extra: Partial<FlowBlock> = {}): FlowBlock => ({
  id,
  type,
  ...extra,
});

describe("findNextBlockId", () => {
  it("segue edge com handle default/null", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "a", target: "b", sourceHandle: null }];
    const r = findNextBlockId(b("a"), edges);
    expect(r).toEqual({ nextId: "b", edgeId: "e1", via: "edges" });
  });

  it("condition true casa aliases de handle (sim/yes/a)", () => {
    const edges: FlowEdge[] = [
      { id: "e-no", source: "c", target: "x", sourceHandle: "nao" },
      { id: "e-yes", source: "c", target: "y", sourceHandle: "SIM" },
    ];
    const r = findNextBlockId(b("c", "condition"), edges, "true");
    expect(r.nextId).toBe("y");
    expect(r.via).toBe("edges(handle=true)");
  });

  it("condition false casa aliases (não/no/b)", () => {
    const edges: FlowEdge[] = [{ id: "e2", source: "c", target: "x", sourceHandle: "não" }];
    const r = findNextBlockId(b("c", "condition"), edges, "false");
    expect(r.nextId).toBe("x");
  });

  it("condition sem edge do handle usa config.next_if_true/false", () => {
    const block = b("c", "condition", { config: { next_if_false: "z" } });
    const r = findNextBlockId(block, [], "false");
    expect(r).toEqual({ nextId: "z", edgeId: null, via: "config.next_if_false" });
  });

  it("handle custom (fase B: goal/giveup/limit) casa por igualdade", () => {
    const edges: FlowEdge[] = [{ id: "e3", source: "ai", target: "g", sourceHandle: "goal" }];
    const r = findNextBlockId(b("ai", "ai_agent"), edges, "goal");
    expect(r.nextId).toBe("g");
  });

  it("sem edges cai no next_block_id legado", () => {
    const r = findNextBlockId(b("a", "message", { next_block_id: "n" }), []);
    expect(r).toEqual({ nextId: "n", edgeId: null, via: "next_block_id" });
  });

  it("sem nada retorna null", () => {
    expect(findNextBlockId(b("a"), []).nextId).toBeNull();
  });
});

describe("findFallbackBlockId", () => {
  it("usa next_block_id quando o alvo existe", () => {
    const blocks = [
      b("a", "trigger", { next_block_id: "b", position: 0 }),
      b("b", "message", { position: 1 }),
    ];
    expect(findFallbackBlockId(blocks[0], blocks)).toBe("b");
  });

  it("cai para o próximo por position quando next_block_id não existe", () => {
    const blocks = [
      b("a", "trigger", { next_block_id: "morto", position: 0 }),
      b("c", "message", { position: 5 }),
      b("b", "message", { position: 2 }),
    ];
    expect(findFallbackBlockId(blocks[0], blocks)).toBe("b");
  });

  it("retorna null sem candidatos", () => {
    expect(
      findFallbackBlockId(b("a", "end", { position: 9 }), [b("a", "end", { position: 9 })]),
    ).toBeNull();
  });
});

describe("resolveExistingNextBlockId", () => {
  const blocks = [
    b("t", "trigger", { position: 0 }),
    b("m1", "message", { position: 1 }),
    b("m2", "message", { position: 2 }),
    b("c", "condition", { position: 3 }),
  ];

  it("retorna alvo quando existe na lista de blocks", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "m1", target: "m2" }];
    expect(resolveExistingNextBlockId(blocks[1], blocks, edges).nextId).toBe("m2");
  });

  it("edge para bloco removido: usa outra edge válida (não-condition)", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "m1", target: "fantasma" },
      { id: "e2", source: "m1", target: "m2", sourceHandle: "out" },
    ];
    const r = resolveExistingNextBlockId(blocks[1], blocks, edges);
    expect(r.nextId).toBe("m2");
    expect(r.via).toBe("edges_valid_fallback");
  });

  it("condition com alvo removido cai no fallback por posição", () => {
    const cond = b("c", "condition", { position: 1 });
    const all = [cond, b("m2", "message", { position: 2 })];
    const edges: FlowEdge[] = [{ id: "e1", source: "c", target: "fantasma", sourceHandle: "sim" }];
    const r = resolveExistingNextBlockId(cond, all, edges, "true");
    expect(r.nextId).toBe("m2");
    expect(r.via).toContain("fallback_position");
  });

  it("message sem alvo válido retorna null (não inventa caminho)", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "m2", target: "fantasma" }];
    const r = resolveExistingNextBlockId(blocks[2], blocks, edges);
    expect(r.nextId).toBeNull();
  });
});
```

- [ ] **Step 5: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../supabase/functions/_shared/flow-routing'`.

- [ ] **Step 6: Implementar `supabase/functions/_shared/flow-routing.ts`**

Unificação fiel da versão mais rica (a do `whatsapp-webhook`), com handle genérico:

```ts
export interface FlowBlock {
  id: string;
  type: string;
  position?: number | null;
  next_block_id?: string | null;
  config?: Record<string, unknown> | null;
}

export interface FlowEdge {
  id?: string;
  source?: string;
  target?: string;
  sourceHandle?: string | null;
}

export interface RouteResult {
  nextId: string | null;
  edgeId: string | null;
  via: string;
}

export const HANDLE_ALIASES: Record<string, string[]> = {
  true: ["true", "sim", "yes", "positive", "a"],
  false: ["false", "nao", "não", "no", "negative", "b"],
};

const isDefaultHandle = (h: unknown) =>
  h == null || h === "default" || h === "source" || h === "out";

export function findNextBlockId(
  currentBlock: FlowBlock,
  edges: FlowEdge[],
  output?: string,
): RouteResult {
  const currentId = currentBlock?.id;
  if (!currentId) return { nextId: null, edgeId: null, via: "no_current" };

  const outgoing = (edges || []).filter((e) => e?.source === currentId);

  if (output) {
    const wanted = HANDLE_ALIASES[output] ?? [output.toLowerCase()];
    const match = outgoing.find((e) =>
      wanted.includes(String(e?.sourceHandle ?? "").toLowerCase()),
    );
    if (match) {
      return {
        nextId: match.target ?? null,
        edgeId: match.id ?? null,
        via: `edges(handle=${output})`,
      };
    }
    const cfg = (currentBlock.config ?? {}) as Record<string, unknown>;
    const cfgNext =
      output === "true"
        ? cfg.next_if_true || cfg.sim || cfg.yes || cfg.positive
        : output === "false"
          ? cfg.next_if_false || cfg.nao || cfg.no || cfg.negative
          : cfg[`next_if_${output}`];
    if (cfgNext) return { nextId: String(cfgNext), edgeId: null, via: `config.next_if_${output}` };
    return { nextId: null, edgeId: null, via: "no_match" };
  }

  if (outgoing.length > 0) {
    const def = outgoing.find((e) => isDefaultHandle(e?.sourceHandle)) || outgoing[0];
    return { nextId: def.target ?? null, edgeId: def.id ?? null, via: "edges" };
  }

  if (currentBlock.next_block_id) {
    return { nextId: currentBlock.next_block_id, edgeId: null, via: "next_block_id" };
  }
  return { nextId: null, edgeId: null, via: "no_edges" };
}

export function findFallbackBlockId(currentBlock: FlowBlock, blocks: FlowBlock[]): string | null {
  if (!currentBlock) return null;
  if (currentBlock.next_block_id && blocks.some((b) => b.id === currentBlock.next_block_id)) {
    return currentBlock.next_block_id;
  }
  const pos = Number(currentBlock.position ?? -1);
  return (
    (blocks || [])
      .filter((b) => b.id !== currentBlock.id && Number(b.position ?? -1) > pos)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))[0]?.id || null
  );
}

export function resolveExistingNextBlockId(
  currentBlock: FlowBlock,
  blocks: FlowBlock[],
  edges: FlowEdge[],
  output?: string,
): RouteResult {
  const resolved = findNextBlockId(currentBlock, edges, output);
  if (resolved.nextId && blocks.some((b) => b.id === resolved.nextId)) return resolved;

  const currentId = currentBlock?.id;
  const outgoing = (edges || []).filter(
    (e) => e?.source === currentId && blocks.some((b) => b.id === e?.target),
  );
  if (outgoing.length > 0 && currentBlock?.type !== "condition") {
    const valid = outgoing.find((e) => isDefaultHandle(e?.sourceHandle)) || outgoing[0];
    return { nextId: valid.target ?? null, edgeId: valid.id ?? null, via: "edges_valid_fallback" };
  }
  if (currentBlock?.type !== "condition" && currentBlock?.type !== "trigger") {
    return { nextId: null, edgeId: resolved.edgeId, via: `${resolved.via}_missing_target` };
  }
  const fallback = findFallbackBlockId(currentBlock, blocks);
  if (fallback) {
    return { nextId: fallback, edgeId: resolved.edgeId, via: `${resolved.via}_fallback_position` };
  }
  return resolved;
}
```

Diferenças deliberadas vs original (documentadas aqui, cobertas por teste):

- `findFallbackBlockId` ganha guarda explícita `b.id !== currentBlock.id` (defensiva; comportamento original já excluía por `> pos`, a guarda protege contra dados de posição inconsistentes).
- Handle de condition genérico (`output: string`) — prepara `goal`/`giveup`/`limit` da fase B sem mudança de assinatura.

- [ ] **Step 7: Rodar e ver passar, com cobertura**

Run: `npm run test:coverage`
Expected: todos os testes PASS; cobertura de `flow-routing.ts` ≥ 80% em todas as métricas (gate ativo — se cair abaixo, o comando falha).

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts package.json package-lock.json tests/ supabase/functions/_shared/flow-routing.ts
git commit -m "feat: extrai roteamento de blocos para módulo compartilhado testado"
```

---

### Task 3: Motores passam a importar `flow-routing` (fim da duplicação)

**Files:**

- Modify: `supabase/functions/execute-flow/index.ts:6-73` (remover funções locais) e call sites `:284`, `:448-452`
- Modify: `supabase/functions/whatsapp-webhook/index.ts:73-148` (remover funções locais)

**Interfaces:**

- Consumes: `resolveExistingNextBlockId`, `findFallbackBlockId` de `../_shared/flow-routing.ts` (Task 2).

- [ ] **Step 1: `whatsapp-webhook` importa o módulo**

Remover as declarações locais de `findNextBlockId`, `findFallbackBlockId`, `resolveExistingNextBlockId` (linhas 73-148) e adicionar no topo:

```ts
import { resolveExistingNextBlockId } from "../_shared/flow-routing.ts";
```

Call sites do webhook já usam o retorno-objeto (`resolved.nextId`) — sem mais mudanças.

- [ ] **Step 2: `execute-flow` importa o módulo e adapta retorno**

Remover `findNextBlockId`, `findFallbackBlockId`, `resolveExistingNextBlockId` locais (linhas 6-36 e 59-73; manter `getNextValidQueueTime`). Adicionar:

```ts
import { resolveExistingNextBlockId, findFallbackBlockId } from "../_shared/flow-routing.ts";
```

Adaptar call sites (retorno era string, agora é `RouteResult`):

Linha ~284:

```ts
let nextBlockId = resolveExistingNextBlockId(block, blocks, edges).nextId;
```

Linhas ~447-449 (case condition):

```ts
const handle = conditionMet ? "true" : "false";
nextBlockId =
  resolveExistingNextBlockId(block, blocks, edges, handle).nextId ||
  (conditionMet ? config.next_if_true : config.next_if_false);
```

`findFallbackBlockId` (linha ~452) permanece com a mesma assinatura.

- [ ] **Step 3: Unit tests continuam verdes**

Run: `npm test`
Expected: PASS (mesma suite — o módulo compartilhado é a única fonte agora).

- [ ] **Step 4: Checagem Deno (se disponível)**

Run: `deno check supabase/functions/execute-flow/index.ts supabase/functions/whatsapp-webhook/index.ts 2>/dev/null || echo "deno ausente — validação ocorre no deploy da Task 6"`
Expected: sem erros de tipo, OU mensagem de fallback (o `functions deploy` da Task 6 compila e valida).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/execute-flow/index.ts supabase/functions/whatsapp-webhook/index.ts
git commit -m "refactor: motores usam roteamento compartilhado de flow-routing"
```

---

### Task 4: Migration — trigger de estágio parametrizado

**Files:**

- Create: `supabase/migrations/20260704160000_parametriza_trigger_stage.sql`

**Interfaces:**

- Produces: chaves `edge_functions_base_url` e `edge_functions_anon_key` em `global_settings`; função `auto_trigger_flow_on_stage` sem hardcode. Task 6 preenche os valores no staging.

- [ ] **Step 1: Escrever a migration**

```sql
-- Parametriza o trigger de estágio: URL e anon key saem do hardcode
-- e passam a viver em global_settings (por ambiente).
INSERT INTO public.global_settings (key, value)
VALUES
  ('edge_functions_base_url', 'https://aoanpviozfabrrxjqayk.supabase.co'),
  ('edge_functions_anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvYW5wdmlvemZhYnJyeGpxYXlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDc1NjEsImV4cCI6MjA5NjM4MzU2MX0.DQcuI3CUWbIWVn96WflG0ApB4BiI9l92Ir7TuIrJZ-8')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.auto_trigger_flow_on_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_flow_exists boolean;
  v_base_url text;
  v_anon_key text;
BEGIN
  IF NEW.stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.flows
    WHERE user_id = NEW.user_id
      AND trigger_stage_id = NEW.stage_id
      AND is_active = true
  ) INTO v_flow_exists;

  IF NOT v_flow_exists THEN
    RETURN NEW;
  END IF;

  SELECT value INTO v_base_url FROM public.global_settings WHERE key = 'edge_functions_base_url';
  SELECT value INTO v_anon_key FROM public.global_settings WHERE key = 'edge_functions_anon_key';

  -- Fail-safe: sem configuração, não dispara (em vez de chamar URL errada)
  IF v_base_url IS NULL OR v_anon_key IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_base_url || '/functions/v1/trigger-flow-by-stage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_anon_key,
      'Authorization', 'Bearer ' || v_anon_key
    ),
    body := jsonb_build_object(
      'lead_id', NEW.id,
      'user_id', NEW.user_id,
      'new_stage_id', NEW.stage_id
    )
  );

  RETURN NEW;
END;
$function$;
```

Os valores default do INSERT são os de produção (anon key é pública por design e já consta em migration anterior) — produção mantém comportamento idêntico quando a migration for aplicada lá (fase B). Staging sobrescreve com os próprios valores (Task 6).

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260704160000_parametriza_trigger_stage.sql
git commit -m "fix: parametriza URL e chave do trigger de estagio via global_settings"
```

---

### Task 5: `EVOLUTION_MOCK` — helper compartilhado de envio (TDD)

**Files:**

- Create: `supabase/functions/_shared/evolution.ts`
- Create: `tests/unit/evolution.test.ts`
- Modify: `supabase/functions/process-queue/index.ts:358-387` (bloco de envio usa o helper)
- Modify: `vitest.config.ts` (coverage.include ganha o novo módulo)

**Interfaces:**

- Produces:
  - `interface SendTextParams { apiUrl: string; apiKey: string; instance: string; number: string; text: string; mock?: boolean; fetchFn?: typeof fetch }`
  - `interface SendTextResult { ok: boolean; status: number; data: Record<string, unknown> }`
  - `sendWhatsAppText(params: SendTextParams): Promise<SendTextResult>` — com `mock: true` NÃO faz rede e devolve `{ ok: true, status: 200, data: { mocked: true, key: { id: "mock-<timestamp>" } } }`.
- Desvio de spec documentado: §3.2 cita também `whatsapp-proxy`; o e2e da fase A não exercita o proxy e o staging não tem Evolution configurada (proxy real falharia inofensivamente). O proxy migra para este helper quando for tocado (fase B/D). Registrado aqui para rastreabilidade.

- [ ] **Step 1: Teste falhando**

`tests/unit/evolution.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { sendWhatsAppText } from "../../supabase/functions/_shared/evolution";

describe("sendWhatsAppText", () => {
  it("mock: não chama rede e devolve sucesso simulado", async () => {
    const fetchFn = vi.fn();
    const r = await sendWhatsAppText({
      apiUrl: "https://evo.example",
      apiKey: "k",
      instance: "inst",
      number: "5511999999999",
      text: "olá",
      mock: true,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.data.mocked).toBe(true);
    expect(String((r.data.key as { id: string }).id)).toMatch(/^mock-/);
  });

  it("real: POST em /message/sendText/<instance> com header apikey", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ key: { id: "abc" } }), { status: 200 }));
    const r = await sendWhatsAppText({
      apiUrl: "https://evo.example",
      apiKey: "k",
      instance: "inst",
      number: "5511999999999",
      text: "olá",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://evo.example/message/sendText/inst",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "k" }),
      }),
    );
    expect(r.ok).toBe(true);
    expect((r.data.key as { id: string }).id).toBe("abc");
  });

  it("resposta não-JSON vira { raw }", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const r = await sendWhatsAppText({
      apiUrl: "https://evo.example",
      apiKey: "k",
      instance: "inst",
      number: "1",
      text: "x",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.data.raw).toBe("boom");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — módulo `evolution` inexistente.

- [ ] **Step 3: Implementar `supabase/functions/_shared/evolution.ts`**

```ts
export interface SendTextParams {
  apiUrl: string;
  apiKey: string;
  instance: string;
  number: string;
  text: string;
  mock?: boolean;
  fetchFn?: typeof fetch;
}

export interface SendTextResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

export async function sendWhatsAppText(params: SendTextParams): Promise<SendTextResult> {
  const { apiUrl, apiKey, instance, number, text, mock, fetchFn = fetch } = params;

  if (mock) {
    console.log("[EVOLUTION MOCK] envio simulado", { instance, number, chars: text.length });
    return {
      ok: true,
      status: 200,
      data: { mocked: true, key: { id: `mock-${Date.now()}` } },
    };
  }

  const endpoint = `${apiUrl.replace(/\/+$/, "")}/message/sendText/${instance}`;
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ number, text }),
  });
  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  return { ok: res.ok, status: res.status, data };
}
```

- [ ] **Step 4: Incluir no gate de cobertura**

`vitest.config.ts` → `coverage.include`:

```ts
include: [
  "supabase/functions/_shared/flow-routing.ts",
  "supabase/functions/_shared/evolution.ts",
],
```

Run: `npm run test:coverage`
Expected: PASS, ambos módulos ≥ 80%.

- [ ] **Step 5: `process-queue` usa o helper**

Em `supabase/functions/process-queue/index.ts`, adicionar import no topo:

```ts
import { sendWhatsAppText } from "../_shared/evolution.ts";
```

Substituir o bloco de envio (do `const evolutionPayload = {` na linha ~358 até o fechamento do parse em ~387) por:

```ts
step = "evolution_request";
const isMock = Deno.env.get("EVOLUTION_MOCK") === "true";
console.log("[PROCESS_QUEUE] Chamando Evolution:", { instanceName, phone, mock: isMock });

const sendResult = await sendWhatsAppText({
  apiUrl: EVOLUTION_API_URL,
  apiKey: EVOLUTION_API_KEY,
  instance: instanceName,
  number: phone,
  text: message,
  mock: isMock,
});
const sendData: any = sendResult.data;
```

Ajustar as referências seguintes no mesmo arquivo: `sendRes.ok` → `sendResult.ok`; `sendRes.status` → `sendResult.status` (ocorrências nas linhas ~389, ~452, ~470). `sendData` permanece com o mesmo nome.

Atenção: com `EVOLUTION_MOCK=true`, a validação de `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` (linha ~146) não pode derrubar a função — mudar a condição para:

```ts
if ((!EVOLUTION_API_URL || !EVOLUTION_API_KEY) && Deno.env.get('EVOLUTION_MOCK') !== 'true') {
```

- [ ] **Step 6: Unit verde + commit**

Run: `npm run test:coverage`
Expected: PASS.

```bash
git add supabase/functions/_shared/evolution.ts tests/unit/evolution.test.ts supabase/functions/process-queue/index.ts vitest.config.ts
git commit -m "feat: envio Evolution via helper compartilhado com modo mock"
```

---

### Task 6: Staging Supabase no ar

**Files:**

- Create: `scripts/seed-staging.mjs`
- Create: `docs/staging.md`

**Interfaces:**

- Consumes: migrations (inclui Task 4).
- Produces: projeto staging linkado, migrations aplicadas, functions deployadas, secrets setados, usuário de teste `e2e@eleveflow.test` / senha `e2e-password-123`, um lead seed com telefone `5511999990000`. Credenciais e URLs ficam em `.env.staging` (gitignored). Task 7 consome tudo.

- [ ] **Step 1 (AÇÃO DO USUÁRIO): autenticar CLI e criar projeto**

O usuário roda no prompt (interativo): `! npx supabase login`
Depois cria o projeto staging no dashboard (nome `eleve-flow-staging`, senha de banco anotada) OU autoriza criar via CLI. Registrar o `project-ref` do staging.

- [ ] **Step 2: Linkar e aplicar migrations**

Run:

```bash
npx supabase link --project-ref <REF_STAGING>
npx supabase db push
```

Expected: todas as migrations aplicadas sem erro (inclusive a da Task 4).

- [ ] **Step 3: Apontar `global_settings` do staging para o staging**

Run: `npx supabase db execute --sql "UPDATE public.global_settings SET value='https://<REF_STAGING>.supabase.co' WHERE key='edge_functions_base_url'; UPDATE public.global_settings SET value='<ANON_KEY_STAGING>' WHERE key='edge_functions_anon_key';"`
Expected: 2 updates. (Se o subcomando `db execute` não existir na versão do CLI, rodar o SQL no SQL Editor do dashboard.)

- [ ] **Step 4: Secrets e deploy das functions**

Run:

```bash
npx supabase secrets set EVOLUTION_MOCK=true
npx supabase functions deploy
```

Expected: deploy de todas as functions sem erro de compilação (isto valida os imports das Tasks 3 e 5 no runtime Deno real).

- [ ] **Step 5: Seed de dados de teste**

`scripts/seed-staging.mjs` (roda com `node`, usa service role do staging via env):

```js
// Uso: SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/seed-staging.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(url, key);

const EMAIL = "e2e@eleveflow.test";
const PASSWORD = "e2e-password-123";

const { data: existing } = await admin.auth.admin.listUsers();
let user = existing?.users?.find((u) => u.email === EMAIL);
if (!user) {
  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  user = data.user;
  console.log("Usuário e2e criado:", user.id);
} else {
  console.log("Usuário e2e já existe:", user.id);
}

await admin
  .from("accounts")
  .upsert({ user_id: user.id, onboarding_completed: true }, { onConflict: "user_id" });

const { data: stage } = await admin
  .from("pipeline_stages")
  .upsert({ user_id: user.id, name: "Novo", position: 0 }, { onConflict: "id" })
  .select()
  .maybeSingle();

const { data: lead, error: leadErr } = await admin
  .from("leads")
  .upsert(
    {
      user_id: user.id,
      name: "Lead E2E",
      phone: "5511999990000",
      stage_id: stage?.id ?? null,
    },
    { onConflict: "id" },
  )
  .select()
  .single();
if (leadErr) throw leadErr;
console.log("Lead seed:", lead.id);
console.log("Seed concluído.");
```

Nota: se o schema real de `accounts`/`pipeline_stages` rejeitar alguma coluna (conferir na primeira execução contra o staging), ajustar o script ao schema — nunca o contrário.

Run: `SUPABASE_URL=https://<REF_STAGING>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/seed-staging.mjs`
Expected: `Seed concluído.`

- [ ] **Step 6: Smoke do webhook no staging**

Run:

```bash
curl -s -X POST "https://<REF_STAGING>.supabase.co/functions/v1/whatsapp-webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ANON_KEY_STAGING>" \
  -d '{"event":"messages.upsert","instance":"e2e","data":{"key":{"remoteJid":"5511999990000@s.whatsapp.net","fromMe":false,"id":"SMOKE-1"},"message":{"conversation":"olá, tenho interesse"}}}'
```

Expected: HTTP 200 com `"success":true` (lead encontrado; sem execução ativa → `"ignored":true,"reason":"Nenhuma execução aguardando resposta..."` é o resultado correto neste estado).

- [ ] **Step 7: Documentar em `docs/staging.md`**

Conteúdo: project-ref, como rodar seed, como setar secrets, o que `EVOLUTION_MOCK` faz, aviso "nunca rodar db push/deploy na produção durante a fase A" e o comando de smoke acima. Sem chaves no arquivo — referência a `.env.staging`.

- [ ] **Step 8: Commit**

```bash
git add scripts/seed-staging.mjs docs/staging.md
git commit -m "feat: seed e documentacao do ambiente de staging"
```

---

### Task 7: Playwright — jornadas de login e inbound

**Files:**

- Create: `playwright.config.ts`
- Create: `tests/e2e/login.spec.ts`
- Create: `tests/e2e/inbound-webhook.spec.ts`
- Create: `.env.staging.example`
- Modify: `package.json` (script `test:e2e`)

**Interfaces:**

- Consumes: usuário/lead seed da Task 6; `.env.staging` local com `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (valores do staging) e `STAGING_SERVICE_ROLE_KEY` (para asserções de banco no teste).
- Produces: `npm run test:e2e` verde — base para a jornada completa do agente na fase B.

- [ ] **Step 1: Instalar Playwright**

Run: `npm install -D @playwright/test && npx playwright install chromium`
Expected: chromium baixado.

- [ ] **Step 2: `.env.staging.example` commitável**

```bash
# Copie para .env.staging e preencha com os valores do PROJETO DE STAGING
VITE_SUPABASE_URL=https://SEU-REF-STAGING.supabase.co
VITE_SUPABASE_ANON_KEY=
# usada apenas pelos testes e2e para asserções de banco — NUNCA a de produção
STAGING_SERVICE_ROLE_KEY=
```

(`.env.*` já está no .gitignore; só o `.example` entra no repo.)

- [ ] **Step 3: Descobrir a porta real do dev server**

Run: `npm run dev -- --mode staging` (encerrar com Ctrl+C após ver o banner)
Expected: anotar a URL local impressa (`http://localhost:<PORTA>`). O wrapper Lovable pode fixar porta própria; usar a porta REAL observada no passo seguinte. Confirmar no banner que o modo carregou `.env.staging` (a URL do Supabase aparece nos logs de rede da app, não no banner — validação efetiva é o login e2e passar contra o staging).

- [ ] **Step 4: `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 5173); // ajustar para a porta real do Step 3

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --mode staging",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

Script no `package.json`:

```json
"test:e2e": "playwright test"
```

- [ ] **Step 5: Teste de login**

`tests/e2e/login.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("login com usuário e2e chega ao app autenticado", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "EleveFlow" })).toBeVisible();

  await page.getByLabel("Email").fill("e2e@eleveflow.test");
  await page.getByLabel("Senha").fill("e2e-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();

  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });
  expect(page.url()).toMatch(/\/(dashboard|onboarding)/);
});
```

- [ ] **Step 6: Teste de inbound (webhook → banco)**

`tests/e2e/inbound-webhook.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.STAGING_SERVICE_ROLE_KEY!;

test("mensagem inbound simulada é registrada no banco", async ({ request }) => {
  const whatsappId = `E2E-${Date.now()}`;

  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: { Authorization: `Bearer ${ANON_KEY}` },
    data: {
      event: "messages.upsert",
      instance: "e2e",
      data: {
        key: {
          remoteJid: "5511999990000@s.whatsapp.net",
          fromMe: false,
          id: whatsappId,
        },
        message: { conversation: "olá, quero saber mais" },
      },
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: msg } = await admin
    .from("messages")
    .select("id, direction, content")
    .eq("whatsapp_id", whatsappId)
    .maybeSingle();

  expect(msg).not.toBeNull();
  expect(msg!.direction).toBe("inbound");
  expect(msg!.content).toBe("olá, quero saber mais");
});
```

Carregamento das envs: rodar com as variáveis de `.env.staging` exportadas no shell (Git Bash):

```bash
set -a; source .env.staging; set +a; npm run test:e2e
```

- [ ] **Step 7: Rodar e2e completo e ver passar**

Run: `set -a; source .env.staging; set +a; npm run test:e2e`
Expected: 2 specs PASS. Se o login cair em `/onboarding`, o seed de `accounts.onboarding_completed` (Task 6) precisa ser conferido — corrigir o seed, não o teste.

- [ ] **Step 8: Commit**

```bash
git add playwright.config.ts tests/e2e/ .env.staging.example package.json package-lock.json
git commit -m "feat: e2e de login e inbound contra staging com Playwright"
```

---

### Task 8: Fechamento da fase A

**Files:**

- Modify: `STATUS.md`

- [ ] **Step 1: Rodar a bateria completa e colar evidências**

Run:

```bash
npm run test:coverage && npm run lint && npm run build
set -a; source .env.staging; set +a; npm run test:e2e
```

Expected: tudo verde (coverage gate ≥80% incluso). Qualquer vermelho = fase não fecha; corrigir causa raiz antes.

- [ ] **Step 2: Atualizar STATUS.md**

Verde: harness (unit+coverage gate, e2e login/inbound, staging, mock Evolution, flow-routing unificado). Próximo: escrever plano fases B+C (motor do agente + observabilidade). Notas: produção ainda sem as migrations novas (aplicar na fase B); typecheck baseline registrado na Task 1.

- [ ] **Step 3: Commit**

```bash
git add STATUS.md
git commit -m "docs: fecha fase A com harness verde"
```
