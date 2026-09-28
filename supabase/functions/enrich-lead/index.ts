// Edge function: enrich-lead
// Modes:
//   { lead_id: "uuid" }         -> enriches one lead
//   { all: true }               -> enriches all leads of the calling user that have place_id and not enriched yet
//   { all: true, force: true }  -> reprocess even already-enriched leads
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  callLLM,
  makeApiCallRecorder,
  getGlobalSetting,
  type ApiCallRecorder,
} from "../_shared/ai.ts";
import { serpFetch } from "../_shared/serp.ts";
import { HttpError, getHttpErrorStatus, getRequestActor } from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-function-secret, x-eleveflow-webhook-secret",
};

const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY")!;

type SerpCtx = {
  costUsdMicros: number;
  record: ApiCallRecorder;
  context: { user_id: string; lead_id: string };
};

const findInstagram = (...vals: any[]) => {
  for (const v of vals) {
    if (!v) continue;
    const s = String(v);
    const m = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i);
    if (m) return `https://www.instagram.com/${m[1].replace(/\/$/, "")}`;
  }
  return null;
};

async function scrapeInstagramFromWebsite(url: string): Promise<string | null> {
  try {
    const u = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(u, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadEnricher/1.0)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return findInstagram(html);
  } catch {
    return null;
  }
}

async function fetchPlaceDetails(placeId: string, serp: SerpCtx) {
  // Use place_id detail lookup via google_maps engine
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("hl", "pt");
  const r = await serpFetch({ url: url.toString(), feature: "enrich_details", ...serp });
  if (!r.ok) throw new Error(`SerpAPI place details ${r.status}`);
  return r.json;
}

// Lookup place via free-text search when lead has no place_id (legacy leads)
async function lookupPlaceByText(
  query: string,
  serp: SerpCtx,
): Promise<{ place_id: string | null; data_id: string | null; thumbnail: string | null }> {
  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", SERPAPI_KEY);
    url.searchParams.set("hl", "pt");
    url.searchParams.set("gl", "br");
    const r = await serpFetch({ url: url.toString(), feature: "enrich_details", ...serp });
    if (!r.ok) return { place_id: null, data_id: null, thumbnail: null };
    const j = r.json;
    const first = j.place_results || (Array.isArray(j.local_results) ? j.local_results[0] : null);
    if (!first) return { place_id: null, data_id: null, thumbnail: null };
    return {
      place_id: first.place_id || null,
      data_id: first.data_id || null,
      thumbnail: first.thumbnail || null,
    };
  } catch {
    return { place_id: null, data_id: null, thumbnail: null };
  }
}

async function fetchPhotos(dataId: string, serp: SerpCtx): Promise<string[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps_photos");
  url.searchParams.set("data_id", dataId);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("hl", "pt");
  const r = await serpFetch({ url: url.toString(), feature: "enrich_photos", ...serp });
  if (!r.ok) return [];
  const j = r.json;
  const photos = Array.isArray(j.photos) ? j.photos : [];
  return photos
    .map((p: any) => p.image || p.thumbnail)
    .filter(Boolean)
    .slice(0, 12);
}

async function fetchReviews(dataId: string, serp: SerpCtx): Promise<any[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps_reviews");
  url.searchParams.set("data_id", dataId);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("hl", "pt");
  url.searchParams.set("sort_by", "ratingHigh");
  const r = await serpFetch({ url: url.toString(), feature: "enrich_reviews", ...serp });
  if (!r.ok) return [];
  const j = r.json;
  const reviews = Array.isArray(j.reviews) ? j.reviews : [];
  return reviews
    .filter((rv: any) => (rv.rating ?? 5) >= 4 && rv.snippet)
    .slice(0, 3)
    .map((rv: any) => ({
      author: rv.user?.name || "Cliente",
      rating: rv.rating || 5,
      text: rv.snippet || rv.text || "",
    }));
}

