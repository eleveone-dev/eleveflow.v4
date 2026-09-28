// Rotas de tarefa da office-api. O que precisa ser atomico (versao, transicao de
// status, chave de idempotencia) fica nas funcoes SQL; aqui o resultado delas vira
// status HTTP. Nenhuma rota conclui, apaga ou reabre: isso e do dono, na tela.

import { HttpError } from "../http-error.ts";
import type { Pedido, Resposta } from "./atender.ts";
import { ErroApi } from "./erros.ts";
import { montarPagina } from "./pagina.ts";
import { lerCursor, lerLimite, UUID } from "./parametros.ts";
import { chamar, type Cliente, type Item } from "./rpc.ts";
import type { NomeRota } from "./rotas.ts";
import {
  lerAlteracao,
  lerChave,
  lerEntrega,
  lerFiltrosTarefas,
  lerNovaTarefa,
  lerVersao,
} from "./tarefas-corpo.ts";

type Escrita = { resultado: string; tarefa?: Item };

const RECUSAS: Record<string, [number, string]> = {
  nao_encontrada: [404, "tarefa nao encontrada"],
  lead_invalido: [400, "lead_id nao encontrado na conta"],
  versao: [412, "a tarefa mudou: refaca a alteracao sobre a versao atual, que vai em tarefa"],
  transicao: [
    409,
    "pela API o status so vai e volta entre pendente e em_andamento, e tarefa concluida nao recebe entrega",
  ],
};

function responder(escrita: Escrita, status: number): Resposta {
  const recusa = RECUSAS[escrita.resultado];
  if (recusa) {
    throw new ErroApi(recusa[0], recusa[1], escrita.tarefa ? { tarefa: escrita.tarefa } : {});
  }
  return { status, corpo: escrita.tarefa, itens: 1 };
}

function listar(client: Cliente, userId: string, args: Record<string, unknown>) {
  return chamar<Item[]>(client, "office_tarefas", {
    p_user_id: userId,
    p_tarefa_id: null,
    p_cursor_ts: null,
    p_cursor_id: null,
    p_limite: 1,
    p_status: null,
    p_responsavel_tipo: null,
    p_responsavel_ref: null,
    p_atualizado_desde: null,
    ...args,
  });
}

export async function atenderTarefas(
  client: Cliente,
  rota: { nome: NomeRota; id?: string },
  pedido: Pedido,
): Promise<Resposta> {
  const { userId, ator } = pedido;
  switch (`${pedido.metodo} ${rota.nome}`) {
    case "GET tarefas": {
      const limite = lerLimite(pedido.query.get("limite"));
      const recebido = pedido.query.get("cursor");
      const cursor = lerCursor(recebido, UUID);
      const filtros = lerFiltrosTarefas(pedido.query);
      const itens = await listar(client, userId, {
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
        p_status: filtros.status,
        p_responsavel_tipo: filtros.responsavelTipo,
        p_responsavel_ref: filtros.responsavelRef,
        p_atualizado_desde: filtros.atualizadoDesde,
      });
      const corpo = montarPagina(itens, limite, recebido, (t) => [t.atualizada_em, t.tarefa_id]);
      return { status: 200, corpo, itens: corpo.dados.length };
    }
    case "GET tarefa": {
      // Tarefa de outra conta e inexistente respondem igual: 404.
      const [tarefa] = await listar(client, userId, { p_tarefa_id: rota.id });
      if (!tarefa) throw new HttpError(404, "tarefa nao encontrada");
      return { status: 200, corpo: tarefa, itens: 1 };
    }
    case "POST tarefas": {
      const chave = lerChave(pedido.chave);
      const dados = lerNovaTarefa(pedido.corpo);
      const escrita = await chamar<Escrita>(client, "office_tarefa_criar", {
        p_user_id: userId,
        p_ator: ator,
        p_chave: chave,
        p_dados: dados,
      });
      return responder(escrita, escrita.resultado === "criada" ? 201 : 200);
    }
    case "PATCH tarefa": {
      const versao = lerVersao(pedido.ifMatch);
      const campos = lerAlteracao(pedido.corpo);
      const escrita = await chamar<Escrita>(client, "office_tarefa_alterar", {
        p_user_id: userId,
        p_ator: ator,
        p_tarefa_id: rota.id,
        p_versao: versao,
        p_campos: campos,
      });
      return responder(escrita, 200);
    }
    case "POST tarefa_entrega": {
      const versao = lerVersao(pedido.ifMatch);
      const { resultado, resultadoRef } = lerEntrega(pedido.corpo);
      const escrita = await chamar<Escrita>(client, "office_tarefa_entregar", {
        p_user_id: userId,
        p_ator: ator,
        p_tarefa_id: rota.id,
        p_versao: versao,
        p_resultado: resultado,
        p_resultado_ref: resultadoRef,
      });
      return responder(escrita, 200);
    }
    default:
      throw new HttpError(404, "rota inexistente");
  }
}
