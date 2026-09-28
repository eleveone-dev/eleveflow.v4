import { describe, it, expect, vi } from "vitest";
import { completeSignupOnboarding } from "../../supabase/functions/_shared/whatsapp/signup-onboarding";
import { decryptSecret } from "../../supabase/functions/_shared/crypto";
import { createFakeClient } from "./helpers/fake-supabase";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const TENANT = "tenant-1";

const env = {
  graphApiVersion: "v25.0",
  appId: "1742922410057266",
  appSecret: "APP-SECRET",
  tokenEncryptionKey: KEY,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** troca → debug_token → phone_numbers → getPhoneNumber → subscribed_apps */
const onboardingFetch = (numbers: unknown[] = [defaultNumber()]) =>
  vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token-do-cliente" }))
    .mockResolvedValueOnce(
      jsonResponse({
        data: {
          is_valid: true,
          app_id: "1742922410057266",
          expires_at: 0,
          scopes: ["whatsapp_business_management"],
          granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA-CLI"] }],
        },
      }),
    )
    .mockResolvedValueOnce(jsonResponse({ data: numbers }))
    .mockResolvedValueOnce(
      jsonResponse({
        id: "106540352242922",
        display_phone_number: "+55 37 99820-4766",
        verified_name: "Atual Barbearia",
        quality_rating: "GREEN",
      }),
    )
    .mockResolvedValueOnce(jsonResponse({ data: [] }));

function defaultNumber() {
  return {
    id: "106540352242922",
    display_phone_number: "+55 37 99820-4766",
    verified_name: "Atual Barbearia",
    quality_rating: "GREEN",
  };
}

const deps = (db: any, fetchFn: any) => ({
  client: createFakeClient(db) as any,
  env,
  fetchFn,
});

describe("completeSignupOnboarding — sucesso", () => {
  it("grava a conexão com os dados que a Meta confirmou", async () => {
    const db = { whatsapp_connections: [] as any[] };
    const result = await completeSignupOnboarding(deps(db, onboardingFetch()), TENANT, "CODE-123");

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections).toHaveLength(1);
    expect(db.whatsapp_connections[0]).toMatchObject({
      tenant_id: TENANT,
      status: "connected",
      waba_id: "WABA-CLI",
      phone_number_id: "106540352242922",
      display_phone_number: "+55 37 99820-4766",
      display_name: "Atual Barbearia",
      quality_rating: "GREEN",
    });
  });

  it("o token é gravado cifrado e volta a ser legível com a chave", async () => {
    const db = { whatsapp_connections: [] as any[] };
    await completeSignupOnboarding(deps(db, onboardingFetch()), TENANT, "CODE-123");

    const guardado = db.whatsapp_connections[0].access_token_encrypted;
    expect(guardado.startsWith("v1:")).toBe(true);
    expect(guardado).not.toContain("EAAJB-token-do-cliente");
    expect(await decryptSecret(guardado, KEY)).toBe("EAAJB-token-do-cliente");
  });

  it("o retorno não carrega o token em lugar nenhum", async () => {
    const db = { whatsapp_connections: [] as any[] };
    const result = await completeSignupOnboarding(deps(db, onboardingFetch()), TENANT, "CODE-123");
    expect(JSON.stringify(result)).not.toContain("EAAJB-token-do-cliente");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("webhook não é dado como inscrito: isso é a etapa seguinte", async () => {
    const db = { whatsapp_connections: [] as any[] };
    await completeSignupOnboarding(deps(db, onboardingFetch()), TENANT, "CODE-123");
    expect(db.whatsapp_connections[0].webhook_subscribed_at).toBeNull();
  });

  it("com vários números grava o indicado e informa os demais", async () => {
    // Com mais de um número, a escolha cega foi desativada (ver describe
    // "escolha do número e coexistência"): é preciso indicar phoneNumberId.
    const db = { whatsapp_connections: [] as any[] };
    const result = await completeSignupOnboarding(
      deps(
        db,
        onboardingFetch([
          defaultNumber(),
          { id: "999888777666555", display_phone_number: "+55 11 90000-0000" },
        ]),
      ),
      TENANT,
      "CODE-123",
      { phoneNumberId: "106540352242922" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.otherNumbers).toHaveLength(1);
    expect(db.whatsapp_connections[0].phone_number_id).toBe("106540352242922");
  });
});

describe("completeSignupOnboarding — recusas", () => {
  it("code inválido não grava nada", async () => {
    const db = { whatsapp_connections: [] as any[] };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { message: "This authorization code has expired.", code: 100 } },
          400,
        ),
      );

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "VELHO");
    expect(result.ok).toBe(false);
    expect(db.whatsapp_connections).toHaveLength(0);
  });

  it("WABA sem números não grava conexão pela metade", async () => {
    const db = { whatsapp_connections: [] as any[] };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            app_id: "1742922410057266",
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA-CLI"] }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("número");
    expect(db.whatsapp_connections).toHaveLength(0);
  });

  it("sem chave de criptografia recusa antes de tocar na rede", async () => {
    const db = { whatsapp_connections: [] as any[] };
    const fetchFn = vi.fn();
    const result = await completeSignupOnboarding(
      { client: createFakeClient(db) as any, env: { ...env, tokenEncryptionKey: "" }, fetchFn },
      TENANT,
      "CODE",
    );
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(db.whatsapp_connections).toHaveLength(0);
  });

  it("conexão anterior do mesmo tenant é substituída, não duplicada", async () => {
    const db = {
      whatsapp_connections: [
        {
          tenant_id: TENANT,
          status: "connected",
          phone_number_id: "ANTIGO",
          waba_id: "WABA-VELHA",
        },
      ],
    };
    await completeSignupOnboarding(deps(db, onboardingFetch()), TENANT, "CODE-123");

    expect(db.whatsapp_connections).toHaveLength(1);
    expect(db.whatsapp_connections[0].phone_number_id).toBe("106540352242922");
  });
});

