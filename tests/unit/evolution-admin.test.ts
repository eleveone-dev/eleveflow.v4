import { describe, it, expect, vi } from "vitest";
import {
  connectInstance,
  deleteInstance,
  instanceStatus,
  logoutInstance,
  setInstanceWebhook,
} from "../../supabase/functions/_shared/whatsapp/evolution-admin";

const CFG = { apiUrl: "https://evo.example", apiKey: "chave-global", instance: "conta-a" };
const SECRET = "s".repeat(32);

const resposta = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const urlsChamadas = (fetchFn: any) => fetchFn.mock.calls.map((c: any[]) => c[0]);
const corpoDe = (fetchFn: any, i: number) => JSON.parse(fetchFn.mock.calls[i][1].body);

describe("instanceStatus", () => {
  it("state open vira connected", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({ instance: { state: "open" } }));
    const r = await instanceStatus({ ...CFG, fetchFn: fetchFn as any });
    expect(urlsChamadas(fetchFn)[0]).toBe("https://evo.example/instance/connectionState/conta-a");
    expect(r).toEqual({ exists: true, connected: true, state: "open" });
  });

  it("404 significa instancia inexistente, nao erro", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({ message: "not found" }, 404));
    expect(await instanceStatus({ ...CFG, fetchFn: fetchFn as any })).toEqual({
      exists: false,
      connected: false,
      state: null,
    });
  });

  it("state connecting nao e conectado", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({ instance: { state: "connecting" } }));
    const r = await instanceStatus({ ...CFG, fetchFn: fetchFn as any });
    expect(r).toEqual({ exists: true, connected: false, state: "connecting" });
  });
});

describe("setInstanceWebhook", () => {
  it("registra com o header privado e para no primeiro formato aceito", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({ webhook: { enabled: true } }));
    const r = await setInstanceWebhook({
      ...CFG,
      webhookUrl: "https://projeto.supabase.co/functions/v1/whatsapp-webhook",
      webhookSecret: SECRET,
      fetchFn: fetchFn as any,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(urlsChamadas(fetchFn)[0]).toBe("https://evo.example/webhook/set/conta-a");
    expect(corpoDe(fetchFn, 0).headers).toEqual({ "x-eleveflow-webhook-secret": SECRET });
    expect(r.ok).toBe(true);
    expect(r.shape).toBe("current");
  });

  it("cai para os formatos legados quando o primeiro e recusado", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(resposta({ message: "bad request" }, 400))
      .mockResolvedValueOnce(resposta({ webhook: { enabled: true } }));

    const r = await setInstanceWebhook({
      ...CFG,
      webhookUrl: "https://x/y",
      webhookSecret: SECRET,
      fetchFn: fetchFn as any,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    expect(r.shape).toBe("legacy_nested");
    // Todos os formatos carregam o header, senao o inbound chega sem prova.
    expect(corpoDe(fetchFn, 1).webhook.headers).toEqual({ "x-eleveflow-webhook-secret": SECRET });
  });

  it("todos os formatos recusados devolve ok falso com o ultimo erro", async () => {
    // mockImplementation, nao mockResolvedValue: corpo de Response so se le uma
    // vez, e esta chamada acontece tres vezes.
    const fetchFn = vi.fn().mockImplementation(() => resposta({ message: "nope" }, 400));
    const r = await setInstanceWebhook({
      ...CFG,
      webhookUrl: "https://x/y",
      webhookSecret: SECRET,
      fetchFn: fetchFn as any,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(r.ok).toBe(false);
  });

  it("sem segredo nao registra: webhook sem header nasce sem verificacao", async () => {
    const fetchFn = vi.fn();
    const r = await setInstanceWebhook({
      ...CFG,
      webhookUrl: "https://x/y",
      webhookSecret: "",
      fetchFn: fetchFn as any,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_secret_configured");
  });
});

describe("connectInstance", () => {
  it("instancia inexistente e criada antes de pedir o QR", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(resposta({ message: "not found" }, 404)) // status
      .mockResolvedValueOnce(resposta({ instance: { instanceName: "conta-a" } })) // create
      .mockResolvedValueOnce(resposta({ webhook: { enabled: true } })) // webhook
      .mockResolvedValueOnce(resposta({ base64: "data:image/png;base64,AAA" })); // connect

    const r = await connectInstance({
      ...CFG,
      webhookUrl: "https://x/y",
      webhookSecret: SECRET,
      fetchFn: fetchFn as any,
    });

    const urls = urlsChamadas(fetchFn);
    expect(urls[1]).toBe("https://evo.example/instance/create");
    expect(corpoDe(fetchFn, 1)).toMatchObject({
      instanceName: "conta-a",
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    });
    expect(urls[3]).toBe("https://evo.example/instance/connect/conta-a");
    expect(r.qrcode).toBe("data:image/png;base64,AAA");
    expect(r.connected).toBe(false);
  });

  it("instancia ja conectada nao recria nem devolve QR", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(resposta({ instance: { state: "open" } })) // status
      .mockResolvedValueOnce(resposta({ webhook: { enabled: true } })); // webhook

    const r = await connectInstance({
      ...CFG,
      webhookUrl: "https://x/y",
      webhookSecret: SECRET,
      fetchFn: fetchFn as any,
    });

    expect(urlsChamadas(fetchFn)).not.toContain("https://evo.example/instance/create");
    expect(r.connected).toBe(true);
    expect(r.qrcode).toBeNull();
  });

  it("instancia existente mas desconectada pede QR sem recriar", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(resposta({ instance: { state: "close" } })) // status
      .mockResolvedValueOnce(resposta({ webhook: { enabled: true } })) // webhook
      .mockResolvedValueOnce(resposta({ base64: "QR" })); // connect

    const r = await connectInstance({
      ...CFG,
      webhookUrl: "https://x/y",
      webhookSecret: SECRET,
      fetchFn: fetchFn as any,
    });

    expect(urlsChamadas(fetchFn)).not.toContain("https://evo.example/instance/create");
    expect(r.qrcode).toBe("QR");
  });
});

describe("logoutInstance e deleteInstance", () => {
  it("logout usa DELETE em /instance/logout", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({ status: "SUCCESS" }));
    await logoutInstance({ ...CFG, fetchFn: fetchFn as any });
    expect(urlsChamadas(fetchFn)[0]).toBe("https://evo.example/instance/logout/conta-a");
    expect(fetchFn.mock.calls[0][1].method).toBe("DELETE");
  });

  it("delete usa DELETE em /instance/delete", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({ status: "SUCCESS" }));
    await deleteInstance({ ...CFG, fetchFn: fetchFn as any });
    expect(urlsChamadas(fetchFn)[0]).toBe("https://evo.example/instance/delete/conta-a");
  });

  it("nome de instancia com caractere especial e escapado", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resposta({}));
    await deleteInstance({ ...CFG, instance: "a/b c", fetchFn: fetchFn as any });
    expect(urlsChamadas(fetchFn)[0]).toBe("https://evo.example/instance/delete/a%2Fb%20c");
  });
});
