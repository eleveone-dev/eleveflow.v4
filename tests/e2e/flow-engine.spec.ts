import { test, expect } from "@playwright/test";
import { adminClient, removeLeadByPhone } from "./helpers/agent-seed";
import { stagingServiceKey, stagingUrl } from "./helpers/supabase-admin";

/**
 * O motor do fluxo diante de uma mensagem que o lead já recebeu.
 *
 * A trigger prevent_duplicate_send_queue descarta em silêncio o item de um bloco
 * que o lead já recebeu. O execute-flow inseria com `.single()`, e a linha ausente
 * virava exceção: o motor devolvia 500 e a execução ficava presa na mensagem. Foi
 * o "Edge Function returned a non-2xx status code" do botão Testar fluxo em
 * 2026-09-22, com o lead de teste reaproveitado. Com lead real que volta ao fluxo,
 * o efeito era o mesmo, só que sem ninguém olhando.
 */

const SUPABASE_URL = stagingUrl();
const SERVICE_KEY = stagingServiceKey();
// Celular sem WhatsApp: nada do que este teste enfileira chega a ninguém.
const TELEFONE = "5511999990006";
const headers = { apikey: SERVICE_KEY, "Content-Type": "application/json" };

let tenantId = "";
let flowId = "";
let mensagemId = "";
let leadId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const tenant = users?.users.find((u) => u.email === "e2e@eleveflow.test");
  if (!tenant) throw new Error("usuário e2e@eleveflow.test não existe");
  tenantId = tenant.id;

  const { data: flow } = await admin
    .from("flows")
    .insert({ user_id: tenantId, name: `Motor E2E ${Date.now()}`, is_active: false })
    .select("id")
    .single();
  flowId = flow!.id;

  const bloco = async (type: string, position: number, config: Record<string, unknown>) =>
    (
      await admin
        .from("flow_blocks")
        .insert({ user_id: tenantId, flow_id: flowId, type, position, config })
        .select("id")
        .single()
    ).data!.id as string;

  const gatilho = await bloco("trigger", 0, { trigger_type: "manual" });
  mensagemId = await bloco("message", 1, { message: "teste de duplicata", auto_continue: true });
  const fim = await bloco("end", 2, {});
  await admin
    .from("flows")
    .update({
      canvas_state: {
        edges: [
          { id: "e1", source: gatilho, target: mensagemId },
          { id: "e2", source: mensagemId, target: fim },
        ],
      },
    })
    .eq("id", flowId);

  await removeLeadByPhone(admin, tenantId, TELEFONE);
  const { data: lead } = await admin
    .from("leads")
    .insert({
      user_id: tenantId,
      name: "Lead Motor E2E",
      phone: TELEFONE,
      marketing_consent_status: "not_required",
    })
    .select("id")
    .single();
  leadId = lead!.id;

  // O lead já recebeu esta mensagem: é o estado que disparava o 500.
  await admin.from("send_queue").insert({
    user_id: tenantId,
    lead_id: leadId,
    flow_id: flowId,
    block_id: mensagemId,
    status: "sent",
    content: "teste de duplicata",
    scheduled_at: new Date().toISOString(),
  });
});

test.afterAll(async () => {
  const admin = adminClient();
  await removeLeadByPhone(admin, tenantId, TELEFONE);
  await admin.from("flows").delete().eq("id", flowId);
});

const itensDaMensagem = async () =>
  (
    await adminClient()
      .from("send_queue")
      .select("id")
      .eq("lead_id", leadId)
      .eq("block_id", mensagemId)
  ).data?.length ?? 0;

test("no teste, mensagem já recebida devolve o motivo em vez de quebrar o motor", async ({
  request,
}) => {
  const res = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers,
    data: {
      flow_id: flowId,
      lead_id: leadId,
      user_id: tenantId,
      trigger_type: "manual",
      is_test: true,
    },
  });

  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ success: true, paused: "duplicate_blocked" });
  expect(await itensDaMensagem()).toBe(1);
});

test("lead real que volta ao fluxo segue adiante sem receber a mesma mensagem", async ({
  request,
}) => {
  await adminClient().from("flow_executions").delete().eq("lead_id", leadId);

  const res = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers,
    data: { flow_id: flowId, lead_id: leadId, user_id: tenantId, trigger_type: "manual" },
  });

  expect(res.status()).toBe(200);
  expect((await res.json()).success).toBe(true);
  // Nenhum item novo: a mensagem não se repete.
  expect(await itensDaMensagem()).toBe(1);
  // E o fluxo não ficou preso na mensagem: chegou ao fim.
  await expect
    .poll(
      async () =>
        (
          await adminClient()
            .from("flow_executions")
            .select("status")
            .eq("lead_id", leadId)
            .maybeSingle()
        ).data?.status,
      { timeout: 30_000 },
    )
    .toBe("completed");
});

test("mensagem enfileirada não aparece na conversa antes de ser entregue", async ({ request }) => {
  // A conversa mostra o que o lead recebeu, e quem grava em `messages` é a
  // entrega (complete_marketing_queue_delivery), com o item da fila ligado. O
  // motor gravava também uma cópia "pendente" ao enfileirar: toda mensagem
  // entregue aparecia duas vezes, e a que nunca saía ficava "pendente" para sempre.
  const admin = adminClient();
  await admin.from("flow_executions").delete().eq("lead_id", leadId);
  await admin.from("send_queue").delete().eq("lead_id", leadId);

  const res = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers,
    data: { flow_id: flowId, lead_id: leadId, user_id: tenantId, trigger_type: "manual" },
  });

  expect(res.status()).toBe(200);
  // Agora a mensagem entrou na fila de verdade.
  expect(await itensDaMensagem()).toBe(1);

  // O número do teste não tem WhatsApp: nada foi entregue, e nada pode constar
  // na conversa como se tivesse saído.
  const { data: saidas } = await admin
    .from("messages")
    .select("id, queue_item_id")
    .eq("lead_id", leadId)
    .eq("direction", "outbound");
  expect(saidas!.filter((m) => !m.queue_item_id)).toHaveLength(0);
});
