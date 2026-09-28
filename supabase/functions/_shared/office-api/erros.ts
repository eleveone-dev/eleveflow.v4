// Corpo de erro da office-api: { erro: { codigo, mensagem } }, com a tarefa atual
// quando o Office precisa dela para decidir (409 e 412).

import { HttpError } from "../http-error.ts";

export const CODIGOS: Record<number, string> = {
  400: "parametro_invalido",
  401: "token_invalido",
  403: "escopo_insuficiente",
  404: "nao_encontrado",
  405: "metodo_nao_permitido",
  409: "transicao_invalida",
  412: "versao_desatualizada",
  428: "versao_obrigatoria",
  429: "limite_excedido",
  500: "erro_interno",
};

export class ErroApi extends HttpError {
  constructor(
    status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(status, message);
  }
}

export function corpoDeErro(status: number, mensagem: string, extra: Record<string, unknown> = {}) {
  return { erro: { codigo: CODIGOS[status] ?? CODIGOS[500], mensagem }, ...extra };
}
