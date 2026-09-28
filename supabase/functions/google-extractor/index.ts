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
      throw new HttpError(403, "A user session is required for extraction");
    }
    const callerUserId = actor.userId;

    // Pegar SERPAPI_KEY
    const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY");
    if (!SERPAPI_KEY) {
      console.error("SERPAPI_KEY não configurada");
      return new Response(
        JSON.stringify({
          error: "SERPAPI_KEY não configurada",
          results: [],
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const admin = createServiceRoleClient();

    // Pegar body
    const body = await req.json();
    const { query, city, state, filters, limit } = body;
    const normalizedQuery = String(query || "").trim();
    const normalizedCity = String(city || "").trim();

    if (!normalizedQuery || !normalizedCity) {
      return new Response(
        JSON.stringify({
          error: "Nicho e cidade são obrigatórios",
          results: [],
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }
    if (normalizedQuery.length > 160 || normalizedCity.length > 120) {
      throw new HttpError(400, "Nicho ou cidade excede o tamanho permitido");
    }

    const parsedLimit = Number.parseInt(String(limit ?? 20), 10);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;

    // Montar query de busca
    const searchQuery = `${normalizedQuery} em ${normalizedCity}${state ? " " + state : ""}`;
    const limitParam = `&num=${safeLimit}`;
    const serpUrl = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(searchQuery)}&api_key=${SERPAPI_KEY}&hl=pt&gl=br${limitParam}`;

    console.log("Buscando:", searchQuery);

    const serpCost = parseInt(
      (await getGlobalSetting(admin, "serpapi_cost_per_search_usd_micros")) || "15000",
      10,
    );
    const r = await serpFetch({
      url: serpUrl,
      feature: "extract_search",
      costUsdMicros: serpCost,
      context: { user_id: callerUserId },
      record: makeApiCallRecorder(admin),
    });
    if (!r.ok) {
      console.error("SerpAPI erro:", r.status);
      return new Response(JSON.stringify({ error: `SerpAPI retornou ${r.status}`, results: [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const serpData = r.json;

    if (serpData.error) {
      console.error("SerpAPI data error:", serpData.error);
      return new Response(
        JSON.stringify({
          error: serpData.error,
          results: [],
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const places = serpData.local_results || [];
    console.log("Resultados encontrados:", places.length);

    // Helper: detecta perfil Instagram em qualquer string
    const findInstagram = (...vals: any[]) => {
      for (const v of vals) {
        if (!v) continue;
        const s = String(v);
        const m = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i);
        if (m) return `https://www.instagram.com/${m[1].replace(/\/$/, "")}`;
      }
      return null;
    };

    // Mapear resultados
    let results = places.map((place: any) => {
      const placeId = place.place_id || null;
      const dataId = place.data_id || null;
      // Google Meu Negócio / Maps URL
      const mapsUrl =
        place.links?.directions ||
        (placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : null);
      const instagram = findInstagram(
        place.website,
        place.links?.website,
        ...(Array.isArray(place.extensions) ? place.extensions : []),
      );
      return {
        name: place.title || "",
        phone: place.phone || null,
        address: place.address || "",
        website: place.website || null,
        rating: place.rating || null,
        total_ratings: place.reviews || null,
        place_id: placeId,
        data_id: dataId,
        maps_url: mapsUrl,
        instagram_url: instagram,
        cover_photo_url: place.thumbnail || null,
        whatsapp_status: "pending",
      };
    });

    // Aplicar filtros
    if (filters?.site === "com" || filters?.site === "with_site") {
      results = results.filter((r: any) => r.website);
    } else if (filters?.site === "sem" || filters?.site === "without_site") {
      results = results.filter((r: any) => !r.website);
    }

    if (filters?.contact === "whatsapp" || filters?.contact === "whatsapp_only") {
      results = results.filter((r: any) => r.phone);
    }

    return new Response(
      JSON.stringify({
        results,
        total: results.length,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err: any) {
    console.error("Erro geral:", err);
    return new Response(
      JSON.stringify({
        error: err.message,
        results: [],
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
