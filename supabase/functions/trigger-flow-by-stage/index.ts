import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import {
  HttpError,
  getHttpErrorStatus,
  getRequestActor,
  getResourceOwner,
  internalAuthHeaders,
  requireServiceRole,
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
    const { lead_id, user_id: requestedUserId, new_stage_id } = body;
    if (!lead_id || !new_stage_id) {
      throw new HttpError(400, "lead_id and new_stage_id are required");
    }

    const actor = await getRequestActor(req);
    requireServiceRole(actor);
    const [leadOwnerId, stageOwnerId] = await Promise.all([
      getResourceOwner(supabaseClient, "leads", lead_id),
      getResourceOwner(supabaseClient, "pipeline_stages", new_stage_id),
    ]);
    if (leadOwnerId !== stageOwnerId) {
      throw new HttpError(403, "Lead and pipeline stage belong to different tenants");
    }
    const userId = resolveActorUserId(actor, leadOwnerId, requestedUserId);

    const { data: flows, error: flowsError } = await supabaseClient
      .from("flows")
      .select("*")
      .eq("user_id", userId)
      .eq("trigger_stage_id", new_stage_id)
      .eq("is_active", true);
    if (flowsError) throw flowsError;

    // Lead em conversa num fluxo não entra em outro pela mudança de etapa. O
    // classificador de etapa por IA move o lead a cada mensagem recebida, e com
    // fluxo ativo na etapa de destino o lead passava a receber dois fluxos ao
    // mesmo tempo. Medido em 2026-09-22: a conversa com o agente e a abordagem de
    // prospecção no mesmo WhatsApp, e a resposta seguinte do lead indo para a
    // abordagem. Execução `running` não conta: é o próprio fluxo movendo o lead
    // de etapa, e esse encadeamento continua valendo.
    const { data: conversas, error: conversasError } = await supabaseClient
      .from("flow_executions")
      .select("flow_id")
      .eq("lead_id", lead_id)
      .eq("user_id", userId)
      .eq("status", "waiting_response");
    if (conversasError) throw conversasError;

    const results = [];
    const baseUrl = Deno.env.get("SUPABASE_URL");
    for (const flow of flows || []) {
      const { data: existingExec, error: existingExecError } = await supabaseClient
        .from("flow_executions")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("flow_id", flow.id)
        .in("status", ["running", "waiting_response", "active"])
        .maybeSingle();
      if (existingExecError) throw existingExecError;
      if (existingExec) {
        results.push({ flow_id: flow.id, skipped: "already_active" });
        continue;
      }

      const outraConversa = (conversas || []).find((c: any) => c.flow_id !== flow.id);
      if (outraConversa) {
        results.push({
          flow_id: flow.id,
          skipped: "lead_in_other_flow",
          other_flow_id: outraConversa.flow_id,
        });
        await supabaseClient.from("logs").insert({
          user_id: userId,
          lead_id,
          flow_id: flow.id,
          event: "flow_stage_trigger_skipped",
          details: {
            reason: "lead_in_other_flow",
            other_flow_id: outraConversa.flow_id,
            stage_id: new_stage_id,
          },
        });
        continue;
      }

      const res = await fetch(`${baseUrl}/functions/v1/execute-flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
        body: JSON.stringify({
          lead_id,
          flow_id: flow.id,
          user_id: userId,
          trigger_type: "stage_enter",
        }),
      });
      const data = await res.json().catch(() => ({}));
      results.push({ flow_id: flow.id, success: res.ok, data });
    }

    return json({ results });
  } catch (error: any) {
    console.error("Error triggering flow by stage:", error?.message || error);
    return json({ error: error?.message || String(error) }, getHttpErrorStatus(error, 500));
  }
});
