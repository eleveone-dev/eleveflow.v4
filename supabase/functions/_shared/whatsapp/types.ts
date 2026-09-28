// Contrato único de provedor de WhatsApp. Automações, filas, IA e telas falam
// só com esta interface — nunca com a Graph API direto.

export type WhatsAppProviderId = "meta_cloud" | "evolution";

export interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  status: number;
  raw: unknown;
  error?: { code?: string; message: string };
  /** Numero efetivamente usado, quando o provedor resolveu um JID diferente do
   *  cadastrado. Quem chama pode corrigir o cadastro do lead com ele. */
  resolvedTo?: string;
  /** O provedor confirmou que o numero nao tem WhatsApp — nao foi enviado. */
  notOnWhatsApp?: boolean;
}

export interface SendTextParams {
  to: string;
  text: string;
}

export interface SendMediaParams {
  to: string;
  kind: "image" | "audio" | "video" | "document";
  mediaId?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

export interface SendTemplateParams {
  to: string;
  name: string;
  languageCode: string;
  components?: unknown[];
}

export interface MarkAsReadParams {
  providerMessageId: string;
}

export interface CreateTemplateParams {
  name: string;
  category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
  language: string;
  components: unknown[];
}

export type InboundMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "interactive"
  | "unsupported";

export interface InboundMessage {
  providerMessageId: string;
  fromPhone: string;
  phoneNumberId?: string;
  type: InboundMessageType;
  text?: string;
  media?: { id: string; mimeType?: string; caption?: string; filename?: string };
  timestamp: string;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusUpdate {
  providerMessageId: string;
  status: DeliveryStatus;
  timestamp: string;
  error?: { code?: string; message: string };
}

/** Mensagem que o dono mandou fora do CRM, pelo aparelho. Na Meta chega no campo
 *  `smb_message_echoes` (coexistência); na Evolution, como `messages.upsert` com
 *  `fromMe`. Atenção: aqui o lead é o `to`. */
export interface EchoMessage {
  providerMessageId: string;
  toPhone: string;
  phoneNumberId?: string;
  type: InboundMessageType;
  text?: string;
  timestamp: string;
}

export interface WebhookParseResult {
  inbound: InboundMessage[];
  statuses: StatusUpdate[];
  /** Ecos do WhatsApp Business App. Vazio fora de coexistência. */
  echoes: EchoMessage[];
  /** Número que recebeu o evento. Único caminho para achar o tenant quando o
   *  payload traz apenas statuses. */
  phoneNumberId?: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components?: unknown[];
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  sendText(params: SendTextParams): Promise<SendResult>;
  sendMedia(params: SendMediaParams): Promise<SendResult>;
  sendTemplate(params: SendTemplateParams): Promise<SendResult>;
  markAsRead(params: MarkAsReadParams): Promise<void>;
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
  getConnectionStatus(): Promise<{ connected: boolean; details: unknown }>;
  listTemplates(): Promise<TemplateSummary[]>;
  createTemplate(params: CreateTemplateParams): Promise<TemplateSummary>;
  verifyWebhook(req: Request, rawBody: string): Promise<void>;
  parseWebhook(rawBody: string): WebhookParseResult;
}

export class NotSupportedError extends Error {
  constructor(provider: WhatsAppProviderId, operation: string) {
    super(`Provider ${provider} does not support ${operation}`);
    this.name = "NotSupportedError";
  }
}
