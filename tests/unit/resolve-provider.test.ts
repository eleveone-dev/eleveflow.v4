import { describe, it, expect, vi } from "vitest";
import { resolveProvider } from "../../supabase/functions/_shared/whatsapp";
import { encryptSecret } from "../../supabase/functions/_shared/crypto";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import { createFakeClient } from "./helpers/fake-supabase";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

const env = {
  metaGraphApiVersion: "v25.0",
  metaAppSecret: "app-secret",
  tokenEncryptionKey: KEY,
};

const deps = (db: any) => ({ client: createFakeClient(db) as any, env });

const connectedRow = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: "tenant-1",
  status: "connected",
  phone_number_id: "PNID",
  waba_id: "WABA",
  ...overrides,
});

describe("resolveProvider", () => {
  it("conectado devolve MetaProvider com o token descriptografado", async () => {
    const encrypted = await encryptSecret("EAAJB-token-real", KEY);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }),
      );

    const provider = await resolveProvider("tenant-1", {
      ...deps({
        whatsapp_connections: [connectedRow({ access_token_encrypted: encrypted })],
      }),
      fetchFn: fetchFn as any,
    });

    expect(provider.id).toBe("meta_cloud");
    const result = await provider.sendText({ to: "1", text: "x" });
    expect(fetchFn.mock.calls[0][0]).toBe("https://graph.facebook.com/v25.0/PNID/messages");
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer EAAJB-token-real");
    expect(result.providerMessageId).toBe("wamid.1");
  });

  it("sem linha falha com 409 explícito, nunca com fallback silencioso", async () => {
    const promise = resolveProvider("tenant-1", deps({ whatsapp_connections: [] }));
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toThrow("Tenant has no WhatsApp connection configured");
    await expect(promise).rejects.toMatchObject({ status: 409 });
  });

  it("linha não conectada falha com 409", async () => {
    const promise = resolveProvider(
      "tenant-1",
      deps({
        whatsapp_connections: [
          connectedRow({ status: "disconnected", access_token_encrypted: "v1:aa.bb" }),
        ],
      }),
    );
    await expect(promise).rejects.toThrow("WhatsApp connection for this tenant is not connected");
    await expect(promise).rejects.toMatchObject({ status: 409 });
  });

  it("sem token falha claro", async () => {
    await expect(
      resolveProvider("tenant-1", deps({ whatsapp_connections: [connectedRow()] })),
    ).rejects.toThrow("WhatsApp connection is missing the encrypted access token");
  });

  it("sem phone_number_id falha claro", async () => {
    await expect(
      resolveProvider(
        "tenant-1",
        deps({
          whatsapp_connections: [
            connectedRow({ phone_number_id: null, access_token_encrypted: "v1:aa.bb" }),
          ],
        }),
      ),
    ).rejects.toThrow("WhatsApp connection is missing phone_number_id");
  });

  it("sem chave de criptografia falha antes de tentar decifrar", async () => {
    await expect(
      resolveProvider("tenant-1", {
        client: createFakeClient({
          whatsapp_connections: [connectedRow({ access_token_encrypted: "v1:aa.bb" })],
        }) as any,
        env: { ...env, tokenEncryptionKey: undefined },
      }),
    ).rejects.toThrow("WHATSAPP_TOKEN_ENC_KEY is required");
  });

  it("erro de leitura do banco não vira tenant sem conexão", async () => {
    const client = createFakeClient(
      { whatsapp_connections: [] },
      { errors: { whatsapp_connections: { message: "connection reset" } } },
    );
    await expect(resolveProvider("tenant-1", { client: client as any, env })).rejects.toThrow(
      "Failed to read whatsapp_connections: connection reset",
    );
  });

  it("resolve a linha do tenant certo", async () => {
    const encrypted = await encryptSecret("token-do-2", KEY);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: "w" }] }), { status: 200 }),
      );

    const provider = await resolveProvider("tenant-2", {
      ...deps({
        whatsapp_connections: [
          connectedRow({ access_token_encrypted: "v1:outro.tenant" }),
          connectedRow({
            tenant_id: "tenant-2",
            phone_number_id: "PNID-2",
            access_token_encrypted: encrypted,
          }),
        ],
      }),
      fetchFn: fetchFn as any,
    });

    await provider.sendText({ to: "1", text: "x" });
    expect(fetchFn.mock.calls[0][0]).toContain("/PNID-2/messages");
  });
});

