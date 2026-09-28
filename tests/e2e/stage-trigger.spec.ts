import { test, expect } from "@playwright/test";
import { adminClient, removeLeadByPhone } from "./helpers/agent-seed";
import { stagingServiceKey, stagingUrl } from "./helpers/supabase-admin";

/**
 * Fluxo disparado por etapa diante de um lead que já está conversando noutro fluxo.
 *
 * O classificador de etapa por IA move o lead a cada mensagem recebida. Com fluxo
 * ativo na etapa de destino, o `trigger-flow-by-stage` inscrevia o lead também
 * nesse fluxo: em 2026-09-22 o lead de teste recebeu a conversa do agente e a
 * abordagem de prospecção ao mesmo tempo, e a resposta seguinte dele foi parar na
 * abordagem.
 */

const SUPABASE_URL = stagingUrl();
const SERVICE_KEY = stagingServiceKey();
// Celular sem WhatsApp: nada do que este teste enfileira chega a ninguém.
const TELEFONE = "5511999990008";
const headers = { apikey: SERVICE_KEY, "Content-Type": "application/json" };

let tenantId = "";
let etapaId = "";
let fluxoDaEtapaId = "";
let conversaFluxoId = "";
let leadId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const tenant = users?.users.find((u) => u.email === "e2e@eleveflow.test");
  if (!tenant) throw new Error("usuário e2e@eleveflow.test não existe");
  tenantId = tenant.id;

  const sufixo = Date.now();
  etapaId = (
    await admin
      .from("pipeline_stages")
      .insert({ user_id: tenantId, name: `Etapa Gatilho E2E ${sufixo}`, position: 91 })
      .select("id")
      .single()
  ).data!.id;

  const novoFluxo = async (name: string, ativoNaEtapa: boolean) => {
    const flowId = (
      await admin
        .from("flows")
        .insert({
          user_id: tenantId,
          name,
          is_active: ativoNaEtapa,
          trigger_stage_id: ativoNaEtapa ? etapaId : null,
        })
        .select("id")
        .single()
    ).data!.id as string;
    const bloco = async (type: string, position: number, config: Record<string, unknown>) =>
      (
        await admin
          .from("flow_blocks")
          .insert({ user_id: tenantId, flow_id: flowId, type, position, config })
          .select("id")
          .single()
      ).data!.id as string;
    const gatilho = await bloco(
      "trigger",
      0,
      ativoNaEtapa ? { trigger_type: "stage_enter", stage_id: etapaId } : { trigger_type: "manual" },
    );
    const mensagem = await bloco("message", 1, { message: `mensagem de ${name}` });
    const fim = await bloco("end", 2, {});
    await admin
      .from("flows")
      .update({
        canvas_state: {
          edges: [
            { id: "e1", source: gatilho, target: mensagem },
            { id: "e2", source: mensagem, target: fim },
          ],
        },
      })
      .eq("id", flowId);
    return flowId;
  };

  fluxoDaEtapaId = await novoFluxo(`Fluxo da Etapa E2E ${sufixo}`, true);
  conversaFluxoId = await novoFluxo(`Conversa em Curso E2E ${sufixo}`, false);

  await removeLeadByPhone(admin, tenantId, TELEFONE);
  leadId = (
    await admin
      .from("leads")
      .insert({
        user_id: tenantId,
        name: "Lead Gatilho E2E",
        phone: TELEFONE,
        marketing_consent_status: "not_required",
      })
      .select("id")
      .single()
  ).data!.id;

  // O lead está no meio de uma conversa noutro fluxo, esperando a resposta dele.
  await admin.from("flow_executions").insert({
    user_id: tenantId,
    lead_id: leadId,
    flow_id: conversaFluxoId,
    status: "waiting_response",
  });
});

test.afterAll(async () => {
  const admin = adminClient();
  await removeLeadByPhone(admin, tenantId, TELEFONE);
  await admin.from("flows").delete().in("id", [fluxoDaEtapaId, conversaFluxoId]);
  await admin.from("pipeline_stages").delete().eq("id", etapaId);
});

const dispararEtapa = (request: any) =>
  request.post(`${SUPABASE_URL}/functions/v1/trigger-flow-by-stage`, {
    headers,
    data: { lead_id: leadId, new_stage_id: etapaId, user_id: tenantId },
  });

const execucoesDoFluxoDaEtapa = async () =>
  (
    await adminClient()
      .from("flow_executions")
      .select("id")
      .eq("lead_id", leadId)
      .eq("flow_id", fluxoDaEtapaId)
  ).data?.length ?? 0;

test("lead conversando noutro fluxo não entra no fluxo da etapa", async ({ request }) => {
  const res = await dispararEtapa(request);

  expect(res.status()).toBe(200);
  expect((await res.json()).results).toEqual([
    expect.objectContaining({
      flow_id: fluxoDaEtapaId,
      skipped: "lead_in_other_flow",
      other_flow_id: conversaFluxoId,
    }),
  ]);
  expect(await execucoesDoFluxoDaEtapa()).toBe(0);
});

test("sem conversa em curso, o fluxo da etapa começa", async ({ request }) => {
  await adminClient()
    .from("flow_executions")
    .update({ status: "completed" })
    .eq("lead_id", leadId)
    .eq("flow_id", conversaFluxoId);

  const res = await dispararEtapa(request);

  expect(res.status()).toBe(200);
  expect((await res.json()).results).toEqual([
    expect.objectContaining({ flow_id: fluxoDaEtapaId, success: true }),
  ]);
  expect(await execucoesDoFluxoDaEtapa()).toBe(1);
});
