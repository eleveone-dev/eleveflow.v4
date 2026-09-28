// Inscreve o app do EleveFlow nos webhooks da WABA do tenant.
//
// Endpoint conferido na doc oficial em 2026-08-04:
//   POST /{version}/{WABA_ID}/subscribed_apps
//
// O 200 do POST não é aceito como prova: depois de inscrever, relemos a lista e
// exigimos o nosso App ID nela. Foi confiar em "existe algum app inscrito" que
// produziu o falso positivo de "Webhook inscrito" quando quem estava lá era o
// app de teste da Meta.

import { decryptSecret } from "../crypto.ts";
import { listSubscribedApps } from "./meta-diagnostics.ts";

const DEFAULT_BASE_URL = "https://graph.facebook.com";

export interface SubscriptionEnv {
  graphApiVersion: string;
  tokenEncryptionKey: string;
  /** App ID do EleveFlow, para confirmar que quem ficou inscrito fomos nós. */
  appId: string;
}

export interface SubscriptionDeps {
  client: { from: (table: string) => any };
  env: SubscriptionEnv;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

export type SubscriptionResult =
  | { ok: true; wabaId: string; subscribedAt: string }
  | { ok: false; error: { code?: string; message: string } };

export async function subscribeAppToWaba(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<SubscriptionResult> {
  if (!deps.env.appId) {
    return {
      ok: false,
      error: { message: "Meta App ID não configurado: não há como confirmar a inscrição" },
    };
  }
  if (!deps.env.tokenEncryptionKey) {
    return { ok: false, error: { message: "WHATSAPP_TOKEN_ENC_KEY não está configurada" } };
  }

  const { data: connection } = await deps.client
    .from("whatsapp_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!connection?.access_token_encrypted) {
    return { ok: false, error: { message: "Este tenant não tem conexão configurada" } };
  }
  if (!connection.waba_id) {
    return { ok: false, error: { message: "A conexão não tem WABA associada" } };
  }

  let accessToken: string;
  try {
    accessToken = await decryptSecret(
      connection.access_token_encrypted,
      deps.env.tokenEncryptionKey,
    );
  } catch (error: any) {
    return { ok: false, error: { message: error?.message ?? "Falha ao ler o token da conexão" } };
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const wabaId = String(connection.waba_id);

  const response = await fetchFn(
    `${baseUrl}/${deps.env.graphApiVersion}/${wabaId}/subscribed_apps`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    },
  );

  let data: Record<string, any>;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = {};
  }

  if (!response.ok) {
    const code = data?.error?.code;
    return {
      ok: false,
      error: {
        code: code === undefined || code === null ? undefined : String(code),
        message:
          typeof data?.error?.message === "string"
            ? data.error.message
            : `Erro ${response.status} ao inscrever o app na WABA`,
      },
    };
  }

  // Confirmação independente: a inscrição só vale se o nosso app estiver na lista.
  const apps = await listSubscribedApps({
    graphApiVersion: deps.env.graphApiVersion,
    accessToken,
    wabaId,
    baseUrl: deps.baseUrl,
    fetchFn: deps.fetchFn,
  });

  if (!apps.some((app) => app.appId === deps.env.appId)) {
    return {
      ok: false,
      error: {
        message:
          "A Meta aceitou a chamada, mas o app do EleveFlow não aparece entre os inscritos na WABA.",
      },
    };
  }

  const subscribedAt = new Date().toISOString();
  const { error } = await deps.client
    .from("whatsapp_connections")
    .update({ webhook_subscribed_at: subscribedAt, last_sync_at: subscribedAt })
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: { message: error.message } };

  return { ok: true, wabaId, subscribedAt };
}
