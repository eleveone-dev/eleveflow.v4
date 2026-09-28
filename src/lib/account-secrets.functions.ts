import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Sem `openrouter`: a chave do LLM é global do projeto (`OPENROUTER_API_KEY` nos
// secrets) e nenhuma edge function lê esta tabela. Guardar um campo de chave que
// ninguém usa só cria credencial parada no banco e sugere configuração que não
// existe. Nenhuma conta tinha valor gravado quando isto foi removido.
const DEFAULT_INTEGRATIONS = {
  serpapi: { key: "" },
};

async function ensureRow(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("account_secrets" as any)
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  return supabaseAdmin;
}

export const getAccountSecrets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.userId;
    const admin = await ensureRow(userId);
    const { data, error } = await admin
      .from("account_secrets" as any)
      .select("integrations, whatsapp_session")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as { integrations?: any; whatsapp_session?: any };
    return {
      integrations: row.integrations ?? DEFAULT_INTEGRATIONS,
      whatsapp_session: row.whatsapp_session ?? null,
    };
  });

const integrationsSchema = z.object({
  serpapi: z.object({ key: z.string().max(500).default("") }).default({ key: "" }),
});

export const updateIntegrations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ integrations: integrationsSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const admin = await ensureRow(userId);
    const { error } = await admin
      .from("account_secrets" as any)
      .update({ integrations: data.integrations })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setWhatsappSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        session: z.any().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const admin = await ensureRow(userId);
    const { error } = await admin
      .from("account_secrets" as any)
      .update({ whatsapp_session: data.session })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
