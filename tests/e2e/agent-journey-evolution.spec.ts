import { test, expect } from "@playwright/test";
import {
  adminClient,
  evolutionInboundPayload,
  removeEvolutionConnection,
  removeLeadByPhone,
  seedAgentFlow,
  seedEvolutionConnection,
} from "./helpers/agent-seed";
import { stagingServiceKey, stagingUrl } from "./helpers/supabase-admin";

/**
 * A jornada do agente pelo caminho que está no ar: inbound da Evolution.
 *
 * O `agent-journey.spec.ts` cobre a mesma jornada pela Cloud API, mas a metade
 * que importa — o lead responde, o agente decide e o fluxo segue pela saída
 * Objetivo — fica atrás de `STAGING_META_HAS_REAL_TOKEN`, que este projeto não
 * tem desde que a Meta foi parqueada. Resultado: a decisão do agente não era
 * exercitada por teste nenhum.
 *
 * Aqui a entrega pelo provedor não é o alvo: a instância de teste não existe no
 * servidor da Evolution, então o item da fila não chega a `sent`. O que se mede é
 * o cérebro do agente — abertura, decisão sobre a resposta, movimento no pipeline
 * e custo registrado —, e o caminho real de inbound que leva até ele.
 */

const SUPABASE_URL = stagingUrl();
const SERVICE_KEY = stagingServiceKey();
const WEBHOOK_SECRET = process.env.STAGING_EVOLUTION_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error("STAGING_EVOLUTION_WEBHOOK_SECRET must be configured for E2E tests");
}

// Telefone próprio: não pode disputar o lead com os outros E2E, que limpam por
// número. Celular com nono dígito, senão o portão de telefone recusa antes.
const TELEFONE = "5511999990005";
const TELEFONE_CONVERSA = "5511999990007";
const TELEFONE_SAIDA = "5511999990009";
const INSTANCIA = `e2e-agente-${Date.now()}`;

const svcHeaders = { apikey: SERVICE_KEY, "Content-Type": "application/json" };
const webhookHeaders = {
  "Content-Type": "application/json",
  "x-eleveflow-webhook-secret": WEBHOOK_SECRET!,
};

let tenantId = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000); // chamadas LLM reais

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const tenant = users?.users.find((user) => user.email === "e2e@eleveflow.test");
  if (!tenant) throw new Error("usuário e2e@eleveflow.test não existe");
  tenantId = tenant.id;
  await seedEvolutionConnection(admin, tenantId, INSTANCIA);
});

test.afterAll(async () => {
  // Conexão e lead fictícios não podem sobreviver ao teste: a aplicação os
  // mostraria como número conectado e contato real.
  const admin = adminClient();
  await removeLeadByPhone(admin, tenantId, TELEFONE);
  await removeLeadByPhone(admin, tenantId, TELEFONE_CONVERSA);
  await removeLeadByPhone(admin, tenantId, TELEFONE_SAIDA);
  await removeEvolutionConnection(admin, INSTANCIA);
});

test("agente abre conversa, o lead responde pela Evolution e o fluxo sai por OBJETIVO", async ({
  request,
}) => {
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, { phone: TELEFONE, maxTurns: 5, suffix: "EVO" });

  // 1. abertura: o agente é acionado e escreve a primeira mensagem via LLM real.
  const inicio = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(inicio.ok()).toBeTruthy();

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

  const { data: fila } = await admin
    .from("send_queue")
    .select("id, content")
    .eq("lead_id", seed.leadId);
  expect(fila!.length).toBeGreaterThan(0);
  expect(String(fila![0].content).trim().length).toBeGreaterThan(0);

  // 2. o lead responde aceitando: é o webhook real da Evolution, com verificação
  //    de origem pelo header privado.
  const resposta = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: webhookHeaders,
    data: evolutionInboundPayload(
      INSTANCIA,
      TELEFONE,
      "Sim! Quero agendar essa conversa, pode marcar amanhã às 10h.",
      `E2E-EVO-GOAL-${Date.now()}`,
    ),
  });
  expect(resposta.status()).toBe(200);
  expect(await resposta.json()).toMatchObject({ success: true });

  // 3. a resposta entrou no histórico como inbound do lead.
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("messages")
            .select("id")
            .eq("lead_id", seed.leadId)
            .eq("direction", "inbound")
        ).data?.length ?? 0,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  // 4. o agente decidiu que o objetivo foi atingido e o fluxo seguiu pela saída
  //    Objetivo até o move_pipeline.
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

  // 5. custo medido: sem isto o produto vende crédito sem saber quanto gastou.
  const { data: chamadas } = await admin
    .from("api_calls")
    .select("feature, status, prompt_tokens, completion_tokens, latency_ms, cost_usd_micros")
    .eq("lead_id", seed.leadId)
    .in("feature", ["agent_opening", "agent_reply"]);

  expect(chamadas!.length).toBeGreaterThanOrEqual(2);
  for (const chamada of chamadas!) {
    expect(chamada.status).toBe("ok");
    expect(chamada.prompt_tokens).toBeGreaterThan(0);
    expect(chamada.latency_ms).toBeGreaterThan(0);
    expect(chamada.cost_usd_micros).toBeGreaterThan(0);
  }
});

