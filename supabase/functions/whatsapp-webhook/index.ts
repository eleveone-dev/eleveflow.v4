// Webhook de inbound da Evolution API.
//
// Fino de proposito: toda a orquestracao de CRM (agente de IA, avanco de fluxo,
// estagio, opt-out, pausa por atendimento humano) vive em handleInboundMessage,
// que ja e escopado por tenant e nao sabe qual provedor entregou a mensagem.
// O trabalho daqui e: provar que o evento veio da nossa Evolution, descobrir de
// qual conta e a instancia que o recebeu, e delegar.
//
// Tudo que nao e nosso responde 200: a Evolution reenvia o que falha, e um
// evento de outro tipo nao deve virar retentativa eterna.
//
// Mensagem `fromMe` e o dono falando pelo aparelho (ou o eco de um envio nosso)
// e vai para o handleEcho.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import { getHttpErrorStatus, internalAuthHeaders } from "../_shared/auth.ts";
import { handleEcho } from "../_shared/whatsapp/echo-handler.ts";
import { handleInboundMessage } from "../_shared/whatsapp/inbound-orchestrator.ts";
import { resolveTenantByInstance } from "../_shared/whatsapp/instance-tenant.ts";
import {
  extractInstanceName,
  mediaTypeColumn,
  parseEvolutionWebhook,
} from "../_shared/whatsapp/evolution-parse.ts";
import { verifyEvolutionWebhook } from "../_shared/whatsapp/evolution-webhook.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-eleveflow-webhook-secret, x-evolution-signature",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ignored = (reason: string, extra: Record<string, unknown> = {}) =>
  json({ success: true, ignored: true, reason, ...extra });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  const supabaseClient = createServiceRoleClient();
  let step = "init";

  try {
    step = "verify_webhook";
    // Corpo cru, nao req.json(): o HMAC assina os bytes que vieram pela rede, e
    // reserializar muda a assinatura.
    const rawBody = await req.text();
    const verification = await verifyEvolutionWebhook(
      req,
      rawBody,
      Deno.env.get("EVOLUTION_WEBHOOK_SECRET") ?? null,
    );
    if (!verification.verified) {
      // Guarda de implantacao: permite registrar o header nas instancias antes
      // de a rejeicao entrar em vigor. Ver o plano do F1, Task 9.
      console.log("[EvolutionWebhook] webhook_unverified — secret ainda nao configurado");
    }

    step = "resolve_instance_tenant";
    const tenant = await resolveTenantByInstance(supabaseClient, extractInstanceName(rawBody));
    if (!tenant.ok) {
      console.log(`[EvolutionWebhook] evento ignorado: ${tenant.reason}`);
      return ignored(tenant.reason);
    }
    const tenantId = tenant.tenantId;

    step = "parse";
    const { inbound, echoes } = parseEvolutionWebhook(rawBody);
    if (inbound.length === 0 && echoes.length === 0) return ignored("no_actionable_event");

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

    const results: unknown[] = [];
    // Eco primeiro: o dono falando pelo aparelho pausa IA e fluxos antes de o
    // inbound do mesmo lote decidir alguma coisa.
    for (const echo of echoes) {
      const outcome = await handleEcho(
        { client: supabaseClient, onStep: deps.onStep },
        {
          tenantId,
          providerMessageId: echo.providerMessageId || null,
          toPhone: echo.toPhone,
          text: echo.text ?? "",
          timestamp: echo.timestamp,
          mediaType: mediaTypeColumn(echo.type),
        },
      );
      results.push(outcome.body);
    }
    for (const message of inbound) {
      const outcome = await handleInboundMessage(deps, {
        tenantId,
        providerMessageId: message.providerMessageId || null,
        fromPhone: message.fromPhone,
        text: message.text ?? "",
        mediaType: mediaTypeColumn(message.type),
      });
      results.push(outcome.body);
    }

    return json({ success: true, results });
  } catch (error: any) {
    console.error(`[EvolutionWebhook] Erro em step=${step}:`, error?.message || error);
    return json(
      { success: false, step, error: error?.message || String(error) },
      getHttpErrorStatus(error, 500),
    );
  }
});
