import { describe, it, expect, vi } from "vitest";
import { createEvolutionProvider } from "../../supabase/functions/_shared/whatsapp/evolution-provider";
import {
  mediaTypeColumn,
  parseEvolutionWebhook,
} from "../../supabase/functions/_shared/whatsapp/evolution-parse";

const BASE = {
  apiUrl: "https://evo.example",
  apiKey: "chave-da-evolution",
  instance: "eleve-conta-a",
};

function ok(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("createEvolutionProvider.sendText", () => {
  it("POST em /message/sendText/<instance> com header apikey", async () => {
    const fetchFn = ok({ key: { id: "3EB0ABC" } });
    const provider = createEvolutionProvider({ ...BASE, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "5511987654321", text: "ola" });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://evo.example/message/sendText/eleve-conta-a",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "chave-da-evolution" }),
      }),
    );
    expect(JSON.parse((fetchFn.mock.calls[0][1] as any).body)).toEqual({
      number: "5511987654321",
      text: "ola",
    });
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe("3EB0ABC");
    expect(r.status).toBe(200);
  });

  it("normaliza barra final da apiUrl", async () => {
    const fetchFn = ok({ key: { id: "x" } });
    const provider = createEvolutionProvider({
      ...BASE,
      apiUrl: "https://evo.example///",
      fetchFn: fetchFn as any,
    });

    await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(fetchFn.mock.calls[0][0]).toBe("https://evo.example/message/sendText/eleve-conta-a");
  });

  it("resposta nao-JSON vira raw sem lancar", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const provider = createEvolutionProvider({ ...BASE, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.providerMessageId).toBeNull();
    expect(r.raw).toEqual({ raw: "<html>502 Bad Gateway</html>" });
  });

  it("erro do provedor vem com mensagem, sem vazar a apikey", async () => {
    const fetchFn = ok({ message: "instance not found" }, 404);
    const provider = createEvolutionProvider({ ...BASE, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("instance not found");
    expect(JSON.stringify(r)).not.toContain("chave-da-evolution");
  });

  it("nome de instancia com caractere especial e escapado na URL", async () => {
    const fetchFn = ok({ key: { id: "x" } });
    const provider = createEvolutionProvider({
      ...BASE,
      instance: "conta a/b",
      fetchFn: fetchFn as any,
    });

    await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(fetchFn.mock.calls[0][0]).toBe("https://evo.example/message/sendText/conta%20a%2Fb");
  });
});

describe("createEvolutionProvider.getConnectionStatus", () => {
  it("state open significa conectado", async () => {
    const fetchFn = ok({ instance: { state: "open" } });
    const provider = createEvolutionProvider({ ...BASE, fetchFn: fetchFn as any });

    const r = await provider.getConnectionStatus();

    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://evo.example/instance/connectionState/eleve-conta-a",
    );
    expect(r.connected).toBe(true);
  });

  it("qualquer outro state significa desconectado", async () => {
    const fetchFn = ok({ instance: { state: "close" } });
    const provider = createEvolutionProvider({ ...BASE, fetchFn: fetchFn as any });
    expect((await provider.getConnectionStatus()).connected).toBe(false);
  });
});

describe("createEvolutionProvider: o que a Evolution nao faz", () => {
  const provider = createEvolutionProvider({ ...BASE, fetchFn: vi.fn() as any });

  it("id do provider", () => {
    expect(provider.id).toBe("evolution");
  });

  it("template, markAsRead, media e download lancam NotSupportedError", async () => {
    await expect(
      provider.sendTemplate({ to: "5511999999999", name: "x", languageCode: "pt_BR" }),
    ).rejects.toThrow(/does not support/);
    await expect(provider.listTemplates()).rejects.toThrow(/does not support/);
    await expect(
      provider.createTemplate({
        name: "x",
        category: "MARKETING",
        language: "pt_BR",
        components: [],
      }),
    ).rejects.toThrow(/does not support/);
    await expect(provider.markAsRead({ providerMessageId: "x" })).rejects.toThrow(
      /does not support/,
    );
    await expect(
      provider.sendMedia({ to: "5511999999999", kind: "image", link: "https://x/y.png" }),
    ).rejects.toThrow(/does not support/);
    await expect(provider.downloadMedia("x")).rejects.toThrow(/does not support/);
  });
});

