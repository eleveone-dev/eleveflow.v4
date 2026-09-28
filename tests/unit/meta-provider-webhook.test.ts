import { describe, it, expect } from "vitest";
import { createMetaProvider } from "../../supabase/functions/_shared/whatsapp/meta-provider";
import { hmacSha256Hex } from "../../supabase/functions/_shared/hmac";

const config = {
  graphApiVersion: "v25.0",
  phoneNumberId: "106540352242922",
  accessToken: "EAAJB-token",
  appSecret: "app-secret-de-teste",
};

const textPayload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
            contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
            messages: [
              {
                from: "16505551234",
                id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                timestamp: "1749416383",
                type: "text",
                text: { body: "Does it come in another color?" },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
});

async function signedRequest(body: string, secret = config.appSecret) {
  const signature = await hmacSha256Hex(secret, body);
  return new Request("https://x.test/webhook", {
    method: "POST",
    headers: { "X-Hub-Signature-256": `sha256=${signature}` },
    body,
  });
}

describe("MetaProvider.verifyWebhook", () => {
  it("aceita assinatura válida", async () => {
    const provider = createMetaProvider(config);
    await expect(
      provider.verifyWebhook(await signedRequest(textPayload), textPayload),
    ).resolves.toBeUndefined();
  });

  it("rejeita assinatura de outro segredo", async () => {
    const provider = createMetaProvider(config);
    const req = await signedRequest(textPayload, "segredo-errado");
    await expect(provider.verifyWebhook(req, textPayload)).rejects.toMatchObject({ status: 401 });
  });

  it("rejeita quando o corpo foi alterado depois de assinado", async () => {
    const provider = createMetaProvider(config);
    const req = await signedRequest(textPayload);
    await expect(provider.verifyWebhook(req, textPayload + " ")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejeita sem header de assinatura", async () => {
    const provider = createMetaProvider(config);
    const req = new Request("https://x.test/webhook", { method: "POST", body: textPayload });
    await expect(provider.verifyWebhook(req, textPayload)).rejects.toMatchObject({ status: 401 });
  });

  it("falha fechado (503) quando o App Secret não está configurado", async () => {
    const provider = createMetaProvider({ ...config, appSecret: undefined });
    const req = await signedRequest(textPayload);
    await expect(provider.verifyWebhook(req, textPayload)).rejects.toMatchObject({ status: 503 });
  });
});

describe("MetaProvider.parseWebhook", () => {
  it("normaliza mensagem de texto", () => {
    const provider = createMetaProvider(config);
    const result = provider.parseWebhook(textPayload);
    expect(result.statuses).toEqual([]);
    expect(result.inbound).toEqual([
      {
        providerMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
        fromPhone: "16505551234",
        phoneNumberId: "106540352242922",
        type: "text",
        text: "Does it come in another color?",
        timestamp: "2025-06-08T20:59:43.000Z",
      },
    ]);
  });

  it("normaliza mensagem de imagem com media id, mime e caption", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.IMG",
                    timestamp: "1744344496",
                    type: "image",
                    image: {
                      caption: "Taj Mahal",
                      mime_type: "image/jpeg",
                      sha256: "SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=",
                      id: "1003383421387256",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    const [inbound] = provider.parseWebhook(payload).inbound;
    expect(inbound).toMatchObject({
      providerMessageId: "wamid.IMG",
      type: "image",
      media: { id: "1003383421387256", mimeType: "image/jpeg", caption: "Taj Mahal" },
    });
    expect(inbound.text).toBeUndefined();
  });

  it("tipo desconhecido vira unsupported", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "106540352242922" },
                messages: [{ from: "1", id: "wamid.X", timestamp: "1744344496", type: "sticker" }],
              },
            },
          ],
        },
      ],
    });
    expect(provider.parseWebhook(payload).inbound[0].type).toBe("unsupported");
  });

  it("normaliza statuses e descarta os fora da união", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "106540352242922" },
                statuses: [
                  { id: "wamid.A", status: "sent", timestamp: "1750263773", recipient_id: "1" },
                  {
                    id: "wamid.B",
                    status: "delivered",
                    timestamp: "1750263774",
                    recipient_id: "1",
                  },
                  { id: "wamid.C", status: "played", timestamp: "1750263775", recipient_id: "1" },
                  {
                    id: "wamid.D",
                    status: "failed",
                    timestamp: "1750263776",
                    recipient_id: "1",
                    errors: [
                      {
                        code: 131049,
                        title:
                          "This message was not delivered to maintain healthy ecosystem engagement.",
                        message:
                          "This message was not delivered to maintain healthy ecosystem engagement.",
                        error_data: { details: "..." },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const result = provider.parseWebhook(payload);
    const { statuses } = result;
    // Payload só de statuses: o phone_number_id do resultado é o único caminho
    // para achar o tenant.
    expect(result.phoneNumberId).toBe("106540352242922");
    expect(statuses.map((s) => s.status)).toEqual(["sent", "delivered", "failed"]);
    expect(statuses[2].error).toEqual({
      code: "131049",
      message: "This message was not delivered to maintain healthy ecosystem engagement.",
    });
  });

  it("ignora changes de outro field", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      entry: [
        { changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }] },
      ],
    });
    expect(provider.parseWebhook(payload)).toEqual({ inbound: [], statuses: [], echoes: [] });
  });

  it("corpo inválido não derruba o webhook", () => {
    const provider = createMetaProvider(config);
    expect(provider.parseWebhook("{}")).toEqual({ inbound: [], statuses: [], echoes: [] });
  });
});

