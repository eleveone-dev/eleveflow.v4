// Parse do webhook da Evolution (Baileys) para o formato neutro do sistema.
//
// A Evolution entrega o evento `messages.upsert` com a mensagem dentro de
// `data.message`, num de varios formatos conforme o tipo. O remetente vem como
// JID (`5511999999999@s.whatsapp.net`), nao como telefone.
//
// Deno-free: o Vitest importa este arquivo em Node.

import type {
  EchoMessage,
  InboundMessage,
  InboundMessageType,
  WebhookParseResult,
} from "./types.ts";

/** Remove o sufixo de JID e tudo que nao for digito. */
export function stripJid(raw: unknown): string {
  if (!raw) return "";
  return String(raw)
    .replace(/@s\.whatsapp\.net/gi, "")
    .replace(/@c\.us/gi, "")
    .replace(/\D/g, "");
}

export function normalizeEvolutionEvent(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[.\-\s]+/g, "_");
}

export function isInboundMessageEvent(value: unknown): boolean {
  return normalizeEvolutionEvent(value) === "MESSAGES_UPSERT";
}

// Envelopes que o WhatsApp poe em volta da mensagem de verdade.
const ENVELOPES = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "documentWithCaptionMessage",
  "associatedChildMessage",
];

const MIDIAS: Array<[string, InboundMessageType]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["documentMessage", "document"],
  ["audioMessage", "audio"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "location"],
  ["liveLocationMessage", "location"],
  ["contactMessage", "contact"],
  ["contactsArrayMessage", "contact"],
];

/** Tipo e texto de uma mensagem da Baileys. null = nao e mensagem de conversa
 *  (protocolo, reacao, edicao, enquete, botoes, conteiner de album). */
export function classifyEvolutionContent(
  raw: Record<string, any> | null | undefined,
): { type: InboundMessageType; text: string } | null {
  let message: Record<string, any> = raw ?? {};
  for (const envelope of ENVELOPES) {
    if (message[envelope]?.message) {
      message = message[envelope].message;
      break;
    }
  }

  const texto = String(message.conversation ?? message.extendedTextMessage?.text ?? "").trim();
  if (texto) return { type: "text", text: texto };

  for (const [chave, type] of MIDIAS) {
    if (message[chave]) return { type, text: String(message[chave].caption ?? "").trim() };
  }
  return null;
}

/** Valor de messages.media_type: null para texto. */
export function mediaTypeColumn(type: InboundMessageType): string | null {
  if (type === "text") return null;
  if (type === "interactive" || type === "unsupported") return "other";
  return type;
}

// Grupo, canal e transmissao nao sao conversa com lead.
const NAO_INDIVIDUAL = /@(g\.us|newsletter|broadcast)$/i;

/** Telefone do contato. JID @lid e identificador de privacidade, nao telefone:
 *  so vale o remoteJidAlt, quando vem. */
function telefoneDoContato(jid: string, alt: unknown): string {
  if (!/@lid$/i.test(jid)) return stripJid(jid);
  const alternativo = String(alt ?? "");
  return /@lid$/i.test(alternativo) ? "" : stripJid(alternativo);
}

const EMPTY: WebhookParseResult = { inbound: [], statuses: [], echoes: [] };

export function parseEvolutionWebhook(rawBody: string): WebhookParseResult {
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Corpo ilegivel nao e erro do nosso lado: a Evolution reenvia o que falha,
    // e devolver vazio faz o webhook responder 200 e encerrar.
    return { ...EMPTY };
  }

  if (!isInboundMessageEvent(payload?.event)) return { ...EMPTY };

  const data = payload?.data ?? {};
  const key = data.key ?? {};

  const jid = String(key.remoteJid ?? data.remoteJid ?? "");
  if (!jid || NAO_INDIVIDUAL.test(jid)) return { ...EMPTY };

  const phone = telefoneDoContato(jid, key.remoteJidAlt);
  if (!phone) return { ...EMPTY };

  const conteudo = classifyEvolutionContent(data.message);
  if (!conteudo) return { ...EMPTY };

  const timestampSeconds = Number(data.messageTimestamp ?? 0);
  const timestamp = timestampSeconds
    ? new Date(timestampSeconds * 1000).toISOString()
    : new Date().toISOString();
  const providerMessageId = String(key.id ?? data.id ?? "");

  // fromMe e o dono falando fora do CRM (celular ou WhatsApp Web), ou o eco de um
  // envio nosso: quem separa os dois e o echo-handler. statuses segue vazio: o
  // recibo de entrega da Baileys tem formato proprio e nao ha consumidor dele.
  if (key.fromMe ?? data.fromMe ?? false) {
    const echo: EchoMessage = {
      providerMessageId,
      toPhone: phone,
      type: conteudo.type,
      text: conteudo.text,
      timestamp,
    };
    return { inbound: [], statuses: [], echoes: [echo] };
  }

  const inbound: InboundMessage = {
    providerMessageId,
    fromPhone: phone,
    type: conteudo.type,
    text: conteudo.text,
    timestamp,
  };
  return { inbound: [inbound], statuses: [], echoes: [] };
}

/** Nome da instancia que recebeu o evento. E a chave de resolucao do tenant. */
export function extractInstanceName(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody);
    const instance = payload?.instance ?? payload?.instanceName;
    return typeof instance === "string" && instance.trim() !== "" ? instance.trim() : null;
  } catch {
    return null;
  }
}
