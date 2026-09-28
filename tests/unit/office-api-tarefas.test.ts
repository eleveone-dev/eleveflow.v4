import { describe, it, expect } from "vitest";
import { atender, type Pedido } from "../../supabase/functions/_shared/office-api/atender";
import { codificarCursor } from "../../supabase/functions/_shared/office-api/cursor";
import { ErroApi } from "../../supabase/functions/_shared/office-api/erros";
import { encontrarRota, type Metodo } from "../../supabase/functions/_shared/office-api/rotas";
import { createFakeClient } from "./helpers/fake-supabase";

const CONTA = "0b7c9a6e-1f2d-4c3b-8a9e-5d4c3b2a1f0e";
const TAREFA = "2d9e1c8a-3b4f-4e5d-8c1a-7f6e5d4c3b2a";
const T1 = "2026-09-25T10:00:00.000001+00:00";
const tarefa = { tarefa_id: TAREFA, versao: 2, status: "pendente", atualizada_em: T1 };

function cliente(respostas: Record<string, (args: any) => unknown>) {
  const chamadas: Array<{ nome: string; args: any }> = [];
  const rpc: Record<string, (args: any) => { data: unknown; error: null }> = {};
  for (const [nome, fn] of Object.entries(respostas)) {
    rpc[nome] = (args) => {
      chamadas.push({ nome, args });
      return { data: fn(args), error: null };
    };
  }
  return { client: createFakeClient({}, { rpc }) as any, chamadas };
}

function pedido(metodo: Metodo, extra: Partial<Pedido> = {}): Pedido {
  return {
    metodo,
    userId: CONTA,
    escopos: ["tarefas:leitura", "tarefas:escrita"],
    ator: "api:Nexo",
    query: new URLSearchParams(),
    ifMatch: null,
    chave: null,
    corpo: null,
    ...extra,
  };
}

const rota = (caminho: string) => encontrarRota(caminho)!;

async function recusa(promessa: Promise<unknown>): Promise<any> {
  try {
    await promessa;
  } catch (error) {
    return error;
  }
  throw new Error("esperava recusa");
}