async function classifyPhotos(
  photoUrls: string[],
  admin: any,
  lead: any,
): Promise<{
  logo?: string;
  professional?: string;
  facade?: string;
  structure?: string;
}> {
  const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
  if (photoUrls.length === 0 || !OPENROUTER_API_KEY) return {};

  const content: any[] = [
    {
      type: "text",
      text: `Analise as ${photoUrls.length} fotos numeradas de um negócio. Para cada uma, identifique a categoria:
- "logo": logo/marca da empresa
- "profissional": foto de pessoa(s) trabalhando ou retrato profissional
- "fachada": fachada externa do estabelecimento
- "estrutura": ambiente interno, equipamentos, decoração
- "outro": nenhuma das acima

Responda APENAS em JSON: {"categorias":[{"index":0,"categoria":"logo"},...]}`,
    },
    ...photoUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const model =
    (await getGlobalSetting(admin, "ai_model_economy")) || "google/gemini-2.5-flash-lite";
  const result = await callLLM({
    apiKey: OPENROUTER_API_KEY,
    model,
    feature: "photo_vision",
    jsonResponse: true,
    maxTokens: 800,
    messages: [{ role: "user", content }],
    context: { user_id: lead.user_id, lead_id: lead.id },
    record: makeApiCallRecorder(admin),
  });
  if (!result.ok) return {};

  try {
    const parsed = JSON.parse(result.content);
    const cats: any[] = Array.isArray(parsed.categorias) ? parsed.categorias : [];
    const out: any = {};
    for (const c of cats) {
      const url = photoUrls[c.index];
      if (!url) continue;
      const cat = String(c.categoria || "").toLowerCase();
      if (cat === "logo" && !out.logo) out.logo = url;
      else if (cat === "profissional" && !out.professional) out.professional = url;
      else if (cat === "fachada" && !out.facade) out.facade = url;
      else if (cat === "estrutura" && !out.structure) out.structure = url;
    }
    return out;
  } catch (e) {
    console.error("classifyPhotos parse err:", e);
    return {};
  }
}

async function enrichOne(supabase: any, lead: any) {
  const serpCost = parseInt(
    (await getGlobalSetting(supabase, "serpapi_cost_per_search_usd_micros")) || "15000",
    10,
  );
  const serp: SerpCtx = {
    costUsdMicros: serpCost,
    record: makeApiCallRecorder(supabase),
    context: { user_id: lead.user_id, lead_id: lead.id },
  };

  let placeId: string | null = lead.place_id || null;
  let dataIdHint: string | null = null;
  let coverFromLookup: string | null = null;

  // Fallback: legacy leads without place_id — search by name + address/city
  if (!placeId) {
    const q = [lead.name, lead.address, lead.city].filter(Boolean).join(" ");
    if (!q) return { ok: false, reason: "sem place_id e sem nome/endereço" };
    const found = await lookupPlaceByText(q, serp);
    if (!found.place_id) return { ok: false, reason: "place não encontrado no Google" };
    placeId = found.place_id;
    dataIdHint = found.data_id;
    coverFromLookup = found.thumbnail;
  }

  try {
    const details = await fetchPlaceDetails(placeId!, serp);
    const placeRes = details.place_results || {};
    const dataId = placeRes.data_id || dataIdHint;

    const about: string =
      placeRes.description ||
      placeRes.about?.[0]?.text ||
      (Array.isArray(placeRes.extensions) ? placeRes.extensions.join(" • ") : "") ||
      "";

    let photos: string[] = [];
    if (dataId) photos = await fetchPhotos(dataId, serp);
    if (photos.length === 0 && Array.isArray(placeRes.photos)) {
      photos = placeRes.photos
        .map((p: any) => p.image || p.thumbnail)
        .filter(Boolean)
        .slice(0, 12);
    }

    // Cover = primeira foto do GMB (capa) ou thumbnail do lookup
    const cover =
      lead.cover_photo_url || placeRes.thumbnail || coverFromLookup || photos[0] || null;

    let reviews: any[] = [];
    if (dataId) reviews = await fetchReviews(dataId, serp);
    if (reviews.length === 0 && Array.isArray(placeRes.user_reviews?.most_relevant)) {
      reviews = placeRes.user_reviews.most_relevant
        .filter((rv: any) => (rv.rating ?? 5) >= 4)
        .slice(0, 3)
        .map((rv: any) => ({
          author: rv.username || "Cliente",
          rating: rv.rating || 5,
          text: rv.description || "",
        }));
    }

    let instagram = lead.instagram_url || findInstagram(placeRes.website, lead.website);
    if (!instagram && (lead.website || placeRes.website)) {
      instagram = await scrapeInstagramFromWebsite(lead.website || placeRes.website);
    }

    const cats = await classifyPhotos(photos, supabase, lead);

    // ===== Re-host fotos no Storage (links permanentes que NÃO expiram) =====
    const rehost = async (
      srcUrl: string | null | undefined,
      kind: string,
    ): Promise<string | null> => {
      if (!srcUrl) return null;
      try {
        const r = await fetch(srcUrl, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return srcUrl; // fallback p/ url original se falhar
        const ct = r.headers.get("content-type") || "image/jpeg";
        const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
        const buf = new Uint8Array(await r.arrayBuffer());
        const path = `${lead.user_id}/${lead.id}/${kind}-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage.from("lead-photos").upload(path, buf, {
          contentType: ct,
          upsert: true,
        });
        if (upErr) {
          console.error(`upload ${kind} failed:`, upErr.message);
          return srcUrl;
        }
        const { data: pub } = supabase.storage.from("lead-photos").getPublicUrl(path);
        return pub?.publicUrl || srcUrl;
      } catch (e: any) {
        console.error(`rehost ${kind} err:`, e?.message);
        return srcUrl;
      }
    };

    // Instagram profile photo via SerpAPI
    let instagramPhoto: string | null = null;
    if (instagram) {
      try {
        const handle = instagram.replace(/\/+$/, "").split("/").pop();
        if (handle) {
          const igUrl = new URL("https://serpapi.com/search.json");
          igUrl.searchParams.set("engine", "instagram_profile");
          igUrl.searchParams.set("username", handle);
          igUrl.searchParams.set("api_key", SERPAPI_KEY);
          const r = await serpFetch({
            url: igUrl.toString(),
            feature: "instagram_profile",
            timeoutMs: 15000,
            ...serp,
          });
          if (r.ok) {
            const igJson = r.json;
            instagramPhoto =
              igJson?.profile_pic_url_hd ||
              igJson?.profile_pic_url ||
              igJson?.profile?.profile_pic_url ||
              null;
          }
        }
      } catch (e: any) {
        console.error("instagram fetch err:", e?.message);
      }
    }

    const [logoP, profP, faceP, structP, coverP, igP] = await Promise.all([
      rehost(cats.logo, "logo"),
      rehost(cats.professional, "profissional"),
      rehost(cats.facade, "fachada"),
      rehost(cats.structure, "estrutura"),
      rehost(cover, "capa"),
      rehost(instagramPhoto, "instagram"),
    ]);

    const update: any = {
      place_id: placeId,
      maps_url: lead.maps_url || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
      cover_photo_url: coverP,
      about: about || lead.about,
      top_reviews: reviews,
      all_photos: photos,
      logo_url: logoP,
      professional_photo_url: profP,
      facade_photo_url: faceP,
      structure_photo_url: structP,
      instagram_url: instagram || lead.instagram_url,
      instagram_photo_url: igP,
      enriched_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("leads").update(update).eq("id", lead.id);
    if (error) throw error;

    return { ok: true };
  } catch (e: any) {
    console.error(`enrich ${lead.id} failed:`, e?.message);
    return { ok: false, reason: e?.message };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const actor = await getRequestActor(req);
    if (actor.kind !== "user") {
      throw new HttpError(403, "A user session is required for enrichment");
    }
    const userId = actor.userId;
    const admin = createServiceRoleClient();
    const body = await req.json().catch(() => ({}));
    const { lead_id, all, force } = body;

    let leads: any[] = [];
    if (lead_id) {
      const { data } = await admin
        .from("leads")
        .select("*")
        .eq("id", lead_id)
        .eq("user_id", userId)
        .limit(1);
      leads = data || [];
    } else if (all) {
      // Inclui leads sem place_id também (fallback faz lookup pelo nome)
      const q = admin.from("leads").select("*").eq("user_id", userId);
      const { data } = force ? await q : await q.is("enriched_at", null);
      leads = data || [];
    }

    if (leads.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, processed: 0, failed: 0, message: "Nada para enriquecer" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    let processed = 0;
    let failed = 0;
    for (const lead of leads) {
      const r = await enrichOne(admin, lead);
      if (r.ok) processed++;
      else failed++;
      // pequena pausa pra não estourar rate limits
      await new Promise((res) => setTimeout(res, 300));
    }

    return new Response(JSON.stringify({ ok: true, processed, failed, total: leads.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("enrich-lead fatal:", e);
    return new Response(JSON.stringify({ error: e?.message || "erro" }), {
      status: getHttpErrorStatus(e, 500),
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
