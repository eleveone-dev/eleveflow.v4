// Resolve a conta dona de uma instancia da Evolution.
//
// O inbound da Evolution nao carrega identificacao de tenant: carrega o nome da
// instancia que recebeu a mensagem. Sem traduzir isso para um tenant_id antes de
// tocar em lead, a busca por telefone roda sobre todas as contas e a mensagem de
// um cliente cai no CRM de outro.
//
// A fonte de verdade e `whatsapp_connections`, que tem indice unico parcial em
// instance_name: duas contas na mesma instancia e impossivel pelo banco.
//
// Deno-free: o Vitest importa este arquivo em Node.

export type InstanceTenant =
  | { ok: true; tenantId: string }
  | { ok: false; reason: "missing_instance" | "unknown_instance" };

export interface InstanceLookupClient {
  from: (table: string) => any;
}

export async function resolveTenantByInstance(
  client: InstanceLookupClient,
  instance: unknown,
): Promise<InstanceTenant> {
  if (typeof instance !== "string" || instance.trim() === "") {
    return { ok: false, reason: "missing_instance" };
  }

  const { data, error } = await client
    .from("whatsapp_connections")
    .select("tenant_id")
    .eq("provider", "evolution")
    .eq("instance_name", instance.trim())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.tenant_id) return { ok: false, reason: "unknown_instance" };

  return { ok: true, tenantId: data.tenant_id };
}
