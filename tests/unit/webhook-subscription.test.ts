import { describe, it, expect, vi } from "vitest";
import { subscribeAppToWaba } from "../../supabase/functions/_shared/whatsapp/webhook-subscription";
import { encryptSecret } from "../../supabase/functions/_shared/crypto";
import { createFakeClient } from "./helpers/fake-supabase";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const TENANT = "tenant-1";
const APP_ID = "1742922410057266";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

async function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    status: "connected",
    waba_id: "WABA-CLI",
    phone_number_id: "106540352242922",
    access_token_encrypted: await encryptSecret("EAAJB-token", KEY),
    webhook_subscribed_at: null,
    ...overrides,
  };
}

const deps = (db: any, fetchFn: any) => ({
  client: createFakeClient(db) as any,
  env: { graphApiVersion: "v25.0", tokenEncryptionKey: KEY, appId: APP_ID },
  fetchFn,
});

/** POST de inscrição seguido do GET que confirma quem ficou inscrito. */
const subscribeThenConfirm = (apps: unknown[]) =>
  vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ success: true }))
    .mockResolvedValueOnce(jsonResponse({ data: apps }));

describe("subscribeAppToWaba — sucesso", () => {
  it("faz POST em /{WABA_ID}/subscribed_apps com o token do tenant", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = subscribeThenConfirm([
      { whatsapp_business_api_data: { id: APP_ID, name: "EleveOne" } },
    ]);

    await subscribeAppToWaba(deps(db, fetchFn), TENANT);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/WABA-CLI/subscribed_apps");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer EAAJB-token");
  });

  it("só marca inscrito depois de confirmar que o app aparece na lista", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const result = await subscribeAppToWaba(
      deps(
        db,
        subscribeThenConfirm([{ whatsapp_business_api_data: { id: APP_ID, name: "EleveOne" } }]),
      ),
      TENANT,
    );

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].webhook_subscribed_at).toMatch(/^\d{4}-/);
  });
});

describe("subscribeAppToWaba — recusas", () => {
  it("POST com sucesso mas app ausente na confirmação não marca inscrito", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    // A Meta devolveu 200, mas quem ficou inscrito foi outro app. Confiar no
    // 200 aqui reproduziria o falso positivo que já corrigimos antes.
    const fetchFn = subscribeThenConfirm([
      { whatsapp_business_api_data: { id: "OUTRO-APP", name: "App de teste da Meta" } },
    ]);

    const result = await subscribeAppToWaba(deps(db, fetchFn), TENANT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("não aparece");
    expect(db.whatsapp_connections[0].webhook_subscribed_at).toBeNull();
  });

  it("erro da Graph API não marca inscrito", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Permissions error", code: 200 } }, 403));

    const result = await subscribeAppToWaba(deps(db, fetchFn), TENANT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Permissions error");
    expect(db.whatsapp_connections[0].webhook_subscribed_at).toBeNull();
  });

  it("tenant sem conexão devolve erro claro", async () => {
    const fetchFn = vi.fn();
    const result = await subscribeAppToWaba(deps({ whatsapp_connections: [] }, fetchFn), TENANT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("conexão");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("conexão sem waba_id não tenta inscrever", async () => {
    const fetchFn = vi.fn();
    const db = { whatsapp_connections: [await connectionRow({ waba_id: null })] };
    const result = await subscribeAppToWaba(deps(db, fetchFn), TENANT);
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sem App ID configurado não dá para confirmar a identidade do app", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const fetchFn = vi.fn();
    const result = await subscribeAppToWaba(
      {
        client: createFakeClient(db) as any,
        env: { graphApiVersion: "v25.0", tokenEncryptionKey: KEY, appId: "" },
        fetchFn,
      },
      TENANT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("App ID");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("nunca devolve o token do tenant", async () => {
    const db = { whatsapp_connections: [await connectionRow()] };
    const result = await subscribeAppToWaba(
      deps(
        db,
        subscribeThenConfirm([{ whatsapp_business_api_data: { id: APP_ID, name: "EleveOne" } }]),
      ),
      TENANT,
    );
    expect(JSON.stringify(result)).not.toContain("EAAJB-token");
  });
});
