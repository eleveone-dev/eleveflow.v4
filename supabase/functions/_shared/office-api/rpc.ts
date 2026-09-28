// Chamada de funcao SQL da office-api. Erro do banco vira 500; a mensagem vai so para
// o log da funcao.

export type Cliente = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};
export type Item = Record<string, any>;

export async function chamar<T = Item[]>(
  client: Cliente,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data ?? []) as T;
}
