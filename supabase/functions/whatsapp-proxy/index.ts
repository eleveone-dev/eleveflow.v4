// Gestao da conexao com a Evolution: estado, pareamento por QR, registro de
// webhook, logout e remocao. E o que a tela /whatsapp consome.
//
// Regra que nao pode ser afrouxada: o nome da instancia NUNCA vem do corpo da
// requisicao — e derivado do usuario autenticado por resolveProxyInstance.
// Admin alcanca outra conta por targetUserId explicito, checado contra o papel
// de plataforma em app_metadata — este schema nao tem tabela de papeis. No export
// do Lovable esse campo era aceito do cliente e repassado a Evolution com a
// apikey mestre.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import { getAuthUserWithPlatformRole, getHttpErrorStatus } from "../_shared/auth.ts";
import { HttpError } from "../_shared/http-error.ts";
import { ProxyAuthError, resolveProxyInstance } from "../_shared/whatsapp/proxy-auth.ts";
import {
  connectInstance,
  deleteInstance,
  instanceStatus,
  logoutInstance,
  setInstanceWebhook,
} from "../_shared/whatsapp/evolution-admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: true, message: "Method not allowed" }, 405);

  const client = createServiceRoleClient();
  let step = "init";

  try {
    step = "parse_body";
    // instanceName NAO e lido daqui, de proposito.
    const { action, targetUserId } = await req.json().catch(() => ({}) as any);

    step = "env_check";
    const apiUrl = Deno.env.get("EVOLUTION_API_URL")?.replace(/\/+$/, "") ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY") ?? "";
    const webhookSecret = Deno.env.get("EVOLUTION_WEBHOOK_SECRET") ?? "";
    if (!apiUrl || !apiKey) {
      throw new HttpError(503, "EVOLUTION_API_URL and EVOLUTION_API_KEY are required");
    }
    const webhookUrl = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/whatsapp-webhook`;

    step = "authenticate";
    let authUserId: string | null = null;
    let isAdmin = false;
    try {
      const ator = await getAuthUserWithPlatformRole(req);
      authUserId = ator.userId;
      isAdmin = ator.isSuperadmin;
    } catch {
      // Falta de header e token invalido sao a mesma coisa aqui: nao ha usuario.
      // Quem recusa com 401 e o resolveProxyInstance, logo abaixo.
      authUserId = null;
    }

    step = "resolve_instance";
    const instance = await resolveProxyInstance({ client, authUserId, isAdmin, targetUserId });
    const ownerId = typeof targetUserId === "string" && targetUserId ? targetUserId : authUserId!;
    const cfg = { apiUrl, apiKey, instance, fetchFn: fetch };

    const gravarConexao = async (status: string, extra: Record<string, unknown> = {}) => {
      await client.from("whatsapp_connections").upsert(
        {
          tenant_id: ownerId,
          provider: "evolution",
          instance_name: instance,
          status,
          updated_at: new Date().toISOString(),
          ...extra,
        },
        { onConflict: "tenant_id" },
      );
    };

    step = `action_${action}`;
    switch (action) {
      case "status": {
        const estado = await instanceStatus(cfg);
        // O banco segue a Evolution, nunca o contrario: o estado exibido vem de
        // quem realmente sabe. Foi a licao do incidente de 30/07.
        if (estado.exists) {
          await gravarConexao(estado.connected ? "connected" : "disconnected");
        }
        return json({ success: true, instance, ...estado });
      }

      case "connect": {
        const r = await connectInstance({ ...cfg, webhookUrl, webhookSecret });
        await gravarConexao(r.connected ? "connected" : "pending", {
          ...(r.webhook.ok ? { webhook_subscribed_at: new Date().toISOString() } : {}),
        });
        return json({ success: true, instance, ...r });
      }

      case "ensureWebhook": {
        const r = await setInstanceWebhook({ ...cfg, webhookUrl, webhookSecret });
        if (r.ok)
          await gravarConexao("pending", { webhook_subscribed_at: new Date().toISOString() });
        return json({ success: r.ok, instance, webhook: r });
      }

      case "disconnect": {
        const r = await logoutInstance(cfg);
        await gravarConexao("disconnected");
        return json({ success: r.ok, instance, data: r.data });
      }

      case "delete": {
        const r = await deleteInstance(cfg);
        await client.from("whatsapp_connections").delete().eq("tenant_id", ownerId);
        return json({ success: r.ok, instance, data: r.data });
      }

      default:
        return json({ error: true, message: `Unknown action: ${action}` }, 400);
    }
  } catch (error: any) {
    const status = error instanceof ProxyAuthError ? error.status : getHttpErrorStatus(error, 500);
    console.error(`[WhatsAppProxy] Erro em step=${step}:`, error?.message || error);
    return json({ error: true, step, message: error?.message || String(error) }, status);
  }
});
