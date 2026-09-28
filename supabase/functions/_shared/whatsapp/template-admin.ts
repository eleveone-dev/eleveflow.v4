// Gestão de modelos de mensagem do tenant, sobre a Management API da Meta.
//
// Templates são o único jeito de retomar conversa fora da janela de 24h, e
// passam por aprovação da Meta. O status exibido é sempre o que ela devolveu —
// nunca "criado com sucesso" traduzido como aprovado.

import { decryptSecret } from "../crypto.ts";
import { createMetaProvider } from "./meta-provider.ts";
import type { TemplateSummary } from "./types.ts";

export type TemplateCategory = "AUTHENTICATION" | "MARKETING" | "UTILITY";

export interface TemplateInput {
  name: string;
  category: TemplateCategory;
  language: string;
  body: string;
}

export interface TemplateAdminEnv {
  graphApiVersion: string;
  tokenEncryptionKey: string;
}

export interface TemplateAdminDeps {
  client: { from: (table: string) => any };
  env: TemplateAdminEnv;
  fetchFn?: typeof fetch;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const CATEGORIES: TemplateCategory[] = ["AUTHENTICATION", "MARKETING", "UTILITY"];
const BODY_LIMIT = 1024;

/** A Meta aceita só minúsculas, números e underscore no nome do template. */
export function validateTemplateInput(input: TemplateInput): ValidationResult {
  const name = String(input.name ?? "").trim();
  const body = String(input.body ?? "").trim();

  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    return {
      ok: false,
      error: "O nome deve usar apenas letras minúsculas, números e underscore (ex.: boas_vindas)",
    };
  }
  if (!CATEGORIES.includes(input.category)) {
    return { ok: false, error: "Categoria deve ser AUTHENTICATION, MARKETING ou UTILITY" };
  }
  if (!body) {
    return { ok: false, error: "O corpo da mensagem não pode ficar vazio" };
  }
  if (body.length > BODY_LIMIT) {
    return { ok: false, error: `O corpo da mensagem passa do limite de ${BODY_LIMIT} caracteres` };
  }

  return { ok: true };
}

type TemplateResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: { code?: string; message: string } };

async function providerFor(deps: TemplateAdminDeps, tenantId: string) {
  if (!deps.env.tokenEncryptionKey) {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY não está configurada");
  }

  const { data: connection } = await deps.client
    .from("whatsapp_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!connection?.access_token_encrypted) {
    throw new Error("Este tenant não tem conexão de WhatsApp configurada");
  }
  if (!connection.waba_id) {
    throw new Error("A conexão não tem conta do WhatsApp Business associada");
  }

  const accessToken = await decryptSecret(
    connection.access_token_encrypted,
    deps.env.tokenEncryptionKey,
  );

  return createMetaProvider({
    graphApiVersion: deps.env.graphApiVersion,
    phoneNumberId: connection.phone_number_id ?? "",
    wabaId: connection.waba_id,
    accessToken,
    fetchFn: deps.fetchFn,
  });
}

export async function listTenantTemplates(
  deps: TemplateAdminDeps,
  tenantId: string,
): Promise<TemplateResult<{ templates: TemplateSummary[] }>> {
  try {
    const provider = await providerFor(deps, tenantId);
    return { ok: true, templates: await provider.listTemplates() };
  } catch (error: any) {
    return { ok: false, error: { message: error?.message ?? String(error) } };
  }
}

export async function createTenantTemplate(
  deps: TemplateAdminDeps,
  tenantId: string,
  input: TemplateInput,
): Promise<TemplateResult<{ template: TemplateSummary }>> {
  const validation = validateTemplateInput(input);
  if (!validation.ok) return { ok: false, error: { message: validation.error } };

  try {
    const provider = await providerFor(deps, tenantId);
    const template = await provider.createTemplate({
      name: input.name.trim(),
      category: input.category,
      language: input.language,
      components: [{ type: "BODY", text: input.body.trim() }],
    });
    return { ok: true, template };
  } catch (error: any) {
    return { ok: false, error: { message: error?.message ?? String(error) } };
  }
}
