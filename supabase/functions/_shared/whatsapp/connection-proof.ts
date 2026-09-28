// Prova de que a conexão Meta trafegou de verdade.
//
// A gravação acontece por evento — só quem passou pela verificação de assinatura
// do webhook da Meta chega aqui. Nunca por varredura de `messages`: foi assim
// que mocks da Evolution (`mock-…`) e fixtures de E2E marcaram "envio testado"
// numa conta sem nenhuma conexão configurada.

import type { DeliveryStatus } from "./types.ts";

const PROOF_STATUSES: DeliveryStatus[] = ["sent", "delivered", "read"];
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/** Phone Number ID da Meta é um id numérico — não é o telefone, nem um rótulo
 *  inventado como `E2E-PNID-…`. */
export function isRealMetaPhoneNumberId(value: unknown): boolean {
  return typeof value === "string" && /^[0-9]{6,}$/.test(value);
}

/** wamid real sempre começa com `wamid.`; `mock-…` e `E2E-…` não são da Meta. */
export function isRealMetaWamid(value: unknown): boolean {
  return typeof value === "string" && /^wamid\./.test(value) && value.length > "wamid.".length;
}

async function loadConnection(
  client: { from: (table: string) => any },
  tenantId: string,
  phoneNumberId: string,
) {
  if (!isRealMetaPhoneNumberId(phoneNumberId)) return null;

  const { data } = await client
    .from("whatsapp_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // O evento precisa ser do número que está conectado agora: um webhook de
  // outro número não prova nada sobre esta conexão.
  if (!data || data.phone_number_id !== phoneNumberId) return null;
  return data;
}

export async function recordOutboundProof(
  client: { from: (table: string) => any },
  tenantId: string,
  phoneNumberId: string,
  update: { providerMessageId: string; status: string },
): Promise<boolean> {
  if (!isRealMetaWamid(update.providerMessageId)) return false;
  if (!(PROOF_STATUSES as string[]).includes(update.status)) return false;

  const connection = await loadConnection(client, tenantId, phoneNumberId);
  if (!connection) return false;

  // Monotônico: um webhook fora de ordem não rebaixa uma entrega já confirmada.
  const currentRank = STATUS_RANK[String(connection.last_meta_outbound_status ?? "")] ?? 0;
  if ((STATUS_RANK[update.status] ?? 0) <= currentRank) return false;

  const { error } = await client
    .from("whatsapp_connections")
    .update({
      last_meta_outbound_wamid: update.providerMessageId,
      last_meta_outbound_status: update.status,
      last_meta_outbound_test_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId);

  return !error;
}

export async function recordInboundProof(
  client: { from: (table: string) => any },
  tenantId: string,
  phoneNumberId: string,
  wamid: string,
): Promise<boolean> {
  if (!isRealMetaWamid(wamid)) return false;

  const connection = await loadConnection(client, tenantId, phoneNumberId);
  if (!connection) return false;

  const { error } = await client
    .from("whatsapp_connections")
    .update({
      last_meta_inbound_wamid: wamid,
      last_meta_inbound_test_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId);

  return !error;
}
