// Único ponto do sistema que monta o provedor de um tenant.
// whatsapp_connections é a fonte de verdade: sem linha conectada não existe
// caminho alternativo de envio — o erro é explícito e o chamador decide.

import { HttpError } from "../http-error.ts";
import { decryptSecret } from "../crypto.ts";
import { createMetaProvider } from "./meta-provider.ts";
import { createEvolutionProvider } from "./evolution-provider.ts";
import { type WhatsAppProvider, type WhatsAppProviderId } from "./types.ts";

export * from "./types.ts";
export { createMetaProvider } from "./meta-provider.ts";
export { createEvolutionProvider } from "./evolution-provider.ts";

export interface ProviderEnv {
  metaGraphApiVersion: string;
  metaAppSecret?: string;
  tokenEncryptionKey?: string;
  /** Credencial GLOBAL da Evolution: uma apikey de servidor para todas as
   *  instâncias. Diferente da Meta, não há token por tenant. */
  evolutionApiUrl?: string;
  evolutionApiKey?: string;
  evolutionWebhookSecret?: string;
}

export interface ProviderDeps {
  client: { from: (table: string) => any };
  env: ProviderEnv;
  fetchFn?: typeof fetch;
  /** Espera do "digitando…" da Evolution. Só teste injeta: em produção é real. */
  sleepFn?: (ms: number) => Promise<void>;
}

export async function resolveProvider(
  tenantId: string,
  deps: ProviderDeps,
): Promise<WhatsAppProvider> {
  const { data: connection, error } = await deps.client
    .from("whatsapp_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read whatsapp_connections: ${error.message}`);

  if (!connection) {
    throw new HttpError(409, "Tenant has no WhatsApp connection configured");
  }
  if (connection.status !== "connected") {
    throw new HttpError(409, "WhatsApp connection for this tenant is not connected");
  }

  // Coluna adicionada em 20260918120000 com default 'meta_cloud'. Linha antiga
  // lida antes do reload do schema cache vem sem ela.
  const provider: WhatsAppProviderId = connection.provider ?? "meta_cloud";

  if (provider === "evolution") {
    return resolveEvolution(connection, deps);
  }

  return resolveMetaCloud(connection, deps);
}

function resolveEvolution(connection: any, deps: ProviderDeps): WhatsAppProvider {
  if (!connection.instance_name) {
    throw new HttpError(409, "WhatsApp connection is missing instance_name");
  }
  // A credencial é de ambiente, não do tenant: sem ela nenhuma instância fala.
  if (!deps.env.evolutionApiUrl || !deps.env.evolutionApiKey) {
    throw new HttpError(503, "EVOLUTION_API_URL and EVOLUTION_API_KEY are required");
  }

  return createEvolutionProvider({
    apiUrl: deps.env.evolutionApiUrl,
    apiKey: deps.env.evolutionApiKey,
    instance: connection.instance_name,
    webhookSecret: deps.env.evolutionWebhookSecret ?? null,
    fetchFn: deps.fetchFn,
    // Envio de verdade sai com JID real e "digitando…": e o que o app antigo
    // fazia para nao parecer disparo em serie. Ver evolution-provider.ts.
    humanize: { sleepFn: deps.sleepFn },
  });
}

async function resolveMetaCloud(connection: any, deps: ProviderDeps): Promise<WhatsAppProvider> {
  if (!connection.phone_number_id) {
    throw new HttpError(409, "WhatsApp connection is missing phone_number_id");
  }
  if (!connection.access_token_encrypted) {
    throw new HttpError(409, "WhatsApp connection is missing the encrypted access token");
  }
  if (!deps.env.tokenEncryptionKey) {
    throw new HttpError(503, "WHATSAPP_TOKEN_ENC_KEY is required");
  }

  const accessToken = await decryptSecret(
    connection.access_token_encrypted,
    deps.env.tokenEncryptionKey,
  );

  return createMetaProvider({
    graphApiVersion: deps.env.metaGraphApiVersion,
    phoneNumberId: connection.phone_number_id,
    wabaId: connection.waba_id ?? undefined,
    accessToken,
    appSecret: deps.env.metaAppSecret,
    fetchFn: deps.fetchFn,
  });
}
