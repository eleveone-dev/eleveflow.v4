// Onboarding completo a partir do código do Embedded Signup: troca o código,
// descobre os ativos autorizados e grava a conexão do tenant.
//
// Regra de sempre: só grava o que a Meta confirmou. Se a troca falhar, se a WABA
// não tiver número ou se o número não puder ser lido, nada é escrito — melhor
// nenhuma conexão do que uma conexão pela metade, que a tela exibiria como se
// estivesse pronta.

import { encryptSecret } from "../crypto.ts";
import { exchangeSignupCode } from "./code-exchange.ts";
import { getPhoneNumber, listPhoneNumbers } from "./meta-diagnostics.ts";
import type { PhoneNumberInfo } from "./meta-diagnostics.ts";

export interface OnboardingEnv {
  graphApiVersion: string;
  appId: string;
  appSecret: string;
  tokenEncryptionKey: string;
}

export interface OnboardingDeps {
  client: { from: (table: string) => any };
  env: OnboardingEnv;
  fetchFn?: typeof fetch;
}

export interface OnboardingSuccess {
  ok: true;
  wabaId: string;
  phoneNumber: PhoneNumberInfo;
  /** Demais números da WABA. A tabela guarda uma conexão por tenant; os outros
   *  ficam disponíveis para troca manual depois. */
  otherNumbers: PhoneNumberInfo[];
  tokenExpiresAt: string | null;
}

export interface OnboardingFailure {
  ok: false;
  error: { code?: string; message: string };
}

export type OnboardingResult = OnboardingSuccess | OnboardingFailure;

export interface OnboardingOptions {
  /** Número indicado pelo evento do Embedded Signup, quando a Meta o envia. */
  phoneNumberId?: string | null;
  /** Sinal do evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING, vindo do browser.
   *  É dado do cliente: só vale quando a Graph não expõe `is_on_biz_app`, e
   *  nunca serve de base para decisão de segurança. */
  coexistenceHint?: boolean;
}

export async function completeSignupOnboarding(
  deps: OnboardingDeps,
  tenantId: string,
  code: string,
  options: OnboardingOptions = {},
): Promise<OnboardingResult> {
  if (!deps.env.tokenEncryptionKey) {
    return { ok: false, error: { message: "WHATSAPP_TOKEN_ENC_KEY não está configurada" } };
  }

  let accessToken = "";
  const exchange = await exchangeSignupCode({
    graphApiVersion: deps.env.graphApiVersion,
    appId: deps.env.appId,
    appSecret: deps.env.appSecret,
    code,
    fetchFn: deps.fetchFn,
    onToken: (token) => {
      accessToken = token;
    },
  });

  if (!exchange.ok) return { ok: false, error: exchange.error };

  const wabaId = exchange.wabaIds[0];
  const api = {
    graphApiVersion: deps.env.graphApiVersion,
    accessToken,
    fetchFn: deps.fetchFn,
  };

  let numbers: PhoneNumberInfo[];
  try {
    numbers = await listPhoneNumbers({ ...api, wabaId });
  } catch (error: any) {
    return {
      ok: false,
      error: { message: error?.message ?? "Falha ao listar os números da WABA" },
    };
  }

  if (numbers.length === 0) {
    return {
      ok: false,
      error: {
        message:
          "A conta do WhatsApp Business autorizada não tem nenhum número. Conclua a adição do número no fluxo da Meta.",
      },
    };
  }

  const wanted = options.phoneNumberId?.trim();
  const chosen = wanted ? numbers.find((n) => n.phoneNumberId === wanted) : undefined;

  if (wanted && !chosen) {
    return {
      ok: false,
      error: {
        code: "phone_number_not_in_waba",
        message: `O número ${wanted} não está na conta autorizada.`,
      },
    };
  }

  if (!chosen && numbers.length > 1) {
    // Conectar o número errado em silêncio é pior do que falhar: o tenant só
    // descobriria quando a primeira mensagem saísse pela linha errada.
    const lista = numbers
      .map((n) => `${n.phoneNumberId} (${n.displayPhoneNumber ?? "sem número"})`)
      .join(", ");
    return {
      ok: false,
      error: {
        code: "ambiguous_phone_number",
        message: `A conta autorizada tem ${numbers.length} números e nenhum foi indicado: ${lista}.`,
      },
    };
  }

  const selected = chosen ?? numbers[0];

  // Relê o número escolhido para gravar o que a Meta devolve agora, não o que
  // veio na listagem — os campos da listagem são um subconjunto.
  let confirmed: PhoneNumberInfo;
  try {
    confirmed = await getPhoneNumber({ ...api, phoneNumberId: selected.phoneNumberId });
  } catch (error: any) {
    return { ok: false, error: { message: error?.message ?? "Falha ao ler o número escolhido" } };
  }

  // Servidor manda; a dica do browser só entra quando a Graph não expõe o campo.
  const coexistence =
    typeof selected.isOnBizApp === "boolean"
      ? selected.isOnBizApp
      : Boolean(options.coexistenceHint);

  const { error } = await deps.client.from("whatsapp_connections").upsert(
    {
      tenant_id: tenantId,
      status: "connected",
      waba_id: wabaId,
      phone_number_id: confirmed.phoneNumberId,
      display_phone_number: confirmed.displayPhoneNumber,
      display_name: confirmed.verifiedName,
      quality_rating: confirmed.qualityRating,
      coexistence_enabled: coexistence,
      access_token_encrypted: await encryptSecret(accessToken, deps.env.tokenEncryptionKey),
      token_type: exchange.tokenExpiresAt ? "user" : "system_user",
      token_expires_at: exchange.tokenExpiresAt,
      // A inscrição do app na WABA é uma chamada à parte (etapa 4E). Marcar aqui
      // repetiria o falso positivo que já corrigimos uma vez.
      webhook_subscribed_at: null,
      last_sync_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );

  if (error) {
    return { ok: false, error: { message: error.message } };
  }

  return {
    ok: true,
    wabaId,
    phoneNumber: confirmed,
    otherNumbers: numbers.filter((n) => n.phoneNumberId !== selected.phoneNumberId),
    tokenExpiresAt: exchange.tokenExpiresAt,
  };
}
