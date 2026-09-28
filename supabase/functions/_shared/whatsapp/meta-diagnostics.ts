// Diagnóstico da conexão contra a Graph API. Nada aqui confia no banco: cada
// afirmação ("token válido", "número encontrado") só é verdadeira se a Meta
// respondeu confirmando. Endpoints conferidos na doc oficial em 2026-07-30:
//   GET /{v}/debug_token?input_token=…            → validade, app, granular_scopes
//   GET /{v}/{WABA_ID}                            → nome e status de revisão
//   GET /{v}/{WABA_ID}/phone_numbers              → números da conta
//   GET /{v}/{PHONE_NUMBER_ID}?fields=…           → detalhe de um número
//   GET /{v}/{WABA_ID}/subscribed_apps            → apps inscritos no webhook
//
// O access token entra por parâmetro e nunca sai em retorno nem em mensagem de
// erro: só o texto que a própria Meta devolveu é propagado.

const DEFAULT_BASE_URL = "https://graph.facebook.com";

export interface MetaApiConfig {
  graphApiVersion: string;
  accessToken: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface TokenInfo {
  valid: boolean;
  appId: string | null;
  expiresAt: string | null;
  scopes: string[];
  wabaIds: string[];
  error?: { code?: string; message: string };
}

export interface PhoneNumberInfo {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus?: string | null;
  /** Coexistência: número compartilhado com o WhatsApp Business App. A doc da
   *  Meta diverge entre páginas sobre a existência destes campos — quando a
   *  Graph não os devolve, ficam undefined e o onboarding usa a dica do evento. */
  isOnBizApp?: boolean | null;
  platformType?: string | null;
}

export interface WabaInfo {
  wabaId: string;
  name: string | null;
  accountReviewStatus: string | null;
}

export interface SubscribedApp {
  appId: string;
  name: string | null;
}

export interface ConnectionVerification {
  tokenValid: boolean;
  wabaAccessible: boolean;
  phoneNumberFound: boolean;
  webhookSubscribed: boolean;
  token: TokenInfo | null;
  waba: WabaInfo | null;
  phoneNumber: PhoneNumberInfo | null;
  subscribedApps: SubscribedApp[];
  checkedAt: string;
  error?: { code?: string; message: string };
}

interface GraphResult {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}

function errorFrom(data: Record<string, any>, status: number) {
  const code = data?.error?.code;
  const message = data?.error?.message;
  if (typeof message === "string" && message) {
    return {
      code: code === undefined || code === null ? undefined : String(code),
      message,
    };
  }

  // Resposta que não é JSON da Graph API (proxy, HTML de erro, corpo vazio).
  // Guardar um trecho do corpo cru evita o "Erro 400" opaco, que não diz nada
  // a quem precisa corrigir a configuração.
  const raw = typeof data?.__raw === "string" ? data.__raw.trim().slice(0, 200) : "";
  return {
    code: undefined,
    message: raw ? `Erro ${status} na Graph API: ${raw}` : `Erro ${status} na Graph API`,
  };
}

async function graphGet(config: MetaApiConfig, path: string): Promise<GraphResult> {
  const fetchFn = config.fetchFn ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 15_000);

