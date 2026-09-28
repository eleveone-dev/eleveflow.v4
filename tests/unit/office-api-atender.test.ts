import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import { atender, type Pedido } from "../../supabase/functions/_shared/office-api/atender";
import { encontrarRota } from "../../supabase/functions/_shared/office-api/rotas";
import { codificarCursor } from "../../supabase/functions/_shared/office-api/cursor";
import { createFakeClient } from "./helpers/fake-supabase";

const CONTA = "0b7c9a6e-1f2d-4c3b-8a9e-5d4c3b2a1f0e";
const LEAD = "1c8d0b7f-2a3e-4d4c-9b0f-6e5d4c3b2a1f";
const T1 = "2026-09-25T10:00:00.000001+00:00";
const T2 = "2026-09-25T10:00:00.000002+00:00";

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

function pedido(query = new URLSearchParams(), extra: Partial<Pedido> = {}): Pedido {
  return {
    metodo: "GET",
    userId: CONTA,
    escopos: ["comercial:leitura"],
    ator: "api:Teste",
    query,
    ifMatch: null,
    chave: null,
    corpo: null,
    ...extra,
  };
}

const rota = (caminho: string) => encontrarRota(caminho)!;

describe("atender", () => {
  it("leads passa filtros e conta do token e monta a pagina", async () => {
    const { client, chamadas } = cliente({
      office_leads: () => [
        { lead_id: "a", atualizado_em: T1 },
        { lead_id: "b", atualizado_em: T2 },
        { lead_id: "c", atualizado_em: T2 },
      ],
    });
    const query = new URLSearchParams("limite=2&situacao=perdida&criado_de=2026-09-01");

    const { corpo, itens } = await atender(client, rota("/v1/leads"), pedido(query));

    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_lead_id: null,
      p_limite: 2,
      p_situacao: "perdida",
      p_criado_de: "2026-09-01",
      p_cursor_ts: null,
    });
    expect(corpo).toEqual({
      dados: [
        { lead_id: "a", atualizado_em: T1 },
        { lead_id: "b", atualizado_em: T2 },
      ],
      proximo_cursor: codificarCursor(T2, "b"),
      tem_mais: true,
    });
    expect(itens).toBe(2);
  });

  it("cursor recebido vira instante e id na chamada", async () => {
    const { client, chamadas } = cliente({ office_mensagens: () => [] });
    const cursor = codificarCursor(T1, LEAD);

    await atender(client, rota("/v1/mensagens"), pedido(new URLSearchParams({ cursor })));

    expect(chamadas[0].args).toMatchObject({ p_feed: true, p_cursor_ts: T1, p_cursor_id: LEAD });
  });

  it("lead de outra conta ou inexistente da 404, sem chamar as mensagens", async () => {
    const { client, chamadas } = cliente({ office_leads: () => [], office_mensagens: () => [] });

    await expect(
      atender(client, rota(`/v1/leads/${LEAD}/mensagens`), pedido(new URLSearchParams())),
    ).rejects.toMatchObject({ status: 404 });
    expect(chamadas.map((c) => c.nome)).toEqual(["office_leads"]);
  });

  it("lead unico devolve o objeto, nao a lista", async () => {
    const { client } = cliente({ office_leads: () => [{ lead_id: LEAD, atualizado_em: T1 }] });
    const { corpo } = await atender(
      client,
      rota(`/v1/leads/${LEAD}`),
      pedido(new URLSearchParams()),
    );
    expect(corpo).toEqual({ lead_id: LEAD, atualizado_em: T1 });
  });

  it("mensagens do lead ordenam pela data da mensagem, nao pela gravacao", async () => {
    const { client, chamadas } = cliente({
      office_leads: () => [{ lead_id: LEAD }],
      office_mensagens: () => [{ mensagem_id: LEAD, enviada_em: T1, gravada_em: T2 }],
    });
    const { corpo } = await atender(
      client,
      rota(`/v1/leads/${LEAD}/mensagens`),
      pedido(new URLSearchParams()),
    );
    expect(chamadas[1].args).toMatchObject({ p_lead_id: LEAD, p_feed: false });
    expect((corpo as any).proximo_cursor).toBe(codificarCursor(T1, LEAD));
  });

  it("exclusoes usam a sequencia no cursor", async () => {
    const { client } = cliente({
      office_exclusoes: () => [{ id: LEAD, excluido_em: T1, sequencia: 7 }],
    });
    const { corpo } = await atender(client, rota("/v1/exclusoes"), pedido(new URLSearchParams()));
    expect((corpo as any).proximo_cursor).toBe(codificarCursor(T1, "7"));
  });

  it("parametro invalido da 400 antes de consultar", async () => {
    const { client, chamadas } = cliente({ office_leads: () => [] });
    await expect(
      atender(client, rota("/v1/leads"), pedido(new URLSearchParams("limite=0"))),
    ).rejects.toBeInstanceOf(HttpError);
    expect(chamadas).toHaveLength(0);
  });

  it("exclusoes mostram so as entidades dos escopos do token", async () => {
    const { client, chamadas } = cliente({ office_exclusoes: () => [] });
    for (const escopos of [
      ["comercial:leitura"],
      ["tarefas:leitura", "tarefas:escrita"],
      ["comercial:leitura", "tarefas:leitura"],
    ]) {
      await atender(client, rota("/v1/exclusoes"), pedido(undefined, { escopos }));
    }
    expect(chamadas.map((c) => c.args.p_entidades)).toEqual([
      ["lead", "message"],
      ["task"],
      ["lead", "message", "task"],
    ]);
  });

  it("resposta de leitura sai com 200", async () => {
    const { client } = cliente({ office_leads: () => [] });
    expect((await atender(client, rota("/v1/leads"), pedido())).status).toBe(200);
  });
});
