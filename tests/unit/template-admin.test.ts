import { describe, it, expect, vi } from "vitest";
import {
  listTenantTemplates,
  createTenantTemplate,
  validateTemplateInput,
} from "../../supabase/functions/_shared/whatsapp/template-admin";
import { encryptSecret } from "../../supabase/functions/_shared/crypto";
import { createFakeClient } from "./helpers/fake-supabase";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const TENANT = "tenant-1";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

async function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    status: "connected",
    waba_id: "WABA-CLI",
    phone_number_id: "106540352242922",
    access_token_encrypted: await encryptSecret("EAAJB-token", KEY),
    ...overrides,
  };
}

const deps = (db: any, fetchFn: any) => ({
  client: createFakeClient(db) as any,
  env: { graphApiVersion: "v25.0", tokenEncryptionKey: KEY },
  fetchFn,
});

describe("validateTemplateInput", () => {
  it("aceita um template mínimo válido", () => {
    expect(
      validateTemplateInput({
        name: "boas_vindas",
        category: "UTILITY",
        language: "pt_BR",
        body: "Olá, tudo bem?",
      }),
    ).toEqual({ ok: true });
  });

  it.each(["Boas Vindas", "boas-vindas", "boas vindas", "BOASVINDAS", "olá"])(
    "rejeita nome fora do padrão da Meta: %s",
    (name) => {
      const result = validateTemplateInput({
        name,
        category: "UTILITY",
        language: "pt_BR",
        body: "texto",
      });
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain("nome");
    },
  );

  it("aceita nome com números e underscore", () => {
    expect(
      validateTemplateInput({
        name: "confirmacao_pedido_2",
        category: "UTILITY",
        language: "pt_BR",
        body: "texto",
      }),
    ).toEqual({ ok: true });
  });

  it("rejeita categoria fora das três aceitas", () => {
    const result = validateTemplateInput({
      name: "teste",
      category: "PROMOCIONAL" as any,
      language: "pt_BR",
      body: "texto",
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("Categoria");
  });

  it("rejeita corpo vazio", () => {
    const result = validateTemplateInput({
      name: "teste",
      category: "UTILITY",
      language: "pt_BR",
      body: "   ",
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("corpo");
  });

  it("rejeita corpo acima do limite da Meta", () => {
    const result = validateTemplateInput({
      name: "teste",
      category: "UTILITY",
      language: "pt_BR",
      body: "x".repeat(1025),
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("1024");
  });
});

describe("listTenantTemplates", () => {
  it("lista os templates da WABA com status real da Meta", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "1667192013751005",
            name: "boas_vindas",
            language: "pt_BR",
            category: "UTILITY",
            status: "APPROVED",
            components: [{ type: "BODY", text: "Olá" }],
          },
        ],
      }),
    );

    const result = await listTenantTemplates(deps(db, fetchFn), TENANT);

    expect(fetchFn.mock.calls[0][0]).toContain("/WABA-CLI/message_templates");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toMatchObject({
      name: "boas_vindas",
      status: "APPROVED",
      category: "UTILITY",
    });
  });

  it("tenant sem conexão devolve erro em vez de lista vazia", async () => {
    const fetchFn = vi.fn();
    const result = await listTenantTemplates(deps({ whatsapp_connections: [] }, fetchFn), TENANT);
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("nunca devolve o token", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const result = await listTenantTemplates(deps(db, fetchFn), TENANT);
    expect(JSON.stringify(result)).not.toContain("EAAJB-token");
  });
});

describe("createTenantTemplate", () => {
  const input = {
    name: "boas_vindas",
    category: "UTILITY" as const,
    language: "pt_BR",
    body: "Olá, tudo bem?",
  };

  it("envia o corpo no formato de components da Meta", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "1259544702043867", status: "PENDING" }));

    await createTenantTemplate(deps(db, fetchFn), TENANT, input);

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body).toEqual({
      name: "boas_vindas",
      category: "UTILITY",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Olá, tudo bem?" }],
    });
  });

  it("devolve o status que a Meta atribuiu, não um status inventado", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "1259544702043867", status: "PENDING" }));

    const result = await createTenantTemplate(deps(db, fetchFn), TENANT, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.status).toBe("PENDING");
    expect(result.template.id).toBe("1259544702043867");
  });

  it("entrada inválida não chega à rede", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi.fn();
    const result = await createTenantTemplate(deps(db, fetchFn), TENANT, {
      ...input,
      name: "Nome Inválido",
    });
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("recusa da Meta vira erro com a mensagem dela", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "Template name already exists", code: 100 } }, 400),
      );

    const result = await createTenantTemplate(deps(db, fetchFn), TENANT, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("already exists");
  });
});