describe("rotas de tarefa", () => {
  it("lista com filtros traduzidos, conta do token e cursor", async () => {
    const { client, chamadas } = cliente({ office_tarefas: () => [tarefa] });
    const query = new URLSearchParams("status=pendente&responsavel_tipo=agente&limite=10");
    const resposta = await atender(client, rota("/v1/tarefas"), pedido("GET", { query }));
    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_tarefa_id: null,
      p_status: "pending",
      p_responsavel_tipo: "agente",
      p_limite: 10,
    });
    expect(resposta).toEqual({
      status: 200,
      corpo: { dados: [tarefa], proximo_cursor: codificarCursor(T1, TAREFA), tem_mais: false },
      itens: 1,
    });
  });

  it("tarefa unica; de outra conta ou inexistente da 404", async () => {
    const { client, chamadas } = cliente({ office_tarefas: () => [tarefa] });
    const resposta = await atender(client, rota(`/v1/tarefas/${TAREFA}`), pedido("GET"));
    expect(resposta).toEqual({ status: 200, corpo: tarefa, itens: 1 });
    expect(chamadas[0].args).toMatchObject({ p_tarefa_id: TAREFA, p_user_id: CONTA });

    const vazio = cliente({ office_tarefas: () => [] });
    expect(
      await recusa(atender(vazio.client, rota(`/v1/tarefas/${TAREFA}`), pedido("GET"))),
    ).toMatchObject({ status: 404 });
  });

  it("criacao: 201 na primeira, 200 na repeticao, com chave, ator e colunas", async () => {
    const respostas = [
      { resultado: "criada", tarefa },
      { resultado: "repetida", tarefa },
    ];
    const { client, chamadas } = cliente({ office_tarefa_criar: () => respostas.shift() });
    const criar = () =>
      atender(
        client,
        rota("/v1/tarefas"),
        pedido("POST", { chave: "ordem-1", corpo: { titulo: "Ligar", prioridade: "baixa" } }),
      );
    expect(await criar()).toEqual({ status: 201, corpo: tarefa, itens: 1 });
    expect(await criar()).toEqual({ status: 200, corpo: tarefa, itens: 1 });
    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_ator: "api:Nexo",
      p_chave: "ordem-1",
      p_dados: { title: "Ligar", priority: "low", assignee_type: "dono" },
    });
  });

  it("criacao sem Idempotency-Key ou com corpo invalido nao chama o banco", async () => {
    const { client, chamadas } = cliente({
      office_tarefa_criar: () => ({ resultado: "criada", tarefa }),
    });
    for (const extra of [
      { corpo: { titulo: "x" } },
      { chave: "k", corpo: { titulo: "x", conta_id: CONTA } },
    ]) {
      expect(
        await recusa(atender(client, rota("/v1/tarefas"), pedido("POST", extra))),
      ).toMatchObject({ status: 400 });
    }
    expect(chamadas).toHaveLength(0);
  });

  it("lead de outra conta da 400", async () => {
    const { client } = cliente({ office_tarefa_criar: () => ({ resultado: "lead_invalido" }) });
    const corpo = { titulo: "x", lead_id: TAREFA };
    expect(
      await recusa(atender(client, rota("/v1/tarefas"), pedido("POST", { chave: "k", corpo }))),
    ).toMatchObject({ status: 400 });
  });

  it("alteracao: If-Match obrigatorio; versao e transicao voltam com a tarefa atual", async () => {
    const respostas = [
      { resultado: "ok", tarefa },
      { resultado: "versao", tarefa },
      { resultado: "transicao", tarefa },
      { resultado: "nao_encontrada" },
    ];
    const { client, chamadas } = cliente({ office_tarefa_alterar: () => respostas.shift() });
    const alterar = (ifMatch: string | null) =>
      atender(
        client,
        rota(`/v1/tarefas/${TAREFA}`),
        pedido("PATCH", { ifMatch, corpo: { status: "em_andamento" } }),
      );

    expect(await recusa(alterar(null))).toMatchObject({ status: 428 });
    expect(chamadas).toHaveLength(0);
    expect(await alterar('"2"')).toEqual({ status: 200, corpo: tarefa, itens: 1 });
    expect(chamadas[0].args).toMatchObject({
      p_tarefa_id: TAREFA,
      p_versao: 2,
      p_campos: { status: "in_progress" },
      p_ator: "api:Nexo",
    });

    const conflito = await recusa(alterar('"1"'));
    expect(conflito).toBeInstanceOf(ErroApi);
    expect(conflito).toMatchObject({ status: 412, extra: { tarefa } });
    expect(await recusa(alterar('"2"'))).toMatchObject({ status: 409, extra: { tarefa } });
    expect(await recusa(alterar('"2"'))).toMatchObject({ status: 404, extra: {} });
  });

  it("entrega: resultado e link vao ao banco; tarefa concluida da 409", async () => {
    const entregue = { ...tarefa, status: "aguardando_revisao" };
    const respostas = [
      { resultado: "ok", tarefa: entregue },
      { resultado: "transicao", tarefa },
    ];
    const { client, chamadas } = cliente({ office_tarefa_entregar: () => respostas.shift() });
    const entregar = () =>
      atender(
        client,
        rota(`/v1/tarefas/${TAREFA}/entrega`),
        pedido("POST", {
          ifMatch: '"2"',
          corpo: { resultado: "feito", resultado_ref: "https://x.com" },
        }),
      );
    expect(await entregar()).toEqual({ status: 200, corpo: entregue, itens: 1 });
    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_tarefa_id: TAREFA,
      p_versao: 2,
      p_resultado: "feito",
      p_resultado_ref: "https://x.com",
    });
    expect(await recusa(entregar())).toMatchObject({ status: 409 });
  });

  it("metodo sem par na rota cai em 404", async () => {
    const { client } = cliente({});
    expect(
      await recusa(atender(client, rota(`/v1/tarefas/${TAREFA}`), pedido("POST"))),
    ).toMatchObject({ status: 404 });
  });
});
