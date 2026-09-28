import { describe, it, expect } from "vitest";
import {
  alternar,
  concluir,
  devolver,
  nomeDoResponsavel,
  ordenarTarefas,
  type StatusTarefa,
} from "../../src/lib/tarefas";

const AGORA = new Date("2026-09-25T12:00:00.000Z");
const t = (id: string, status: StatusTarefa, due_date: string | null, created_at: string) => ({
  id,
  status,
  due_date,
  created_at,
});

describe("ordenarTarefas", () => {
  it("revisao, em andamento, pendente e concluida; prazo mais proximo antes; sem prazo por ultimo", () => {
    const tarefas = [
      t("d", "done", null, "2026-09-20T00:00:00Z"),
      t("p-sem-prazo", "pending", null, "2026-09-21T00:00:00Z"),
      t("p-27", "pending", "2026-09-27T00:00:00Z", "2026-09-21T00:00:00Z"),
      t("p-26", "pending", "2026-09-26T00:00:00Z", "2026-09-21T00:00:00Z"),
      t("i", "in_progress", null, "2026-09-22T00:00:00Z"),
      t("r", "aguardando_revisao", null, "2026-09-23T00:00:00Z"),
    ];
    expect(ordenarTarefas(tarefas).map((x) => x.id)).toEqual([
      "r",
      "i",
      "p-26",
      "p-27",
      "p-sem-prazo",
      "d",
    ]);
  });

  it("no empate, a criada por ultimo vem antes; a lista original fica igual", () => {
    const tarefas = [
      t("velha", "pending", null, "2026-09-20T00:00:00Z"),
      t("nova", "pending", null, "2026-09-24T00:00:00Z"),
    ];
    expect(ordenarTarefas(tarefas).map((x) => x.id)).toEqual(["nova", "velha"]);
    expect(tarefas.map((x) => x.id)).toEqual(["velha", "nova"]);
  });
});

describe("acoes do dono", () => {
  it("concluir marca a hora; devolver volta a tarefa para em andamento", () => {
    expect(concluir(AGORA)).toEqual({ status: "done", completed_at: "2026-09-25T12:00:00.000Z" });
    expect(devolver()).toEqual({ status: "in_progress", completed_at: null });
  });

  it("o quadrado conclui a aberta e reabre a concluida", () => {
    expect(alternar("pending", AGORA)).toEqual(concluir(AGORA));
    expect(alternar("in_progress", AGORA)).toEqual(concluir(AGORA));
    expect(alternar("done", AGORA)).toEqual({ status: "pending", completed_at: null });
  });
});

describe("nomeDoResponsavel", () => {
  it("agente pela referencia do Office; dono e voce", () => {
    expect(nomeDoResponsavel({ assignee_type: "agente", assignee_ref: "sdr-1" })).toBe(
      "Agente sdr-1",
    );
    expect(nomeDoResponsavel({ assignee_type: "dono", assignee_ref: null })).toBe("Você");
  });
});
