// Provedor Evolution API (Baileys), atras da mesma interface que a Meta.
//
// Diferenca de modelo que importa: a credencial da Evolution e GLOBAL, uma
// apikey de servidor que vale para todas as instancias. Nao ha token por tenant
// para descriptografar. O isolamento entre contas vem do nome da instancia, que
// `resolveProvider` le de whatsapp_connections e passa aqui.
//
// Deno-free: o Vitest importa este arquivo em Node.

import {
  NotSupportedError,
  type CreateTemplateParams,
  type DownloadedMedia,
  type MarkAsReadParams,
  type SendMediaParams,
  type SendResult,
  type SendTemplateParams,
  type SendTextParams,
  type TemplateSummary,
  type WebhookParseResult,
  type WhatsAppProvider,
} from "./types.ts";
import { parseEvolutionWebhook } from "./evolution-parse.ts";
import { verifyEvolutionWebhook } from "./evolution-webhook.ts";
import { phoneVariants } from "./crm-parse.ts";

/**
 * Envio com cara de gente, portado do app antigo (eleve.flow.3), onde rodava em
 * producao. Opcional de proposito: sem isto o provedor faz so o envio cru, que e
 * o contrato testado das outras operacoes. Quem monta o provedor para mandar
 * mensagem de verdade (`resolveProvider`) liga.
 */
export interface EvolutionHumanize {
  /** Espera do "digitando…". Injetavel: teste nao pode dormir de verdade. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Sorteio da duracao do "digitando…". Injetavel pelo mesmo motivo. */
  random?: () => number;
}

export interface EvolutionProviderConfig {
  apiUrl: string;
  apiKey: string;
  instance: string;
  /** Segredo do webhook. Ausente = verificacao ainda nao ligada. */
  webhookSecret?: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  humanize?: EvolutionHumanize;
}

const DIGITANDO_MIN_MS = 2_000;
const DIGITANDO_FAIXA_MS = 3_000;

function unsupported(operation: string): never {
  throw new NotSupportedError("evolution", operation);
}

export function createEvolutionProvider(config: EvolutionProviderConfig): WhatsAppProvider {
  const apiUrl = config.apiUrl.replace(/\/+$/, "");
  const instance = encodeURIComponent(config.instance);
  const fetchFn = config.fetchFn ?? fetch;
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 25_000);

  async function call(path: string, body?: unknown) {
    const res = await fetchFn(`${apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", apikey: config.apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let data: Record<string, any>;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    return { ok: res.ok, status: res.status, data };
  }

  /**
   * Pergunta ao WhatsApp qual e o JID real do numero, nas duas formas do nono
   * digito. Medido em producao: nos DDDs 37 e 46 o JID e de 12 digitos, sem o 9,
   * mesmo com o lead cadastrado com 13. No app antigo, mandar para a forma errada
   * fazia a mensagem sumir — a Evolution aceitava, devolvia id, e ninguem recebia.
   *
   * `exists: null` = nao deu para saber; quem chama segue com o numero cadastrado.
   */
  async function resolverJid(
    numero: string,
  ): Promise<{ exists: boolean | null; numero?: string; raw?: unknown }> {
    const digitos = numero.replace(/\D/g, "");
    const formas = phoneVariants(digitos).filter(
      (v) => v.startsWith("55") && (v.length === 12 || v.length === 13),
    );
    try {
      const { ok, data } = await call(`/chat/whatsappNumbers/${instance}`, {
        numbers: formas.length > 0 ? formas : [digitos],
      });
      if (!ok || !Array.isArray(data)) return { exists: null };
      const achado = data.find((e: any) => e?.exists === true && e?.jid);
      if (achado) {
        return { exists: true, numero: String(achado.jid).split("@")[0].split(":")[0] };
      }
      if (data.length > 0 && data.every((e: any) => e?.exists === false)) {
        return { exists: false, raw: data };
      }
      return { exists: null };
    } catch {
      return { exists: null };
    }
  }

  return {
    id: "evolution",

    async sendText(params: SendTextParams): Promise<SendResult> {
      let destino = params.to;
      let resolvido: string | undefined;

      if (config.humanize) {
        const jid = await resolverJid(params.to);
        if (jid.exists === false) {
          // Nao manda: a Evolution recusaria com Bad Request, ou pior, aceitaria.
          return {
            ok: false,
            status: 404,
            providerMessageId: null,
            raw: jid.raw ?? null,
            notOnWhatsApp: true,
            error: { code: "not_on_whatsapp", message: "Número não tem WhatsApp" },
          };
        }
        if (jid.numero && jid.numero !== params.to) {
          destino = jid.numero;
          resolvido = jid.numero;
        }

        // "digitando…" antes de mandar, com duracao sorteada. Melhor esforco:
        // falhar aqui nao pode impedir o envio.
        const sortear = config.humanize.random ?? Math.random;
        const dormir =
          config.humanize.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        const digitandoMs = DIGITANDO_MIN_MS + Math.floor(sortear() * DIGITANDO_FAIXA_MS);
        try {
          await call(`/chat/sendPresence/${instance}`, {
            number: destino,
            delay: digitandoMs,
            presence: "composing",
          });
        } catch {
          // presenca e cosmetica
        }
        await dormir(digitandoMs);
      }

      const { ok, status, data } = await call(`/message/sendText/${instance}`, {
        number: destino,
        text: params.text,
      });

      return {
        ok,
        status,
        providerMessageId: (data?.key?.id as string | undefined) ?? null,
        raw: data,
        ...(resolvido ? { resolvedTo: resolvido } : {}),
        // A apikey nunca entra aqui: so a mensagem que a Evolution devolveu.
        ...(ok
          ? {}
          : { error: { message: String(data?.message ?? data?.error ?? `HTTP ${status}`) } }),
      };
    },

    async getConnectionStatus() {
      const { data } = await call(`/instance/connectionState/${instance}`);
      const state = data?.instance?.state ?? data?.state ?? null;
      return { connected: state === "open", details: data };
    },

    async verifyWebhook(req: Request, rawBody: string): Promise<void> {
      await verifyEvolutionWebhook(req, rawBody, config.webhookSecret ?? null);
    },

    parseWebhook(rawBody: string): WebhookParseResult {
      return parseEvolutionWebhook(rawBody);
    },

    // A Evolution nao tem nenhum destes conceitos. Lancar e melhor que devolver
    // sucesso falso: quem chamar descobre na hora, e o teste documenta.
    async sendMedia(_params: SendMediaParams): Promise<SendResult> {
      unsupported("sendMedia");
    },
    async sendTemplate(_params: SendTemplateParams): Promise<SendResult> {
      unsupported("sendTemplate");
    },
    async markAsRead(_params: MarkAsReadParams): Promise<void> {
      unsupported("markAsRead");
    },
    async downloadMedia(_mediaId: string): Promise<DownloadedMedia> {
      unsupported("downloadMedia");
    },
    async listTemplates(): Promise<TemplateSummary[]> {
      unsupported("listTemplates");
    },
    async createTemplate(_params: CreateTemplateParams): Promise<TemplateSummary> {
      unsupported("createTemplate");
    },
  };
}