describe("parseEvolutionWebhook", () => {
  function upsert(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      event: "messages.upsert",
      instance: "eleve-conta-a",
      data: {
        key: {
          id: "3EB0ABC",
          remoteJid: "5511987654321@s.whatsapp.net",
          fromMe: false,
          ...(extra.key ?? {}),
        },
        message,
        messageTimestamp: 1789000000,
      },
    });
  }

  it("conversation vira mensagem de texto", () => {
    const r = parseEvolutionWebhook(upsert({ conversation: "ola tudo bem" }));
    expect(r.inbound).toHaveLength(1);
    expect(r.inbound[0]).toMatchObject({
      providerMessageId: "3EB0ABC",
      fromPhone: "5511987654321",
      type: "text",
      text: "ola tudo bem",
    });
  });

  it("extendedTextMessage tambem", () => {
    const r = parseEvolutionWebhook(upsert({ extendedTextMessage: { text: "resposta citada" } }));
    expect(r.inbound[0].text).toBe("resposta citada");
  });

  it("legenda de imagem vira o texto de uma mensagem do tipo image", () => {
    const r = parseEvolutionWebhook(
      upsert({ imageMessage: { caption: "olha isso", url: "https://x/y.enc" } }),
    );
    expect(r.inbound[0]).toMatchObject({ type: "image", text: "olha isso" });
  });

  it("JID @c.us tambem resolve o numero", () => {
    const raw = JSON.stringify({
      event: "messages.upsert",
      instance: "eleve-conta-a",
      data: {
        key: { id: "A", remoteJid: "5511987654321@c.us", fromMe: false },
        message: { conversation: "oi" },
      },
    });
    expect(parseEvolutionWebhook(raw).inbound[0].fromPhone).toBe("5511987654321");
  });

  it("evento que nao e messages.upsert nao produz inbound", () => {
    const raw = JSON.stringify({ event: "connection.update", data: { state: "open" } });
    const r = parseEvolutionWebhook(raw);
    expect(r.inbound).toHaveLength(0);
    expect(r.statuses).toHaveLength(0);
    expect(r.echoes).toHaveLength(0);
  });

  it("corpo que nao e JSON devolve resultado vazio em vez de lancar", () => {
    const r = parseEvolutionWebhook("<html>erro</html>");
    expect(r.inbound).toHaveLength(0);
  });

  const TS = new Date(1789000000 * 1000).toISOString();

  it("audio sem legenda vira mensagem de audio com texto vazio", () => {
    const r = parseEvolutionWebhook(upsert({ audioMessage: { seconds: 12, ptt: true } }));
    expect(r.inbound[0]).toMatchObject({ type: "audio", text: "" });
  });

  it("figurinha, localizacao e contato tem tipo proprio", () => {
    expect(parseEvolutionWebhook(upsert({ stickerMessage: { url: "x" } })).inbound[0].type).toBe(
      "sticker",
    );
    expect(
      parseEvolutionWebhook(upsert({ locationMessage: { degreesLatitude: 1 } })).inbound[0].type,
    ).toBe("location");
    expect(
      parseEvolutionWebhook(upsert({ contactMessage: { displayName: "Fulano" } })).inbound[0].type,
    ).toBe("contact");
  });

  it("documento com legenda vem desembrulhado", () => {
    const r = parseEvolutionWebhook(
      upsert({
        documentWithCaptionMessage: {
          message: { documentMessage: { caption: "segue o contrato", fileName: "c.pdf" } },
        },
      }),
    );
    expect(r.inbound[0]).toMatchObject({ type: "document", text: "segue o contrato" });
  });

  it("mensagem efemera vem desembrulhada", () => {
    const r = parseEvolutionWebhook(
      upsert({ ephemeralMessage: { message: { conversation: "some em 24h" } } }),
    );
    expect(r.inbound[0]).toMatchObject({ type: "text", text: "some em 24h" });
  });

  it("reacao e protocolo continuam ignorados", () => {
    expect(parseEvolutionWebhook(upsert({ reactionMessage: { text: "ok" } })).inbound).toHaveLength(
      0,
    );
    expect(parseEvolutionWebhook(upsert({ protocolMessage: { type: 0 } })).inbound).toHaveLength(0);
  });

  it("mensagem propria vira eco com o telefone do lead", () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: "respondi pelo celular" }, { key: { fromMe: true } }),
    );
    expect(r.inbound).toHaveLength(0);
    expect(r.echoes).toEqual([
      {
        providerMessageId: "3EB0ABC",
        toPhone: "5511987654321",
        type: "text",
        text: "respondi pelo celular",
        timestamp: TS,
      },
    ]);
  });

  it("audio mandado pelo aparelho vira eco de audio", () => {
    const r = parseEvolutionWebhook(
      upsert({ audioMessage: { ptt: true } }, { key: { fromMe: true } }),
    );
    expect(r.echoes[0]).toMatchObject({ type: "audio", text: "" });
  });

  it("grupo, canal e transmissao sao ignorados", () => {
    for (const remoteJid of [
      "120363000000000000@g.us",
      "120363000000000001@newsletter",
      "status@broadcast",
    ]) {
      const r = parseEvolutionWebhook(upsert({ conversation: "oi" }, { key: { remoteJid } }));
      expect(r.inbound).toHaveLength(0);
      expect(r.echoes).toHaveLength(0);
    }
  });

  it("@lid usa o telefone de remoteJidAlt", () => {
    const r = parseEvolutionWebhook(
      upsert(
        { conversation: "oi" },
        { key: { remoteJid: "123456789012345@lid", remoteJidAlt: "5511987654321@s.whatsapp.net" } },
      ),
    );
    expect(r.inbound[0].fromPhone).toBe("5511987654321");
  });

  it("@lid sem telefone alternativo e ignorado", () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: "oi" }, { key: { remoteJid: "123456789012345@lid" } }),
    );
    expect(r.inbound).toHaveLength(0);
  });

  it("mensagem recebida nao gera eco nem status", () => {
    const r = parseEvolutionWebhook(upsert({ conversation: "oi" }));
    expect(r.statuses).toEqual([]);
    expect(r.echoes).toEqual([]);
  });
});

