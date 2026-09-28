// Resolução de lead por telefone, compartilhada pelo inbound e pelo eco do
// WhatsApp Business App. Saiu de dentro do inbound-orchestrator sem mudança de
// regra: mesmas variantes de nono dígito, mesmo corte em 3.

import { phoneVariants } from "./crm-parse.ts";

export type LeadResolution =
  | { kind: "found"; lead: any; normalized: string }
  | { kind: "none"; normalized: string }
  | { kind: "ambiguous"; leads: Array<{ id: string }>; normalized: string };

export async function resolveLead(
  client: { from: (table: string) => any },
  tenantId: string,
  phone: string,
): Promise<LeadResolution> {
  // phoneVariants espera dígitos (o parâmetro dela se chama `digits`). Chamador
  // pode passar número formatado; normalizar aqui evita "lead não encontrado"
  // silencioso.
  const variants = phoneVariants(String(phone ?? "").replace(/\D/g, ""));
  const normalized = variants[0] ?? "";

  const { data, error } = await client
    .from("leads")
    .select("*")
    .eq("user_id", tenantId)
    .in("phone_normalized", variants)
    .limit(3);

  if (error) throw error;

  const leads = data || [];
  if (leads.length === 0) return { kind: "none", normalized };
  if (leads.length > 1) return { kind: "ambiguous", leads, normalized };
  return { kind: "found", lead: leads[0], normalized };
}
