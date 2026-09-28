import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import {
  getHttpErrorStatus,
  getRequestActor,
  internalAuthHeaders,
  requireServiceRole,
} from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // This is a cross-tenant scheduler. A browser user must never be able to
    // resume arbitrary executions simply by invoking the endpoint.
    requireServiceRole(await getRequestActor(req));

    const supabaseClient = createServiceRoleClient();

    // 1. Get flow executions scheduled for now or earlier
    const { data: executions, error: execError } = await supabaseClient
      .from("flow_executions")
      .select("*")
      .eq("status", "running")
      .lte("scheduled_at", new Date().toISOString())
      .limit(10);

    if (execError) throw execError;

    const results = [];
    const baseUrl = Deno.env.get("SUPABASE_URL");

    for (const exec of executions) {
      console.log(`Resuming scheduled execution ${exec.id}`);

      // Clear scheduled_at first to avoid double processing
      await supabaseClient.from("flow_executions").update({ scheduled_at: null }).eq("id", exec.id);

      const res = await fetch(`${baseUrl}/functions/v1/execute-flow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...internalAuthHeaders(),
        },
        body: JSON.stringify({
          execution_id: exec.id,
          lead_id: exec.lead_id,
          flow_id: exec.flow_id,
          user_id: exec.user_id,
          trigger_type: "time_elapsed",
          phone: exec.context?.phone || "scheduled",
          block_id: exec.current_block_id,
        }),
      });

      const resData = await res.json();
      results.push({ id: exec.id, success: res.ok, data: resData });
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    console.error("Error processing flows:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: getHttpErrorStatus(error, 400),
    });
  }
});