describe("mediaTypeColumn", () => {
  it("texto e null; midia usa o proprio tipo; interativo vira other", () => {
    expect(mediaTypeColumn("text")).toBeNull();
    expect(mediaTypeColumn("audio")).toBe("audio");
    expect(mediaTypeColumn("sticker")).toBe("sticker");
    expect(mediaTypeColumn("interactive")).toBe("other");
  });
});

// Humanização do envio, portada do app antigo. O fetch responde por rota: a ordem
// das chamadas importa (JID → digitando → envio) e o teste confere essa ordem.
function porRota(rotas: Record<string, { body: unknown; status?: number }>) {
  return vi.fn(async (url: string) => {
    const rota = Object.keys(rotas).find((r) => String(url).includes(r));
    if (!rota) throw new Error(`rota inesperada: ${url}`);
    const { body, status = 200 } = rotas[rota];
    return new Response(JSON.stringify(body), { status });
  });
}

const HUMANO = {
  humanize: { sleepFn: vi.fn(async () => {}), random: () => 0.5 },
};

describe("createEvolutionProvider.sendText humanizado", () => {
  it("envia para o JID real que o WhatsApp devolve, não para o número cadastrado", async () => {
    // Caso real medido em produção: o lead estava com 13 dígitos e o JID é de 12,
    // sem o nono dígito. Nesses DDDs, mandar para a forma errada fazia a mensagem
    // sumir no app antigo — a Evolution aceitava e ninguém recebia.
    const fetchFn = porRota({
      "/chat/whatsappNumbers/": {
        body: [{ exists: true, jid: "553798887747@s.whatsapp.net", number: "5537998887747" }],
      },
      "/chat/sendPresence/": { body: {} },
      "/message/sendText/": { body: { key: { id: "3EB0REAL" } } },
    });
    const provider = createEvolutionProvider({ ...BASE, ...HUMANO, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "5537998887747", text: "oi" });

    expect(r.ok).toBe(true);
    expect(r.resolvedTo).toBe("553798887747");
    const envio = fetchFn.mock.calls.find((c) => String(c[0]).includes("/message/sendText/"))!;
    expect(JSON.parse((envio[1] as any).body).number).toBe("553798887747");
  });

  it("consulta as duas formas do nono dígito", async () => {
    const fetchFn = porRota({
      "/chat/whatsappNumbers/": { body: [{ exists: true, jid: "554698887708@s.whatsapp.net" }] },
      "/chat/sendPresence/": { body: {} },
      "/message/sendText/": { body: { key: { id: "x" } } },
    });
    const provider = createEvolutionProvider({ ...BASE, ...HUMANO, fetchFn: fetchFn as any });

    await provider.sendText({ to: "554698887708", text: "oi" });

    const consulta = fetchFn.mock.calls.find((c) =>
      String(c[0]).includes("/chat/whatsappNumbers/"),
    )!;
    expect(JSON.parse((consulta[1] as any).body).numbers).toEqual(
      expect.arrayContaining(["554698887708", "5546998887708"]),
    );
  });

  it("número sem WhatsApp não é enviado e volta marcado", async () => {
    const fetchFn = porRota({
      "/chat/whatsappNumbers/": { body: [{ exists: false, jid: null }] },
    });
    const provider = createEvolutionProvider({ ...BASE, ...HUMANO, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "554232315889", text: "oi" });

    expect(r.ok).toBe(false);
    expect(r.notOnWhatsApp).toBe(true);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/message/sendText/"))).toBe(false);
  });

  it("se a consulta de JID falhar, envia para o número cadastrado mesmo assim", async () => {
    // A consulta é melhoria, não pré-requisito: indisponível, o envio segue como
    // era antes, em vez de travar a fila inteira.
    const fetchFn = porRota({
      "/chat/whatsappNumbers/": { body: { error: "boom" }, status: 500 },
      "/chat/sendPresence/": { body: {} },
      "/message/sendText/": { body: { key: { id: "x" } } },
    });
    const provider = createEvolutionProvider({ ...BASE, ...HUMANO, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "5542999887766", text: "oi" });

    expect(r.ok).toBe(true);
    const envio = fetchFn.mock.calls.find((c) => String(c[0]).includes("/message/sendText/"))!;
    expect(JSON.parse((envio[1] as any).body).number).toBe("5542999887766");
  });

  it("mostra 'digitando…' de 2 a 5 segundos antes de enviar", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchFn = porRota({
      "/chat/whatsappNumbers/": { body: [{ exists: true, jid: "5542999887766@s.whatsapp.net" }] },
      "/chat/sendPresence/": { body: {} },
      "/message/sendText/": { body: { key: { id: "x" } } },
    });
    const provider = createEvolutionProvider({
      ...BASE,
      humanize: { sleepFn, random: () => 0.5 },
      fetchFn: fetchFn as any,
    });

    await provider.sendText({ to: "5542999887766", text: "oi" });

    const rotas = fetchFn.mock.calls.map((c) => String(c[0]));
    const iPresenca = rotas.findIndex((r) => r.includes("/chat/sendPresence/"));
    const iEnvio = rotas.findIndex((r) => r.includes("/message/sendText/"));
    expect(iPresenca).toBeGreaterThanOrEqual(0);
    expect(iPresenca).toBeLessThan(iEnvio);

    const presenca = JSON.parse((fetchFn.mock.calls[iPresenca][1] as any).body);
    expect(presenca.presence).toBe("composing");
    expect(presenca.delay).toBeGreaterThanOrEqual(2000);
    expect(presenca.delay).toBeLessThanOrEqual(5000);
    expect(sleepFn).toHaveBeenCalledWith(presenca.delay);
  });

  it("falha do 'digitando…' não impede o envio", async () => {
    const fetchFn = porRota({
      "/chat/whatsappNumbers/": { body: [{ exists: true, jid: "5542999887766@s.whatsapp.net" }] },
      "/chat/sendPresence/": { body: { error: "x" }, status: 500 },
      "/message/sendText/": { body: { key: { id: "x" } } },
    });
    const provider = createEvolutionProvider({ ...BASE, ...HUMANO, fetchFn: fetchFn as any });

    const r = await provider.sendText({ to: "5542999887766", text: "oi" });

    expect(r.ok).toBe(true);
  });

  it("sem a opção humanize o envio continua cru, como sempre foi", async () => {
    const fetchFn = ok({ key: { id: "x" } });
    const provider = createEvolutionProvider({ ...BASE, fetchFn: fetchFn as any });

    await provider.sendText({ to: "5542999887766", text: "oi" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toContain("/message/sendText/");
  });
});
