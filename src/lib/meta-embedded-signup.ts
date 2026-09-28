// Parâmetros e leitura de eventos do WhatsApp Embedded Signup.
//
// Isolado do componente de propósito: são as regras que decidem qual fluxo a
// Meta abre e em quem podemos confiar. Testáveis sem SDK, sem DOM e sem rede.
//
// Formatos conferidos na doc oficial em 2026-08-03:
//   FB.login(cb, { config_id, response_type: "code",
//                  override_default_response_type: true, extras })
//   coexistência exige extras.featureType = "whatsapp_business_app_onboarding"
//   e extras.sessionInfoVersion = "3"; a conclusão chega como o evento
//   FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING.
//
// A versão do fluxo (v2/v3/v4) NÃO é parâmetro: ela vem dos produtos marcados
// na configuração do Facebook Login for Business.

export interface MetaPublicConfigLike {
  appId: string | null;
  configId: string | null;
  graphApiVersion: string;
  enabled: boolean;
}

export interface LoginParams {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: {
    setup: Record<string, never>;
    featureType: string;
    sessionInfoVersion: string;
  };
}

/**
 * Coexistência: conecta um número que continua em uso no WhatsApp Business App.
 * Sem `featureType`, a Meta abre o fluxo de número novo — que exigiria apagar a
 * conta do aparelho. Por isso o valor é fixo aqui e coberto por teste.
 */
export function buildLoginParams(config: MetaPublicConfigLike): LoginParams {
  const configId = config.configId?.trim();
  if (!configId) throw new Error("Configuration ID não configurado");

  return {
    config_id: configId,
    response_type: "code",
    override_default_response_type: true,
    extras: {
      // Exatamente os campos dos exemplos oficiais (Implementation § passo 3 e
      // "Onboard WhatsApp Business app users" § passo 2).
      //
      // Nada de `version`: a geração do fluxo vem da configuração do Facebook
      // Login for Business — "Selecting the products will automatically set you
      // to v4". O `version: "v4"` que estava aqui foi copiado do link do Hosted
      // ES, que é outro produto com outros parâmetros.
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
    },
  };
}

const META_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "web.facebook.com",
  "business.facebook.com",
]);

/**
 * Compara o host inteiro, não o sufixo. `endsWith("facebook.com")` — que a doc
 * usa no exemplo — aceitaria `https://malicious-facebook.com`, e o listener
 * recebe dados de onboarding de um domínio que não controlamos.
 */
export function isTrustedMetaOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && META_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export type SignupEvent =
  | { kind: "finish"; coexistence: boolean; wabaId: string | null; phoneNumberId: string | null }
  | { kind: "cancel"; step: string | null }
  | { kind: "error"; message: string };

/** Devolve null para qualquer coisa que não seja um evento do Embedded Signup. */
export function parseSignupEvent(raw: unknown): SignupEvent | null {
  let payload: any = raw;

  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== "object") return null;
  if (payload.type !== "WA_EMBEDDED_SIGNUP") return null;

  const data = payload.data ?? {};
  const event = String(payload.event ?? "");

  if (event === "FINISH" || event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    return {
      kind: "finish",
      coexistence: event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId: data.waba_id ? String(data.waba_id) : null,
      phoneNumberId: data.phone_number_id ? String(data.phone_number_id) : null,
    };
  }

  if (event === "CANCEL") {
    return { kind: "cancel", step: data.current_step ? String(data.current_step) : null };
  }

  if (event === "ERROR") {
    return { kind: "error", message: String(data.error_message ?? "Erro no fluxo da Meta") };
  }

  return null;
}
