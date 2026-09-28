import { describe, it, expect, vi } from "vitest";
import { handleInboundMessage } from "../../supabase/functions/_shared/whatsapp/inbound-orchestrator";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

function deps(dbOrClient: any, fetchFn = vi.fn()) {
  const client = typeof dbOrClient?.from === "function" ? dbOrClient : createFakeClient(dbOrClient);
  return {
    client: client as any,
    fetchFn: fetchFn as any,
    baseUrl: "https://project.supabase.co",
    internalHeaders: () => ({ apikey: "service-key" }),
    openrouterKey: null,
  };
}

const input = {
  tenantId: TENANT,
  providerMessageId: "MSG-1",
  fromPhone: "5511999998888",
  text: "quero sim",
};

const lead = () => ({
  id: "lead-1",
  user_id: TENANT,
  phone_normalized: "5511999998888",
  name: "Cliente",
  company: "Empresa",
  phone: "5511999998888",
  stage_id: null,
  marketing_consent_status: "granted",
  is_suppressed: false,
  marketing_opted_out_at: null,
});

describe("handleInboundMessage — portões", () => {
  it("mensagem duplicada (mesmo providerMessageId) não é processada duas vezes", async () => {
    const db = {
      messages: [
        { id: "m1", user_id: TENANT, whatsapp_id: "MSG-1", direction: "inbound", content: "x" },
      ],
      leads: [lead()],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body).toMatchObject({ ignored: true, reason: "duplicate" });
    expect(db.messages).toHaveLength(1);
  });

  it("lead inexistente é ignorado com log", async () => {
    const db = { messages: [], leads: [], flow_executions: [], logs: [], pipeline_stages: [] };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body.ignored).toBe(true);
    expect(db.logs.some((l: any) => l.event === "webhook_lead_not_found")).toBe(true);
  });

  it("telefone ambíguo (2+ leads) é ignorado com log", async () => {
    const db = {
      messages: [],
      leads: [lead(), { ...lead(), id: "lead-2" }],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body).toMatchObject({ ignored: true, reason: "ambiguous_lead_phone" });
    expect(db.logs.some((l: any) => l.event === "webhook_ambiguous_lead_phone")).toBe(true);
  });

  it("opt-out suprime o lead e não segue para automação", async () => {
    const db = {
      messages: [],
      leads: [lead()],
      flow_executions: [],
      logs: [],
      send_queue: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), { ...input, text: "PARE" });
    expect(result.body).toMatchObject({ opted_out: true });
    expect(db.leads[0].is_suppressed).toBe(true);
    expect(db.leads[0].marketing_consent_status).toBe("withdrawn");
  });

  it("lead sem consentimento não avança automação", async () => {
    const db = {
      messages: [],
      leads: [{ ...lead(), marketing_consent_status: "unknown" }],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body).toMatchObject({ ignored: true, reason: "lead_suppressed_or_opted_out" });
  });

  it("sem execução ativa, grava a mensagem e para", async () => {
    const db = {
      messages: [],
      leads: [lead()],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      direction: "inbound",
      whatsapp_id: "MSG-1",
      user_id: TENANT,
    });
    expect(db.logs.some((l: any) => l.event === "webhook_no_execution")).toBe(true);
    expect(result.status).toBe(200);
  });

  it("execução em modo agente delega a ai-agent-reply", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const db = {
      messages: [],
      leads: [lead()],
      flow_executions: [
        {
          id: "exec-1",
          user_id: TENANT,
          lead_id: "lead-1",
          flow_id: "flow-1",
          status: "waiting_response",
          context: { agent: { status: "active" } },
          created_at: "2026-07-25T00:00:00Z",
        },
      ],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db, fetchFn), input);
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://project.supabase.co/functions/v1/ai-agent-reply",
    );
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({
      execution_id: "exec-1",
      lead_id: "lead-1",
      reply_content: "quero sim",
    });
    expect(result.body).toMatchObject({ mode: "ai_agent" });
  });

  it("execução em modo sequence delega a execute-sequence", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const db = {
      messages: [],
      leads: [lead()],
      flow_executions: [
        {
          id: "exec-1",
          user_id: TENANT,
          lead_id: "lead-1",
          flow_id: "flow-1",
          status: "waiting_response",
          context: { mode: "sequence" },
          created_at: "2026-07-25T00:00:00Z",
        },
      ],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db, fetchFn), input);
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://project.supabase.co/functions/v1/execute-sequence",
    );
    expect(result.body).toMatchObject({ mode: "sequence" });
  });

  it("nao segue o fluxo quando a gravacao da mensagem falha", async () => {
    const client = createFakeClient(
      {
        leads: [{ id: "lead-1", user_id: TENANT, phone_normalized: "5511987654321" }],
        messages: [],
        logs: [],
      },
      { errors: { messages: { message: "duplicate key value violates unique constraint" } } },
    );

    await expect(
      handleInboundMessage(deps(client), {
        tenantId: TENANT,
        providerMessageId: "wamid.DUP",
        fromPhone: "5511987654321",
        text: "oi",
      }),
    ).rejects.toThrow(/duplicate key/);
  });

  it("isolamento: lead de outro tenant não é encontrado", async () => {
    const db = {
      messages: [],
      leads: [{ ...lead(), user_id: "tenant-2" }],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body.ignored).toBe(true);
    expect(String(result.body.reason)).toContain("Lead não encontrado");
  });
});

describe("handleInboundMessage — midia", () => {
  const db = () => ({
    messages: [] as any[],
    leads: [lead()],
    flow_executions: [
      {
        id: "exec-1",
        user_id: TENANT,
        lead_id: "lead-1",
        status: "waiting_response",
        flow_id: "f1",
      },
    ] as any[],
    logs: [] as any[],
    pipeline_stages: [],
  });

  it("midia sem legenda e gravada com o tipo e nao segue para automacao", async () => {
    const banco = db();
    const fetchFn = vi.fn();

    const result = await handleInboundMessage(deps(banco, fetchFn), {
      ...input,
      text: "",
      mediaType: "audio",
    });

    expect(result.body).toMatchObject({ recorded_only: true, reason: "media_without_text" });
    expect(banco.messages[0]).toMatchObject({
      content: "",
      media_type: "audio",
      direction: "inbound",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("midia com legenda grava o tipo e segue o caminho do texto", async () => {
    const banco = { ...db(), flow_executions: [] };

    const result = await handleInboundMessage(deps(banco), {
      ...input,
      text: "olha a foto da fachada",
      mediaType: "image",
    });

    expect(result.body.recorded_only).toBeUndefined();
    expect(banco.messages[0]).toMatchObject({
      content: "olha a foto da fachada",
      media_type: "image",
    });
  });

  it("texto grava media_type nulo", async () => {
    const banco = { ...db(), flow_executions: [] };

    await handleInboundMessage(deps(banco), input);

    expect(banco.messages[0].media_type).toBeNull();
  });
});
