// Dedupe por wamid. A Meta reentrega webhook: sem isto, a mesma mensagem vira
// duas linhas e, no caso do eco, renovaria a pausa indevidamente.

export async function isAlreadyRegistered(
  client: { from: (table: string) => any },
  tenantId: string,
  providerMessageId: string | null | undefined,
  direction: "inbound" | "outbound",
): Promise<boolean> {
  if (!providerMessageId) return false;

  const { data } = await client
    .from("messages")
    .select("id")
    .eq("whatsapp_id", providerMessageId)
    .eq("direction", direction)
    .eq("user_id", tenantId)
    .limit(1)
    .maybeSingle();

  return Boolean(data);
}
