import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import {
  lerAlteracao,
  lerChave,
  lerEntrega,
  lerFiltrosTarefas,
  lerJson,
  lerNovaTarefa,
  lerVersao,
} from "../../supabase/functions/_shared/office-api/tarefas-corpo";

const LEAD = "1c8d0b7f-2a3e-4d4c-9b0f-6e5d4c3b2a1f";

function statusDe(fn: () => unknown): number | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return null;
}

describe("lerNovaTarefa", () => {
  it("traduz o corpo minimo para as colunas, com os padroes", () => {
    expect(lerNovaTarefa({ titulo: "  Ligar  " })).toEqual({
      title: "Ligar",
      description: null,
      priority: "medium",
      due_date: null,
      lead_id: null,
      project_ref: null,
      creator_ref: null,
      assignee_type: "dono",
      assignee_ref: null,
      external_order_id: null,
    });
  });

  it("traduz o corpo completo", () => {
    expect(
      lerNovaTarefa({
        titulo: "Ligar",
        descricao: "Confirmar",
        prioridade: "alta",
        prazo: "2026-09-26T13:00:00-03:00",
        lead_id: LEAD,
        projeto_ref: "proj-1",
        responsavel: { tipo: "agente", ref: "sdr-1" },
        criador_ref: "nexo",
        ordem_externa_id: "ordem-123",
      }),
    ).toEqual({
      title: "Ligar",
      description: "Confirmar",
      priority: "high",
      due_date: "2026-09-26T13:00:00-03:00",
      lead_id: LEAD,
      project_ref: "proj-1",
      creator_ref: "nexo",
      assignee_type: "agente",
      assignee_ref: "sdr-1",
      external_order_id: "ordem-123",
    });
  });

  it("recusa corpo invalido com 400", () => {
    for (const corpo of [
      null,
      [],
      "texto",
      {},
      { titulo: "   " },
      { titulo: "x".repeat(301) },
      { titulo: "a", conta_id: LEAD },
      { titulo: "a", prioridade: "urgente" },
      { titulo: "a", prazo: "2026-09-26T13:00:00" },
      { titulo: "a", prazo: "2026-02-30T13:00:00Z" },
      { titulo: "a", prazo: "2026-09-26T25:00:00Z" },
      { titulo: "a", lead_id: "123" },
      { titulo: "a", responsavel: { tipo: "agente" } },
      { titulo: "a", responsavel: { tipo: "dono", ref: "sdr-1" } },
      { titulo: "a", responsavel: { tipo: "gerente" } },
      { titulo: "a", responsavel: { tipo: "agente", ref: "sdr", conta: 1 } },
      { titulo: "a", descricao: 5 },
    ]) {
      expect(
        statusDe(() => lerNovaTarefa(corpo)),
        JSON.stringify(corpo),
      ).toBe(400);
    }
  });

  it("conta caracteres como o banco, nao unidades UTF-16", () => {
    expect(lerNovaTarefa({ titulo: "🎯".repeat(300) }).title).toHaveLength(600);
  });
});

describe("lerAlteracao", () => {
  it("so os campos enviados; null limpa", () => {
    expect(lerAlteracao({ descricao: null, prazo: null, status: "em_andamento" })).toEqual({
      description: null,
      due_date: null,
      status: "in_progress",
    });
    expect(lerAlteracao({ responsavel: { tipo: "dono" } })).toEqual({
      assignee_type: "dono",
      assignee_ref: null,
    });
  });

  it("status vira o do banco; a regra de transicao e do banco", () => {
    expect(lerAlteracao({ status: "concluida" })).toEqual({ status: "done" });
    expect(lerAlteracao({ status: "aguardando_revisao" })).toEqual({
      status: "aguardando_revisao",
    });
  });

  it("recusa vazio, campo fora da lista e nulo onde nao cabe", () => {
    for (const corpo of [
      {},
      { resultado: "x" },
      { titulo: null },
      { status: "feita" },
      { prioridade: null },
      { responsavel: null },
    ]) {
      expect(
        statusDe(() => lerAlteracao(corpo)),
        JSON.stringify(corpo),
      ).toBe(400);
    }
  });
});

describe("lerEntrega", () => {
  it("resultado obrigatorio; link http ou https", () => {
    expect(lerEntrega({ resultado: "feito" })).toEqual({ resultado: "feito", resultadoRef: null });
    expect(lerEntrega({ resultado: "feito", resultado_ref: "https://x.com/r" })).toEqual({
      resultado: "feito",
      resultadoRef: "https://x.com/r",
    });
    for (const corpo of [
      {},
      { resultado: "" },
      { resultado: "x".repeat(5001) },
      { resultado: "a", resultado_ref: "ftp://x.com" },
      { resultado: "a", resultado_ref: "nao e url" },
      { resultado: "a", status: "concluida" },
    ]) {
      expect(
        statusDe(() => lerEntrega(corpo)),
        JSON.stringify(corpo),
      ).toBe(400);
    }
  });
});

describe("cabecalhos e corpo", () => {
  it("If-Match: ausente da 428; versao com ou sem aspas", () => {
    expect(statusDe(() => lerVersao(null))).toBe(428);
    expect(lerVersao('"3"')).toBe(3);
    expect(lerVersao("12")).toBe(12);
    for (const valor of ['"3', 'W/"3"', "tres", "", '"-1"']) {
      expect(
        statusDe(() => lerVersao(valor)),
        valor,
      ).toBe(400);
    }
  });

  it("Idempotency-Key obrigatorio, de 1 a 200 caracteres visiveis", () => {
    expect(lerChave("ordem-123:tarefa-1")).toBe("ordem-123:tarefa-1");
    for (const valor of [null, "", "com espaco", "x".repeat(201)]) {
      expect(
        statusDe(() => lerChave(valor)),
        String(valor),
      ).toBe(400);
    }
  });

  it("corpo JSON; vazio vira null", () => {
    expect(lerJson('{"a":1}')).toEqual({ a: 1 });
    expect(lerJson("")).toBeNull();
    expect(statusDe(() => lerJson("{"))).toBe(400);
  });
});

describe("lerFiltrosTarefas", () => {
  it("status e responsavel validados e traduzidos", () => {
    const query = new URLSearchParams(
      "status=em_andamento&responsavel_tipo=agente&responsavel_ref=sdr-1&atualizado_desde=2026-09-25T00:00:00Z",
    );
    expect(lerFiltrosTarefas(query)).toEqual({
      status: "in_progress",
      responsavelTipo: "agente",
      responsavelRef: "sdr-1",
      atualizadoDesde: "2026-09-25T00:00:00Z",
    });
    expect(lerFiltrosTarefas(new URLSearchParams())).toEqual({
      status: null,
      responsavelTipo: null,
      responsavelRef: null,
      atualizadoDesde: null,
    });
    for (const q of [
      "status=feita",
      "responsavel_tipo=gerente",
      "responsavel_ref=",
      "atualizado_desde=ontem",
    ]) {
      expect(
        statusDe(() => lerFiltrosTarefas(new URLSearchParams(q))),
        q,
      ).toBe(400);
    }
  });
});
