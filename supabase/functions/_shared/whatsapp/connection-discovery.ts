// Descoberta de uma conexão concluída fora do pop-up do Embedded Signup.
//
// No fluxo de coexistência a Meta não devolve `code` ao navegador: o pareamento
// termina no celular, com a leitura de um QR Code, e pode levar minutos. Quando
// o tenant conclui em aba própria (ou o pop-up é fechado antes da hora), não há
// código para trocar e a conexão ficaria invisível para o CRM.
//
// Então ela é descoberta depois: com o token de plataforma, lista-se as WABAs
// do portfólio, procura-se um número com `is_on_biz_app = true` que ainda não
// pertença a outro tenant, e grava-se a conexão.

import { decryptSecret, encryptSecret } from "../crypto.ts";

export const PLATFORM_TOKEN_KEY = "meta_platform_token_encrypted";
export const PLATFORM_BUSINESS_ID_KEY = "meta_platform_business_id";

export interface DiscoveryEnv {
  graphApiVersion: string;
  tokenEncryptionKey: string;
}

export interface DiscoveryDeps {
  client: { from: (table: string) => any };
  env: DiscoveryEnv;
  fetchFn?: typeof fetch;
}

export interface DiscoveredNumber {
  wabaId: string;
  wabaName: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  isOnBizApp: boolean;
}

export type DiscoveryResult =
  | { ok: true; connection: DiscoveredNumber; alreadyConnected: boolean }
  | { ok: false; error: { code?: string; message: string }; candidates?: DiscoveredNumber[] };

interface GraphDeps {
  fetchFn: typeof fetch;
  graphApiVersion: string;
  token: string;
}

async function graphGet(deps: GraphDeps, path: string): Promise<Record<string, any>> {
  const response = await deps.fetchFn(
    `https://graph.facebook.com/${deps.graphApiVersion}/${path}`,
    {
      headers: { Authorization: `Bearer ${deps.token}` },
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message ?? `Graph API respondeu ${response.status}`;
    throw new Error(message);
  }
  return data;
}

/** Números de todas as WABAs do portfólio, com o sinal de coexistência. */
export async function listPortfolioNumbers(
  deps: GraphDeps,
  businessId: string,
): Promise<DiscoveredNumber[]> {
  const wabas = await graphGet(
    deps,
    `${businessId}/owned_whatsapp_business_accounts?fields=id,name`,
  );
  const rows = Array.isArray(wabas?.data) ? wabas.data : [];

  const found: DiscoveredNumber[] = [];
  for (const waba of rows) {
    const wabaId = String(waba?.id ?? "");
    if (!wabaId) continue;

    // `is_on_biz_app` existe na v25.0 (provado em 2026-08-19), mas a referência
    // do node não o lista: se a Graph recusar o campo, relê sem ele em vez de
    // perder a WABA inteira.
    let numbers: Record<string, any>;
    try {
      numbers = await graphGet(
        deps,
        `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,is_on_biz_app`,
      );
    } catch {
      numbers = await graphGet(deps, `${wabaId}/phone_numbers`);
    }

    for (const number of Array.isArray(numbers?.data) ? numbers.data : []) {
      found.push({
        wabaId,
        wabaName: waba?.name ? String(waba.name) : null,
        phoneNumberId: String(number?.id ?? ""),
        displayPhoneNumber: number?.display_phone_number
          ? String(number.display_phone_number)
          : null,
        verifiedName: number?.verified_name ? String(number.verified_name) : null,
        qualityRating: number?.quality_rating ? String(number.quality_rating) : null,
        isOnBizApp: number?.is_on_biz_app === true,
      });
    }
  }

  return found;
}

async function readSetting(client: DiscoveryDeps["client"], key: string): Promise<string | null> {
  const { data } = await client
    .from("global_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const value = data?.value;
  return value === undefined || value === null ? null : String(value);
}

/**
 * Acha a conexão de coexistência do tenant e grava. Idempotente: repetir a
 * chamada com o mesmo número devolve `alreadyConnected`.
 */
export async function discoverAndSaveConnection(
  deps: DiscoveryDeps,
  tenantId: string,
): Promise<DiscoveryResult> {
  if (!deps.env.tokenEncryptionKey) {
    return { ok: false, error: { message: "WHATSAPP_TOKEN_ENC_KEY não está configurada" } };
  }

  const businessId = await readSetting(deps.client, PLATFORM_BUSINESS_ID_KEY);
  const tokenEncrypted = await readSetting(deps.client, PLATFORM_TOKEN_KEY);
  if (!businessId || !tokenEncrypted) {
    return {
      ok: false,
      error: {
        code: "platform_not_configured",
        message: "Token e portfólio da plataforma não estão configurados.",
      },
    };
  }

  let token: string;
  try {
    token = await decryptSecret(tokenEncrypted, deps.env.tokenEncryptionKey);
  } catch {
    return { ok: false, error: { message: "Falha ao ler o token da plataforma" } };
  }

  const graph: GraphDeps = {
    fetchFn: deps.fetchFn ?? fetch,
    graphApiVersion: deps.env.graphApiVersion,
    token,
  };

  let numbers: DiscoveredNumber[];
  try {
    numbers = await listPortfolioNumbers(graph, businessId);
  } catch (error: any) {
    return { ok: false, error: { message: error?.message ?? "Falha ao listar os números" } };
  }

  const coexistence = numbers.filter((number) => number.isOnBizApp);
  if (coexistence.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_coexistence_number",
        message:
          "Nenhum número em coexistência encontrado. Conclua o fluxo da Meta antes de sincronizar.",
      },
      candidates: numbers,
    };
  }

  // Um número já gravado para outro tenant não pode ser reivindicado: dois
  // tenants no mesmo número misturariam as conversas de empresas diferentes.
  const { data: taken } = await deps.client
    .from("whatsapp_connections")
    .select("tenant_id, phone_number_id");
  const takenByOthers = new Set(
    (taken ?? [])
      .filter((row: any) => row.tenant_id !== tenantId)
      .map((row: any) => String(row.phone_number_id)),
  );

  const mine = coexistence.find((number) => !takenByOthers.has(number.phoneNumberId));
  if (!mine) {
    return {
      ok: false,
      error: {
        code: "already_claimed",
        message: "O número em coexistência já está conectado a outra conta.",
      },
      candidates: coexistence,
    };
  }

  const { data: existing } = await deps.client
    .from("whatsapp_connections")
    .select("phone_number_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const alreadyConnected = existing?.phone_number_id === mine.phoneNumberId;

  const { error } = await deps.client.from("whatsapp_connections").upsert(
    {
      tenant_id: tenantId,
      status: "connected",
      waba_id: mine.wabaId,
      phone_number_id: mine.phoneNumberId,
      display_phone_number: mine.displayPhoneNumber,
      display_name: mine.verifiedName,
      quality_rating: mine.qualityRating,
      coexistence_enabled: true,
      access_token_encrypted: await encryptSecret(token, deps.env.tokenEncryptionKey),
      token_type: "system_user",
      token_expires_at: null,
      last_sync_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );

  if (error) return { ok: false, error: { message: error.message } };

  return { ok: true, connection: mine, alreadyConnected };
}