  const response = await fetchFn(`${baseUrl}/${config.graphApiVersion}/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let data: Record<string, any>;
  try {
    data = JSON.parse(raw);
  } catch {
    // Preserva o corpo para a mensagem de erro: descartá-lo aqui foi o que
    // produziu diagnósticos opacos do tipo "Erro 400 na Graph API".
    data = { __raw: raw };
  }
  return { ok: response.ok, status: response.status, data };
}

export async function debugToken(config: MetaApiConfig): Promise<TokenInfo> {
  const result = await graphGet(
    config,
    `debug_token?input_token=${encodeURIComponent(config.accessToken)}`,
  );

  if (!result.ok) {
    return {
      valid: false,
      appId: null,
      expiresAt: null,
      scopes: [],
      wabaIds: [],
      error: errorFrom(result.data, result.status),
    };
  }

  const data = result.data?.data ?? {};
  const expiresAtSeconds = Number(data.expires_at);
  const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];
  const wabaIds = granular
    .filter((entry: any) => entry?.scope === "whatsapp_business_management")
    .flatMap((entry: any) => (Array.isArray(entry?.target_ids) ? entry.target_ids : []))
    .map((id: unknown) => String(id));

  return {
    valid: data.is_valid === true,
    appId: data.app_id ? String(data.app_id) : null,
    // expires_at = 0 significa token permanente, não 1970.
    expiresAt:
      Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0
        ? new Date(expiresAtSeconds * 1000).toISOString()
        : null,
    scopes: Array.isArray(data.scopes) ? data.scopes.map((s: unknown) => String(s)) : [],
    wabaIds,
  };
}

export async function listPhoneNumbers(
  config: MetaApiConfig & { wabaId: string },
): Promise<PhoneNumberInfo[]> {
  const result = await graphGet(
    config,
    `${config.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type`,
  );
  // Campo desconhecido derruba a chamada inteira (erro 100). Nesse caso repete
  // sem os campos de coexistência: listar os números é obrigatório, saber da
  // coexistência é desejável.
  const fallback = result.ok ? result : await graphGet(config, `${config.wabaId}/phone_numbers`);
  if (!fallback.ok) throw new Error(errorFrom(fallback.data, fallback.status).message);

  const rows = Array.isArray(fallback.data?.data) ? fallback.data.data : [];
  return rows.map((row: Record<string, any>) => ({
    phoneNumberId: String(row.id ?? ""),
    displayPhoneNumber: row.display_phone_number ? String(row.display_phone_number) : null,
    verifiedName: row.verified_name ? String(row.verified_name) : null,
    qualityRating: row.quality_rating ? String(row.quality_rating) : null,
    isOnBizApp: typeof row.is_on_biz_app === "boolean" ? row.is_on_biz_app : undefined,
    platformType: row.platform_type ? String(row.platform_type) : undefined,
  }));
}

export async function getPhoneNumber(
  config: MetaApiConfig & { phoneNumberId: string },
): Promise<PhoneNumberInfo> {
  const result = await graphGet(
    config,
    `${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`,
  );
  if (!result.ok) throw new Error(errorFrom(result.data, result.status).message);

  const data = result.data ?? {};
  return {
    phoneNumberId: String(data.id ?? config.phoneNumberId),
    displayPhoneNumber: data.display_phone_number ? String(data.display_phone_number) : null,
    verifiedName: data.verified_name ? String(data.verified_name) : null,
    qualityRating: data.quality_rating ? String(data.quality_rating) : null,
    codeVerificationStatus: data.code_verification_status
      ? String(data.code_verification_status)
      : null,
  };
}

export async function getWabaDetails(
  config: MetaApiConfig & { wabaId: string },
): Promise<WabaInfo> {
  const result = await graphGet(config, config.wabaId);
  if (!result.ok) throw new Error(errorFrom(result.data, result.status).message);

  const data = result.data ?? {};
  return {
    wabaId: String(data.id ?? config.wabaId),
    name: data.name ? String(data.name) : null,
    accountReviewStatus: data.account_review_status ? String(data.account_review_status) : null,
  };
}

/** Falta de permissão para ler os apps inscritos não invalida o resto do
 *  diagnóstico: devolve lista vazia e o chamador reporta "não confirmado". */
export async function listSubscribedApps(
  config: MetaApiConfig & { wabaId: string },
): Promise<SubscribedApp[]> {
  const result = await graphGet(config, `${config.wabaId}/subscribed_apps`);
  if (!result.ok) return [];

  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  return rows
    .map((row: Record<string, any>) => row?.whatsapp_business_api_data ?? {})
    .filter((app: Record<string, any>) => app?.id)
    .map((app: Record<string, any>) => ({
      appId: String(app.id),
      name: app.name ? String(app.name) : null,
    }));
}

/**
 * Verificação em cadeia. Cada elo só é consultado se o anterior passou, então
 * um token inválido nunca produz "WABA acessível" por omissão.
 */
export async function verifyConnection(
  config: MetaApiConfig & { wabaId?: string; phoneNumberId?: string; appId?: string },
): Promise<ConnectionVerification> {
  const checkedAt = new Date().toISOString();
  const base: ConnectionVerification = {
    tokenValid: false,
    wabaAccessible: false,
    phoneNumberFound: false,
    webhookSubscribed: false,
    token: null,
    waba: null,
    phoneNumber: null,
    subscribedApps: [],
    checkedAt,
  };

  const token = await debugToken(config);
  base.token = token;
  if (!token.valid) {
    return { ...base, error: token.error ?? { message: "Access token inválido" } };
  }
  base.tokenValid = true;

  const wabaId = config.wabaId || token.wabaIds[0];
  if (!wabaId) {
    return { ...base, error: { message: "O token não dá acesso a nenhuma WABA" } };
  }

  try {
    base.waba = await getWabaDetails({ ...config, wabaId });
    base.wabaAccessible = true;
  } catch (error: any) {
    return { ...base, error: { message: error?.message ?? String(error) } };
  }

  if (config.phoneNumberId) {
    try {
      base.phoneNumber = await getPhoneNumber({ ...config, phoneNumberId: config.phoneNumberId });
      base.phoneNumberFound = true;
    } catch (error: any) {
      base.error = { message: error?.message ?? String(error) };
    }
  }

  base.subscribedApps = await listSubscribedApps({ ...config, wabaId });
  base.webhookSubscribed = config.appId
    ? base.subscribedApps.some((app) => app.appId === config.appId)
    : base.subscribedApps.length > 0;

  return base;
}
