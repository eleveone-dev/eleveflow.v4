// Parametros da API de leitura do Eleve Sales Coach. Deno-free: o Vitest importa
// este arquivo em Node. Quem chama e resolvido por _shared/api-token.ts: a conta
// sai do token, nunca da requisicao.

import { HttpError } from "./http-error.ts";

export interface CoachParams {
  periodo_dias: number;
  parado_dias: number;
  followup_horas: number;
  limite: number;
}

const LIMITES: Record<keyof CoachParams, { padrao: number; min: number; max: number }> = {
  periodo_dias: { padrao: 30, min: 1, max: 90 },
  parado_dias: { padrao: 7, min: 1, max: 90 },
  followup_horas: { padrao: 24, min: 1, max: 720 },
  limite: { padrao: 50, min: 1, max: 200 },
};

export function parseCoachParams(query: URLSearchParams): CoachParams {
  const params = {} as CoachParams;
  for (const nome of Object.keys(LIMITES) as (keyof CoachParams)[]) {
    const { padrao, min, max } = LIMITES[nome];
    const valor = query.get(nome);
    if (valor === null) {
      params[nome] = padrao;
    } else if (/^\d+$/.test(valor) && Number(valor) >= min && Number(valor) <= max) {
      params[nome] = Number(valor);
    } else {
      throw new HttpError(400, `${nome} deve ser um inteiro de ${min} a ${max}`);
    }
  }
  return params;
}
