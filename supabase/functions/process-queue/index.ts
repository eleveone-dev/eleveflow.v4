import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { resolveProvider } from "../_shared/whatsapp/index.ts";
import { queueDeferralUntil } from "../_shared/whatsapp/human-takeover.ts";
import { whatsAppSendPhone } from "../_shared/whatsapp/phone-target.ts";
import { renderizarMensagem } from "../_shared/message-humanize.ts";
import { getGlobalSetting } from "../_shared/ai.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import {
  assertLeadCanReceiveMarketing,
  HttpError,
  getHttpErrorStatus,
  getRequestActor,
  getResourceOwner,
} from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-function-secret, x-eleveflow-webhook-secret",
};

const isWithinSchedule = (settings: any) => {
  const dateObj = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const brDay = dateObj.getDay();
  const brHour = dateObj.getHours();

  const schedule = settings || {
    start_hour: 8,
    end_hour: 18,
    days: [1, 2, 3, 4, 5],
    respect_business_hours: true,
    paused: false,
  };

  if (schedule.paused === true) return false;
  if (schedule.respect_business_hours === false && !schedule.paused) return true;

  const start = parseInt(schedule.start_hour ?? 8);
  const end = parseInt(schedule.end_hour ?? 18);
  const activeDays = schedule.days || [1, 2, 3, 4, 5];

  return brHour >= start && brHour < end && activeDays.includes(brDay);
};

// Retorna próximo instante válido: dentro de start_hour..end_hour e dias configurados (BRT)
const getNextValidTime = (settings: any, forceNextDay = false, baseDate = new Date()) => {
  const schedule = settings || {};
  const startHour = parseInt(schedule.start_hour ?? 8);
  const endHour = parseInt(schedule.end_hour ?? 18);
  const activeDays: number[] = schedule.days || [1, 2, 3, 4, 5];

  // Trabalha no fuso BR
  const nowBR = new Date(baseDate.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const candidate = new Date(nowBR);

  if (forceNextDay) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(startHour, 0, 0, 0);
  }

  // Se passou do end_hour ou antes do start_hour, ajusta
  if (candidate.getHours() >= endHour) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(startHour, 0, 0, 0);
  } else if (candidate.getHours() < startHour) {
    candidate.setHours(startHour, 0, 0, 0);
  }

  // Pula fim de semana / dias inativos
  let safety = 0;
  while (!activeDays.includes(candidate.getDay()) && safety < 14) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(startHour, 0, 0, 0);
    safety++;
  }

  // Converte BR-wall-time de volta para UTC ISO
  // candidate representa horário BR; offset BR = -3
  const utcMs = candidate.getTime() + 3 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
};

// Limite diário de envios por usuário (mensagens já enviadas hoje BR) — default 40, configurável via settings.daily_limit
const DEFAULT_DAILY_CAP = 40;

