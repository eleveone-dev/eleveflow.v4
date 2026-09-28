import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  adminClient,
  removeEvolutionConnection,
  removeLeadByPhone,
  seedEvolutionConnection,
  seedLeadForPhone,
} from "./helpers/agent-seed";
import { stagingServiceKey, stagingUrl } from "./helpers/supabase-admin";

const SUPABASE_URL = stagingUrl();
const SECRET = process.env.STAGING_EVOLUTION_WEBHOOK_SECRET?.trim();
const INTERNAL_SECRET = process.env.STAGING_INTERNAL_FUNCTION_SECRET?.trim();

if (!SECRET) {
  throw new Error("STAGING_EVOLUTION_WEBHOOK_SECRET must be configured for E2E tests");
}
if (!INTERNAL_SECRET) {
  throw new Error("STAGING_INTERNAL_FUNCTION_SECRET must be configured for E2E tests");
}

// Tenant próprio, não o `e2e@eleveflow.test`: só existe uma conexão por tenant
// (índice único em `tenant_id`), e semear Evolution nele derrubaria a conexão
// Meta que o outro E2E de inbound semeia.
const TENANT_EMAIL = "admin@eleveflow.test";
const INSTANCIA = `e2e-evolution-${Date.now()}`;
let tenantId = "";
const TELEFONE = "5511999990003";

/** Payload da Evolution no formato `messages.upsert` com texto simples. */
function inbound(instancia: string, id: string, texto: string) {
  return JSON.stringify({
    event: "messages.upsert",
    instance: instancia,
    data: {
      key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: false, id },
      pushName: "E2E Evolution",
      message: { conversation: texto },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  });
}

const comSegredo = {
  "Content-Type": "application/json",
  "x-eleveflow-webhook-secret": SECRET!,
};

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const tenant = users?.users.find((user) => user.email === TENANT_EMAIL);
  if (!tenant) throw new Error(`usuário ${TENANT_EMAIL} não existe`);
  tenantId = tenant.id;
  await seedEvolutionConnection(admin, tenant.id, INSTANCIA);
  // Lead antes do inbound: número sem lead é ignorado de propósito pelo
  // orquestrador, e sem isto o teste passaria sem provar nada.
  await removeLeadByPhone(admin, tenantId, TELEFONE);
  await seedLeadForPhone(admin, tenantId, TELEFONE, "E2E Evolution");
});

test.afterAll(async () => {
  // A conexão e o lead fictícios não podem sobreviver ao teste: a aplicação os
  // exibiria como número conectado e contato real.
  const admin = adminClient();
  await removeLeadByPhone(admin, tenantId, TELEFONE);
  await removeEvolutionConnection(admin, INSTANCIA);
});

test("mensagem inbound da Evolution é registrada no banco", async ({ request }) => {
  const id = `E2E-EVO-${Date.now()}`;
  const texto = "olá, vim pela Evolution";

  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: inbound(INSTANCIA, id, texto),
  });
  expect(res.status()).toBe(200);
  // `ignored` também responde success:true — sem checar isto, mensagem descartada
  // passaria por mensagem entregue.
  const corpo = await res.json();
  expect(corpo).toMatchObject({ success: true });
  expect(corpo.ignored).toBeUndefined();

  const { data: msg } = await adminClient()
    .from("messages")
    .select("id, direction, content")
    .eq("whatsapp_id", id)
    .maybeSingle();

  expect(msg).not.toBeNull();
  expect(msg!.direction).toBe("inbound");
  expect(msg!.content).toBe(texto);
});

test("sem o segredo no header a origem é recusada com 401", async ({ request }) => {
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: { "Content-Type": "application/json" },
    data: inbound(INSTANCIA, `E2E-EVO-FORJADO-${Date.now()}`, "forjada"),
  });
  expect(res.status()).toBe(401);
});

test("segredo errado também é recusado com 401", async ({ request }) => {
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: {
      "Content-Type": "application/json",
      "x-eleveflow-webhook-secret": "x".repeat(SECRET!.length),
    },
    data: inbound(INSTANCIA, `E2E-EVO-ERRADO-${Date.now()}`, "forjada"),
  });
  expect(res.status()).toBe(401);
});

test("instância desconhecida é ignorada com 200, não reenfileirada", async ({ request }) => {
  // A Evolution reenvia o que falha. Instância que não é nossa precisa devolver
  // 200, senão vira retentativa eterna.
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: inbound(`nao-existe-${Date.now()}`, `E2E-EVO-${Date.now()}`, "de outra instancia"),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ignored: true, reason: "unknown_instance" });
});

test("evento que não é messages.upsert é ignorado com 200", async ({ request }) => {
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: JSON.stringify({
      event: "connection.update",
      instance: INSTANCIA,
      data: { state: "open" },
    }),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ignored: true });
});

function upsert(message: Record<string, unknown>, key: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: "messages.upsert",
    instance: INSTANCIA,
    data: {
      key: {
        remoteJid: `${TELEFONE}@s.whatsapp.net`,
        fromMe: false,
        id: `E2E-${Date.now()}`,
        ...key,
      },
      message,
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  });
}

async function leadId(): Promise<string> {
  const { data } = await adminClient()
    .from("leads")
    .select("id")
    .eq("user_id", tenantId)
    .eq("phone", TELEFONE)
    .single();
  return data!.id;
}