describe("escolha do número e coexistência", () => {
  const segundoNumero = () => ({
    id: "999888777666555",
    display_phone_number: "+55 34 95328-5885",
    verified_name: "Segundo Número",
    quality_rating: "GREEN",
  });

  it("recusa quando a WABA tem mais de um numero e nada indica qual", async () => {
    const db: any = { whatsapp_connections: [] };
    const fetchFn = onboardingFetch([defaultNumber(), segundoNumero()]);

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ambiguous_phone_number");
      expect(result.error.message).toContain("999888777666555");
    }
    expect(db.whatsapp_connections).toHaveLength(0);
  });

  it("usa o numero indicado pelo evento quando a WABA tem varios", async () => {
    const db: any = { whatsapp_connections: [] };
    const fetchFn = onboardingFetch([defaultNumber(), segundoNumero()]);

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE", {
      phoneNumberId: "106540352242922",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phoneNumber.phoneNumberId).toBe("106540352242922");
  });

  it("grava coexistence_enabled quando a Graph diz que o numero esta no Business App", async () => {
    const db: any = { whatsapp_connections: [] };
    const fetchFn = onboardingFetch([
      { ...defaultNumber(), is_on_biz_app: true, platform_type: "CLOUD_API" },
    ]);

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE");

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(true);
  });

  it("cai na dica do evento quando a Graph nao expoe o campo", async () => {
    const db: any = { whatsapp_connections: [] };
    const fetchFn = onboardingFetch([defaultNumber()]);

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE", {
      coexistenceHint: true,
    });

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(true);
  });

  it("grava false quando nada indica coexistencia", async () => {
    const db: any = { whatsapp_connections: [] };
    const fetchFn = onboardingFetch([defaultNumber()]);

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE");

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(false);
  });
});

describe("listPhoneNumbers — fallback quando a Graph rejeita os campos de coexistência", () => {
  it("repete a listagem sem is_on_biz_app/platform_type e usa a dica do evento", async () => {
    const db: any = { whatsapp_connections: [] };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token-do-cliente" }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            app_id: "1742922410057266",
            expires_at: 0,
            scopes: ["whatsapp_business_management"],
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA-CLI"] }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "Unknown fields: is_on_biz_app,platform_type", code: 100 } },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [defaultNumber()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "106540352242922",
          display_phone_number: "+55 37 99820-4766",
          verified_name: "Atual Barbearia",
          quality_rating: "GREEN",
        }),
      );

    const result = await completeSignupOnboarding(deps(db, fetchFn), TENANT, "CODE", {
      coexistenceHint: true,
    });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(true);
  });
});
