import { HttpError } from "../http-error.ts";
import { decodificarCursor } from "./cursor.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SEQUENCIA = /^\d+$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SITUACOES = ["em_andamento", "ganha", "perdida"] as const;

export function lerLimite(valor: string | null): number {
  if (valor === null) return 100;
  if (!/^\d+$/.test(valor) || Number(valor) < 1 || Number(valor) > 500) {
    throw new HttpError(400, "limite deve ser um inteiro de 1 a 500");
  }
  return Number(valor);
}

export function lerData(nome: string, valor: string | null): string | null {
  if (valor === null) return null;
  if (!DATA_ISO.test(valor) || Number.isNaN(Date.parse(valor))) {
    throw new HttpError(400, `${nome} deve ser uma data ISO 8601`);
  }
  return valor;
}

export function lerUuid(nome: string, valor: string | null): string | null {
  if (valor === null) return null;
  if (!UUID.test(valor)) throw new HttpError(400, `${nome} deve ser um uuid`);
  return valor;
}

export function lerSituacao(valor: string | null): (typeof SITUACOES)[number] | null {
  if (valor === null) return null;
  if (!(SITUACOES as readonly string[]).includes(valor)) {
    throw new HttpError(400, `situacao deve ser ${SITUACOES.join(", ")}`);
  }
  return valor as (typeof SITUACOES)[number];
}

export function lerCursor(
  valor: string | null,
  formatoId: RegExp,
): { instante: string; id: string } | null {
  return valor === null ? null : decodificarCursor(valor, formatoId);
}
