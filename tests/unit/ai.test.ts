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

  it("retry 1x em erro de rede e sucesso na segunda", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
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

  it("erro de rede nas duas tentativas registra erro sem custo", async () => {
    const rows: ApiCallRecord[] = [];
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const r = await callLLM({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "oi" }],
      feature: "agent_reply",
      record: async (row) => void rows.push(row),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("ECONNRESET");
    expect(rows).toHaveLength(1);
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

  it("passa AbortSignal de timeout ao fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse(openrouterOk));
    await callLLM({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "oi" }],
      feature: "agent_reply",
      record: async () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const [, init] = fetchFn.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
