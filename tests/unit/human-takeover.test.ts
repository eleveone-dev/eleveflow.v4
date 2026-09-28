import { describe, it, expect } from "vitest";
import {
  DEFAULT_TAKEOVER_HOURS,
  endHumanTakeover,
  humanTakeoverUntil,
  isUnderHumanTakeover,
  queueDeferralUntil,
  rescheduleForTakeover,
  shouldSkipAutomation,
  startHumanTakeover,
} from "../../supabase/functions/_shared/whatsapp/human-takeover";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";
const NOW = new Date("2026-08-18T12:00:00.000Z");

describe("isUnderHumanTakeover", () => {
  it("é verdadeiro enquanto o prazo não venceu", () => {
    const lead = { human_takeover_until: "2026-08-18T18:00:00.000Z" };
    expect(isUnderHumanTakeover(lead, NOW)).toBe(true);
  });

  it("é falso depois do prazo", () => {
    const lead = { human_takeover_until: "2026-08-18T06:00:00.000Z" };
    expect(isUnderHumanTakeover(lead, NOW)).toBe(false);
  });

  it("é falso no instante exato do vencimento", () => {
    const lead = { human_takeover_until: "2026-08-18T12:00:00.000Z" };
    expect(isUnderHumanTakeover(lead, NOW)).toBe(false);
  });

  it("é falso quando não há prazo", () => {
    expect(isUnderHumanTakeover({ human_takeover_until: null }, NOW)).toBe(false);
    expect(isUnderHumanTakeover({}, NOW)).toBe(false);
    expect(isUnderHumanTakeover(null, NOW)).toBe(false);
  });

  it("é falso quando o valor gravado não é data", () => {
    expect(isUnderHumanTakeover({ human_takeover_until: "amanhã" }, NOW)).toBe(false);
  });
});

describe("humanTakeoverUntil", () => {
  it("devolve o prazo quando ativo e null quando não", () => {
    expect(humanTakeoverUntil({ human_takeover_until: "2026-08-18T18:00:00.000Z" }, NOW)).toBe(
      "2026-08-18T18:00:00.000Z",
    );
    expect(humanTakeoverUntil({ human_takeover_until: "2026-08-18T06:00:00.000Z" }, NOW)).toBe(
      null,
    );
  });
});

describe("startHumanTakeover", () => {
  it("grava agora mais as horas pedidas", async () => {
    const db: any = { leads: [{ id: "lead-1", user_id: TENANT, human_takeover_until: null }] };
    const client = createFakeClient(db);

    const until = await startHumanTakeover(client as any, TENANT, "lead-1", 24, NOW);

    expect(until).toBe("2026-08-19T12:00:00.000Z");
    expect(db.leads[0].human_takeover_until).toBe("2026-08-19T12:00:00.000Z");
  });

  it("usa 24 horas como padrão do sistema", () => {
    expect(DEFAULT_TAKEOVER_HOURS).toBe(24);
  });
});

describe("endHumanTakeover", () => {
  it("limpa o prazo", async () => {
    const db: any = {
      leads: [{ id: "lead-1", user_id: TENANT, human_takeover_until: "2026-08-19T12:00:00.000Z" }],
    };
    const client = createFakeClient(db);

    await endHumanTakeover(client as any, TENANT, "lead-1");

    expect(db.leads[0].human_takeover_until).toBe(null);
  });
});

describe("shouldSkipAutomation", () => {
  const NOW2 = new Date("2026-08-18T12:00:00.000Z");

  it("pula quando a pausa está ativa", () => {
    const lead = { human_takeover_until: "2026-08-18T18:00:00.000Z" };
    expect(shouldSkipAutomation(lead, { isTest: false, now: NOW2 })).toBe(true);
  });

  it("não pula quando a pausa venceu", () => {
    const lead = { human_takeover_until: "2026-08-18T06:00:00.000Z" };
    expect(shouldSkipAutomation(lead, { isTest: false, now: NOW2 })).toBe(false);
  });

  it("não pula em teste manual, mesmo com pausa ativa", () => {
    const lead = { human_takeover_until: "2026-08-18T18:00:00.000Z" };
    expect(shouldSkipAutomation(lead, { isTest: true, now: NOW2 })).toBe(false);
  });
});

describe("rescheduleForTakeover", () => {
  it("adia a execucao para o fim da pausa e a mantem rodando", async () => {
    const db: any = {
      flow_executions: [{ id: "exec-1", status: "running", scheduled_at: null }],
    };
    const client = createFakeClient(db);

    await rescheduleForTakeover(client as any, "exec-1", "2026-08-19T12:00:00.000Z");

    expect(db.flow_executions[0].scheduled_at).toBe("2026-08-19T12:00:00.000Z");
    expect(db.flow_executions[0].status).toBe("running");
  });
});

describe("queueDeferralUntil", () => {
  const agora = new Date("2026-09-25T12:00:00.000Z");
  const emPausa = { human_takeover_until: "2026-09-26T12:00:00.000Z", is_test: false };

  it("item de automacao de lead em pausa espera ate o fim da pausa", () => {
    expect(queueDeferralUntil({ flow_id: "flow-1" }, emPausa, agora)).toBe(
      "2026-09-26T12:00:00.000Z",
    );
  });

  it("mensagem do vendedor pela tela (sem flow_id) sai mesmo com a pausa", () => {
    expect(queueDeferralUntil({ flow_id: null }, emPausa, agora)).toBeNull();
    expect(queueDeferralUntil({}, emPausa, agora)).toBeNull();
  });

  it("lead de teste nao espera", () => {
    expect(
      queueDeferralUntil({ flow_id: "flow-1" }, { ...emPausa, is_test: true }, agora),
    ).toBeNull();
  });

  it("pausa vencida ou ausente nao segura nada", () => {
    expect(
      queueDeferralUntil(
        { flow_id: "flow-1" },
        { human_takeover_until: "2026-09-25T11:00:00.000Z" },
        agora,
      ),
    ).toBeNull();
    expect(
      queueDeferralUntil({ flow_id: "flow-1" }, { human_takeover_until: null }, agora),
    ).toBeNull();
  });
});
