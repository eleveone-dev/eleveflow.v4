// Diagnóstico e configuração da conexão oficial com a Meta.
//
// Todo contato com a Graph API acontece aqui: o navegador nunca vê o access
// token nem o App Secret. As respostas carregam só identificadores públicos
// (Phone Number ID, WABA ID, número visível) e o resultado de cada verificação.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import { getGlobalSetting } from "../_shared/ai.ts";
import { encryptSecret } from "../_shared/crypto.ts";
import { HttpError } from "../_shared/http-error.ts";
import { getAuthUser, getHttpErrorStatus, requireSuperadmin } from "../_shared/auth.ts";
import { buildConnectionState } from "../_shared/whatsapp/connection-state.ts";
import {
  debugToken,
  getPhoneNumber,
  listPhoneNumbers,
  verifyConnection,
} from "../_shared/whatsapp/meta-diagnostics.ts";
import {
  readPublicMetaConfig,
  saveEmbeddedSignupConfig,
} from "../_shared/whatsapp/embedded-signup-config.ts";
import { completeSignupOnboarding } from "../_shared/whatsapp/signup-onboarding.ts";
import { discoverAndSaveConnection } from "../_shared/whatsapp/connection-discovery.ts";
import { subscribeAppToWaba } from "../_shared/whatsapp/webhook-subscription.ts";
import { createTenantTemplate, listTenantTemplates } from "../_shared/whatsapp/template-admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function readEnv(client: any) {
  const graphApiVersion =
    (await getGlobalSetting(client, "meta_graph_api_version")) ||
    Deno.env.get("META_GRAPH_API_VERSION") ||
    "v25.0";
  return {
    metaGraphApiVersion: graphApiVersion,
    tokenEncryptionKey: Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? undefined,
    metaAppId:
      (await getGlobalSetting(client, "meta_app_id")) || Deno.env.get("META_APP_ID") || undefined,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseClient = createServiceRoleClient();
  let step = "init";

  try {
    step = "parse_body";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = String(body?.action ?? "diagnose");

    // Configuração pública do Embedded Signup: App ID, Configuration ID e versão
    // da Graph API. Não são segredos, mas exigem sessão válida — nada aqui é
    // anônimo. A leitura é feita por uma lista fechada de chaves.
    if (action === "public-config") {
      step = "public_config";
      await getAuthUser(req);
      return json({ success: true, config: await readPublicMetaConfig(supabaseClient) });
    }

    // Alterar a configuração é operação de plataforma, não de tenant.
    if (action === "save-embedded-signup-config") {
      step = "save_embedded_signup_config";
      await requireSuperadmin(req);
      const config = await saveEmbeddedSignupConfig(supabaseClient, {
        appId: String(body?.appId ?? ""),
        configId: String(body?.configId ?? ""),
        enabled: body?.enabled === true,
      });
      return json({ success: true, config });
    }

    step = "authenticate";
    // Sempre um usuário real: esta função lida com credenciais do tenant e não
    // aceita chamada de worker interno.
    const userId = await getAuthUser(req);
    const env = await readEnv(supabaseClient);

    // Etapas 4C+4D: troca o código, descobre os ativos e grava a conexão.
    // O código expira em 30s, então tudo acontece numa chamada só.
    if (action === "exchange-code") {
      step = "exchange_code";
      const userId = await getAuthUser(req);
      const config = await readPublicMetaConfig(supabaseClient);
      if (!config.appId) throw new HttpError(503, "Meta App ID não está configurado");

      const result = await completeSignupOnboarding(
        {
          client: supabaseClient,
          env: {
            graphApiVersion: config.graphApiVersion,
            appId: config.appId,
            appSecret: Deno.env.get("META_APP_SECRET") ?? "",
            tokenEncryptionKey: Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? "",
          },
          fetchFn: fetch,
        },
        userId,
        String(body?.code ?? ""),
        {
          phoneNumberId: body?.phoneNumberId ? String(body.phoneNumberId) : null,
          coexistenceHint: body?.coexistence === true,
        },
      );

      if (!result.ok) {
        return json({ success: false, step, error: result.error.message, code: result.error.code });
      }

      const state = await buildConnectionState(
        { client: supabaseClient, env: await readEnv(supabaseClient), fetchFn: fetch },
        userId,
      );
      return json({
        success: true,
        connected: {
          wabaId: result.wabaId,
          phoneNumber: result.phoneNumber,
          otherNumbers: result.otherNumbers,
        },
        state,
      });
    }

    // Etapa 4E: inscreve o app do EleveFlow nos webhooks da WABA do tenant.
    // Sem isso, nenhuma mensagem recebida chega ao CRM.
    if (action === "subscribe-webhook") {
      step = "subscribe_webhook";
      const userId = await getAuthUser(req);
      const config = await readPublicMetaConfig(supabaseClient);

      const result = await subscribeAppToWaba(
        {
          client: supabaseClient,
          env: {
            graphApiVersion: config.graphApiVersion,
            tokenEncryptionKey: Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? "",
            appId: config.appId ?? "",
          },
          fetchFn: fetch,
        },
        userId,
      );

      if (!result.ok) {
        return json({ success: false, step, error: result.error.message, code: result.error.code });
      }

      const state = await buildConnectionState(
        { client: supabaseClient, env: await readEnv(supabaseClient), fetchFn: fetch },
        userId,
      );
      return json({ success: true, subscribedAt: result.subscribedAt, state });
    }

    // Modelos de mensagem: o unico caminho para retomar conversa fora da
    // janela de 24h. O status vem da Meta, nunca e assumido.
    if (action === "list-templates" || action === "create-template") {
      step = action.replace("-", "_");
      const userId = await getAuthUser(req);
      const config = await readPublicMetaConfig(supabaseClient);
      const templateDeps = {
        client: supabaseClient,
        env: {
          graphApiVersion: config.graphApiVersion,
          tokenEncryptionKey: Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? "",
        },
        fetchFn: fetch,
      };

      if (action === "list-templates") {
        const result = await listTenantTemplates(templateDeps, userId);
        if (!result.ok) {
          return json({ success: false, step, error: result.error.message });
        }
        return json({ success: true, templates: result.templates });
      }

      const result = await createTenantTemplate(templateDeps, userId, {
        name: String(body?.name ?? ""),
        category: String(body?.category ?? "UTILITY") as "AUTHENTICATION" | "MARKETING" | "UTILITY",
        language: String(body?.language ?? "pt_BR"),
        body: String(body?.body ?? ""),
      });
      if (!result.ok) {
        return json({ success: false, step, error: result.error.message });
      }
      return json({ success: true, template: result.template });
    }

    if (action === "diagnose") {
      step = "diagnose";
      const state = await buildConnectionState(
        { client: supabaseClient, env, fetchFn: fetch },
        userId,
      );
      return json({ success: true, state });
    }

    if (action === "validate-token") {
      step = "validate_token";
      const accessToken = String(body?.accessToken ?? "").trim();
      if (!accessToken) throw new HttpError(400, "Informe o access token da Meta");

      const token = await debugToken({
        graphApiVersion: env.metaGraphApiVersion,
        accessToken,
        fetchFn: fetch,
      });
      if (!token.valid) {
        return json({
          success: false,
          step,
          error: token.error?.message ?? "Access token inválido",
          code: token.error?.code,
        });
      }

      const wabaId = String(body?.wabaId ?? "").trim() || token.wabaIds[0] || null;
      if (!wabaId) {
        return json({
          success: false,
          step,
          error:
            "O token é válido, mas não dá acesso a nenhuma WABA. Confirme a permissão whatsapp_business_management.",
        });
      }

      // Lista os números reais da conta para o operador escolher — nunca aceitamos
      // um número digitado como se fosse um Phone Number ID.
      const numbers = await listPhoneNumbers({
        graphApiVersion: env.metaGraphApiVersion,
        accessToken,
        wabaId,
        fetchFn: fetch,
      });

      return json({
        success: true,
        token: { appId: token.appId, expiresAt: token.expiresAt, scopes: token.scopes },
        wabaId,
        wabaIds: token.wabaIds,
        numbers,
      });
    }

    if (action === "save-connection") {
      step = "save_connection";
      const accessToken = String(body?.accessToken ?? "").trim();
      const phoneNumberId = String(body?.phoneNumberId ?? "").trim();
      const wabaIdInput = String(body?.wabaId ?? "").trim();

      if (!accessToken) throw new HttpError(400, "Informe o access token da Meta");
      if (!phoneNumberId) throw new HttpError(400, "Selecione um número devolvido pela Meta");
      if (!env.tokenEncryptionKey) {
        throw new HttpError(503, "WHATSAPP_TOKEN_ENC_KEY não está configurada no ambiente");
      }

      // Só grava o que a Meta confirmou existir. Sem isso, um id digitado errado
      // viraria uma conexão "conectada" que nunca funcionaria.
      const verification = await verifyConnection({
        graphApiVersion: env.metaGraphApiVersion,
        accessToken,
        wabaId: wabaIdInput || undefined,
        phoneNumberId,
        appId: env.metaAppId,
        fetchFn: fetch,
      });

      if (!verification.tokenValid) {
        return json({
          success: false,
          step,
          error: verification.error?.message ?? "Access token inválido",
          code: verification.error?.code,
        });
      }
      if (!verification.phoneNumberFound) {
        return json({
          success: false,
          step,
          error:
            verification.error?.message ??
            "A Meta não reconheceu este Phone Number ID. Escolha um número da lista.",
        });
      }

      const confirmed = await getPhoneNumber({
        graphApiVersion: env.metaGraphApiVersion,
        accessToken,
        phoneNumberId,
        fetchFn: fetch,
      });

      const { error } = await supabaseClient.from("whatsapp_connections").upsert(
        {
          tenant_id: userId,
          status: "connected",
          phone_number_id: confirmed.phoneNumberId,
          waba_id: verification.waba?.wabaId ?? null,
          display_phone_number: confirmed.displayPhoneNumber,
          display_name: confirmed.verifiedName,
          quality_rating: confirmed.qualityRating,
          access_token_encrypted: await encryptSecret(accessToken, env.tokenEncryptionKey),
          token_type: verification.token?.expiresAt ? "user" : "system_user",
          token_expires_at: verification.token?.expiresAt ?? null,
          webhook_subscribed_at: verification.webhookSubscribed ? new Date().toISOString() : null,
          last_sync_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" },
      );
      if (error) throw new HttpError(500, error.message);

      const state = await buildConnectionState(
        { client: supabaseClient, env, fetchFn: fetch },
        userId,
      );
      return json({ success: true, state });
    }

    // O fluxo hospedado pela Meta conclui fora do navegador do tenant e não
    // devolve `code`. Esta ação encontra a conexão recém-criada no portfólio e
    // a grava — é o que faz o botão "Já concluí na Meta" funcionar.
    if (action === "discover-connection") {
      step = "discover_connection";
      const result = await discoverAndSaveConnection(
        {
          client: supabaseClient,
          env: {
            graphApiVersion: env.metaGraphApiVersion,
            tokenEncryptionKey: Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? "",
          },
          fetchFn: fetch,
        },
        userId,
      );

      if (!result.ok) {
        return json({
          success: false,
          step,
          error: result.error.message,
          code: result.error.code,
          candidates: result.candidates,
        });
      }

      const state = await buildConnectionState(
        { client: supabaseClient, env, fetchFn: fetch },
        userId,
      );
      return json({
        success: true,
        connection: result.connection,
        alreadyConnected: result.alreadyConnected,
        state,
      });
    }

    throw new HttpError(400, `Ação não suportada: ${action}`);
  } catch (error: any) {
    console.error(`[MetaAdmin] Erro em step=${step}:`, error?.message || error);
    return json(
      { success: false, step, error: error?.message || String(error) },
      getHttpErrorStatus(error, 500),
    );
  }
});
