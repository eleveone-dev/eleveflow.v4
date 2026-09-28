import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { adminClient } from "./helpers/agent-seed";
import { stagingPublishableKey, stagingUrl } from "./helpers/supabase-admin";

const ENDPOINT = `${stagingUrl()}/functions/v1/sales-coach`;
const TOKEN = process.env.STAGING_SALES_COACH_E2E_TOKEN?.trim();

if (!TOKEN) {
  throw new Error("STAGING_SALES_COACH_E2E_TOKEN must be configured for E2E tests");
}

const E2E_EMAIL = "e2e@eleveflow.test";
const TELEFONE = "5511999990020";
const TEXTO = "Oi! Pode me mandar o orçamento? (E2E coach)";
const comToken = { Authorization: `Bearer ${TOKEN}` };

type ItemComLead = { lead_id: string; horas_sem_resposta?: number };

let userId = "";
let leadId = "";

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users.find((u) => u.email === E2E_EMAIL);
  if (!user) throw new Error(`usuário ${E2E_EMAIL} não existe`);
  userId = user.id;

  // Etapa própria, sem funnel_key e sem fluxo: pôr o lead nela não dispara o
  // trigger-flow-by-stage.
  let { data: etapa } = await admin
    .from("pipeline_stages")
    .select("id")
    .eq("user_id", userId)
    .eq("name", "Coach E2E")
    .maybeSingle();
  if (!etapa) {
    const criada = await admin
      .from("pipeline_stages")
      .insert({ user_id: userId, name: "Coach E2E", position: 95 })
      .select("id")
      .single();
    if (criada.error) throw criada.error;
    etapa = criada.data;
  }

  await admin.from("leads").delete().eq("user_id", userId).eq("phone", TELEFONE);
  const lead = await admin
    .from("leads")
    .insert({
      user_id: userId,
      name: "Lead Coach E2E",
      phone: TELEFONE,
      company: "Empresa Coach E2E",
      city: "Vitória",
      stage_id: etapa!.id,
    })
    .select("id")
    .single();
  if (lead.error) throw lead.error;
  leadId = lead.data.id;

  const mensagem = await admin.from("messages").insert({
    user_id: userId,
    lead_id: leadId,
    direction: "inbound",
    status: "received",
    content: TEXTO,
    created_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
  });
  if (mensagem.error) throw mensagem.error;
});

test.afterAll(async () => {
  // O lead fictício não pode sobreviver: apareceria como contato real da conta.
  if (!leadId) return;
  const admin = adminClient();
  await admin.from("messages").delete().eq("lead_id", leadId);
  await admin.from("leads").delete().eq("id", leadId);
});

test("sem token responde 401", async ({ request }) => {
  const res = await request.get(ENDPOINT);
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "Unauthorized" });
});

test("token errado responde 401 com o mesmo corpo de sem token", async ({ request }) => {
  const res = await request.get(ENDPOINT, {
    headers: { Authorization: `Bearer efsc_${"x".repeat(43)}` },
  });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "Unauthorized" });
});

test("POST responde 405", async ({ request }) => {
  const res = await request.post(ENDPOINT, { headers: comToken });
  expect(res.status()).toBe(405);
});

test("parâmetro fora do limite responde 400", async ({ request }) => {
  const res = await request.get(`${ENDPOINT}?limite=0`, { headers: comToken });
  expect(res.status()).toBe(400);
});

test("lead com mensagem inbound de 30 h aparece em follow_ups_atrasados", async ({ request }) => {
  const res = await request.get(ENDPOINT, { headers: comToken });
  expect(res.status()).toBe(200);
  const corpo = await res.json();

  const item = corpo.follow_ups_atrasados.find((i: ItemComLead) => i.lead_id === leadId);
  expect(item).toMatchObject({
    nome: "Lead Coach E2E",
    empresa: "Empresa Coach E2E",
    cidade: "Vitória",
    etapa: "Coach E2E",
    ultima_msg_do_lead: TEXTO,
  });
  expect(item.horas_sem_resposta).toBeGreaterThanOrEqual(30);
  expect(item.horas_sem_resposta).toBeLessThan(31);

  // Decisão 4 da spec: do atraso mais recente para o mais antigo, com o total.
  const horas = corpo.follow_ups_atrasados.map((i: ItemComLead) => i.horas_sem_resposta);
  expect(horas).toEqual([...horas].sort((a: number, b: number) => a - b));
  expect(corpo.totais.follow_ups_atrasados).toBeGreaterThanOrEqual(horas.length);
});

test("isolamento: todo lead devolvido é da conta do token", async ({ request }) => {
  const res = await request.get(`${ENDPOINT}?limite=200&parado_dias=1&followup_horas=1`, {
    headers: comToken,
  });
  expect(res.status()).toBe(200);
  const corpo = await res.json();

  const ids = [
    ...new Set(
      [...corpo.follow_ups_atrasados, ...corpo.leads_parados].map((i: ItemComLead) => i.lead_id),
    ),
  ];
  expect(ids).toContain(leadId);

  const admin = adminClient();
  const { data: donos, error } = await admin.from("leads").select("id, user_id").in("id", ids);
  expect(error).toBeNull();
  expect(donos).toHaveLength(ids.length);
  for (const dono of donos!) expect(dono.user_id).toBe(userId);

  const { data: conta } = await admin
    .from("accounts")
    .select("name")
    .eq("user_id", userId)
    .single();
  expect(corpo.conta).toBe(conta!.name);
});

test("RPC direta com JWT de usuário comum é negada", async () => {
  // Sessão do usuário de E2E sem senha: link mágico gerado pelo admin, sem e-mail.
  const admin = adminClient();
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: E2E_EMAIL,
  });
  if (error) throw error;

  const usuario = createClient(stagingUrl(), stagingPublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const sessao = await usuario.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (sessao.error || !sessao.data.session) throw sessao.error ?? new Error("sem sessão");

  const args = {
    p_user_id: userId,
    p_periodo_dias: 30,
    p_parado_dias: 7,
    p_followup_horas: 24,
    p_limite: 50,
  };
  try {
    const comoUsuario = await usuario.rpc("sales_coach_snapshot", args);
    expect(comoUsuario.error?.code).toBe("42501");
    expect(comoUsuario.data).toBeNull();
  } finally {
    await usuario.auth.signOut({ scope: "local" });
  }

  const anonimo = createClient(stagingUrl(), stagingPublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const comoAnonimo = await anonimo.rpc("sales_coach_snapshot", args);
  expect(comoAnonimo.error?.code).toBe("42501");
});