describe("parseWebhook — eco do WhatsApp Business App", () => {
  const parser = () =>
    createMetaProvider({
      graphApiVersion: "v25.0",
      phoneNumberId: "",
      accessToken: "",
      appSecret: "segredo",
    });

  const echoPayload = (echo: Record<string, unknown>) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "2203121110258246",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+55 34 95328-5885",
                  phone_number_id: "1267133593145045",
                },
                message_echoes: [echo],
              },
            },
          ],
        },
      ],
    });

  it("le o eco e usa o destinatario como telefone do lead", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        to: "5511987654321",
        id: "wamid.ECHO1",
        timestamp: "1755518400",
        type: "text",
        text: { body: "Bom dia! Vou te passar o preço" },
      }),
    );

    expect(result.echoes).toHaveLength(1);
    expect(result.echoes[0].providerMessageId).toBe("wamid.ECHO1");
    expect(result.echoes[0].toPhone).toBe("5511987654321");
    expect(result.echoes[0].text).toBe("Bom dia! Vou te passar o preço");
    expect(result.echoes[0].type).toBe("text");
    expect(result.phoneNumberId).toBe("1267133593145045");
  });

  it("nunca deixa o eco vazar para inbound", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        to: "5511987654321",
        id: "wamid.ECHO2",
        timestamp: "1755518400",
        type: "text",
        text: { body: "oi" },
      }),
    );

    expect(result.inbound).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
  });

  it("marca tipo desconhecido como unsupported", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        to: "5511987654321",
        id: "wamid.ECHO3",
        timestamp: "1755518400",
        type: "sticker",
      }),
    );

    expect(result.echoes[0].type).toBe("unsupported");
    expect(result.echoes[0].text).toBeUndefined();
  });

  it("descarta eco sem destinatario", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        id: "wamid.ECHO4",
        timestamp: "1755518400",
        type: "text",
      }),
    );

    expect(result.echoes).toHaveLength(0);
  });

  it("continua descartando campos alheios", () => {
    const result = parser().parseWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "2203121110258246",
            changes: [{ field: "history", value: { history: [] } }],
          },
        ],
      }),
    );

    expect(result.echoes).toHaveLength(0);
    expect(result.inbound).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
  });

  it("devolve echoes vazio para payload comum de mensagem", () => {
    const result = parser().parseWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "2203121110258246",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "1267133593145045" },
                  messages: [
                    {
                      from: "5511987654321",
                      id: "wamid.IN1",
                      timestamp: "1755518400",
                      type: "text",
                      text: { body: "oi" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(result.echoes).toEqual([]);
    expect(result.inbound).toHaveLength(1);
  });
});
