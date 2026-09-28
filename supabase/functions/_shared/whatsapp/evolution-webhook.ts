// Verificacao de origem do webhook da Evolution e registro do header privado.
//
// A Evolution nao assina o corpo como a Meta faz. O caminho preferido e um
// header privado registrado na instancia; instalacoes que assinam o corpo cru
// podem usar um dos dois headers de HMAC. Segredo em query string e recusado de
// proposito: vaza em log de proxy.
//
// Deno-free: o segredo entra por parametro, nunca por Deno.env — e o que permite
// testar isto em Node.

import { HttpError } from "../http-error.ts";
import { constantTimeEqual, hmacSha256Hex } from "../hmac.ts";

export const EVOLUTION_INBOUND_WEBHOOK_EVENTS = ["MESSAGES_UPSERT"] as const;
const MIN_SECRET_LENGTH = 32;

function assertUsableSecret(secret: string): string {
  if (secret.trim().length < MIN_SECRET_LENGTH) {
    throw new HttpError(
      503,
      `EVOLUTION_WEBHOOK_SECRET must be configured with at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return secret.trim();
}

function normaliseSignature(value: string): string {
  return value.trim().replace(/^sha256=/i, "").toLowerCase();
}

export type WebhookVerification =
  | { verified: true }
  | { verified: false; reason: "no_secret_configured" };

/**
 * Valida a origem do webhook antes de o JSON ser parseado.
 *
 * `secret` nulo ou vazio e a guarda de implantacao: significa "verificacao ainda
 * nao ligada", a requisicao passa e quem chama registra `webhook_unverified`.
 * Ela existe so para permitir registrar o header nas instancias sem derrubar o
 * inbound, e deixa de valer assim que o segredo e gravado.
 */
export async function verifyEvolutionWebhook(
  req: Request,
  rawBody: string,
  secret: string | null,
): Promise<WebhookVerification> {
  if (!secret || secret.trim() === "") {
    return { verified: false, reason: "no_secret_configured" };
  }

  const sharedSecret =
    req.headers.get("x-eleveflow-webhook-secret") ?? req.headers.get("x-evolution-webhook-secret");
  if (sharedSecret) {
    if (!constantTimeEqual(sharedSecret, assertUsableSecret(secret))) {
      throw new HttpError(401, "Invalid webhook secret");
    }
    return { verified: true };
  }

  const signature =
    req.headers.get("x-evolution-signature") ?? req.headers.get("x-webhook-signature");
  if (signature) {
    const expected = await hmacSha256Hex(assertUsableSecret(secret), rawBody);
    if (!constantTimeEqual(normaliseSignature(signature), expected)) {
      throw new HttpError(401, "Invalid webhook signature");
    }
    return { verified: true };
  }

  throw new HttpError(401, "Webhook authentication failed");
}

/** Header registrado na instancia da Evolution. Nunca logar este valor. */
export function evolutionWebhookHeaders(secret: string): Record<string, string> {
  return { "x-eleveflow-webhook-secret": assertUsableSecret(secret) };
}

/**
 * A Evolution usou mais de um schema de registro de webhook entre releases. O
 * primeiro corpo casa com a doc atual; os outros mantem compativel instalacao
 * self-hosted mais antiga. Todos carregam o header privado.
 */
export function evolutionWebhookPayloads(
  url: string,
  headers: Record<string, string>,
): Array<{ shape: string; body: Record<string, unknown> }> {
  return [
    {
      shape: "current",
      body: {
        enabled: true,
        url,
        events: EVOLUTION_INBOUND_WEBHOOK_EVENTS,
        headers,
        base64: false,
      },
    },
    {
      shape: "legacy_nested",
      body: {
        webhook: {
          enabled: true,
          url,
          events: EVOLUTION_INBOUND_WEBHOOK_EVENTS,
          headers,
          webhookByEvents: false,
          webhookBase64: false,
        },
      },
    },
    {
      shape: "legacy_root",
      body: {
        enabled: true,
        url,
        events: EVOLUTION_INBOUND_WEBHOOK_EVENTS,
        headers,
        webhook_by_events: false,
        webhook_base64: false,
      },
    },
  ];
}