test("mensagem mandada pelo aparelho vira saida business_app e pausa o lead por 24 h", async ({
  request,
}) => {
  const id = `E2E-ECO-${Date.now()}`;
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: upsert({ conversation: "respondi pelo celular" }, { fromMe: true, id }),
  });
  expect(res.status()).toBe(200);

  const admin = adminClient();
  const { data: msg } = await admin
    .from("messages")
    .select("direction, origin, media_type, content")
    .eq("whatsapp_id", id)
    .maybeSingle();
  expect(msg).toEqual({
    direction: "outbound",
    origin: "business_app",
    media_type: null,
    content: "respondi pelo celular",
  });

  const lead = await leadId();
  const { data: pausa } = await admin
    .from("leads")
    .select("human_takeover_until")
    .eq("id", lead)
    .single();
  const horas = (new Date(pausa!.human_takeover_until).getTime() - Date.now()) / 3_600_000;
  expect(horas).toBeGreaterThan(23);
  expect(horas).toBeLessThan(25);
  await admin.from("leads").update({ human_takeover_until: null }).eq("id", lead);
});

test("audio sem legenda e gravado com o tipo e nao aciona automacao", async ({ request }) => {
  const id = `E2E-AUDIO-${Date.now()}`;
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: upsert({ audioMessage: { seconds: 7, ptt: true } }, { id }),
  });
  expect(res.status()).toBe(200);
  const corpo = await res.json();
  expect(corpo.results?.[0]).toMatchObject({
    recorded_only: true,
    reason: "media_without_text",
  });

  const { data: msg } = await adminClient()
    .from("messages")
    .select("direction, media_type, content")
    .eq("whatsapp_id", id)
    .maybeSingle();
  expect(msg).toEqual({ direction: "inbound", media_type: "audio", content: "" });
});

test("mensagem de grupo e ignorada sem deixar log", async ({ request }) => {
  const admin = adminClient();
  const antes = new Date().toISOString();

  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: upsert({ conversation: "oi grupo" }, { remoteJid: "120363000000000000@g.us" }),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ignored: true, reason: "no_actionable_event" });

  const { count } = await admin
    .from("logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", tenantId)
    .eq("event", "webhook_lead_not_found")
    .gte("created_at", antes);
  expect(count).toBe(0);
});

/** Põe o lead em pausa, enfileira um item e roda o process-queue sobre ele.
 *  Devolve o item como ficou e se houve registro de adiamento. */
async function processarItemComLeadEmPausa(
  request: APIRequestContext,
  flowId: string | null,
): Promise<{ ate: string; status: string; scheduledAt: string; adiado: boolean }> {
  const admin = adminClient();
  const lead = await leadId();
  const ate = new Date(Date.now() + 2 * 3_600_000).toISOString();
  // Consentimento liberado: sem ele o item cai no portao de marketing antes da
  // pausa, e o teste passaria a medir outra coisa.
  await admin
    .from("leads")
    .update({ human_takeover_until: ate, marketing_consent_status: "not_required" })
    .eq("id", lead);

  const { data: item, error } = await admin
    .from("send_queue")
    .insert({
      user_id: tenantId,
      lead_id: lead,
      flow_id: flowId,
      content: "mensagem de teste da pausa",
      status: "pending",
      scheduled_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;

  try {
    const res = await request.post(`${SUPABASE_URL}/functions/v1/process-queue`, {
      headers: {
        apikey: stagingServiceKey(),
        "x-internal-function-secret": INTERNAL_SECRET!,
        "Content-Type": "application/json",
      },
      data: { queueItemId: item!.id, force: true },
    });
    expect(res.ok()).toBeTruthy();

    const { data: depois } = await admin
      .from("send_queue")
      .select("status, scheduled_at")
      .eq("id", item!.id)
      .single();
    const { count: adiamentos } = await admin
      .from("logs")
      .select("id", { count: "exact", head: true })
      .eq("event", "queue_item_deferred_takeover")
      .eq("details->>queue_item_id", item!.id);
    return {
      ate,
      status: depois!.status,
      scheduledAt: depois!.scheduled_at,
      adiado: (adiamentos ?? 0) > 0,
    };
  } finally {
    await admin.from("messages").delete().eq("queue_item_id", item!.id);
    await admin.from("send_queue").delete().eq("id", item!.id);
    await admin.from("leads").update({ human_takeover_until: null }).eq("id", lead);
  }
}

test("automacao na fila de lead em pausa volta para depois da pausa", async ({ request }) => {
  const admin = adminClient();
  const { data: fluxo, error } = await admin
    .from("flows")
    .insert({ user_id: tenantId, name: "Fila E2E (pausa)", is_active: false })
    .select("id")
    .single();
  if (error) throw error;

  try {
    const r = await processarItemComLeadEmPausa(request, fluxo!.id);
    expect(r.adiado).toBe(true);
    expect(r.status).toBe("pending");
    expect(new Date(r.scheduledAt).getTime()).toBe(new Date(r.ate).getTime());
  } finally {
    await admin.from("flows").delete().eq("id", fluxo!.id);
  }
});

test("mensagem do vendedor pela tela sai mesmo com o lead em pausa", async ({ request }) => {
  // Sem flow_id e o proprio vendedor escrevendo em Conversas: a pausa cala a
  // automacao, nao ele. O envio falha na instancia ficticia, e o que importa aqui
  // e que o item nao foi adiado.
  const r = await processarItemComLeadEmPausa(request, null);
  expect(r.adiado).toBe(false);
  expect(new Date(r.scheduledAt).getTime()).not.toBe(new Date(r.ate).getTime());
});