test("lead sem WhatsApp não gasta chamada de LLM: o agente recusa antes de abrir", async ({
  request,
}) => {
  const admin = adminClient();
  // Fixo de 8 dígitos começando em 3 — é o formato que a Evolution recusou em
  // produção com `Bad Request`.
  const FIXO = "554232315888";
  const seed = await seedAgentFlow(admin, { phone: FIXO, maxTurns: 5, suffix: "FIXO" });

  const inicio = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(inicio.ok()).toBeTruthy();
  expect(await inicio.json()).toMatchObject({ paused: "phone_not_whatsapp", reason: "landline" });

  // Execução encerrada como `blocked`, não presa em `running`: presa, o lead
  // ficaria fora do fluxo para sempre.
  const { data: execucao } = await admin
    .from("flow_executions")
    .select("status")
    .eq("lead_id", seed.leadId)
    .maybeSingle();
  expect(execucao?.status).toBe("blocked");

  // Nada enfileirado e nenhuma chamada de LLM cobrada por este lead.
  const { data: fila } = await admin.from("send_queue").select("id").eq("lead_id", seed.leadId);
  expect(fila!.length).toBe(0);
  const { data: chamadas } = await admin
    .from("api_calls")
    .select("id")
    .eq("lead_id", seed.leadId)
    .in("feature", ["agent_opening", "agent_reply"]);
  expect(chamadas!.length).toBe(0);

  // O motivo fica escrito no log da conta, e a flag do lead é corrigida para a
  // tela poder avisar que o número pode estar errado.
  const { data: registro } = await admin
    .from("logs")
    .select("event, details")
    .eq("lead_id", seed.leadId)
    .eq("event", "lead_phone_not_whatsapp")
    .maybeSingle();
  expect(registro?.details).toMatchObject({ reason: "landline" });

  const { data: lead } = await admin
    .from("leads")
    .select("has_whatsapp")
    .eq("id", seed.leadId)
    .single();
  expect(lead?.has_whatsapp).toBe(false);

  await removeLeadByPhone(admin, tenantId, FIXO);
});

test("o agente conversa: cada resposta dele entra na fila, nenhuma vira mensagem fantasma", async ({
  request,
}) => {
  // Regressão de 2026-09-22. A abertura e as respostas do agente usam o mesmo
  // block_id, e a trava de duplicata da fila descartava tudo depois da primeira
  // mensagem. Quem inseria ignorava a linha ausente e gravava em `messages`
  // mesmo assim: o agente parecia responder e nada saía. Os testes anteriores só
  // conferiam a decisão do agente, não o envio — por isso passavam.
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, {
    phone: TELEFONE_CONVERSA,
    maxTurns: 5,
    suffix: "CONVERSA",
  });

  const inicio = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(inicio.ok()).toBeTruthy();

  const contexto = async () =>
    (await admin.from("flow_executions").select("context").eq("lead_id", seed.leadId).maybeSingle())
      .data?.context?.agent;

  await expect.poll(async () => (await contexto())?.status, { timeout: 90_000 }).toBe("active");

  // Pergunta neutra: não aceita nem recusa, então o agente precisa continuar.
  const resposta = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: webhookHeaders,
    data: evolutionInboundPayload(
      INSTANCIA,
      TELEFONE_CONVERSA,
      "Como funciona isso? Me explica melhor.",
      `E2E-EVO-CONVERSA-${Date.now()}`,
    ),
  });
  expect(resposta.status()).toBe(200);

  // Espera o turno ser processado: turno sobe quando continua, status muda quando
  // encerra.
  await expect
    .poll(
      async () => {
        const agente = await contexto();
        return (agente?.turns ?? 0) >= 2 || (agente && agente.status !== "active");
      },
      { timeout: 120_000 },
    )
    .toBeTruthy();

  // Por lead e fluxo, não por bloco: a resposta do agente entra na fila sem
  // block_id, porque o par (lead, bloco) do índice único já é da abertura.
  const fila = (
    await admin
      .from("send_queue")
      .select("id, status")
      .eq("lead_id", seed.leadId)
      .eq("flow_id", seed.flowId)
  ).data!;
  expect(fila.length).toBeGreaterThanOrEqual(1);

  // A conversa mostra o que o lead recebeu. A linha em `messages` nasce na
  // entrega (complete_marketing_queue_delivery), ligada ao item da fila. Aqui a
  // instância de teste não existe na Evolution e nada é entregue — então nada
  // pode aparecer na conversa como se tivesse saído. Antes o fluxo gravava uma
  // cópia "pendente" ao enfileirar, e toda mensagem entregue aparecia duas vezes.
  const saidas = (
    await admin
      .from("messages")
      .select("id, queue_item_id")
      .eq("lead_id", seed.leadId)
      .eq("direction", "outbound")
  ).data!;
  expect(saidas.filter((m) => !m.queue_item_id)).toHaveLength(0);
  expect(saidas.length).toBe(fila.filter((item) => item.status === "sent").length);

  // E, se o agente continuou a conversa, a resposta dele de fato entrou na fila.
  const agente = await contexto();
  if (agente?.status === "active") {
    expect(fila.length).toBeGreaterThanOrEqual(2);
  }
});