// Normaliza telefone BR: remove formatação e garante DDI 55
// Delegado ao módulo compartilhado: além do DDI, o celular no formato antigo de 8
// dígitos ganha o nono, senão o provedor recusa o número. A regra vive num lugar
// só porque o portão do fluxo usa a mesma classificação.
const normalizePhone = (raw: string): string => whatsAppSendPhone(raw);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseClient = createServiceRoleClient();

  let currentQueueItemId = null;
  let currentPhone = null;
  let currentContent = null;
  let step = "init";
  let actor!: Awaited<ReturnType<typeof getRequestActor>>;

  const logError = async (userId: string | null, errorData: any) => {
    console.error("[PROCESS_QUEUE_ERROR]", JSON.stringify(errorData, null, 2));
    try {
      await supabaseClient.from("logs").insert({
        user_id: userId,
        event: "process_queue_error",
        details: {
          source: "process-queue",
          level: "error",
          ...errorData,
        },
      });
    } catch (e) {
      console.error("Failed to save log to DB:", e);
    }
  };

  try {
    step = "authenticate";
    actor = await getRequestActor(req);

    step = "parse_body";
    const body = await req.json().catch(() => ({}));
    const { queueItemId } = body;
    currentQueueItemId = queueItemId;

    // Batch processing is a privileged worker operation. Signed-in users can
    // only process one queue item that belongs to their own tenant (used by the
    // existing flow test UI), never scan or send another user's pending queue.
    if (actor.kind === "user") {
      if (!queueItemId) {
        throw new HttpError(403, "Authenticated users must provide a queueItemId");
      }
      const queueOwnerId = await getResourceOwner(supabaseClient, "send_queue", queueItemId);
      if (queueOwnerId !== actor.userId) {
        throw new HttpError(403, "You do not own this queue item");
      }
      if (body?.force === true) {
        throw new HttpError(403, "Only internal workers may force queue delivery");
      }
    }

    step = "env_check";
    const TOKEN_ENC_KEY = Deno.env.get("WHATSAPP_TOKEN_ENC_KEY");
    const META_GRAPH_API_VERSION =
      (await getGlobalSetting(supabaseClient, "meta_graph_api_version")) ||
      Deno.env.get("META_GRAPH_API_VERSION") ||
      "v25.0";

    console.log("[PROCESS_QUEUE] Config check:", {
      hasTokenEncKey: !!TOKEN_ENC_KEY,
      graphApiVersion: META_GRAPH_API_VERSION,
    });

    if (!TOKEN_ENC_KEY) {
      const err = {
        success: false,
        diagnostic: true,
        step,
        error: "WHATSAPP_TOKEN_ENC_KEY ausente nos Secrets: nenhum token pode ser descriptografado",
        queueItemId: currentQueueItemId,
      };
      await logError(null, err);
      return new Response(JSON.stringify(err), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    step = "fetch_queue_item";
    const isSpecificItem = !!currentQueueItemId;
    // queueItemId apenas seleciona um item; ainda respeita horário, limite e intervalo.
    // Selecting one owned item is not a scheduling bypass. Only a trusted worker
    // can explicitly force delivery outside the daily cap, interval, or hours.
    const forceSend = actor.kind === "service_role" && body?.force === true;

    // Recupera itens presos em 'sending' (run anterior travou/falhou)
    if (!isSpecificItem) {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: stuck } = await supabaseClient
        .from("send_queue")
        .update({ status: "pending", sending_at: null, claim_token: null })
        .eq("status", "sending")
        .or(`sending_at.is.null,sending_at.lt.${tenMinAgo}`)
        .select("id");
      if (stuck && stuck.length > 0) {
        console.log("[PROCESS_QUEUE] Itens presos em 'sending' resetados:", stuck.length);
      }
    }

    const now = new Date().toISOString();
    let query = supabaseClient
      .from("send_queue")
      .select(
        "*, leads(phone, whatsapp, name, company, user_id, is_suppressed, marketing_opted_out_at, marketing_consent_status), flow_blocks(user_id, flow_id, config)",
      )
      .eq("status", "pending");

    if (!forceSend) {
      query = query.lte("scheduled_at", now);
    }

    if (currentQueueItemId) {
      query = query.eq("id", currentQueueItemId);
    } else {
      query = query.order("scheduled_at", { ascending: true }).limit(1);
    }

    const { data: queueItems, error: queueError } = await query;
    if (queueError) {
      step = "db_fetch_error";
      throw queueError;
    }

    console.log("[PROCESS_QUEUE] Itens encontrados:", queueItems?.length || 0);

    if (isSpecificItem && (!queueItems || queueItems.length === 0)) {
      const err = {
        success: false,
        step: "queue_item_not_found",
        error: "Item da fila não encontrado",
        queueItemId: currentQueueItemId,
      };
      await logError(null, err);
      return new Response(JSON.stringify(err), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = [];
    const skipped: any[] = [];

    for (const item of queueItems || []) {
      currentQueueItemId = item.id;
      const userId = item.user_id;
      const statusBefore = item.status;
      const initialLead = Array.isArray(item.leads) ? item.leads[0] : item.leads;
      const initialBlock = Array.isArray(item.flow_blocks) ? item.flow_blocks[0] : item.flow_blocks;

      // Defend against malformed/corrupt queue rows before they can address a
      // WhatsApp connection. Service role bypasses RLS, so tenant consistency is
      // checked explicitly here as well.
      if (!userId || (actor.kind === "user" && userId !== actor.userId)) {
        skipped.push({ id: item.id, reason: "tenant_mismatch" });
        continue;
      }
      if (!initialLead || initialLead.user_id !== userId) {
        await supabaseClient
          .from("send_queue")
          .update({ status: "failed" })
          .eq("id", item.id)
          .eq("status", "pending");
        skipped.push({ id: item.id, reason: "lead_tenant_mismatch" });
        continue;
      }
      if (
        item.block_id &&
        (!initialBlock ||
          initialBlock.user_id !== userId ||
          (item.flow_id && initialBlock.flow_id !== item.flow_id))
      ) {
        await supabaseClient
          .from("send_queue")
          .update({ status: "failed" })
          .eq("id", item.id)
          .eq("status", "pending");
        skipped.push({ id: item.id, reason: "flow_block_tenant_mismatch" });
        continue;
      }
      try {
        assertLeadCanReceiveMarketing(initialLead);
      } catch (error: any) {
        await supabaseClient
          .from("send_queue")
          .update({
            status: "failed",
            attempts: (item.attempts || 0) + 1,
          })
          .eq("id", item.id)
          .eq("status", "pending");
        await logError(userId, {
          success: false,
          step: "marketing_suppression_check",
          error: error?.message || "Lead is suppressed or opted out",
          queueItemId: item.id,
          leadId: item.lead_id,
        });
        skipped.push({ id: item.id, reason: "lead_suppressed_or_opted_out" });
        continue;
      }

      console.log("[PROCESS_QUEUE] Diagnóstico item:", {
        queueItemId: item.id,
        status_before: statusBefore,
        phone: initialLead.whatsapp || initialLead.phone,
        scheduled_at: item.scheduled_at,
        will_process: true,
      });

      // Fetch account settings separately (no FK between send_queue and accounts)
      const { data: accountRow } = await supabaseClient
        .from("accounts")
        .select("settings")
        .eq("user_id", userId)
        .maybeSingle();
      const userSettings = accountRow?.settings;

      // `manual_send_only` pauses the background worker without cancelling the
      // queue. A signed-in owner may still explicitly process one of their own
      // items, and it will continue to obey business hours/cap/interval rules.
      const isExplicitOwnerRequest = actor.kind === "user" && isSpecificItem;
      if (!forceSend && userSettings?.manual_send_only === true && !isExplicitOwnerRequest) {
        skipped.push({ id: item.id, reason: "manual_send_only" });
        continue;
      }

      step = "schedule_check";
      if (!forceSend && !isWithinSchedule(userSettings)) {
        console.log("[PROCESS_QUEUE] Fora do horário:", item.id);
        const nextSend = getNextValidTime(userSettings);
        await supabaseClient
          .from("send_queue")
          .update({ scheduled_at: nextSend })
          .eq("id", item.id)
          .eq("status", "pending");
        skipped.push({ id: item.id, reason: "fora_do_horario" });
        continue;
      }

      // The actual cap/interval decision is made by the database claim below,
      // under a per-user advisory lock. Reading counts in this worker first
      // would leave a race between concurrent cron/browser executions.
      const dailyCap = Math.max(1, parseInt(userSettings?.daily_limit ?? DEFAULT_DAILY_CAP));
      // Piso da trava de envio: o MÍNIMO do intervalo sorteado. O sorteio em si
      // acontece no agendamento (next_send_slot); aqui só se garante que nenhum
      // envio saia antes do mínimo, sem desfazer o horário sorteado.
      const intervalMin = Math.max(
        0,
        parseInt(
          userSettings?.send_interval_min_minutes ?? userSettings?.send_interval_minutes ?? 0,
        ),
      );

      step = "prepare_message";
      const rawPhone = initialLead.whatsapp || initialLead.phone;
      let phone = normalizePhone(rawPhone);
      currentPhone = phone;
      const config = initialBlock?.config as any;

      // Mesmo renderizador do enfileiramento. Em conteúdo já renderizado é no-op;
      // em item sem conteúdo, o modelo do bloco ganha variáveis e spintax.
      let message = renderizarMensagem(item.content || config?.message || config?.text || "", {
        ...initialLead,
        phone: rawPhone,
      });
      currentContent = message;

      console.log("[PROCESS_QUEUE] Preparando envio:", {
        queueItemId: item.id,
        phone,
        contentLength: message.length,
      });

      // Validação pré-chamada
      if (!phone) {
        step = "validation_phone";
        const err = {
          success: false,
          diagnostic: true,
          step,
          error: "Telefone do lead ausente",
          queueItemId: item.id,
        };
        await logError(userId, err);
        await supabaseClient
          .from("send_queue")
          .update({ status: "failed", attempts: (item.attempts || 0) + 1 })
          .eq("id", item.id)
          .eq("status", "pending");
        skipped.push({ id: item.id, reason: "phone_missing" });
        continue;
      }

      if (!message) {
        step = "validation_content";
        const err = {
          success: false,
          diagnostic: true,
          step,
          error: "Conteúdo da mensagem vazio",
          queueItemId: item.id,
          phone: phone,
        };
        await logError(userId, err);
        await supabaseClient
          .from("send_queue")
          .update({ status: "failed", attempts: (item.attempts || 0) + 1 })
          .eq("id", item.id)
          .eq("status", "pending");
        skipped.push({ id: item.id, reason: "content_missing" });
        continue;
      }

      let claimToken: string | null = null;
      let providerAccepted = false;

      try {
        step = "claim_delivery";
        const { data: claimRows, error: claimError } = await supabaseClient.rpc(
          "claim_marketing_queue_item_v2",
          {
            p_queue_item_id: item.id,
            p_user_id: userId,
            p_daily_cap: dailyCap,
            p_interval_minutes: intervalMin,
            p_force: forceSend,
          },
        );
        if (claimError) throw claimError;
        const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
        if (!claim?.claimed) {
          const reason = claim?.reason || "queue_item_claim_lost";
          if (reason === "daily_cap_reached") {
            await supabaseClient
              .from("send_queue")
              .update({ scheduled_at: getNextValidTime(userSettings, true) })
              .eq("id", item.id)
              .eq("status", "pending");
          } else if (
            reason === "interval_not_reached" ||
            reason === "interval_reservation_active"
          ) {
            await supabaseClient
              .from("send_queue")
              .update({
                scheduled_at: getNextValidTime(
                  userSettings,
                  false,
                  new Date(Date.now() + Math.max(1, intervalMin) * 60_000),
                ),
              })
              .eq("id", item.id)
              .eq("status", "pending");
          }
          if (reason === "marketing_suppression_check") {
            await logError(userId, {
              success: false,
              step,
              error: "Lead is suppressed, opted out, or lacks marketing approval",
              queueItemId: item.id,
              leadId: item.lead_id,
            });
          }
          skipped.push({ id: item.id, reason });
          continue;
        }
        claimToken = typeof claim.claim_token === "string" ? claim.claim_token : null;
        if (!claimToken) {
          throw new Error("Queue claim did not return a delivery lease token");
        }

        // Re-read immediately after the atomic claim. An inbound opt-out can
        // change a claimed item to failed while this worker is preparing it.
        const { data: dispatchItem, error: dispatchError } = await supabaseClient
          .from("send_queue")
          .select(
            "id, status, leads(phone, whatsapp, name, company, user_id, is_suppressed, marketing_opted_out_at, marketing_consent_status, human_takeover_until, is_test)",
          )
          .eq("id", item.id)
          .eq("user_id", userId)
          .eq("status", "sending")
          .eq("claim_token", claimToken)
          .maybeSingle();
        if (dispatchError) throw dispatchError;
        if (!dispatchItem) {
          skipped.push({ id: item.id, reason: "cancelled_after_claim" });
          continue;
        }
        // Supabase types a relation as an array in some generated schemas even
        // when this deployment returns a single joined lead. Handle both
        // shapes explicitly before any delivery decision.
        const dispatchLead = Array.isArray(dispatchItem.leads)
          ? dispatchItem.leads[0]
          : dispatchItem.leads;
        if (!dispatchLead || dispatchLead.user_id !== userId) {
          await supabaseClient
            .from("send_queue")
            .update({ status: "failed", sending_at: null })
            .eq("id", item.id)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          skipped.push({ id: item.id, reason: "lead_tenant_mismatch" });
          continue;
        }
        try {
          assertLeadCanReceiveMarketing(dispatchLead);
        } catch {
          await supabaseClient
            .from("send_queue")
            .update({ status: "failed", sending_at: null })
            .eq("id", item.id)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          skipped.push({ id: item.id, reason: "cancelled_after_claim" });
          continue;
        }

        // A pausa por atendimento humano vale tambem para a automacao que ja estava
        // na fila: o vendedor falou pelo aparelho, e o item volta para depois da
        // pausa. Uma leitura so do prazo: checar e ler em dois tempos deixaria
        // scheduled_at nulo se a pausa vencesse no meio, e o item nunca mais sairia.
        const takeoverUntil = queueDeferralUntil(item, dispatchLead);
        if (takeoverUntil) {
          await supabaseClient
            .from("send_queue")
            .update({
              status: "pending",
              sending_at: null,
              claim_token: null,
              scheduled_at: takeoverUntil,
            })
            .eq("id", item.id)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          await supabaseClient.from("logs").insert({
            user_id: userId,
            lead_id: item.lead_id,
            event: "queue_item_deferred_takeover",
            details: { queue_item_id: item.id, until: takeoverUntil },
          });
          skipped.push({ id: item.id, reason: "human_takeover" });
          continue;
        }

        const dispatchRawPhone = dispatchLead.whatsapp || dispatchLead.phone;
        phone = normalizePhone(dispatchRawPhone);
        currentPhone = phone;
        message = renderizarMensagem(item.content || config?.message || config?.text || "", {
          ...dispatchLead,
          phone: dispatchRawPhone,
        });
        currentContent = message;
        if (!phone || !message) {
          await supabaseClient
            .from("send_queue")
            .update({ status: "failed", sending_at: null, attempts: (item.attempts || 0) + 1 })
            .eq("id", item.id)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          skipped.push({ id: item.id, reason: !phone ? "phone_missing" : "content_missing" });
          continue;
        }

        step = "resolve_provider";
        // Sem conexão configurada não existe caminho alternativo de envio, e
        // nenhuma retentativa resolve. O item falha de vez, com motivo legível.
        let provider;
        try {
          provider = await resolveProvider(userId, {
            client: supabaseClient,
            env: {
              metaGraphApiVersion: META_GRAPH_API_VERSION,
              metaAppSecret: Deno.env.get("META_APP_SECRET") ?? undefined,
              tokenEncryptionKey: TOKEN_ENC_KEY,
              evolutionApiUrl: Deno.env.get("EVOLUTION_API_URL") ?? undefined,
              evolutionApiKey: Deno.env.get("EVOLUTION_API_KEY") ?? undefined,
              evolutionWebhookSecret: Deno.env.get("EVOLUTION_WEBHOOK_SECRET") ?? undefined,
            },
          });
        } catch (connectionError: any) {
          await supabaseClient
            .from("send_queue")
            .update({ status: "failed", sending_at: null, claim_token: null })
            .eq("id", item.id)
            .eq("user_id", userId)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          await logError(userId, {
            success: false,
            diagnostic: true,
            step,
            error: connectionError?.message || String(connectionError),
            queueItemId: item.id,
          });
          skipped.push({ id: item.id, reason: "no_whatsapp_connection" });
          continue;
        }

        step = "provider_request";
        console.log("[PROCESS_QUEUE] Enviando:", { provider: provider.id, phone });

        const sendResult = await provider.sendText({ to: phone, text: message });
        const whatsappId = sendResult.providerMessageId;
        console.log("[PROCESS_QUEUE] Resposta do provedor:", {
          ok: sendResult.ok,
          status: sendResult.status,
          provider: provider.id,
          whatsappId,
        });

        // O provedor pode ter descoberto o JID real ou que o número não tem
        // WhatsApp. Os dois vêm do próprio WhatsApp — valem mais que a heurística
        // do extrator e que a flag do lead, que tem DEFAULT false. O cadastro é
        // corrigido com eles, para o próximo envio e para o aviso da tela.
        // Melhor esforço: falhar aqui não pode afetar a entrega.
        if (item.lead_id && (sendResult.resolvedTo || sendResult.notOnWhatsApp)) {
          await supabaseClient
            .from("leads")
            .update(
              sendResult.notOnWhatsApp
                ? { has_whatsapp: false }
                : { whatsapp: sendResult.resolvedTo, has_whatsapp: true },
            )
            .eq("id", item.lead_id)
            .then(
              () => undefined,
              () => undefined,
            );
        }

        if (sendResult.ok) {
          // The provider accepted the message. From here on, a database error
          // must never return the queue item to pending and duplicate a real
          // delivery. The RPC records the message and completes the queue in
          // the same transaction.
          providerAccepted = true;
          step = "complete_delivery";
          const { data: completionRows, error: completionError } = await supabaseClient.rpc(
            "complete_marketing_queue_delivery",
            {
              p_queue_item_id: item.id,
              p_user_id: userId,
              p_claim_token: claimToken,
              p_content: message,
              p_whatsapp_id: whatsappId,
            },
          );
          if (completionError) throw completionError;
          const completion = Array.isArray(completionRows) ? completionRows[0] : completionRows;
          if (!completion?.recorded) {
            throw new Error(
              `Delivery finalization was rejected: ${completion?.queue_status || "unknown"}`,
            );
          }

          if (completion.queue_status !== "sent") {
            await supabaseClient.from("logs").insert({
              user_id: userId,
              lead_id: item.lead_id,
              event: "message_sent_after_cancellation",
              details: { queue_item_id: item.id, whatsapp_id: whatsappId },
            });
            results.push({
              id: item.id,
              status: completion.queue_status,
              whatsapp_id: whatsappId,
            });
            continue;
          }

          step = "process_success";
          const { error: messageLogError } = await supabaseClient.from("logs").insert({
            user_id: userId,
            lead_id: item.lead_id,
            event: "message_sent",
            details: { queue_item_id: item.id, whatsapp_id: whatsappId },
          });
          if (messageLogError)
            console.error("[PROCESS_QUEUE] Message log failed:", messageLogError);

          // Garante flow_execution ativa para que respostas avancem o fluxo
          if (item.flow_id && item.lead_id && item.block_id) {
            try {
              const { data: existingExec } = await supabaseClient
                .from("flow_executions")
                .select("id")
                .eq("lead_id", item.lead_id)
                .eq("flow_id", item.flow_id)
                .eq("user_id", userId)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (existingExec?.id) {
                await supabaseClient
                  .from("flow_executions")
                  .update({
                    current_block_id: item.block_id,
                    status: "waiting_response",
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", existingExec.id)
                  .eq("user_id", userId);
              } else {
                await supabaseClient.from("flow_executions").insert({
                  user_id: userId,
                  lead_id: item.lead_id,
                  flow_id: item.flow_id,
                  current_block_id: item.block_id,
                  status: "waiting_response",
                });
              }
            } catch (e) {
              console.error("[PROCESS_QUEUE] Falha ao criar/atualizar flow_execution:", e);
            }
          }

          results.push({ id: item.id, status: "sent", whatsapp_id: whatsappId });
        } else {
          step = "provider_api_error";
          const attempts = (item.attempts || 0) + 1;
          // Número inválido ou confirmado sem WhatsApp: tentar de novo não muda
          // nada, só gasta o limite diário e a reputação do número.
          const isPermanent = sendResult.status === 400 || sendResult.notOnWhatsApp === true;
          const { data: releasedItems, error: releaseError } = await supabaseClient
            .from("send_queue")
            .update({
              status: isPermanent || attempts >= 3 ? "failed" : "pending",
              sending_at: null,
              claim_token: null,
              attempts,
            })
            .eq("id", item.id)
            .eq("user_id", userId)
            .eq("status", "sending")
            .eq("claim_token", claimToken)
            .select("id");
          if (releaseError) throw releaseError;
          if (!releasedItems || releasedItems.length === 0) {
            skipped.push({ id: item.id, reason: "cancelled_after_claim" });
            continue;
          }

          const err = {
            success: false,
            diagnostic: true,
            step,
            error: sendResult.error?.message ?? `Erro ${sendResult.status} no provedor`,
            queueItemId: item.id,
            phone: phone,
            provider: provider.id,
            providerStatus: sendResult.status,
          };
          await logError(userId, err);
          // NÃO retorna — continua processando os demais itens da fila
          skipped.push({ id: item.id, reason: `${provider.id}_${sendResult.status}` });
          continue;
        }
      } catch (err: any) {
        step = "internal_loop_catch";
        const attempts = (item.attempts || 0) + 1;
        if (claimToken) {
          const { error: releaseError } = await supabaseClient
            .from("send_queue")
            .update({
              // A provider-confirmed delivery without a persisted completion
              // is terminal until a human reconciles it; automatic retry could
              // send the same WhatsApp message twice.
              status: providerAccepted ? "delivery_unknown" : attempts >= 3 ? "failed" : "pending",
              sending_at: null,
              claim_token: null,
              sent_at: providerAccepted ? new Date().toISOString() : null,
              attempts,
            })
            .eq("id", item.id)
            .eq("user_id", userId)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          if (releaseError) console.error("[PROCESS_QUEUE] Claim release failed:", releaseError);
        }

        const errData = {
          success: false,
          step,
          error: err.message,
          queue_item_id: item.id,
          phone: phone,
          provider_accepted: providerAccepted,
        };
        await logError(userId, errData);
        // NÃO retorna — continua processando os demais itens da fila
        skipped.push({
          id: item.id,
          reason: providerAccepted ? "delivery_unknown" : "internal_error",
        });
        continue;
      }
    }

    if (results.length === 0) {
      const err = {
        success: false,
        step: "no_items_processed",
        error: "Nenhum item foi processado",
        queueItemId: isSpecificItem ? currentQueueItemId : null,
        reason: skipped.length > 0 ? skipped[0].reason : "sem itens elegíveis",
        skipped,
      };
      await logError(null, err);
      return new Response(JSON.stringify(err), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error: any) {
    const status = getHttpErrorStatus(error, 500);
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (error && typeof error === "object") {
      errorMessage =
        error.message ||
        error.error_description ||
        error.hint ||
        error.details ||
        error.code ||
        JSON.stringify(error);
    } else {
      errorMessage = String(error);
    }

    if (status >= 400 && status < 500) {
      return new Response(JSON.stringify({ success: false, error: errorMessage }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const errData = {
      success: false,
      diagnostic: true,
      step: `main_catch_${step}`,
      error: errorMessage,
      queueItemId: currentQueueItemId,
      phone: currentPhone,
      hasTokenEncKey: !!Deno.env.get("WHATSAPP_TOKEN_ENC_KEY"),
    };

    await logError(null, errData);

    return new Response(JSON.stringify(errData), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
