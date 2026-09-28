import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import {
  codificarCursor,
  decodificarCursor,
} from "../../supabase/functions/_shared/office-api/cursor";
import {
  lerData,
  lerLimite,
  lerSituacao,
  lerUuid,
  SEQUENCIA,
  UUID,
} from "../../supabase/functions/_shared/office-api/parametros";
import {
  encontrarRota,
  metodoDaRota,
  ROTAS,
} from "../../supabase/functions/_shared/office-api/rotas";
import { corpoDeErro, ErroApi } from "../../supabase/functions/_shared/office-api/erros";
import { montarPagina } from "../../supabase/functions/_shared/office-api/pagina";
import { verificarLimite } from "../../supabase/functions/_shared/office-api/limite";
import { registrarChamada } from "../../supabase/functions/_shared/office-api/auditoria";
import { createFakeClient } from "./helpers/fake-supabase";

const ID = "0b7c9a6e-1f2d-4c3b-8a9e-5d4c3b2a1f0e";
const INSTANTE = "2026-09-25T13:53:51.753744+00:00";

function status400(fn: () => unknown): number | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return null;
}

describe("cursor", () => {
  it("ida e volta preserva microssegundos e id", () => {
    const c = codificarCursor(INSTANTE, ID);
    expect(c).not.toMatch(/[+/=]/);
    expect(decodificarCursor(c, UUID)).toEqual({ instante: INSTANTE, id: ID });
  });

  it("lixo, id no formato errado e instante invalido dao 400", () => {
    expect(status400(() => decodificarCursor("lixo", UUID))).toBe(400);
    expect(status400(() => decodificarCursor(codificarCursor(INSTANTE, "123"), UUID))).toBe(400);
    expect(status400(() => decodificarCursor(codificarCursor("ontem", ID), UUID))).toBe(400);
  });

  it("cursor de exclusao usa a sequencia numerica", () => {
    expect(decodificarCursor(codificarCursor(INSTANTE, "42"), SEQUENCIA).id).toBe("42");
  });
});

describe("parametros", () => {
  it("limite padrao 100, de 1 a 500", () => {
    expect(lerLimite(null)).toBe(100);
    expect(lerLimite("500")).toBe(500);
    for (const v of ["0", "501", "abc", "1.5", ""]) expect(status400(() => lerLimite(v))).toBe(400);
  });

  it("data ISO 8601; outra coisa da 400", () => {
    expect(lerData("criado_de", null)).toBeNull();
    expect(lerData("criado_de", "2026-09-25")).toBe("2026-09-25");
    expect(lerData("criado_de", "2026-09-25T10:00:00Z")).toBe("2026-09-25T10:00:00Z");
    expect(status400(() => lerData("criado_de", "ontem"))).toBe(400);
  });

  it("uuid e situacao validados", () => {
    expect(lerUuid("etapa_id", ID)).toBe(ID);
    expect(status400(() => lerUuid("etapa_id", "1"))).toBe(400);
    expect(lerSituacao("perdida")).toBe("perdida");
    expect(lerSituacao(null)).toBeNull();
    expect(status400(() => lerSituacao("fechada"))).toBe(400);
  });
});

describe("rotas", () => {
  it("resolve as rotas com e sem o prefixo da funcao", () => {
    expect(encontrarRota("/office-api/v1/leads")).toMatchObject({
      nome: "leads",
      metodos: { GET: ["comercial:leitura"] },
    });
    expect(encontrarRota(`/office-api/v1/leads/${ID}/mensagens`)).toMatchObject({
      nome: "lead_mensagens",
      modelo: "/v1/leads/{id}/mensagens",
      id: ID,
    });
    expect(encontrarRota("/v1/exclusoes")).toMatchObject({ nome: "exclusoes" });
    expect(encontrarRota(`/functions/v1/office-api/v1/tarefas/${ID}/entrega`)).toMatchObject({
      nome: "tarefa_entrega",
      modelo: "/v1/tarefas/{id}/entrega",
      id: ID,
    });
    expect(encontrarRota("/office-api/v1/openapi.json")).toMatchObject({
      nome: "openapi",
      metodos: { GET: null },
    });
  });

  it("rota desconhecida ou id invalido nao casa", () => {
    expect(encontrarRota("/office-api/v1/lembretes")).toBeNull();
    expect(encontrarRota("/office-api/v1/leads/123")).toBeNull();
    expect(encontrarRota("/office-api/v1/tarefas/123")).toBeNull();
  });

  it("escopo por metodo nas tarefas; exclusoes aceitam os dois escopos de leitura", () => {
    expect(encontrarRota("/v1/tarefas")!.metodos).toEqual({
      GET: ["tarefas:leitura"],
      POST: ["tarefas:escrita"],
    });
    expect(encontrarRota(`/v1/tarefas/${ID}`)!.metodos).toEqual({
      GET: ["tarefas:leitura"],
      PATCH: ["tarefas:escrita"],
    });
    expect(encontrarRota(`/v1/tarefas/${ID}/entrega`)!.metodos).toEqual({
      POST: ["tarefas:escrita"],
    });
    expect(encontrarRota("/v1/exclusoes")!.metodos).toEqual({
      GET: ["comercial:leitura", "tarefas:leitura"],
    });
  });

  it("toda rota com dado exige escopo, e so tarefa aceita escrita", () => {
    for (const r of ROTAS.filter((r) => r.nome !== "openapi")) {
      for (const [metodo, escopos] of Object.entries(r.metodos)) {
        expect(escopos?.length, `${metodo} ${r.modelo}`).toBeGreaterThan(0);
        if (metodo !== "GET") expect(escopos, `${metodo} ${r.modelo}`).toEqual(["tarefas:escrita"]);
      }
    }
  });

  it("metodoDaRota devolve so o metodo que a rota aceita", () => {
    expect(metodoDaRota(encontrarRota("/v1/tarefas")!, "POST")).toBe("POST");
    expect(metodoDaRota(encontrarRota(`/v1/tarefas/${ID}`)!, "PATCH")).toBe("PATCH");
    expect(metodoDaRota(encontrarRota("/v1/leads")!, "POST")).toBeNull();
    expect(metodoDaRota(encontrarRota("/v1/tarefas")!, "DELETE")).toBeNull();
    expect(metodoDaRota(encontrarRota("/v1/tarefas")!, "get")).toBeNull();
  });
});

