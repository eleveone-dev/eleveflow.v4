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
