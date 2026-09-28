import { describe, it, expect, vi } from "vitest";
import { createMetaProvider } from "../../supabase/functions/_shared/whatsapp/meta-provider";

const config = {
  graphApiVersion: "v25.0",
  phoneNumberId: "106540352242922",
  accessToken: "EAAJB-token",
};

const okResponse = () =>
  new Response(
    JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ input: "16505551234", wa_id: "16505551234" }],
      messages: [{ id: "wamid.HBgL", message_status: "accepted" }],
    }),
    { status: 200 },
  );

function callBody(fetchFn: any, index = 0) {
  return JSON.parse(fetchFn.mock.calls[index][1].body);
}

describe("MetaProvider.sendText", () => {
  it("chama /{version}/{phone_number_id}/messages com o corpo da Cloud API", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });

    const result = await provider.sendText({ to: "16505551234", text: "olá" });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/106540352242922/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer EAAJB-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "16505551234",
      type: "text",
      text: { body: "olá" },
    });
    expect(result).toMatchObject({ ok: true, providerMessageId: "wamid.HBgL", status: 200 });
  });

  it("usa a versão configurada, nunca uma fixa", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({
      ...config,
      graphApiVersion: "v99.9",
      fetchFn: fetchFn as any,
    });
    await provider.sendText({ to: "1", text: "x" });
    expect(fetchFn.mock.calls[0][0]).toContain("/v99.9/");
  });

  it("erro da Graph API vira SendResult com code e message, sem vazar o token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Unsupported post request", code: 100, type: "GraphMethodException" },
        }),
        { status: 400 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const result = await provider.sendText({ to: "1", text: "x" });
    expect(result).toMatchObject({ ok: false, status: 400, providerMessageId: null });
    expect(result.error).toEqual({ code: "100", message: "Unsupported post request" });
    expect(JSON.stringify(result)).not.toContain("EAAJB-token");
  });

  it("resposta não-JSON não quebra o envio", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const result = await provider.sendText({ to: "1", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error?.message).toBe("Erro 502 na Graph API");
  });
});

describe("MetaProvider.sendMedia", () => {
  it("mídia por id", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendMedia({ to: "1", kind: "image", mediaId: "media-1", caption: "legenda" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "image",
      image: { id: "media-1", caption: "legenda" },
    });
  });

  it("mídia por link", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendMedia({ to: "1", kind: "video", link: "https://cdn.test/v.mp4" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "video",
      video: { link: "https://cdn.test/v.mp4" },
    });
  });

  it("document aceita filename", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendMedia({ to: "1", kind: "document", mediaId: "d1", filename: "nota.pdf" });
    expect(callBody(fetchFn).document).toEqual({ id: "d1", filename: "nota.pdf" });
  });

  it("sem mediaId e sem link falha antes da rede", async () => {
    const fetchFn = vi.fn();
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(provider.sendMedia({ to: "1", kind: "image" })).rejects.toThrow(
      "sendMedia requires mediaId or link",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("MetaProvider.sendTemplate", () => {
  it("monta template com language.code", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendTemplate({ to: "1", name: "boas_vindas", languageCode: "pt_BR" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "template",
      template: { name: "boas_vindas", language: { code: "pt_BR" } },
    });
  });

  it("inclui components quando fornecidos", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const components = [{ type: "body", parameters: [{ type: "text", text: "Lucas" }] }];
    await provider.sendTemplate({ to: "1", name: "t", languageCode: "pt_BR", components });
    expect(callBody(fetchFn).template.components).toEqual(components);
  });
});

describe("MetaProvider.markAsRead", () => {
  it("posta status=read com o wamid", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.markAsRead({ providerMessageId: "wamid.X" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.X",
    });
  });

  it("falha da API vira erro sem o token na mensagem", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid message id", code: 131009 } }), {
        status: 400,
      }),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(provider.markAsRead({ providerMessageId: "x" })).rejects.toThrow(
      "Invalid message id",
    );
  });
});