describe("erros", () => {
  it("codigo pelo status, com a tarefa quando vem junto", () => {
    expect(corpoDeErro(412, "mudou", { tarefa: { versao: 2 } })).toEqual({
      erro: { codigo: "versao_desatualizada", mensagem: "mudou" },
      tarefa: { versao: 2 },
    });
    expect(corpoDeErro(428, "falta").erro.codigo).toBe("versao_obrigatoria");
    expect(corpoDeErro(409, "nao").erro.codigo).toBe("transicao_invalida");
    expect(corpoDeErro(405, "use GET").erro.codigo).toBe("metodo_nao_permitido");
    expect(corpoDeErro(418, "?").erro.codigo).toBe("erro_interno");
  });

  it("ErroApi e um HttpError com corpo extra", () => {
    const erro = new ErroApi(409, "nao", { tarefa: { status: "concluida" } });
    expect(erro).toBeInstanceOf(HttpError);
    expect(erro.status).toBe(409);
    expect(erro.extra).toEqual({ tarefa: { status: "concluida" } });
    expect(new ErroApi(400, "x").extra).toEqual({});
  });
});

describe("montarPagina", () => {
  const itens = [
    { t: "a", id: "1" },
    { t: "b", id: "2" },
    { t: "c", id: "3" },
  ];
  const chave = (i: { t: string; id: string }) => [i.t, i.id] as [string, string];

  it("corta no limite, marca tem_mais e aponta o cursor para o ultimo devolvido", () => {
    const p = montarPagina(itens, 2, null, chave);
    expect(p.dados).toHaveLength(2);
    expect(p.tem_mais).toBe(true);
    expect(p.proximo_cursor).toBe(codificarCursor("b", "2"));
  });

  it("pagina vazia devolve o cursor recebido", () => {
    expect(montarPagina([], 2, "abc", chave)).toEqual({
      dados: [],
      proximo_cursor: "abc",
      tem_mais: false,
    });
  });
});

describe("verificarLimite", () => {
  const agora = new Date("2026-09-25T12:01:00.000Z").getTime();
  const log = (segundosAtras: number[]) => ({
    api_request_log: segundosAtras.map((s, i) => ({
      id: i,
      token_id: "tok-1",
      created_at: new Date(agora - s * 1000).toISOString(),
    })),
  });

  it("abaixo do limite passa", async () => {
    const client = createFakeClient(log([10, 20]));
    expect(await verificarLimite(client as any, "tok-1", 3, agora)).toEqual({ ok: true });
  });

  it("no limite dentro de 60 s recusa com o tempo ate liberar", async () => {
    const client = createFakeClient(log([5, 10, 50]));
    expect(await verificarLimite(client as any, "tok-1", 3, agora)).toEqual({
      ok: false,
      retryAfter: 10,
    });
  });

  it("chamadas mais velhas que 60 s nao contam", async () => {
    const client = createFakeClient(log([5, 10, 61]));
    expect(await verificarLimite(client as any, "tok-1", 3, agora)).toEqual({ ok: true });
  });
});

describe("registrarChamada", () => {
  it("grava a linha sem conteudo", async () => {
    const db = { api_request_log: [] as any[] };
    await registrarChamada(createFakeClient(db) as any, {
      tokenId: "tok-1",
      userId: "conta-1",
      metodo: "GET",
      rota: "/v1/leads",
      status: 200,
      itens: 3,
      duracaoMs: 42,
    });
    expect(db.api_request_log[0]).toEqual({
      token_id: "tok-1",
      user_id: "conta-1",
      method: "GET",
      route: "/v1/leads",
      status: 200,
      items: 3,
      duration_ms: 42,
    });
  });
});
