import { describe, it, expect } from "vitest";
import { handleEcho } from "../../supabase/functions/_shared/whatsapp/echo-handler";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

const input = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  providerMessageId: "wamid.ECHO1",
  toPhone: "5511987654321",
  text: "Bom dia! Vou te passar o preço",
  timestamp: "2026-08-18T12:00:00.000Z",
  ...over,
});

const dbComLead = () => ({
  leads: [
    {
      id: "lead-1",
      user_id: TENANT,
      phone_normalized: "5511987654321",
      human_takeover_until: null,
    },
  ],
  messages: [] as any[],
  logs: [] as any[],
  global_settings: [{ key: "human_takeover_hours", value: "24" }],
});

describe("handleEcho", () => {
  it("grava a mensagem como saida marcada como do celular", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      user_id: TENANT,
      lead_id: "lead-1",
      direction: "outbound",
      origin: "business_app",
      whatsapp_id: "wamid.ECHO1",
      content: "Bom dia! Vou te passar o preço",
      status: null,
    });
  });

  it("carimba a pausa no lead", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.leads[0].human_takeover_until).toBeTruthy();
    expect(new Date(db.leads[0].human_takeover_until).getTime()).toBeGreaterThan(Date.now());
  });

  it("ignora eco repetido sem gravar nada", async () => {
    const db = dbComLead();
    db.messages.push({
      id: "m1",
      user_id: TENANT,
      whatsapp_id: "wamid.ECHO1",
      direction: "outbound",
    });
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "duplicate" });
    expect(db.messages).toHaveLength(1);
    expect(db.leads[0].human_takeover_until).toBe(null);
  });

  it("ignora eco de numero sem lead, sem criar lead", async () => {
    const db = dbComLead();
    db.leads = [];
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "lead_not_found" });
    expect(db.messages).toHaveLength(0);
    expect(db.leads).toHaveLength(0);
  });

  it("ignora eco de telefone ambiguo", async () => {
    const db = dbComLead();
    db.leads.push({
      id: "lead-2",
      user_id: TENANT,
      phone_normalized: "551187654321",
      human_takeover_until: null,
    });
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "ambiguous_lead_phone" });
    expect(db.messages).toHaveLength(0);
  });

  it("grava a mensagem mesmo sem texto, sem quebrar", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input({ text: "" }));

    expect(result.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.leads[0].human_takeover_until).toBeTruthy();
  });

  it("grava o tipo de midia do eco", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input({ text: "", mediaType: "audio" }));

    expect(db.messages[0]).toMatchObject({ content: "", media_type: "audio" });
  });

  it("eco de texto grava media_type nulo", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.messages[0].media_type).toBeNull();
  });

  it("ignora o eco de um envio nosso em curso", async () => {
    const db: any = dbComLead();
    db.send_queue = [
      {
        id: "q1",
        user_id: TENANT,
        lead_id: "lead-1",
        status: "sending",
        sending_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "own_send_in_flight" });
    expect(db.messages).toHaveLength(0);
    expect(db.leads[0].human_takeover_until).toBe(null);
  });

  it("item em sending ha mais de 2 minutos nao e envio nosso em curso", async () => {
    const db: any = dbComLead();
    db.send_queue = [
      {
        id: "q1",
        user_id: TENANT,
        lead_id: "lead-1",
        status: "sending",
        sending_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    ];
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.messages).toHaveLength(1);
  });

  it("envio em curso para outro lead nao segura o eco", async () => {
    const db: any = dbComLead();
    db.send_queue = [
      {
        id: "q1",
        user_id: TENANT,
        lead_id: "lead-9",
        status: "sending",
        sending_at: new Date().toISOString(),
      },
    ];
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.messages).toHaveLength(1);
  });

  it("numero que nao e lead nao vai para o log", async () => {
    const db = dbComLead();
    db.leads = [];
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.logs.map((l: any) => l.event)).toContain("echo_lead_not_found");
    expect(JSON.stringify(db.logs)).not.toContain("987654321");
  });
});
