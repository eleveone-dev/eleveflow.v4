// Rota da office-api → funcao SQL → resposta. A conta e sempre a do token, recebida
// no pedido; nada da requisicao vira conta.

import { HttpError } from "../http-error.ts";
import { montarPagina } from "./pagina.ts";
import {
  lerCursor,
  lerData,
  lerLimite,
  lerSituacao,
  lerUuid,
  SEQUENCIA,
  UUID,
} from "./parametros.ts";
import { chamar, type Cliente, type Item } from "./rpc.ts";
import type { Metodo, NomeRota } from "./rotas.ts";
import { atenderTarefas } from "./tarefas.ts";

export interface Pedido {
  metodo: Metodo;
  userId: string;
  /** Escopos do token: decidem o que o feed de exclusoes mostra. */
  escopos: string[];
  /** Autor das escritas no historico das tarefas: api:<rotulo do token>. */
  ator: string;
  query: URLSearchParams;
  ifMatch: string | null;
  chave: string | null;
  corpo: unknown;
}

export interface Resposta {
  status: number;
  corpo: unknown;
  itens: number | null;
}

const TAREFAS: NomeRota[] = ["tarefas", "tarefa", "tarefa_entrega"];

async function leadDaConta(client: Cliente, userId: string, leadId: string): Promise<Item> {
  const [lead] = await chamar(client, "office_leads", {
    p_user_id: userId,
    p_lead_id: leadId,
    p_cursor_ts: null,
    p_cursor_id: null,
    p_limite: 1,
    p_atualizado_desde: null,
    p_criado_de: null,
    p_criado_ate: null,
    p_etapa_id: null,
    p_situacao: null,
  });
  // Lead de outra conta e inexistente respondem igual: 404.
  if (!lead) throw new HttpError(404, "lead nao encontrado");
  return lead;
}

function entidadesExcluidas(escopos: string[]): string[] {
  return [
    ...(escopos.includes("comercial:leitura") ? ["lead", "message"] : []),
    ...(escopos.includes("tarefas:leitura") ? ["task"] : []),
  ];
}

export async function atender(
  client: Cliente,
  rota: { nome: NomeRota; id?: string },
  pedido: Pedido,
): Promise<Resposta> {
  if (TAREFAS.includes(rota.nome)) return atenderTarefas(client, rota, pedido);

  const { userId, query } = pedido;
  const limite = lerLimite(query.get("limite"));
  const recebido = query.get("cursor");

  const pagina = (itens: Item[], chave: (i: Item) => [string, string]) => {
    const corpo = montarPagina(itens, limite, recebido, chave);
    return { status: 200, corpo, itens: corpo.dados.length };
  };

  switch (rota.nome) {
    case "leads": {
      const cursor = lerCursor(recebido, UUID);
      const itens = await chamar(client, "office_leads", {
        p_user_id: userId,
        p_lead_id: null,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
        p_atualizado_desde: lerData("atualizado_desde", query.get("atualizado_desde")),
        p_criado_de: lerData("criado_de", query.get("criado_de")),
        p_criado_ate: lerData("criado_ate", query.get("criado_ate")),
        p_etapa_id: lerUuid("etapa_id", query.get("etapa_id")),
        p_situacao: lerSituacao(query.get("situacao")),
      });
      return pagina(itens, (l) => [l.atualizado_em, l.lead_id]);
    }
    case "lead":
      return { status: 200, corpo: await leadDaConta(client, userId, rota.id!), itens: 1 };
    case "lead_mensagens":
    case "mensagens": {
      const feed = rota.nome === "mensagens";
      const cursor = lerCursor(recebido, UUID);
      if (!feed) await leadDaConta(client, userId, rota.id!);
      const itens = await chamar(client, "office_mensagens", {
        p_user_id: userId,
        p_lead_id: feed ? null : rota.id,
        p_feed: feed,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
      });
      return pagina(itens, (m) => [feed ? m.gravada_em : m.enviada_em, m.mensagem_id]);
    }
    case "lead_etapas":
    case "etapas": {
      const feed = rota.nome === "etapas";
      const cursor = lerCursor(recebido, UUID);
      if (!feed) await leadDaConta(client, userId, rota.id!);
      const itens = await chamar(client, "office_eventos", {
        p_user_id: userId,
        p_lead_id: feed ? null : rota.id,
        p_feed: feed,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
      });
      return pagina(itens, (e) => [feed ? e.gravado_em : e.ocorreu_em, e.evento_id]);
    }
    case "exclusoes": {
      const cursor = lerCursor(recebido, SEQUENCIA);
      const itens = await chamar(client, "office_exclusoes", {
        p_user_id: userId,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor ? Number(cursor.id) : null,
        p_limite: limite,
        p_entidades: entidadesExcluidas(pedido.escopos),
      });
      return pagina(itens, (x) => [x.excluido_em, String(x.sequencia)]);
    }
    default:
      throw new HttpError(404, "rota inexistente");
  }
}
