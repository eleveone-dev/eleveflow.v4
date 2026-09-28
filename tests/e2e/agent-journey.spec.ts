import { test, expect } from "@playwright/test";
import {
  adminClient,
  seedAgentFlow,
  metaInboundPayload,
  removeTestConnection,
  seedTestConnection,
  signMetaBody,
} from "./helpers/agent-seed";
import { stagingPublishableKey, stagingServiceKey, stagingUrl } from "./helpers/supabase-admin";

const SUPABASE_URL = stagingUrl();
const SERVICE_KEY = stagingServiceKey();
const PUBLISHABLE_KEY = stagingPublishableKey();
const META_APP_SECRET = process.env.STAGING_META_APP_SECRET!;
const META_PHONE_NUMBER_ID = process.env.STAGING_META_PHONE_NUMBER_ID!;
const INTERNAL_FUNCTION_SECRET = process.env.STAGING_INTERNAL_FUNCTION_SECRET!;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const e2eUser = users?.users.find((user) => user.email === "e2e@eleveflow.test");
  if (!e2eUser) throw new Error("usuário e2e@eleveflow.test não existe");
  await seedTestConnection(admin, e2eUser.id, META_PHONE_NUMBER_ID);
});

test.afterAll(async () => {
  // Não deixar conexão fictícia no banco: a tela a mostraria como número real.
  await removeTestConnection(adminClient(), META_PHONE_NUMBER_ID);
});
test.setTimeout(240_000); // chamadas LLM reais

const svcHeaders = { apikey: SERVICE_KEY, "Content-Type": "application/json" };
const internalHeaders = {
  apikey: SERVICE_KEY,
  "x-internal-function-secret": INTERNAL_FUNCTION_SECRET,
  "Content-Type": "application/json",
};
const internalSecretProofHeaders = {
  apikey: PUBLISHABLE_KEY,
  "x-internal-function-secret": INTERNAL_FUNCTION_SECRET,
  "Content-Type": "application/json",
};
const webhookUrl = `${SUPABASE_URL}/functions/v1/meta-whatsapp-webhook`;

if (!META_APP_SECRET || !META_PHONE_NUMBER_ID || !INTERNAL_FUNCTION_SECRET) {
  throw new Error(
    "STAGING_META_APP_SECRET, STAGING_META_PHONE_NUMBER_ID and STAGING_INTERNAL_FUNCTION_SECRET must be configured for E2E tests",
  );
}

/** O webhook recebe a string assinada, não um objeto reserializado. */
function inbound(phone: string, text: string, id: string) {
  const body = JSON.stringify(metaInboundPayload(phone, text, id, META_PHONE_NUMBER_ID));
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signMetaBody(body, META_APP_SECRET),
    },
    data: body,
  };
}

test("staging usa o mesmo segredo interno no banco e nas Edge Functions", async ({ request }) => {
  const admin = adminClient();
  const { data: internalSetting, error } = await admin
    .from("global_settings")
    .select("value")
    .eq("key", "edge_functions_internal_secret")
    .maybeSingle();
  expect(error).toBeNull();
  expect(internalSetting?.value).toBe(INTERNAL_FUNCTION_SECRET);

  const worker = await request.post(`${SUPABASE_URL}/functions/v1/process-flows`, {
    headers: internalSecretProofHeaders,
    data: {},
  });
  expect(worker.ok()).toBeTruthy();
});

