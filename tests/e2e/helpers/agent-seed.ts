import { createHmac, webcrypto } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStagingAdminClient } from "./supabase-admin";

export interface SeededAgentFlow {
  userId: string;
  leadId: string;
  flowId: string;
  aiBlockId: string;
  goalStageId: string;
  goalMessageBlockId: string | null;
  goalObjectionText: string | null;
}

export function adminClient(): SupabaseClient {
  return createStagingAdminClient();
}

export async function seedAgentFlow(
  admin: SupabaseClient,
  // goalMessage: mensagem do próprio fluxo na saída Objetivo, depois de mover a
  // etapa. Sem ela, a saída só move a etapa e termina.
  opts: { phone: string; maxTurns: number; suffix: string; goalMessage?: string },
): Promise<SeededAgentFlow> {
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === "e2e@eleveflow.test");
  if (!user) throw new Error("usuário e2e ausente — rodar scripts/seed-staging.mjs antes");

  let { data: stage } = await admin
    .from("pipeline_stages")
    .select("id")
    .eq("user_id", user.id)
    .eq("name", "Qualificado E2E")
    .maybeSingle();
  if (!stage) {
    const r = await admin
      .from("pipeline_stages")
      .insert({ user_id: user.id, name: "Qualificado E2E", position: 90 })
      .select("id")
      .single();
    stage = r.data!;
  }

  let { data: lead } = await admin
    .from("leads")
    .select("id")
    .eq("user_id", user.id)
    .eq("phone", opts.phone)
    .maybeSingle();
  if (!lead) {
    const r = await admin
      .from("leads")
      .insert({
        user_id: user.id,
        name: `Lead Agente ${opts.suffix}`,
        phone: opts.phone,
        marketing_consent_status: "not_required",
      })
      .select("id")
      .single();
    lead = r.data!;
  }

  // estado limpo: sem execuções/fila/histórico do lead de rodadas anteriores
  await admin.from("flow_executions").delete().eq("lead_id", lead.id);
  await admin.from("messages").delete().eq("lead_id", lead.id);
  await admin.from("send_queue").delete().eq("lead_id", lead.id);
  await admin
    .from("leads")
    .update({
      flow_waiting_reply: false,
      active_flow_id: null,
      marketing_consent_status: "not_required",
      is_suppressed: false,
      marketing_opted_out_at: null,
    })
    .eq("id", lead.id);

  const { data: flow } = await admin
    .from("flows")
    .insert({ user_id: user.id, name: `Agente E2E ${opts.suffix} ${Date.now()}`, is_active: true })
    .select("id")
    .single();

  const mkBlock = async (type: string, position: number, config: Record<string, unknown>) =>
    (
      await admin
        .from("flow_blocks")
        .insert({ user_id: user.id, flow_id: flow!.id, type, position, config })
        .select("id")
        .single()
    ).data!.id as string;

  const triggerId = await mkBlock("trigger", 0, { trigger_type: "manual" });
  const aiId = await mkBlock("ai_agent", 1, {
    model: "google/gemini-2.5-flash-lite",
    prompt: "Você atende a {{empresa}}. Convide {{nome}} para agendar uma conversa de 15 minutos.",
    rules: "Seja breve\nSe o lead disser que quer agendar, considere o objetivo atingido",
    goal_description: "o lead aceitou agendar uma conversa",
    max_turns: opts.maxTurns,
    maxChars: 300,
    useHistory: true,
  });
  const moveId = await mkBlock("move_pipeline", 2, { target_stage_id: stage.id });
  const endId = await mkBlock("end", 3, {});
  const goalMessageId = opts.goalMessage
    ? await mkBlock("message", 4, { message: opts.goalMessage, auto_continue: true })
    : null;
  // Segundo ramo da mesma saída. Objeção, e não mover etapa: o classificador de
  // etapa por IA move o lead por conta dele, então mover etapa não provaria que o
  // ramo rodou.
  const objecaoTexto = opts.goalMessage ? `ramo paralelo E2E ${opts.suffix} ${Date.now()}` : null;
  const goalObjectionId = objecaoTexto
    ? await mkBlock("objection", 5, { objection_text: objecaoTexto })
    : null;

  await admin
    .from("flows")
    .update({
      canvas_state: {
        edges: [
          { id: "e-t-ai", source: triggerId, target: aiId },
          // Com goalMessage, a saída Objetivo fica ligada em DOIS blocos, como no
          // fluxo real da conta Eleve One: manda a mensagem e move a etapa.
          ...(goalMessageId && goalObjectionId
            ? [
                { id: "e-goal-msg", source: aiId, target: goalMessageId, sourceHandle: "goal" },
                { id: "e-goal-obj", source: aiId, target: goalObjectionId, sourceHandle: "goal" },
              ]
            : []),
          { id: "e-goal", source: aiId, target: moveId, sourceHandle: "goal" },
          { id: "e-giveup", source: aiId, target: endId, sourceHandle: "giveup" },
          { id: "e-limit", source: aiId, target: endId, sourceHandle: "limit" },
          ...(goalMessageId
            ? [{ id: "e-msg-end", source: goalMessageId, target: endId }]
            : [{ id: "e-move-end", source: moveId, target: endId }]),
        ],
      },
    })
    .eq("id", flow!.id);

  return {
    userId: user.id,
    leadId: lead.id,
    flowId: flow!.id,
    aiBlockId: aiId,
    goalStageId: stage.id,
    goalMessageBlockId: goalMessageId,
    goalObjectionText: objecaoTexto,
  };
}

