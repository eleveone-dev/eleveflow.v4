// Limite por token: as ultimas chamadas em api_request_log. Se a de numero
// `limitePorMinuto` foi ha menos de 60 s, a janela esta cheia.

export async function verificarLimite(
  client: { from: (table: string) => any },
  tokenId: string,
  limitePorMinuto: number,
  agora = Date.now(),
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const { data, error } = await client
    .from("api_request_log")
    .select("created_at")
    .eq("token_id", tokenId)
    .order("created_at", { ascending: false })
    .limit(limitePorMinuto);
  if (error) throw error;

  const chamadas = data ?? [];
  if (chamadas.length < limitePorMinuto) return { ok: true };

  const decorrido = agora - new Date(chamadas[limitePorMinuto - 1].created_at).getTime();
  if (decorrido >= 60_000) return { ok: true };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - decorrido) / 1000)) };
}