test("saída por Objetivo que já tem mensagem no fluxo: o agente não fala junto", async ({
  request,
}) => {
  // Regressão de 2026-09-22. Na saída, o agente mandava a resposta dele e o fluxo
  // mandava a mensagem da saída seis segundos depois: duas mensagens seguidas, uma
  // perguntando "WhatsApp ou e-mail?" e a outra dizendo "vou criar e te envio".
  // Quando o caminho da saída já fala, quem encerra a conversa é o fluxo.
  const admin = adminClient();
  const seed = await seedAgentFlow(admin, {
    phone: TELEFONE_SAIDA,
    maxTurns: 5,
    suffix: "SAIDA",
    goalMessage: "Perfeito! Vou preparar a demonstração e te envio por aqui.",
  });

  const inicio = await request.post(`${SUPABASE_URL}/functions/v1/execute-flow`, {
    headers: svcHeaders,
    data: {
      flow_id: seed.flowId,
      lead_id: seed.leadId,
      user_id: seed.userId,
      trigger_type: "manual",
    },
  });
  expect(inicio.ok()).toBeTruthy();

  const contexto = async () =>
    (await admin.from("flow_executions").select("context").eq("lead_id", seed.leadId).maybeSingle())
      .data?.context?.agent;
  await expect.poll(async () => (await contexto())?.status, { timeout: 90_000 }).toBe("active");

  const resposta = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: webhookHeaders,
    data: evolutionInboundPayload(
      INSTANCIA,
      TELEFONE_SAIDA,
      "Sim! Quero agendar essa conversa, pode marcar amanhã às 10h.",
      `E2E-EVO-SAIDA-${Date.now()}`,
    ),
  });
  expect(resposta.status()).toBe(200);

  await expect.poll(async () => (await contexto())?.status, { timeout: 120_000 }).toBe("goal");

  // A mensagem da saída entrou na fila: o fluxo seguiu e falou.
  const filaDoLead = async () =>
    (
      await admin
        .from("send_queue")
        .select("id, block_id")
        .eq("lead_id", seed.leadId)
        .eq("flow_id", seed.flowId)
    ).data ?? [];
  await expect
    .poll(async () => (await filaDoLead()).some((i) => i.block_id === seed.goalMessageBlockId), {
      timeout: 60_000,
    })
    .toBe(true);

  // E a resposta do agente não entrou. Resposta do agente é o item sem block_id;
  // a abertura tem o block_id do agente.
  const fila = await filaDoLead();
  expect(fila.filter((i) => i.block_id === null)).toHaveLength(0);
  expect(fila.filter((i) => i.block_id === seed.aiBlockId)).toHaveLength(1);

  // O outro ramo da mesma saída também rodou. Antes o motor seguia só a primeira
  // ligação: no fluxo da conta Eleve One, a saída Objetivo mandava a mensagem e
  // nunca movia o lead de etapa.
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("objections")
            .select("id")
            .eq("lead_id", seed.leadId)
            .eq("content", seed.goalObjectionText!)
        ).data?.length ?? 0,
      { timeout: 60_000 },
    )
    .toBe(1);
});