/** Envelope de mensagem recebida da Cloud API. O tenant é resolvido pelo
 *  phone_number_id do metadata — não existe mais "instância". */
export const metaInboundPayload = (
  phone: string,
  text: string,
  id: string,
  phoneNumberId: string,
) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "E2E-WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: phone, phone_number_id: phoneNumberId },
            contacts: [{ profile: { name: "E2E" }, wa_id: phone }],
            messages: [
              {
                from: phone,
                id,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
});

/** A Meta assina o corpo cru: serializar de novo depois de assinar daria outro
 *  hash, então o teste envia exatamente a string que assinou. */
export function signMetaBody(body: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

/**
 * Conexão fictícia usada só pelos testes: o webhook precisa resolver um tenant
 * a partir do phone_number_id. Nunca use isto fora de teste — a aplicação só
 * grava conexão depois que a Meta confirma o número (ver
 * scripts/seed-whatsapp-connection.mjs e a edge function meta-whatsapp-admin).
 */
export async function seedTestConnection(
  admin: SupabaseClient,
  tenantId: string,
  phoneNumberId: string,
): Promise<void> {
  const keyBase64 = process.env.WHATSAPP_TOKEN_ENC_KEY;
  if (!keyBase64) throw new Error("WHATSAPP_TOKEN_ENC_KEY must be configured for E2E tests");

  const raw = Buffer.from(keyBase64.trim(), "base64");
  const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode("E2E-TOKEN-SEM-VALOR-REAL"),
    ),
  );
  const encrypted = `v1:${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;

  const { error } = await admin.from("whatsapp_connections").upsert(
    {
      tenant_id: tenantId,
      // Explícito porque só existe uma conexão por tenant: sem isto, um teste da
      // Evolution que rodou antes deixaria `provider = evolution` na linha e o
      // resolveProvider mandaria o caminho Meta para o lugar errado.
      provider: "meta_cloud",
      status: "connected",
      phone_number_id: phoneNumberId,
      waba_id: "E2E-WABA",
      display_phone_number: "5511999990000",
      access_token_encrypted: encrypted,
      webhook_subscribed_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );
  if (error) throw new Error(`Falha ao semear a conexão de teste: ${error.message}`);
}

export async function removeTestConnection(
  admin: SupabaseClient,
  phoneNumberId: string,
): Promise<void> {
  await admin.from("whatsapp_connections").delete().eq("phone_number_id", phoneNumberId);
}

/** Conexão da Evolution: a chave de resolução do inbound é o `instance_name`,
 *  não o `phone_number_id`. Nada de token aqui — a credencial da Evolution é
 *  global, de ambiente, e não por tenant. */
export async function seedEvolutionConnection(
  admin: SupabaseClient,
  tenantId: string,
  instanceName: string,
): Promise<void> {
  const { error } = await admin.from("whatsapp_connections").upsert(
    {
      tenant_id: tenantId,
      provider: "evolution",
      instance_name: instanceName,
      status: "connected",
      webhook_subscribed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );
  if (error) throw new Error(`Falha ao semear a conexão Evolution: ${error.message}`);
}

export async function removeEvolutionConnection(
  admin: SupabaseClient,
  instanceName: string,
): Promise<void> {
  await admin.from("whatsapp_connections").delete().eq("instance_name", instanceName);
}

/** Apaga o lead criado pelo inbound de teste e o que pende dele. Sem isto a
 *  conta de teste acumula lead fictício, e foi assim que a tela de diagnóstico
 *  passou a contar tráfego que nunca existiu.
 *
 *  O tenant é obrigatório: telefone não é único entre contas, e apagar só por
 *  telefone já levou embora o fixture de outra conta de teste. */
export async function removeLeadByPhone(
  admin: SupabaseClient,
  tenantId: string,
  phone: string,
): Promise<void> {
  const { data: leads } = await admin
    .from("leads")
    .select("id")
    .eq("user_id", tenantId)
    .eq("phone", phone);
  for (const lead of leads ?? []) {
    await admin.from("messages").delete().eq("lead_id", lead.id);
    await admin.from("send_queue").delete().eq("lead_id", lead.id);
    await admin.from("lead_stage_events").delete().eq("lead_id", lead.id);
    await admin.from("flow_executions").delete().eq("lead_id", lead.id);
    await admin.from("leads").delete().eq("id", lead.id);
  }
}

/** Lead para o inbound cair em algum lugar. O orquestrador ignora número que não
 *  tem lead (`webhook_lead_not_found`): contato desconhecido não vira cadastro
 *  sozinho, então o teste precisa semear o dele. */
export async function seedLeadForPhone(
  admin: SupabaseClient,
  tenantId: string,
  phone: string,
  name = "E2E Inbound",
): Promise<string> {
  const { data, error } = await admin
    .from("leads")
    .insert({ user_id: tenantId, phone, name })
    .select("id")
    .single();
  if (error) throw new Error(`Falha ao semear o lead de teste: ${error.message}`);
  return data.id as string;
}

/** Payload de inbound da Evolution no formato `messages.upsert` com texto. */
export function evolutionInboundPayload(
  instance: string,
  phone: string,
  text: string,
  id: string,
): string {
  return JSON.stringify({
    event: "messages.upsert",
    instance,
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id },
      pushName: "Lead E2E",
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  });
}
