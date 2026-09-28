// Motor "Sequência Simples de WhatsApp" — não depende de edges/nodes.
// Lê flows.canvas_state.sequence e enfileira mensagens diretamente em send_queue.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import {
  HttpError,
  assertLeadCanReceiveMarketing,
  getSupabaseUrl,
  getHttpErrorStatus,
  getRequestActor,
  getResourceOwner,
  internalAuthHeaders,
  requireServiceRole,
  resolveActorUserId,
} from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-function-secret, x-eleveflow-webhook-secret",
};

function waitToMs(value: number, unit: string): number {
  const v = Math.max(0, Number(value) || 0);
  if (unit === "minutes") return v * 60_000;
  if (unit === "hours") return v * 60 * 60_000;
  return v * 24 * 60 * 60_000;
}

function renderVars(text: string, lead: any): string {
  return String(text || "")
    .replace(/{{nome}}/g, lead?.name || "")
    .replace(/{{empresa}}/g, lead?.company || "")
    .replace(/{{telefone}}/g, lead?.phone || "");
}

function getNextValidQueueTime(settings: any, baseDate = new Date()) {
  const schedule = settings || {};
  if (schedule.respect_business_hours === false) return baseDate.toISOString();
  const startHour = parseInt(schedule.start_hour ?? 8);
  const endHour = parseInt(schedule.end_hour ?? 18);
  const activeDays: number[] =
    Array.isArray(schedule.days) && schedule.days.length > 0 ? schedule.days : [1, 2, 3, 4, 5];
  const br = new Date(baseDate.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  if (br.getHours() < startHour) br.setHours(startHour, 0, 0, 0);
  if (br.getHours() >= endHour) {
    br.setDate(br.getDate() + 1);
    br.setHours(startHour, 0, 0, 0);
  }
  let safety = 0;
  while (!activeDays.includes(br.getDay()) && safety < 14) {
    br.setDate(br.getDate() + 1);
    br.setHours(startHour, 0, 0, 0);
    safety++;
  }
  return new Date(br.getTime() + 3 * 60 * 60 * 1000).toISOString();
}

async function enqueueAndProcess(
  client: any,
  baseUrl: string,
  row: any,
  delayMs = 0,
  settings: any = {},
) {
  // Calcula próximo slot válido respeitando intervalo, limite diário e horário comercial
  const minAt = new Date(Date.now() + delayMs).toISOString();
  let scheduled_at: string;
  const { data: slotRpc, error: slotErr } = await client.rpc("next_send_slot", {
    p_user_id: row.user_id,
    p_min_at: minAt,
  });
  if (slotErr || !slotRpc) {
    console.warn("[execute-sequence] next_send_slot fallback:", slotErr);
    scheduled_at = getNextValidQueueTime(settings, new Date(Date.now() + delayMs));
  } else {
    scheduled_at = slotRpc as string;
  }

  const { data: q, error } = await client
    .from("send_queue")
    .insert({ ...row, scheduled_at, status: "pending", attempts: 0 })
    .select()
    .single();
  if (error || !q) {
    console.error("[execute-sequence] insert send_queue failed:", error);
    return null;
  }
  // Aciona process-queue para o item; ele só envia se scheduled_at <= now.
  const isDue = new Date(scheduled_at).getTime() <= Date.now();
  if (isDue) {
    try {
      await fetch(`${baseUrl}/functions/v1/process-queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...internalAuthHeaders(),
        },
        body: JSON.stringify({ queueItemId: q.id }),
      });
    } catch (e) {
      console.error("[execute-sequence] process-queue call failed:", e);
    }
  }
  return q;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const client = createServiceRoleClient();
  const baseUrl = getSupabaseUrl();

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "start";
    const actor = await getRequestActor(req);
    if (action === "on_reply" || action === "no_reply_check") {
      requireServiceRole(actor);
    }
    console.log("[execute-sequence] action=", action);

    // ===== START =====
    if (action === "start") {
      const { flow_id, lead_id, user_id: requestedUserId, is_test } = body;
      if (!flow_id || !lead_id) {
        return new Response(JSON.stringify({ error: "Missing flow_id/lead_id" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const [leadOwnerId, flowOwnerId] = await Promise.all([
        getResourceOwner(client, "leads", lead_id),
        getResourceOwner(client, "flows", flow_id),
      ]);
      if (leadOwnerId !== flowOwnerId) {
        throw new HttpError(403, "Lead and flow belong to different tenants");
      }
      const user_id = resolveActorUserId(actor, leadOwnerId, requestedUserId);

      const { data: flow } = await client
        .from("flows")
        .select("*")
        .eq("id", flow_id)
        .eq("user_id", user_id)
        .maybeSingle();
      if (!flow) throw new Error("flow not found");
      const canvas: any = flow.canvas_state || {};
      const seq = canvas?.sequence;
      if (!seq || canvas.mode !== "sequence") {
        return new Response(JSON.stringify({ error: "flow não está no modo sequence" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: lead } = await client
        .from("leads")
        .select("*")
        .eq("id", lead_id)
        .eq("user_id", user_id)
        .maybeSingle();
      if (!lead) throw new Error("lead not found");
      assertLeadCanReceiveMarketing(lead);

      const { data: account } = await client
        .from("accounts")
        .select("settings")
        .eq("user_id", user_id)
        .maybeSingle();
      const userSettings = account?.settings || {};

      const noReplyAt = seq.on_no_reply
        ? new Date(
            Date.now() + waitToMs(seq.on_no_reply.wait_value, seq.on_no_reply.wait_unit),
          ).toISOString()
        : null;

      const { data: execution, error: execErr } = await client
        .from("flow_executions")
        .insert({
          user_id,
          lead_id,
          flow_id,
          status: "running",
          is_test: !!is_test,
          context: {
            mode: "sequence",
            stage: "m1_sending",
            no_reply_at: noReplyAt,
            no_reply_fired: false,
          },
        })
        .select()
        .single();
      if (execErr || !execution) throw new Error(`execution insert failed: ${execErr?.message}`);

      const m1Content = renderVars(seq.m1?.message || "", lead);
      if (!m1Content) {
        await client.from("flow_executions").update({ status: "failed" }).eq("id", execution.id);
        return new Response(JSON.stringify({ error: "M1 vazia" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const q = await enqueueAndProcess(
        client,
        baseUrl,
        {
          user_id,
          lead_id,
          flow_id,
          block_id: null,
          content: m1Content,
        },
        0,
        userSettings,
      );

      await client
        .from("flow_executions")
        .update({
          status: "waiting_response",
          context: {
            mode: "sequence",
            stage: "awaiting_reply",
            no_reply_at: noReplyAt,
            no_reply_fired: false,
          },
        })
        .eq("id", execution.id);

      await client.from("logs").insert({
        user_id,
        lead_id,
        flow_id,
        event: "sequence_started",
        details: { execution_id: execution.id, queueItemId: q?.id, no_reply_at: noReplyAt },
      });

      return new Response(
        JSON.stringify({ success: true, execution_id: execution.id, queueItemId: q?.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ===== ON_REPLY =====
    if (action === "on_reply") {
      const { execution_id } = body;
      const { data: execution } = await client
        .from("flow_executions")
        .select("*")
        .eq("id", execution_id)
        .maybeSingle();
      if (!execution) throw new HttpError(404, "execution not found");

      const ctx: any = execution.context || {};
      if (ctx.mode !== "sequence") {
        return new Response(JSON.stringify({ skipped: "not_sequence" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (ctx.stage !== "awaiting_reply") {
        return new Response(JSON.stringify({ skipped: `stage=${ctx.stage}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const [{ data: flow }, { data: lead }, { data: account }] = await Promise.all([
        client
          .from("flows")
          .select("canvas_state, user_id")
          .eq("id", execution.flow_id)
          .maybeSingle(),
        client.from("leads").select("*").eq("id", execution.lead_id).maybeSingle(),
        client.from("accounts").select("settings").eq("user_id", execution.user_id).maybeSingle(),
      ]);
      if (
        !flow ||
        flow.user_id !== execution.user_id ||
        !lead ||
        lead.user_id !== execution.user_id
      ) {
        throw new HttpError(403, "Sequence execution resources do not belong to the same tenant");
      }
      assertLeadCanReceiveMarketing(lead);
      const userSettings = account?.settings || {};
      const seq = (flow?.canvas_state as any)?.sequence;
      if (!seq) throw new Error("sequence missing");

      const msgs: string[] = (seq.on_reply?.messages || []).filter((m: string) => m && m.trim());
      await client
        .from("flow_executions")
        .update({
          context: { ...ctx, stage: "reply_processing" },
        })
        .eq("id", execution.id);

      const queued: any[] = [];
      for (let i = 0; i < msgs.length; i++) {
        const content = renderVars(msgs[i], lead);
        const q = await enqueueAndProcess(
          client,
          baseUrl,
          {
            user_id: execution.user_id,
            lead_id: execution.lead_id,
            flow_id: execution.flow_id,
            block_id: null,
            content,
          },
          i * 3500,
          userSettings,
        );
        if (q) queued.push(q.id);
      }

      await client
        .from("flow_executions")
        .update({
          status: "completed",
          context: { ...ctx, stage: "completed", completed_at: new Date().toISOString() },
        })
        .eq("id", execution.id);

      await client.from("logs").insert({
        user_id: execution.user_id,
        lead_id: execution.lead_id,
        flow_id: execution.flow_id,
        event: "sequence_on_reply",
        details: { execution_id, queued, count: msgs.length },
      });

      return new Response(JSON.stringify({ success: true, queued }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== NO_REPLY_CHECK (batch) =====
    if (action === "no_reply_check") {
      const nowIso = new Date().toISOString();
      const { data: candidates } = await client
        .from("flow_executions")
        .select("*")
        .eq("status", "waiting_response")
        .limit(50);

      const due = (candidates || []).filter((e: any) => {
        const c = e.context || {};
        return (
          c.mode === "sequence" &&
          c.stage === "awaiting_reply" &&
          !c.no_reply_fired &&
          c.no_reply_at &&
          c.no_reply_at <= nowIso
        );
      });

      const results: any[] = [];
      for (const execution of due) {
        const [{ data: flow }, { data: lead }, { data: account }] = await Promise.all([
          client
            .from("flows")
            .select("canvas_state, user_id")
            .eq("id", execution.flow_id)
            .maybeSingle(),
          client.from("leads").select("*").eq("id", execution.lead_id).maybeSingle(),
          client.from("accounts").select("settings").eq("user_id", execution.user_id).maybeSingle(),
        ]);
        if (
          !flow ||
          flow.user_id !== execution.user_id ||
          !lead ||
          lead.user_id !== execution.user_id
        ) {
          await client.from("flow_executions").update({ status: "failed" }).eq("id", execution.id);
          continue;
        }
        try {
          assertLeadCanReceiveMarketing(lead);
        } catch (error: any) {
          await client
            .from("flow_executions")
            .update({
              status: "completed",
              context: {
                ...execution.context,
                no_reply_fired: true,
                stage: "blocked_marketing_opt_out",
              },
            })
            .eq("id", execution.id);
          await client.from("logs").insert({
            user_id: execution.user_id,
            lead_id: execution.lead_id,
            flow_id: execution.flow_id,
            event: "marketing_send_blocked",
            details: {
              execution_id: execution.id,
              reason: error?.message || "lead_suppressed_or_opted_out",
            },
          });
          continue;
        }
        const userSettings = account?.settings || {};
        const seq = (flow?.canvas_state as any)?.sequence;
        const followups: string[] = (seq?.on_no_reply?.messages || []).filter(
          (m: string) => m && m.trim(),
        );
        if (followups.length === 0) {
          await client
            .from("flow_executions")
            .update({
              status: "completed",
              context: { ...execution.context, no_reply_fired: true, stage: "completed" },
            })
            .eq("id", execution.id);
          continue;
        }
        for (let i = 0; i < followups.length; i++) {
          await enqueueAndProcess(
            client,
            baseUrl,
            {
              user_id: execution.user_id,
              lead_id: execution.lead_id,
              flow_id: execution.flow_id,
              block_id: null,
              content: renderVars(followups[i], lead),
            },
            i * 3500,
            userSettings,
          );
        }
        await client
          .from("flow_executions")
          .update({
            status: "completed",
            context: { ...execution.context, no_reply_fired: true, stage: "completed_no_reply" },
          })
          .eq("id", execution.id);
        results.push(execution.id);
      }

      return new Response(
        JSON.stringify({ success: true, fired: results.length, executions: results }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ error: `unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[execute-sequence] error:", e);
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: getHttpErrorStatus(e, 500),
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