test("agente abre conversa, responde e sai por OBJETIVO com custo registrado", async ({
  request,
}) => {
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, { phone: "5511999990001", maxTurns: 5, suffix: "GOAL" });

  // 1. dispara o fluxo (abertura via LLM real)
  const ex = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(ex.ok()).toBeTruthy();

  // 2. abertura enfileirada + contexto de agente ativo
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 90_000 },
    )
    .toBe("active");
  const { data: q } = await admin
    .from("send_queue")
    .select("id")
    .eq("lead_id", seed.leadId)
    .eq("status", "pending");
  expect(q!.length).toBeGreaterThan(0);

  // 3. envia a abertura pela fila
  const queueItemId = q![0].id;
  // force:true evita depender do horário comercial do tenant: fora da janela
  // (fim de semana, por exemplo) o item é agendado para o próximo dia útil e o
  // teste falharia por motivo alheio ao que ele mede.
  const queueSend = await request.post(`${SUPABASE_URL}/functions/v1/process-queue`, {
    headers: internalHeaders,
    data: { queueItemId, force: true },
  });
  expect(queueSend.ok()).toBeTruthy();
  // A entrega real exige um access token Meta válido. Sem ele a Graph API
  // responde 401 e o item não chega a "sent" — o resto da jornada (webhook,
  // decisão do agente, custo) continua sendo verificado normalmente.
  const REAL_META_TOKEN = process.env.STAGING_META_HAS_REAL_TOKEN === "true";
  await expect
    .poll(
      async () =>
        (await admin.from("send_queue").select("status").eq("id", queueItemId).single()).data
          ?.status,
      { timeout: 30_000 },
    )
    .toBe(REAL_META_TOKEN ? "sent" : "pending");
  test.skip(!REAL_META_TOKEN, "envio real exige STAGING_META_HAS_REAL_TOKEN=true");
  const { data: deliveredMessage } = await admin
    .from("messages")
    .select("queue_item_id, direction, status")
    .eq("queue_item_id", queueItemId)
    .maybeSingle();
  expect(deliveredMessage).toMatchObject({
    queue_item_id: queueItemId,
    direction: "outbound",
    status: "sent",
  });

  // 4. lead aceita agendar → decision goal
  const wh = await request.post(
    webhookUrl,
    inbound(
      "5511999990001",
      "Sim! Quero agendar essa conversa, pode marcar amanhã às 10h.",
      `E2E-GOAL-${Date.now()}`,
    ),
  );
  expect(wh.ok()).toBeTruthy();

  // 5. decisão goal aplicada, fluxo seguiu pela saída Objetivo → move_pipeline
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 120_000 },
    )
    .toBe("goal");
  await expect
    .poll(
      async () =>
        (await admin.from("leads").select("stage_id").eq("id", seed.leadId).single()).data
          ?.stage_id,
      { timeout: 60_000 },
    )
    .toBe(seed.goalStageId);

  // 6. api_calls: tokens, latência e custo real > 0 (critério §8.1)
  const { data: calls } = await admin
    .from("api_calls")
    .select("feature, status, prompt_tokens, completion_tokens, latency_ms, cost_usd_micros")
    .eq("lead_id", seed.leadId)
    .in("feature", ["agent_opening", "agent_reply"]);
  expect(calls!.length).toBeGreaterThanOrEqual(2);
  for (const c of calls!) {
    expect(c.status).toBe("ok");
    expect(c.prompt_tokens).toBeGreaterThan(0);
    expect(c.latency_ms).toBeGreaterThan(0);
    expect(c.cost_usd_micros).toBeGreaterThan(0);
  }
});

test("limite de turnos força saída LIMITE", async ({ request }) => {
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, { phone: "5511999990002", maxTurns: 1, suffix: "LIMIT" });

  const ex = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(ex.ok()).toBeTruthy();

  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 90_000 },
    )
    .toBe("active");

  // resposta vaga: LLM tende a "continue", motor força "limit" (turns 1 >= max_turns 1)
  await request.post(
    webhookUrl,
    inbound(
      "5511999990002",
      "hmm, me explica melhor o que vocês fazem?",
      `E2E-LIMIT-${Date.now()}`,
    ),
  );

  await expect
    .poll(
      async () =>
        (
          await admin
            .from("flow_executions")
            .select("context, status")
            .eq("lead_id", seed.leadId)
            .maybeSingle()
        ).data?.context?.agent?.status,
      { timeout: 120_000 },
    )
    .toBe("limit");
  const { data: exec } = await admin
    .from("flow_executions")
    .select("status")
    .eq("lead_id", seed.leadId)
    .maybeSingle();
  expect(exec!.status).toBe("completed"); // saída limit → end
});
