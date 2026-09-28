// WhatsApp Business Platform Cloud API (Meta). Formatos conferidos na doc
// oficial em 2026-07-25 — ver docs/plans/2026-07-25-migracao-whatsapp-meta-cloud-bloco-a.md.
// A versão da Graph API vem sempre de configuração, nunca fixa aqui.

import { HttpError } from "../http-error.ts";
import { constantTimeEqual, hmacSha256Hex } from "../hmac.ts";
import {
  type CreateTemplateParams,
  type DeliveryStatus,
  type DownloadedMedia,
  type EchoMessage,
  type InboundMessage,
  type InboundMessageType,
  type MarkAsReadParams,
  type SendMediaParams,
  type SendResult,
  type SendTemplateParams,
  type SendTextParams,
  type StatusUpdate,
  type TemplateSummary,
  type WebhookParseResult,
  type WhatsAppProvider,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://graph.facebook.com";

const MEDIA_TYPES: InboundMessageType[] = ["image", "audio", "video", "document"];
const KNOWN_TYPES: InboundMessageType[] = ["text", ...MEDIA_TYPES, "interactive"];
const KNOWN_STATUSES: DeliveryStatus[] = ["sent", "delivered", "read", "failed"];

function toIsoTimestamp(value: unknown): string {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date(0).toISOString();
}

export interface MetaProviderConfig {
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string;
  appSecret?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface GraphResponse {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}

function graphErrorMessage(data: Record<string, any>, status: number): string {
  const message = data?.error?.message;
  return typeof message === "string" && message ? message : `Erro ${status} na Graph API`;
}

export function createMetaProvider(config: MetaProviderConfig): WhatsAppProvider {
  const fetchFn = config.fetchFn ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 25_000);
  const graphUrl = (path: string) => `${baseUrl}/${config.graphApiVersion}/${path}`;

  const authHeaders = () => ({ Authorization: `Bearer ${config.accessToken}` });

  async function graphRequest(url: string, init: RequestInit): Promise<GraphResponse> {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const raw = await response.text();
    let data: Record<string, any>;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    return { ok: response.ok, status: response.status, data };
  }

  async function postMessages(body: Record<string, unknown>): Promise<GraphResponse> {
    return graphRequest(graphUrl(`${config.phoneNumberId}/messages`), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function toSendResult(response: GraphResponse): SendResult {
    const messageId = response.data?.messages?.[0]?.id;
    if (!response.ok) {
      const code = response.data?.error?.code;
      return {
        ok: false,
        providerMessageId: null,
        status: response.status,
        raw: response.data,
        error: {
          code: code === undefined || code === null ? undefined : String(code),
          message: graphErrorMessage(response.data, response.status),
        },
      };
    }
    return {
      ok: true,
      providerMessageId: typeof messageId === "string" ? messageId : null,
      status: response.status,
      raw: response.data,
    };
  }

  const recipient = (to: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
  });

  return {
    id: "meta_cloud",

    async sendText({ to, text }: SendTextParams): Promise<SendResult> {
      return toSendResult(
        await postMessages({ ...recipient(to), type: "text", text: { body: text } }),
      );
    },

    async sendMedia(params: SendMediaParams): Promise<SendResult> {
      if (!params.mediaId && !params.link) {
        throw new Error("sendMedia requires mediaId or link");
      }
      const media: Record<string, unknown> = params.mediaId
        ? { id: params.mediaId }
        : { link: params.link };
      if (params.caption) media.caption = params.caption;
      if (params.filename) media.filename = params.filename;

      return toSendResult(
        await postMessages({ ...recipient(params.to), type: params.kind, [params.kind]: media }),
      );
    },

    async sendTemplate(params: SendTemplateParams): Promise<SendResult> {
      const template: Record<string, unknown> = {
        name: params.name,
        language: { code: params.languageCode },
      };
      if (params.components) template.components = params.components;

      return toSendResult(
        await postMessages({ ...recipient(params.to), type: "template", template }),
      );
    },

    async markAsRead({ providerMessageId }: MarkAsReadParams): Promise<void> {
      const response = await postMessages({
        messaging_product: "whatsapp",
        status: "read",
        message_id: providerMessageId,
      });
      if (!response.ok) {
        throw new Error(graphErrorMessage(response.data, response.status));
      }
    },

    async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
      const lookup = await graphRequest(
        `${graphUrl(mediaId)}?phone_number_id=${config.phoneNumberId}`,
        { method: "GET", headers: authHeaders() },
      );
      if (!lookup.ok) {
        throw new Error(graphErrorMessage(lookup.data, lookup.status));
      }

      const url = String(lookup.data?.url ?? "");
      if (!url) throw new Error("Media lookup did not return a url");

      const download = await fetchFn(url, {
        method: "GET",
        headers: authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!download.ok) {
        throw new Error(`Erro ${download.status} ao baixar mídia`);
      }

      return {
        bytes: new Uint8Array(await download.arrayBuffer()),
        mimeType: String(lookup.data?.mime_type ?? "application/octet-stream"),
      };
    },

    async getConnectionStatus(): Promise<{ connected: boolean; details: unknown }> {
      const response = await graphRequest(
        `${graphUrl(config.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
        { method: "GET", headers: authHeaders() },
      );
      if (!response.ok) {
        return {
          connected: false,
          details: {
            status: response.status,
            error: graphErrorMessage(response.data, response.status),
          },
        };
      }
      return { connected: true, details: response.data };
    },

    async listTemplates(): Promise<TemplateSummary[]> {
      if (!config.wabaId) throw new Error("WABA id is not configured");

      const response = await graphRequest(
        `${graphUrl(`${config.wabaId}/message_templates`)}?limit=200`,
        { method: "GET", headers: authHeaders() },
      );
      if (!response.ok) {
        throw new Error(graphErrorMessage(response.data, response.status));
      }

      return (response.data?.data ?? []).map((template: Record<string, any>) => ({
        id: String(template.id ?? ""),
        name: String(template.name ?? ""),
        language: String(template.language ?? ""),
        category: String(template.category ?? ""),
        status: String(template.status ?? ""),
        components: template.components,
      }));
    },

    async createTemplate(params: CreateTemplateParams): Promise<TemplateSummary> {
      if (!config.wabaId) throw new Error("WABA id is not configured");

      const response = await graphRequest(graphUrl(`${config.wabaId}/message_templates`), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: params.name,
          category: params.category,
          language: params.language,
          components: params.components,
        }),
      });
      if (!response.ok) {
        throw new Error(graphErrorMessage(response.data, response.status));
      }

      return {
        id: String(response.data?.id ?? ""),
        name: params.name,
        language: params.language,
        category: String(response.data?.category ?? params.category),
        status: String(response.data?.status ?? "PENDING"),
      };
    },

    async verifyWebhook(req: Request, rawBody: string): Promise<void> {
      if (!config.appSecret) {
        throw new HttpError(503, "META_APP_SECRET is not configured");
      }
      const header = req.headers.get("x-hub-signature-256");
      if (!header) {
        throw new HttpError(401, "Missing X-Hub-Signature-256 header");
      }
      const received = header
        .trim()
        .replace(/^sha256=/i, "")
        .toLowerCase();
      const expected = await hmacSha256Hex(config.appSecret, rawBody);
      if (!constantTimeEqual(received, expected)) {
        throw new HttpError(401, "Invalid webhook signature");
      }
    },

    parseWebhook(rawBody: string): WebhookParseResult {
      const inbound: InboundMessage[] = [];
      const statuses: StatusUpdate[] = [];
      const echoes: EchoMessage[] = [];
      let phoneNumberIdSeen: string | undefined;

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return { inbound, statuses, echoes };
      }

      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const field = String(change?.field ?? "");
          if (field !== "messages" && field !== "smb_message_echoes") continue;

          const value = change?.value ?? {};
          const phoneNumberId = value?.metadata?.phone_number_id;
          if (phoneNumberId && !phoneNumberIdSeen) phoneNumberIdSeen = String(phoneNumberId);

          if (field === "smb_message_echoes") {
            for (const echo of value?.message_echoes ?? []) {
              const toPhone = String(echo?.to ?? "").replace(/\D/g, "");
              // Sem destinatário não há lead a associar: o eco é inútil e não
              // pode virar mensagem órfã.
              if (!toPhone) continue;

              const rawType = String(echo?.type ?? "");
              const type = (KNOWN_TYPES as string[]).includes(rawType)
                ? (rawType as InboundMessageType)
                : "unsupported";

              echoes.push({
                providerMessageId: String(echo?.id ?? ""),
                toPhone,
                phoneNumberId: phoneNumberId ? String(phoneNumberId) : undefined,
                type,
                text: type === "text" ? String(echo?.text?.body ?? "") : undefined,
                timestamp: toIsoTimestamp(echo?.timestamp),
              });
            }
            continue;
          }

          for (const message of value?.messages ?? []) {
            const rawType = String(message?.type ?? "");
            const type = (KNOWN_TYPES as string[]).includes(rawType)
              ? (rawType as InboundMessageType)
              : "unsupported";
            const mediaObject = (MEDIA_TYPES as string[]).includes(rawType)
              ? message?.[rawType]
              : null;

            inbound.push({
              providerMessageId: String(message?.id ?? ""),
              fromPhone: String(message?.from ?? "").replace(/\D/g, ""),
              phoneNumberId: phoneNumberId ? String(phoneNumberId) : undefined,
              type,
              text: type === "text" ? String(message?.text?.body ?? "") : undefined,
              media: mediaObject
                ? {
                    id: String(mediaObject.id ?? ""),
                    mimeType: mediaObject.mime_type ? String(mediaObject.mime_type) : undefined,
                    caption: mediaObject.caption ? String(mediaObject.caption) : undefined,
                    filename: mediaObject.filename ? String(mediaObject.filename) : undefined,
                  }
                : undefined,
              timestamp: toIsoTimestamp(message?.timestamp),
            });
          }

          for (const status of value?.statuses ?? []) {
            const statusName = String(status?.status ?? "");
            // `played` existe na API e não faz parte do contrato do Bloco A.
            if (!(KNOWN_STATUSES as string[]).includes(statusName)) continue;
            const firstError = status?.errors?.[0];

            statuses.push({
              providerMessageId: String(status?.id ?? ""),
              status: statusName as DeliveryStatus,
              timestamp: toIsoTimestamp(status?.timestamp),
              error: firstError
                ? {
                    code:
                      firstError.code === undefined || firstError.code === null
                        ? undefined
                        : String(firstError.code),
                    message: String(firstError.message ?? firstError.title ?? "unknown error"),
                  }
                : undefined,
            });
          }
        }
      }

      return { inbound, statuses, echoes, phoneNumberId: phoneNumberIdSeen };
    },
  };
}
