export interface ApiCallRecord {
  user_id: string | null;
  lead_id?: string | null;
  flow_id?: string | null;
  execution_id?: string | null;
  block_id?: string | null;
  provider: "openrouter" | "serpapi" | "meta_cloud";
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
  timeoutMs?: number;
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
    timeoutMs = 60_000,
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
        signal: AbortSignal.timeout(timeoutMs),
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
