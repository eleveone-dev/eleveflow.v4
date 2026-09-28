// Corpo e cabecalhos das rotas de tarefa: valida e traduz a API (portugues) para as
// colunas de personal_tasks. Campo fora da lista da 400: o Office descobre o erro na
// hora, em vez de achar que gravou.

import { HttpError } from "../http-error.ts";
import { lerData, UUID } from "./parametros.ts";

export const STATUS_DB: Record<string, string> = {
  pendente: "pending",
  em_andamento: "in_progress",
  aguardando_revisao: "aguardando_revisao",
  concluida: "done",
};

const PRIORIDADE_DB: Record<string, string> = { baixa: "low", media: "medium", alta: "high" };
const TIPOS = ["dono", "agente"];
const NOVA = [
  "titulo",
  "descricao",
  "prioridade",
  "prazo",
  "lead_id",
  "projeto_ref",
  "responsavel",
  "criador_ref",
  "ordem_externa_id",
];
const ALTERAVEIS = [
  "titulo",
  "descricao",
  "prioridade",
  "prazo",
  "lead_id",
  "projeto_ref",
  "responsavel",
  "status",
];
// Prazo so com fuso: "13:00" sem fuso seria uma hora no Office e outra no banco.
const DATA_COM_FUSO =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const CHAVE = /^[\x21-\x7e]{1,200}$/;
const VERSAO = /^(?:"(\d{1,9})"|(\d{1,9}))$/;

type Obj = Record<string, unknown>;

export interface NovaTarefa {
  title: string;
  description: string | null;
  priority: string;
  due_date: string | null;
  lead_id: string | null;
  project_ref: string | null;
  creator_ref: string | null;
  assignee_type: string;
  assignee_ref: string | null;
  external_order_id: string | null;
}

export interface FiltrosTarefas {
  status: string | null;
  responsavelTipo: string | null;
  responsavelRef: string | null;
  atualizadoDesde: string | null;
}

function invalido(mensagem: string): never {
  throw new HttpError(400, mensagem);
}

function objeto(valor: unknown, nome: string): Obj {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    invalido(`${nome} deve ser um objeto JSON`);
  }
  return valor as Obj;
}

function soPermitidos(corpo: Obj, permitidos: string[], prefixo = ""): void {
  const fora = Object.keys(corpo).filter((campo) => !permitidos.includes(campo));
  if (fora.length) invalido(`campo nao permitido: ${fora.map((c) => prefixo + c).join(", ")}`);
}

/** Ausente → undefined; null → null (limpa). Tamanho em caracteres, como no banco. */
function texto(corpo: Obj, campo: string, maximo: number, nome = campo): string | null | undefined {
  const valor = corpo[campo];
  if (valor === undefined || valor === null) return valor;
  if (typeof valor !== "string" || valor.trim() === "" || [...valor].length > maximo) {
    invalido(`${nome} deve ser texto de 1 a ${maximo} caracteres`);
  }
  return valor;
}

function obrigatorio<T>(valor: T | null | undefined, nome: string): T {
  if (valor === undefined || valor === null) invalido(`${nome} e obrigatorio`);
  return valor;
}

function traduzido(corpo: Obj, campo: string, mapa: Record<string, string>): string | undefined {
  const valor = corpo[campo];
  if (valor === undefined) return undefined;
  if (typeof valor !== "string" || !Object.keys(mapa).includes(valor)) {
    invalido(`${campo} deve ser ${Object.keys(mapa).join(", ")}`);
  }
  return mapa[valor];
}