describe("resolveProvider com Evolution", () => {
  const evolutionEnv = {
    ...env,
    evolutionApiUrl: "https://evo.example",
    evolutionApiKey: "chave-global",
    evolutionWebhookSecret: "s".repeat(32),
  };

  const evolutionRow = (overrides: Record<string, unknown> = {}) => ({
    tenant_id: "tenant-evo",
    status: "connected",
    provider: "evolution",
    instance_name: "eleve-conta-a",
    phone_number_id: null,
    access_token_encrypted: null,
    ...overrides,
  });

  it("devolve EvolutionProvider sem exigir token nem phone_number_id", async () => {
    // Resposta nova por chamada: um mesmo Response só pode ser lido uma vez, e o
    // envio de produção agora faz três chamadas (JID, "digitando…", envio).
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).includes("/chat/whatsappNumbers/")) {
        return new Response(
          JSON.stringify([{ exists: true, jid: "5511999999999@s.whatsapp.net" }]),
          { status: 200 },
        );
      }
      if (String(url).includes("/chat/sendPresence/")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ key: { id: "3EB0" } }), { status: 200 });
    });
    const sleepFn = vi.fn(async () => {});

    const provider = await resolveProvider("tenant-evo", {
      client: createFakeClient({ whatsapp_connections: [evolutionRow()] }) as any,
      env: evolutionEnv,
      fetchFn: fetchFn as any,
      sleepFn,
    });

    expect(provider.id).toBe("evolution");
    const result = await provider.sendText({ to: "5511999999999", text: "x" });
    const rotas = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(rotas).toContain("https://evo.example/message/sendText/eleve-conta-a");
    expect(result.providerMessageId).toBe("3EB0");
  });

  it("o provedor de produção sai humanizado: JID real e 'digitando…' antes do envio", async () => {
    // É isto que tira o disparo da cara de robô, e é o que o app antigo fazia.
    // Se alguém montar o provedor sem `humanize` aqui, o envio volta a ser cru.
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).includes("/chat/whatsappNumbers/")) {
        return new Response(
          JSON.stringify([{ exists: true, jid: "5511999999999@s.whatsapp.net" }]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ key: { id: "3EB0" } }), { status: 200 });
    });
    const sleepFn = vi.fn(async () => {});

    const provider = await resolveProvider("tenant-evo", {
      client: createFakeClient({ whatsapp_connections: [evolutionRow()] }) as any,
      env: evolutionEnv,
      fetchFn: fetchFn as any,
      sleepFn,
    });
    await provider.sendText({ to: "5511999999999", text: "x" });

    const rotas = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(rotas.findIndex((r) => r.includes("/chat/whatsappNumbers/"))).toBe(0);
    expect(rotas.findIndex((r) => r.includes("/chat/sendPresence/"))).toBe(1);
    expect(rotas.findIndex((r) => r.includes("/message/sendText/"))).toBe(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it("sem credencial da Evolution no ambiente falha com 503", async () => {
    const promise = resolveProvider("tenant-evo", {
      client: createFakeClient({ whatsapp_connections: [evolutionRow()] }) as any,
      env: { ...env },
    });
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toMatchObject({ status: 503 });
  });

  it("sem instance_name falha claro", async () => {
    await expect(
      resolveProvider("tenant-evo", {
        client: createFakeClient({
          whatsapp_connections: [evolutionRow({ instance_name: null })],
        }) as any,
        env: evolutionEnv,
      }),
    ).rejects.toThrow("WhatsApp connection is missing instance_name");
  });

  it("linha sem provider continua sendo tratada como meta_cloud", async () => {
    const encrypted = await encryptSecret("token", KEY);
    const provider = await resolveProvider("tenant-1", {
      ...deps({
        whatsapp_connections: [connectedRow({ access_token_encrypted: encrypted })],
      }),
      fetchFn: vi.fn() as any,
    });
    expect(provider.id).toBe("meta_cloud");
  });

  it("nao confunde os dois tenants quando os dois providers convivem", async () => {
    const encrypted = await encryptSecret("token-meta", KEY);
    const db = {
      whatsapp_connections: [
        connectedRow({ tenant_id: "tenant-meta", access_token_encrypted: encrypted }),
        evolutionRow(),
      ],
    };

    const meta = await resolveProvider("tenant-meta", {
      client: createFakeClient(db) as any,
      env: evolutionEnv,
      fetchFn: vi.fn() as any,
    });
    const evo = await resolveProvider("tenant-evo", {
      client: createFakeClient(db) as any,
      env: evolutionEnv,
      fetchFn: vi.fn() as any,
    });

    expect(meta.id).toBe("meta_cloud");
    expect(evo.id).toBe("evolution");
  });
});
