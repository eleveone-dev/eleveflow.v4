import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import {
  HttpError,
  getHttpErrorStatus,
  getRequestActor,
  getResourceOwner,
  internalAuthHeaders,
  resolveActorUserId,
} from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabaseClient = createServiceRoleClient();
    const body = await req.json().catch(() => ({}));
    const { lead_id, user_id: requestedUserId, reply_content } = body;
    if (!lead_id || typeof reply_content !== "string") {
      throw new HttpError(400, "lead_id and reply_content are required");
    }

    const actor = await getRequestActor(req);
    const leadOwnerId = await getResourceOwner(supabaseClient, "leads", lead_id);
    const userId = resolveActorUserId(actor, leadOwnerId, requestedUserId);

    const { data: lead, error: leadError } = await supabaseClient
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (leadError) throw leadError;
    if (!lead) throw new HttpError(404, "Lead not found");

    const { data: execution, error: execError } = await supabaseClient
      .from("flow_executions")
      .select("*")
      .eq("lead_id", lead_id)
      .eq("user_id", userId)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (execError) throw execError;
    if (!execution) {
      return json({ success: false, message: "No active execution" });
    }

    const { data: flowOwnerId } = await supabaseClient
      .from("flows")
      .select("user_id")
      .eq("id", execution.flow_id)
      .maybeSingle();
    if (!flowOwnerId || flowOwnerId.user_id !== userId) {
      throw new HttpError(403, "Execution flow belongs to another tenant");
    }

    const { data: block, error: blockError } = await supabaseClient
      .from("flow_blocks")
      .select("*")
      .eq("id", execution.current_block_id)
      .eq("flow_id", execution.flow_id)
      .maybeSingle();
    if (blockError) throw blockError;

    const config = block?.config as any;
    if (config?.on_reply_stage_id) {
      const stageOwnerId = await getResourceOwner(
        supabaseClient,
        "pipeline_stages",
        config.on_reply_stage_id,
      );
      if (stageOwnerId !== userId) {
        throw new HttpError(403, "Reply stage belongs to another tenant");
      }
      await supabaseClient
        .from("leads")
        .update({ stage_id: config.on_reply_stage_id })
        .eq("id", lead_id);
      await supabaseClient.from("logs").insert({
        user_id: userId,
        lead_id,
        flow_id: execution.flow_id,
        event: "stage_changed",
        details: { stage_id: config.on_reply_stage_id, reason: "reply_received" },
      });
    }

    await supabaseClient.from("messages").insert({
      user_id: userId,
      lead_id,
      flow_id: execution.flow_id,
      content: reply_content,
      direction: "inbound",
      status: "received",
    });
    await supabaseClient.from("leads").update({ flow_waiting_reply: false }).eq("id", lead_id);
    await supabaseClient.from("logs").insert({
      user_id: userId,
      lead_id,
      flow_id: execution.flow_id,
      event: "message_received",
      details: { content: reply_content },
    });

    const baseUrl = Deno.env.get("SUPABASE_URL");
    const res = await fetch(`${baseUrl}/functions/v1/execute-flow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
      body: JSON.stringify({
        lead_id,
        flow_id: execution.flow_id,
        execution_id: execution.id,
        user_id: userId,
        trigger_type: "reply_received",
        reply_content,
        block_id: block?.next_block_id,
      }),
    });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      throw new HttpError(502, result?.error || "Could not continue the flow");
    }

    return json({ success: true });
  } catch (error: any) {
    console.error("Error resuming flow:", error?.message || error);
    return json({ error: error?.message || String(error) }, getHttpErrorStatus(error, 500));
  }
});
