// Configuração pública do Embedded Signup.
//
// App ID e Configuration ID não são segredos — aparecem no HTML do cliente
// quando o SDK da Meta é inicializado. Mesmo assim ficam em `global_settings`,
// administrados pelo backend: assim mudam sem rebuild da Vercel e a lista do que
// é público fica explícita num lugar só.
//
// O que é segredo (App Secret, access token, verify token) nunca passa por aqui.

const DEFAULT_GRAPH_API_VERSION = "v25.0";

export const APP_ID_KEY = "meta_app_id";
export const CONFIG_ID_KEY = "meta_embedded_signup_config_id";
export const ENABLED_KEY = "meta_embedded_signup_enabled";
export const GRAPH_VERSION_KEY = "meta_graph_api_version";

export interface PublicMetaConfig {
  appId: string | null;
  configId: string | null;
  graphApiVersion: string;
  enabled: boolean;
}

export interface EmbeddedSignupInput {
  appId: string;
  configId: string;
  enabled: boolean;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

type MinimalClient = { from: (table: string) => any };

/** Ids da Meta são numéricos e longos; 15–17 dígitos é o tamanho usual. */
function isPlausibleMetaId(value: string): boolean {
  return /^[0-9]{10,20}$/.test(value);
}

export function validateEmbeddedSignupInput(input: EmbeddedSignupInput): ValidationResult {
  const appId = String(input.appId ?? "").trim();
  const configId = String(input.configId ?? "").trim();

  if (appId && !isPlausibleMetaId(appId)) {
    return { ok: false, error: "Meta App ID deve conter apenas dígitos (10 a 20)" };
  }
  if (configId && !isPlausibleMetaId(configId)) {
    return {
      ok: false,
      error: "Embedded Signup Configuration ID deve conter apenas dígitos (10 a 20)",
    };
  }

  // Habilitar sem os ids produziria um botão que abre o SDK sem parâmetros e
  // falha de forma opaca para o usuário final.
  if (input.enabled && !appId) {
    return { ok: false, error: "Informe o Meta App ID antes de habilitar o Embedded Signup" };
  }
  if (input.enabled && !configId) {
    return {
      ok: false,
      error: "Informe o Embedded Signup Configuration ID antes de habilitar o Embedded Signup",
    };
  }

  return { ok: true };
}

async function readSettings(
  client: MinimalClient,
  keys: string[],
): Promise<Record<string, string>> {
  const { data } = await client.from("global_settings").select("key, value").in("key", keys);
  const rows = Array.isArray(data) ? data : [];
  return Object.fromEntries(
    rows
      .filter((row: any) => typeof row?.key === "string")
      .map((row: any) => [row.key, String(row.value ?? "")]),
  );
}

/**
 * Devolve exatamente os quatro campos que o frontend precisa para iniciar o SDK.
 * A lista de chaves lidas é fechada: nenhuma outra entrada de `global_settings`
 * pode escapar por aqui, nem por engano futuro.
 */
export async function readPublicMetaConfig(client: MinimalClient): Promise<PublicMetaConfig> {
  const values = await readSettings(client, [
    APP_ID_KEY,
    CONFIG_ID_KEY,
    ENABLED_KEY,
    GRAPH_VERSION_KEY,
  ]);

  const appId = values[APP_ID_KEY]?.trim() || null;
  const configId = values[CONFIG_ID_KEY]?.trim() || null;
  const flag = values[ENABLED_KEY]?.trim().toLowerCase() === "true";

  return {
    appId,
    configId,
    graphApiVersion: values[GRAPH_VERSION_KEY]?.trim() || DEFAULT_GRAPH_API_VERSION,
    // Nunca reportar habilitado sem os dois ids, mesmo que a flag diga o
    // contrário: o frontend usa este campo para decidir se mostra o botão.
    enabled: flag && !!appId && !!configId,
  };
}

async function upsertSetting(client: MinimalClient, key: string, value: string): Promise<void> {
  const { data: existing } = await client
    .from("global_settings")
    .select("key")
    .eq("key", key)
    .maybeSingle();

  if (existing) {
    const { error } = await client.from("global_settings").update({ value }).eq("key", key);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await client.from("global_settings").insert({ key, value });
  if (error) throw new Error(error.message);
}

export async function saveEmbeddedSignupConfig(
  client: MinimalClient,
  input: EmbeddedSignupInput,
): Promise<PublicMetaConfig> {
  const validation = validateEmbeddedSignupInput(input);
  if (!validation.ok) throw new Error(validation.error);

  await upsertSetting(client, APP_ID_KEY, String(input.appId ?? "").trim());
  await upsertSetting(client, CONFIG_ID_KEY, String(input.configId ?? "").trim());
  await upsertSetting(client, ENABLED_KEY, input.enabled ? "true" : "false");

  return readPublicMetaConfig(client);
}
