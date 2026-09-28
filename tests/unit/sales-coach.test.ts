import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import { parseCoachParams } from "../../supabase/functions/_shared/sales-coach";

describe("parseCoachParams", () => {
  const parse = (query: string) => parseCoachParams(new URLSearchParams(query));

  function erroDe(query: string): HttpError {
    try {
      parse(query);
    } catch (error) {
      if (error instanceof HttpError) return error;
      throw error;
    }
    throw new Error(`"${query}" deveria ter sido recusado`);
  }

  it("sem parâmetros, usa os padrões", () => {
    expect(parse("")).toEqual({ periodo_dias: 30, parado_dias: 7, followup_horas: 24, limite: 50 });
  });

  it("aceita os extremos de cada limite", () => {
    expect(parse("periodo_dias=1&parado_dias=1&followup_horas=1&limite=1")).toEqual({
      periodo_dias: 1,
      parado_dias: 1,
      followup_horas: 1,
      limite: 1,
    });
    expect(parse("periodo_dias=90&parado_dias=90&followup_horas=720&limite=200")).toEqual({
      periodo_dias: 90,
      parado_dias: 90,
      followup_horas: 720,
      limite: 200,
    });
  });

  it("fora do limite responde 400 com o nome do parâmetro", () => {
    for (const query of [
      "periodo_dias=0",
      "periodo_dias=91",
      "parado_dias=0",
      "parado_dias=91",
      "followup_horas=0",
      "followup_horas=721",
      "limite=0",
      "limite=201",
    ]) {
      const erro = erroDe(query);
      expect(erro.status).toBe(400);
      expect(erro.message).toContain(query.split("=")[0]);
    }
  });

  it("texto não numérico responde 400", () => {
    for (const query of [
      "limite=abc",
      "limite=10.5",
      "limite=-3",
      "limite=",
      "limite=1e2",
      "limite= 5",
    ]) {
      expect(erroDe(query).status).toBe(400);
    }
  });

  it("ignora parâmetro desconhecido", () => {
    expect(parse("foo=bar").limite).toBe(50);
  });
});
