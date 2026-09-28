import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { serpFetch } from "../_shared/serp.ts";
import { makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
import { HttpError, getHttpErrorStatus, getRequestActor } from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-function-secret, x-eleveflow-webhook-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const actor = await getRequestActor(req);
    if (actor.kind !== "user") {
      throw new HttpError(403, "A user session is required for search");
    }

    const { query, location } = await req.json();
    const apiKey = Deno.env.get("SERPAPI_KEY");

    if (!apiKey) {
      throw new Error("SERPAPI_KEY not set");
    }

    const url = new URL("https://serpapi.com/search");
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("q", query);
    if (location) url.searchParams.set("location", location);
    url.searchParams.set("type", "search");
    url.searchParams.set("api_key", apiKey);

    const admin = createServiceRoleClient();
    const serpCost = parseInt(
      (await getGlobalSetting(admin, "serpapi_cost_per_search_usd_micros")) || "15000",
      10,
    );
    const r = await serpFetch({
      url: url.toString(),
      feature: "extract_search",
      costUsdMicros: serpCost,
      context: { user_id: actor.userId },
      record: makeApiCallRecorder(admin),
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `SerpAPI retornou ${r.status}`, results: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    const data = r.json;

    const results = (data.local_results || []).map((item: any) => ({
      name: item.title,
      phone: item.phone,
      address: item.address,
      website: item.website,
      rating: item.rating,
      reviews: item.reviews,
      category: item.type,
      latitude: item.gps_coordinates?.latitude,
      longitude: item.gps_coordinates?.longitude,
    }));

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: getHttpErrorStatus(error, 400),
    });
  }
});
