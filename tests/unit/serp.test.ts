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
