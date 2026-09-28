// Aplica status de entrega em messages.status. Idempotente e monotônico: um
// webhook repetido ou fora de ordem nunca regride o estado de uma entrega.

import { type StatusUpdate } from "./types.ts";
import { recordOutboundProof } from "./connection-proof.ts";

const RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export async function applyStatusUpdates(
  client: { from: (table: string) => any },
  tenantId: string,
  statuses: StatusUpdate[],
  /** Número que recebeu o evento. Sem ele não há como provar que o status é
   *  desta conexão, e a prova de envio não é gravada. */
  phoneNumberId?: string,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const update of statuses) {
    if (!update.providerMessageId) {
      skipped += 1;
      continue;
    }

    const { data: message } = await client
      .from("messages")
      .select("id, status")
      .eq("user_id", tenantId)
      .eq("whatsapp_id", update.providerMessageId)
      .maybeSingle();

    if (!message) {
      skipped += 1;
      continue;
    }

    const isFailure = update.status === "failed";
    const currentRank = RANK[String(message.status ?? "pending")] ?? 0;
    const nextRank = RANK[update.status] ?? 0;

    if (!isFailure && nextRank <= currentRank) {
      skipped += 1;
      continue;
    }

    const { error } = await client
      .from("messages")
      .update({ status: update.status })
      .eq("id", message.id)
      .eq("user_id", tenantId);

    if (error) {
      skipped += 1;
      continue;
    }
    applied += 1;

    // Um status confirmado pela Meta é a única prova de que o envio funcionou:
    // resposta 200 do POST de envio não diz nada sobre entrega.
    if (phoneNumberId) {
      await recordOutboundProof(client, tenantId, phoneNumberId, {
        providerMessageId: update.providerMessageId,
        status: update.status,
      });
    }
  }

  return { applied, skipped };
}
