// Troca do código do Embedded Signup por um Business Integration System User
// access token — server-to-server, porque exige o App Secret.
//
// Endpoint conferido na doc oficial em 2026-08-03:
//   GET /{version}/oauth/access_token?client_id=&client_secret=&code=
//
// O código tem TTL de 30 segundos. Por isso a troca acontece assim que ele
// chega, sem passar por confirmação de tela — pedir "deseja continuar?" no meio
// faria o código expirar antes da resposta.
//
// O token do cliente nunca volta no retorno: sai apenas pelo callback `onToken`,
// para quem for cifrar e persistir. Assim nenhuma camada acima consegue vazá-lo
// por engano numa resposta HTTP.

import { debugToken } from "./meta-diagnostics.ts";

const DEFAULT_BASE_URL = "https://graph.facebook.com";

export interface ExchangeParams {
  graphApiVersion: string;
  appId: string;
  appSecret: string;
  code: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Recebe o token do cliente para cifrar e guardar. Nunca logar aqui. */
  onToken?: (accessToken: string) => Promise<void> | void;
}

export interface ExchangeSuccess {
  ok: true;
  appId: string | null;
  wabaIds: string[];
  scopes: string[];
  tokenExpiresAt: string | null;
}

export interface ExchangeFailure {
  ok: false;
  error: { code?: string; message: string };
}

export type ExchangeResult = ExchangeSuccess | ExchangeFailure;

export async function exchangeSignupCode(params: ExchangeParams): Promise<ExchangeResult> {
  const code = String(params.code ?? "").trim();
  if (!code) {
    return { ok: false, error: { message: "Código do Embedded Signup ausente" } };
  }
  if (!String(params.appSecret ?? "").trim()) {
    return { ok: false, error: { message: "App Secret não está configurado no servidor" } };
  }

  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = (params.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  const url = new URL(`${baseUrl}/${params.graphApiVersion}/oauth/access_token`);
  url.searchParams.set("client_id", params.appId);
  url.searchParams.set("client_secret", params.appSecret);
  url.searchParams.set("code", code);

  const response = await fetchFn(url.toString(), {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });

  let data: Record<string, any>;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = {};
  }

  if (!response.ok || !data?.access_token) {
    const code_ = data?.error?.code;
    return {
      ok: false,
      error: {
        code: code_ === undefined || code_ === null ? undefined : String(code_),
        message:
          typeof data?.error?.message === "string"
            ? data.error.message
            : "A Meta não devolveu um access token para este código",
      },
    };
  }

  const accessToken = String(data.access_token);

  // O token precisa ser inspecionado antes de valer: um token válido para outro
  // app, ou sem acesso a WABA, não serve para conectar ninguém.
  const info = await debugToken({
    graphApiVersion: params.graphApiVersion,
    accessToken,
    baseUrl: params.baseUrl,
    fetchFn: params.fetchFn,
  });

  if (!info.valid) {
    return {
      ok: false,
      error: info.error ?? { message: "A Meta devolveu um token inválido" },
    };
  }
  if (info.appId && info.appId !== params.appId) {
    return {
      ok: false,
      error: { message: "O token devolvido pertence a outro app e não pode ser usado" },
    };
  }
  if (info.wabaIds.length === 0) {
    return {
      ok: false,
      error: {
        message:
          "O token não dá acesso a nenhuma WABA. Confirme se a conta do WhatsApp Business foi compartilhada no fluxo.",
      },
    };
  }

  await params.onToken?.(accessToken);

  return {
    ok: true,
    appId: info.appId,
    wabaIds: info.wabaIds,
    scopes: info.scopes,
    tokenExpiresAt: info.expiresAt,
  };
}
