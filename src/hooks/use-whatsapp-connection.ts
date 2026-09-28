import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** `untested` é ausência de evidência; `failed` é evidência de falha. A tela
 *  precisa distinguir os dois — tratá-los igual foi o que fez a página mentir. */
export type CheckState = "ok" | "failed" | "missing" | "untested" | "unknown";

export interface ConnectionChecks {
  credentials: CheckState;
  connection: CheckState;
  phoneNumber: CheckState;
  webhook: CheckState;
  outbound: CheckState;
  inbound: CheckState;
}

export interface PhoneNumberInfo {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus?: string | null;
}

export interface WabaInfo {
  wabaId: string;
  name: string | null;
  accountReviewStatus: string | null;
}

export interface OutboundProof {
  wamid: string;
  status: string;
  at: string;
}

export interface InboundProof {
  wamid: string;
  at: string;
}

export interface ConnectionState {
  configured: boolean;
  checks: ConnectionChecks;
  phoneNumber: PhoneNumberInfo | null;
  waba: WabaInfo | null;
  tokenExpiresAt: string | null;
  verifiedAt: string | null;
  outboundProof: OutboundProof | null;
  inboundProof: InboundProof | null;
  error?: { code?: string; message: string };
}

async function callAdmin<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("meta-whatsapp-admin", { body });
  if (error) throw new Error(error.message);
  if (data && data.success === false) {
    throw new Error(data.error ?? "Falha ao falar com a Meta");
  }
  return data as T;
}

/**
 * Estado verificado contra a Graph API. Não há cache longo de propósito: um
 * diagnóstico velho é exatamente o que não queremos exibir como se fosse atual.
 */
export function useWhatsappConnection() {
  return useQuery<ConnectionState>({
    queryKey: ["whatsapp-connection-state"],
    queryFn: async () => {
      const result = await callAdmin<{ state: ConnectionState }>({ action: "diagnose" });
      return result.state;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export interface DiscoveredNumber {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

export interface TokenValidation {
  token: { appId: string | null; expiresAt: string | null; scopes: string[] };
  wabaId: string;
  wabaIds: string[];
  numbers: DiscoveredNumber[];
}

/** Passo 1 da configuração: valida o token e descobre os números reais. Nada é
 *  gravado aqui — o operador ainda precisa escolher um número. */
export function useValidateMetaToken() {
  return useMutation<TokenValidation, Error, { accessToken: string; wabaId?: string }>({
    mutationFn: (input) => callAdmin<TokenValidation>({ action: "validate-token", ...input }),
  });
}

/** Passo 2: grava só identificadores que a Meta confirmou. */
export function useSaveMetaConnection() {
  const queryClient = useQueryClient();
  return useMutation<
    { state: ConnectionState },
    Error,
    { accessToken: string; phoneNumberId: string; wabaId?: string }
  >({
    mutationFn: (input) =>
      callAdmin<{ state: ConnectionState }>({ action: "save-connection", ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-connection-state"] });
    },
  });
}

export type AppEnvironment = "development" | "preview" | "production";

export function appEnvironment(): AppEnvironment {
  const vercelEnv = import.meta.env.VITE_VERCEL_ENV as string | undefined;
  if (vercelEnv === "preview") return "preview";
  if (vercelEnv === "production") return "production";
  return import.meta.env.DEV ? "development" : "production";
}
