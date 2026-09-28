// Uma linha por chamada, sem conteudo, parametro com dado de lead ou token.
// Falha aqui nao derruba a resposta: vai para o log da funcao.

export interface Chamada {
  tokenId: string | null;
  userId: string | null;
  metodo: string;
  rota: string;
  status: number;
  itens: number | null;
  duracaoMs: number;
}

export async function registrarChamada(
  client: { from: (table: string) => any },
  chamada: Chamada,
): Promise<void> {
  const { error } = await client.from("api_request_log").insert({
    token_id: chamada.tokenId,
    user_id: chamada.userId,
    method: chamada.metodo,
    route: chamada.rota,
    status: chamada.status,
    items: chamada.itens,
    duration_ms: chamada.duracaoMs,
  });
  if (error)
    console.error(JSON.stringify({ event: "api_request_log_falhou", error: error.message }));
}
