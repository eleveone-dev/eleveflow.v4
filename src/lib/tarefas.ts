// Regras da tela Minhas Tarefas. A entrega de um agente espera o dono no topo e só
// sai de lá por Concluir ou Devolver: nenhuma rota da API conclui tarefa.

export type StatusTarefa = "pending" | "in_progress" | "aguardando_revisao" | "done";

export interface Mudanca {
  status: StatusTarefa;
  completed_at: string | null;
}

const ORDEM: Record<StatusTarefa, number> = {
  aguardando_revisao: 0,
  in_progress: 1,
  pending: 2,
  done: 3,
};

const prazo = (t: { due_date: string | null }) =>
  t.due_date ? Date.parse(t.due_date) : Number.POSITIVE_INFINITY;

export function ordenarTarefas<
  T extends { status: StatusTarefa; due_date: string | null; created_at: string },
>(tarefas: T[]): T[] {
  return [...tarefas].sort(
    (a, b) =>
      ORDEM[a.status] - ORDEM[b.status] ||
      prazo(a) - prazo(b) ||
      b.created_at.localeCompare(a.created_at),
  );
}

export function concluir(agora = new Date()): Mudanca {
  return { status: "done", completed_at: agora.toISOString() };
}

export function devolver(): Mudanca {
  return { status: "in_progress", completed_at: null };
}

/** Clique no quadrado da tarefa: conclui a aberta, reabre a concluída. */
export function alternar(status: StatusTarefa, agora = new Date()): Mudanca {
  return status === "done" ? { status: "pending", completed_at: null } : concluir(agora);
}

export function nomeDoResponsavel(t: {
  assignee_type: string;
  assignee_ref: string | null;
}): string {
  return t.assignee_type === "agente" ? `Agente ${t.assignee_ref}` : "Você";
}
