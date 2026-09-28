// Estado da conexão de um tenant, montado só com o que pode ser comprovado.
//
// Regra: nada é "ok" por estar gravado no banco. Token, WABA, número e webhook
// vêm de uma chamada real à Graph API; envio e recebimento saem da prova que o
// webhook da Meta gravou na própria conexão — nunca de uma varredura em
// `messages`, que confundia mock da Evolution com tráfego real.

import { decryptSecret } from "../crypto.ts";
import { verifyConnection } from "./meta-diagnostics.ts";
import type { PhoneNumberInfo, WabaInfo } from "./meta-diagnostics.ts";
import { isRealMetaPhoneNumberId, isRealMetaWamid } from "./connection-proof.ts";

/** `untested` é diferente de `failed`: um nunca foi exercitado, o outro falhou. */
export type CheckState = "ok" | "failed" | "missing" | "untested" | "unknown";

export interface ConnectionChecks {
  credentials: CheckState;
  connection: CheckState;
  phoneNumber: CheckState;
  webhook: CheckState;
  outbound: CheckState;
  inbound: CheckState;
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

export interface ConnectionStateEnv {
  metaGraphApiVersion: string;
  tokenEncryptionKey?: string;
  metaAppId?: string;
}

export interface ConnectionStateDeps {
  client: { from: (table: string) => any };
  env: ConnectionStateEnv;
  fetchFn?: typeof fetch;
}

const EMPTY_CHECKS: ConnectionChecks = {
  credentials: "missing",
  connection: "unknown",
  phoneNumber: "unknown",
  webhook: "unknown",
  outbound: "untested",
  inbound: "untested",
};

/**
 * A prova de tráfego vive na própria conexão, gravada por evento do webhook da
 * Meta (ver connection-proof.ts). Ela só é aceita se a conexão ainda estiver
 * conectada, com um Phone Number ID numérico e um wamid de verdade — uma prova
 * de outra conexão, ou vinda de mock, não vale.
 */
function readProofs(connection: Record<string, any> | null): {
  outbound: OutboundProof | null;
  inbound: InboundProof | null;
} {
  if (
    !connection ||
    connection.status !== "connected" ||
    !isRealMetaPhoneNumberId(connection.phone_number_id)
  ) {
    return { outbound: null, inbound: null };
  }

  const outboundOk =
    isRealMetaWamid(connection.last_meta_outbound_wamid) &&
    !!connection.last_meta_outbound_test_at &&
    ["sent", "delivered", "read"].includes(String(connection.last_meta_outbound_status));

  const inboundOk =
    isRealMetaWamid(connection.last_meta_inbound_wamid) && !!connection.last_meta_inbound_test_at;

  return {
    outbound: outboundOk
      ? {
          wamid: String(connection.last_meta_outbound_wamid),
          status: String(connection.last_meta_outbound_status),
          at: String(connection.last_meta_outbound_test_at),
        }
      : null,
    inbound: inboundOk
      ? {
          wamid: String(connection.last_meta_inbound_wamid),
          at: String(connection.last_meta_inbound_test_at),
        }
      : null,
  };
}

export async function buildConnectionState(
  deps: ConnectionStateDeps,
  tenantId: string,
): Promise<ConnectionState> {
  const { data: connection } = await deps.client
    .from("whatsapp_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const proofs = readProofs(connection ?? null);
  const traffic = {
    outbound: (proofs.outbound ? "ok" : "untested") as CheckState,
    inbound: (proofs.inbound ? "ok" : "untested") as CheckState,
  };

  if (!connection?.access_token_encrypted) {
    return {
      configured: false,
      checks: { ...EMPTY_CHECKS, ...traffic },
      phoneNumber: null,
      waba: null,
      tokenExpiresAt: null,
      verifiedAt: null,
      outboundProof: null,
      inboundProof: null,
    };
  }

  if (!deps.env.tokenEncryptionKey) {
    return {
      configured: true,
      checks: { ...EMPTY_CHECKS, credentials: "failed", ...traffic },
      phoneNumber: null,
      waba: null,
      tokenExpiresAt: null,
      verifiedAt: null,
      outboundProof: null,
      inboundProof: null,
      error: { message: "WHATSAPP_TOKEN_ENC_KEY não está configurada no ambiente" },
    };
  }

  let accessToken: string;
  try {
    accessToken = await decryptSecret(
      connection.access_token_encrypted,
      deps.env.tokenEncryptionKey,
    );
  } catch (error: any) {
    return {
      configured: true,
      checks: { ...EMPTY_CHECKS, credentials: "failed", ...traffic },
      phoneNumber: null,
      waba: null,
      tokenExpiresAt: null,
      verifiedAt: null,
      outboundProof: null,
      inboundProof: null,
      error: { message: error?.message ?? "Não foi possível descriptografar o token" },
    };
  }

  const verification = await verifyConnection({
    graphApiVersion: deps.env.metaGraphApiVersion,
    accessToken,
    wabaId: connection.waba_id ?? undefined,
    phoneNumberId: connection.phone_number_id ?? undefined,
    appId: deps.env.metaAppId,
    fetchFn: deps.fetchFn,
  });

  const connectionOk = verification.tokenValid && verification.wabaAccessible;
  // Token recusado agora invalida a prova antiga: ela não diz nada sobre o
  // estado atual da conexão.
  const provenTraffic = connectionOk
    ? traffic
    : { outbound: "untested" as CheckState, inbound: "untested" as CheckState };

  return {
    configured: true,
    checks: {
      credentials: "ok",
      connection: connectionOk ? "ok" : "failed",
      phoneNumber: connectionOk
        ? verification.phoneNumberFound
          ? "ok"
          : connection.phone_number_id
            ? "failed"
            : "missing"
        : "unknown",
      webhook: connectionOk ? (verification.webhookSubscribed ? "ok" : "failed") : "unknown",
      ...provenTraffic,
    },
    phoneNumber: verification.phoneNumber,
    waba: verification.waba,
    tokenExpiresAt: verification.token?.expiresAt ?? null,
    verifiedAt: verification.checkedAt,
    outboundProof: connectionOk ? proofs.outbound : null,
    inboundProof: connectionOk ? proofs.inbound : null,
    error: verification.error,
  };
}
