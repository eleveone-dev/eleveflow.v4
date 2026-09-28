import { codificarCursor } from "./cursor.ts";

export interface Pagina<T> {
  dados: T[];
  proximo_cursor: string | null;
  tem_mais: boolean;
}

/** `itens` vem com ate limite + 1: o excedente so diz que ha mais. */
export function montarPagina<T>(
  itens: T[],
  limite: number,
  cursorRecebido: string | null,
  chave: (item: T) => [string, string],
): Pagina<T> {
  const dados = itens.slice(0, limite);
  const ultimo = dados[dados.length - 1];
  return {
    dados,
    proximo_cursor: ultimo ? codificarCursor(...chave(ultimo)) : cursorRecebido,
    tem_mais: itens.length > limite,
  };
}
