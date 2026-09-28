import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import { getGlobalSetting } from "../_shared/ai.ts";
import { constantTimeEqual } from "../_shared/hmac.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { HttpError } from "../_shared/http-error.ts";
import { getHttpErrorStatus, internalAuthHeaders } from "../_shared/auth.ts";
import { createMetaProvider } from "../_shared/whatsapp/meta-provider.ts";
import { handleInboundMessage, safeLog } from "../_shared/whatsapp/inbound-orchestrator.ts";
import { handleEcho } from "../_shared/whatsapp/echo-handler.ts";
import { applyStatusUpdates } from "../_shared/whatsapp/status-sync.ts";
import { recordInboundProof } from "../_shared/whatsapp/connection-proof.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function readSetting(client: any, key: string, envName: string): Promise<string | null> {
  return (await getGlobalSetting(client, key)) ?? Deno.env.get(envName) ?? null;
}

/** whatsapp_connections tem índice único parcial em phone_number_id, então um
 *  número pertence a no máximo um tenant. */
async function tenantForPhoneNumberId(
  client: any,
  phoneNumberId: string | undefined,
): Promise<string | null> {
  if (!phoneNumberId) return null;
  const { data } = await client
    .from("whatsapp_connections")
    .select("tenant_id")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseClient = createServiceRoleClient();
  let step = "init";

  try {
    if (req.method === "GET") {
      step = "verify_subscription";
      const url = new URL(req.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token") ?? "";
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      const expected = await readSetting(
        supabaseClient,
        "meta_webhook_verify_token",
        "META_WEBHOOK_VERIFY_TOKEN",
      );

      if (!expected) throw new HttpError(503, "meta_webhook_verify_token is not configured");
      if (mode !== "subscribe" || !constantTimeEqual(token, expected)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }

      // A Meta exige exatamente o challenge, em texto puro.
      return new Response(challenge, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    if (req.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    step = "verify_signature";
    const rawBody = await req.text();
    const appSecretEncrypted = await getGlobalSetting(supabaseClient, "meta_app_secret_encrypted");
    const appSecret = appSecretEncrypted
      ? await decryptSecret(appSecretEncrypted, Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? "")
      : (Deno.env.get("META_APP_SECRET") ?? "");

    const graphApiVersion =
      (await readSetting(supabaseClient, "meta_graph_api_version", "META_GRAPH_API_VERSION")) ??
      "v25.0";

    // Provider só para verificar/parsear: sem número nem token nesta etapa.
    const parser = createMetaProvider({
      graphApiVersion,
      phoneNumberId: "",
      accessToken: "",
      appSecret: appSecret || undefined,
    });

    await parser.verifyWebhook(req, rawBody);

    step = "parse";
    const { inbound, statuses, echoes, phoneNumberId } = parser.parseWebhook(rawBody);
    if (inbound.length === 0 && statuses.length === 0 && echoes.length === 0) {
      return json({ success: true, ignored: true, reason: "no_actionable_event" });
    }

    step = "resolve_tenant";
    const results: unknown[] = [];
    const deps = {
      client: supabaseClient,
      fetchFn: fetch,
      baseUrl: Deno.env.get("SUPABASE_URL") ?? "",
      internalHeaders: internalAuthHeaders,
      openrouterKey: Deno.env.get("OPENROUTER_API_KEY") ?? null,
      onStep: (value: string) => {
        step = value;
      },
    };

    for (const message of inbound) {
      const tenantId = await tenantForPhoneNumberId(
        supabaseClient,
        message.phoneNumberId ?? phoneNumberId,
      );
      if (!tenantId) {
        results.push({ ignored: true, reason: "unknown_phone_number_id" });
        continue;
      }
      if (message.type !== "text" || !message.text) {
        results.push({ ignored: true, reason: `unsupported_type_${message.type}` });
        continue;
      }
      const outcome = await handleInboundMessage(deps, {
        tenantId,
        providerMessageId: message.providerMessageId || null,
        fromPhone: message.fromPhone,
        text: message.text,
      });
      results.push(outcome.body);

      // Prova de recebimento: mensagem que chegou pelo webhook autenticado, no
      // número desta conexão, e foi persistida para este tenant.
      if (outcome.status === 200 && message.providerMessageId) {
        await recordInboundProof(
          supabaseClient,
          tenantId,
          message.phoneNumberId ?? phoneNumberId ?? "",
          message.providerMessageId,
        );
      }
    }

    for (const echo of echoes) {
      const tenantId = await tenantForPhoneNumberId(
        supabaseClient,
        echo.phoneNumberId ?? phoneNumberId,
      );
      if (!tenantId) {
        results.push({ ignored: true, reason: "unknown_phone_number_id" });
        continue;
      }
      if (echo.type !== "text") {
        // Edição, revogação e mídia chegam no mesmo campo. Tratar cada uma é
        // feature própria; ignorar em silêncio esconderia o caso do log.
        await safeLog(supabaseClient, {
          user_id: tenantId,
          event: "echo_unsupported_operation",
          details: { type: echo.type, whatsapp_id: echo.providerMessageId },
        });
        results.push({ ignored: true, reason: `unsupported_echo_type_${echo.type}` });
        continue;
      }

      const outcome = await handleEcho(
        { client: supabaseClient, onStep: (value: string) => (step = value) },
        {
          tenantId,
          providerMessageId: echo.providerMessageId || null,
          toPhone: echo.toPhone,
          text: echo.text ?? "",
          timestamp: echo.timestamp,
        },
      );
      results.push(outcome.body);
    }

    if (statuses.length > 0) {
      step = "apply_statuses";
      const tenantId = await tenantForPhoneNumberId(supabaseClient, phoneNumberId);
      if (tenantId) {
        results.push(await applyStatusUpdates(supabaseClient, tenantId, statuses, phoneNumberId));
      } else {
        results.push({ ignored: true, reason: "unknown_phone_number_id" });
      }
    }

    return json({ success: true, results });
  } catch (error: any) {
    console.error(`[MetaWebhook] Erro em step=${step}:`, error?.message || error);
    return json(
      { success: false, step, error: error?.message || String(error) },
      getHttpErrorStatus(error, 500),
    );
  }
});
