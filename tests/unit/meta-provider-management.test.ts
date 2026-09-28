import { describe, it, expect, vi } from "vitest";
import { createMetaProvider } from "../../supabase/functions/_shared/whatsapp/meta-provider";

const config = {
  graphApiVersion: "v25.0",
  phoneNumberId: "106540352242922",
  wabaId: "102290129340398",
  accessToken: "EAAJB-token",
};

describe("MetaProvider.downloadMedia", () => {
  it("resolve a URL pelo media id e baixa o binário com Bearer", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            url: "https://lookaside.test/asset",
            mime_type: "image/jpeg",
            file_size: 3,
            id: "media-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const media = await provider.downloadMedia("media-1");

    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/media-1?phone_number_id=106540352242922",
    );
    expect(fetchFn.mock.calls[1][0]).toBe("https://lookaside.test/asset");
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe("Bearer EAAJB-token");
    expect(Array.from(media.bytes)).toEqual([1, 2, 3]);
    expect(media.mimeType).toBe("image/jpeg");
  });

  it("erro na resolução do id não tenta baixar", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), {
        status: 400,
      }),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(provider.downloadMedia("media-1")).rejects.toThrow("Unsupported get request");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("MetaProvider.getConnectionStatus", () => {
  it("consulta o phone number id e devolve connected=true", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          display_phone_number: "15550783881",
          verified_name: "Eleve One",
          quality_rating: "GREEN",
          id: "106540352242922",
        }),
        { status: 200 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const status = await provider.getConnectionStatus();
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/106540352242922?fields=display_phone_number,verified_name,quality_rating",
    );
    expect(status.connected).toBe(true);
    expect(status.details).toMatchObject({ quality_rating: "GREEN" });
  });

  it("token inválido devolve connected=false sem lançar", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }),
          { status: 401 },
        ),
      );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const status = await provider.getConnectionStatus();
    expect(status.connected).toBe(false);
    expect(JSON.stringify(status)).not.toContain("EAAJB-token");
  });
});

describe("MetaProvider.listTemplates", () => {
  it("lista templates do WABA", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              name: "order_delivery_update",
              components: [{ type: "BODY", text: "Good news {{1}}!" }],
              language: "en_US",
              status: "APPROVED",
              category: "UTILITY",
              id: "1667192013751005",
            },
          ],
          paging: { cursors: { before: "MAZDZD", after: "MjQZD" } },
        }),
        { status: 200 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const templates = await provider.listTemplates();
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/102290129340398/message_templates?limit=200",
    );
    expect(templates).toEqual([
      {
        id: "1667192013751005",
        name: "order_delivery_update",
        language: "en_US",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Good news {{1}}!" }],
      },
    ]);
  });

  it("sem wabaId configurado falha antes da rede", async () => {
    const fetchFn = vi.fn();
    const provider = createMetaProvider({ ...config, wabaId: undefined, fetchFn: fetchFn as any });
    await expect(provider.listTemplates()).rejects.toThrow("WABA id is not configured");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("MetaProvider.createTemplate", () => {
  it("cria o template e devolve id/status da Meta", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "1259544702043867", status: "APPROVED" }), {
        status: 200,
      }),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const template = await provider.createTemplate({
      name: "boas_vindas",
      category: "UTILITY",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Olá {{1}}" }],
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/102290129340398/message_templates");
    expect(JSON.parse(init.body)).toEqual({
      name: "boas_vindas",
      category: "UTILITY",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Olá {{1}}" }],
    });
    expect(template).toEqual({
      id: "1259544702043867",
      name: "boas_vindas",
      language: "pt_BR",
      category: "UTILITY",
      status: "APPROVED",
    });
  });

  it("rejeição da Meta vira erro com a mensagem dela", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Template name already exists", code: 100 } }),
        {
          status: 400,
        },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(
      provider.createTemplate({
        name: "t",
        category: "UTILITY",
        language: "pt_BR",
        components: [],
      }),
    ).rejects.toThrow("Template name already exists");
  });
});