function dataValida(valor: string): boolean {
  const casou = DATA_COM_FUSO.exec(valor);
  if (!casou) return false;
  const [ano, mes, dia] = [Number(casou[1]), Number(casou[2]), Number(casou[3])];
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

function prazo(corpo: Obj): string | null | undefined {
  const valor = corpo.prazo;
  if (valor === undefined || valor === null) return valor;
  if (typeof valor !== "string" || !dataValida(valor)) {
    invalido("prazo deve ser ISO 8601 com fuso, como 2026-09-26T13:00:00-03:00");
  }
  return valor;
}

function leadId(corpo: Obj): string | null | undefined {
  const valor = corpo.lead_id;
  if (valor === undefined || valor === null) return valor;
  if (typeof valor !== "string" || !UUID.test(valor)) invalido("lead_id deve ser um uuid");
  return valor;
}

function responsavel(corpo: Obj): { assignee_type: string; assignee_ref: string | null } {
  const r = objeto(corpo.responsavel, "responsavel");
  soPermitidos(r, ["tipo", "ref"], "responsavel.");
  if (typeof r.tipo !== "string" || !TIPOS.includes(r.tipo)) {
    invalido("responsavel.tipo deve ser dono ou agente");
  }
  const ref = texto(r, "ref", 200, "responsavel.ref");
  if (r.tipo === "agente" && !ref) invalido("responsavel.ref e obrigatoria para agente");
  if (r.tipo === "dono" && ref) invalido("responsavel.ref so vale para agente");
  return { assignee_type: r.tipo, assignee_ref: ref ?? null };
}

export function lerNovaTarefa(valor: unknown): NovaTarefa {
  const corpo = objeto(valor, "corpo");
  soPermitidos(corpo, NOVA);
  const dono = { assignee_type: "dono", assignee_ref: null };
  return {
    title: obrigatorio(texto(corpo, "titulo", 300), "titulo").trim(),
    description: texto(corpo, "descricao", 10_000) ?? null,
    priority: traduzido(corpo, "prioridade", PRIORIDADE_DB) ?? "medium",
    due_date: prazo(corpo) ?? null,
    lead_id: leadId(corpo) ?? null,
    project_ref: texto(corpo, "projeto_ref", 200) ?? null,
    creator_ref: texto(corpo, "criador_ref", 200) ?? null,
    ...(corpo.responsavel === undefined ? dono : responsavel(corpo)),
    external_order_id: texto(corpo, "ordem_externa_id", 200) ?? null,
  };
}

export function lerAlteracao(valor: unknown): Record<string, unknown> {
  const corpo = objeto(valor, "corpo");
  soPermitidos(corpo, ALTERAVEIS);
  if (Object.keys(corpo).length === 0) invalido("nada para alterar");

  const campos: Record<string, unknown> = {};
  if ("titulo" in corpo) campos.title = obrigatorio(texto(corpo, "titulo", 300), "titulo").trim();
  if ("descricao" in corpo) campos.description = texto(corpo, "descricao", 10_000);
  if ("prioridade" in corpo) campos.priority = traduzido(corpo, "prioridade", PRIORIDADE_DB);
  if ("prazo" in corpo) campos.due_date = prazo(corpo);
  if ("lead_id" in corpo) campos.lead_id = leadId(corpo);
  if ("projeto_ref" in corpo) campos.project_ref = texto(corpo, "projeto_ref", 200);
  if ("responsavel" in corpo) Object.assign(campos, responsavel(corpo));
  if ("status" in corpo) campos.status = traduzido(corpo, "status", STATUS_DB);
  return campos;
}

function ehUrl(valor: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(valor).protocol);
  } catch {
    return false;
  }
}

export function lerEntrega(valor: unknown): { resultado: string; resultadoRef: string | null } {
  const corpo = objeto(valor, "corpo");
  soPermitidos(corpo, ["resultado", "resultado_ref"]);
  const resultado = obrigatorio(texto(corpo, "resultado", 5000), "resultado");
  const resultadoRef = texto(corpo, "resultado_ref", 2000) ?? null;
  if (resultadoRef !== null && !ehUrl(resultadoRef)) {
    invalido("resultado_ref deve ser uma URL http ou https");
  }
  return { resultado, resultadoRef };
}

export function lerVersao(valor: string | null): number {
  if (valor === null) {
    throw new HttpError(428, 'envie If-Match com a versao da tarefa, como "3"');
  }
  const casou = VERSAO.exec(valor.trim());
  if (!casou) invalido('If-Match deve ser a versao da tarefa, como "3"');
  return Number(casou[1] ?? casou[2]);
}

export function lerChave(valor: string | null): string {
  if (valor === null || !CHAVE.test(valor)) {
    invalido("Idempotency-Key obrigatorio: de 1 a 200 caracteres visiveis, sem espaco");
  }
  return valor;
}

export function lerFiltrosTarefas(query: URLSearchParams): FiltrosTarefas {
  const status = query.get("status");
  const tipo = query.get("responsavel_tipo");
  const ref = query.get("responsavel_ref");
  if (status !== null && !Object.keys(STATUS_DB).includes(status)) {
    invalido(`status deve ser ${Object.keys(STATUS_DB).join(", ")}`);
  }
  if (tipo !== null && !TIPOS.includes(tipo)) invalido("responsavel_tipo deve ser dono ou agente");
  if (ref !== null && (ref === "" || [...ref].length > 200)) {
    invalido("responsavel_ref deve ter de 1 a 200 caracteres");
  }
  return {
    status: status === null ? null : STATUS_DB[status],
    responsavelTipo: tipo,
    responsavelRef: ref,
    atualizadoDesde: lerData("atualizado_desde", query.get("atualizado_desde")),
  };
}

export function lerJson(texto: string): unknown {
  if (texto.trim() === "") return null;
  try {
    return JSON.parse(texto);
  } catch {
    invalido("corpo deve ser JSON valido");
  }
}
