import { describe, it, expect, vi } from "vitest";
import { buildConnectionState } from "../../supabase/functions/_shared/whatsapp/connection-state";
import { encryptSecret } from "../../supabase/functions/_shared/crypto";
import { createFakeClient } from "./helpers/fake-supabase";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const TENANT = "tenant-1";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Sequência de respostas de um diagnóstico bem-sucedido. */
const healthyFetch = () =>
  vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        data: {
          is_valid: true,
          app_id: "APP1",
          granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA1"] }],
        },
      }),
    )
    .mockResolvedValueOnce(jsonResponse({ id: "WABA1", name: "Eleve One WABA" }))
    .mockResolvedValueOnce(
      jsonResponse({
        id: "106540352242922",
        display_phone_number: "+55 11 99999-0000",
        verified_name: "Eleve One",
        quality_rating: "GREEN",
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({ data: [{ whatsapp_business_api_data: { id: "APP1", name: "EleveFlow" } }] }),
    );

async function connectedRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    status: "connected",
    phone_number_id: "106540352242922",
    waba_id: "WABA1",
    access_token_encrypted: await encryptSecret("EAAJB-token", KEY),
    ...overrides,
  };
}

const deps = (db: any, fetchFn?: any) => ({
  client: createFakeClient(db) as any,
  env: { metaGraphApiVersion: "v25.0", tokenEncryptionKey: KEY, metaAppId: "APP1" },
  fetchFn,
});

describe("buildConnectionState — sem credenciais", () => {
  it("sem linha devolve credenciais não configuradas e nada verificado", async () => {
    const fetchFn = vi.fn();
    const state = await buildConnectionState(
      deps({ whatsapp_connections: [], messages: [] }, fetchFn),
      TENANT,
    );

    expect(state.configured).toBe(false);
    expect(state.checks.credentials).toBe("missing");
    expect(state.checks.connection).toBe("unknown");
    expect(state.checks.phoneNumber).toBe("unknown");
    expect(state.checks.webhook).toBe("unknown");
    expect(state.phoneNumber).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("linha sem token cifrado conta como credencial faltando", async () => {
    const fetchFn = vi.fn();
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [await connectedRow({ access_token_encrypted: null })],
          messages: [],
        },
        fetchFn,
      ),
      TENANT,
    );
    expect(state.checks.credentials).toBe("missing");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("buildConnectionState — verificação real", () => {
  it("só marca ok o que a Meta confirmou", async () => {
    const fetchFn = healthyFetch();
    const state = await buildConnectionState(
      deps({ whatsapp_connections: [await connectedRow()], messages: [] }, fetchFn),
      TENANT,
    );

    expect(state.checks.credentials).toBe("ok");
    expect(state.checks.connection).toBe("ok");
    expect(state.checks.phoneNumber).toBe("ok");
    expect(state.checks.webhook).toBe("ok");
    expect(state.phoneNumber).toMatchObject({
      phoneNumberId: "106540352242922",
      displayPhoneNumber: "+55 11 99999-0000",
      verifiedName: "Eleve One",
      qualityRating: "GREEN",
    });
    expect(state.waba).toMatchObject({ wabaId: "WABA1", name: "Eleve One WABA" });
    expect(state.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("token recusado pela Meta derruba a conexão mesmo com status connected no banco", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401),
      );

    const state = await buildConnectionState(
      deps({ whatsapp_connections: [await connectedRow()], messages: [] }, fetchFn),
      TENANT,
    );

    expect(state.checks.connection).toBe("failed");
    expect(state.checks.phoneNumber).toBe("unknown");
    expect(state.checks.webhook).toBe("unknown");
    expect(state.phoneNumber).toBeNull();
    expect(state.error).toMatchObject({ code: "190", message: "Invalid OAuth access token" });
  });

  it("nunca devolve o access token", async () => {
    const fetchFn = healthyFetch();
    const state = await buildConnectionState(
      deps({ whatsapp_connections: [await connectedRow()], messages: [] }, fetchFn),
      TENANT,
    );
    expect(JSON.stringify(state)).not.toContain("EAAJB-token");
    expect(JSON.stringify(state)).not.toContain(KEY);
  });
});

describe("buildConnectionState — envio e recebimento exigem prova da Meta", () => {
  it("sem credencial nenhuma, ambos ficam pendentes", async () => {
    const state = await buildConnectionState(
      deps({ whatsapp_connections: [], messages: [] }, vi.fn()),
      TENANT,
    );
    expect(state.checks.outbound).toBe("untested");
    expect(state.checks.inbound).toBe("untested");
  });

  it("mensagens antigas da Evolution não provam nada", async () => {
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [],
          // exatamente o que existia na conta e2e: mocks do EVOLUTION_MOCK
          messages: [
            {
              user_id: TENANT,
              direction: "outbound",
              status: "sent",
              whatsapp_id: "mock-1784207880470",
            },
            {
              user_id: TENANT,
              direction: "inbound",
              status: "received",
              whatsapp_id: "E2E-GOAL-1",
            },
          ],
        },
        vi.fn(),
      ),
      TENANT,
    );
    expect(state.checks.outbound).toBe("untested");
    expect(state.checks.inbound).toBe("untested");
  });

  it("conexão validada mas sem webhook de status deixa o envio pendente", async () => {
    const state = await buildConnectionState(
      deps({ whatsapp_connections: [await connectedRow()], messages: [] }, healthyFetch()),
      TENANT,
    );
    expect(state.checks.phoneNumber).toBe("ok");
    expect(state.checks.outbound).toBe("untested");
    expect(state.outboundProof).toBeNull();
  });

  it("status delivered gravado marca envio testado com data e origem", async () => {
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [
            await connectedRow({
              last_meta_outbound_wamid: "wamid.OUT",
              last_meta_outbound_status: "delivered",
              last_meta_outbound_test_at: "2026-07-30T12:00:00.000Z",
            }),
          ],
          messages: [],
        },
        healthyFetch(),
      ),
      TENANT,
    );
    expect(state.checks.outbound).toBe("ok");
    expect(state.outboundProof).toMatchObject({
      wamid: "wamid.OUT",
      status: "delivered",
      at: "2026-07-30T12:00:00.000Z",
    });
  });

  it("webhook de entrada gravado marca recebimento testado", async () => {
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [
            await connectedRow({
              last_meta_inbound_wamid: "wamid.IN",
              last_meta_inbound_test_at: "2026-07-30T12:05:00.000Z",
            }),
          ],
          messages: [],
        },
        healthyFetch(),
      ),
      TENANT,
    );
    expect(state.checks.inbound).toBe("ok");
    expect(state.inboundProof).toMatchObject({
      wamid: "wamid.IN",
      at: "2026-07-30T12:05:00.000Z",
    });
  });

  it("prova com phone number id não numérico é descartada", async () => {
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [
            await connectedRow({
              phone_number_id: "E2E-PNID-abc",
              last_meta_outbound_wamid: "wamid.OUT",
              last_meta_outbound_status: "read",
              last_meta_outbound_test_at: "2026-07-30T12:00:00.000Z",
            }),
          ],
          messages: [],
        },
        healthyFetch(),
      ),
      TENANT,
    );
    expect(state.checks.outbound).toBe("untested");
  });

  it("token recusado pela Meta invalida a prova antiga", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401),
      );
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [
            await connectedRow({
              last_meta_outbound_wamid: "wamid.OUT",
              last_meta_outbound_status: "read",
              last_meta_outbound_test_at: "2026-07-30T12:00:00.000Z",
              last_meta_inbound_wamid: "wamid.IN",
              last_meta_inbound_test_at: "2026-07-30T12:05:00.000Z",
            }),
          ],
          messages: [],
        },
        fetchFn,
      ),
      TENANT,
    );
    expect(state.checks.connection).toBe("failed");
    expect(state.checks.outbound).toBe("untested");
    expect(state.checks.inbound).toBe("untested");
  });

  it("conexão desconectada zera os indicadores", async () => {
    const state = await buildConnectionState(
      deps(
        {
          whatsapp_connections: [
            await connectedRow({
              status: "disconnected",
              last_meta_outbound_wamid: "wamid.OUT",
              last_meta_outbound_status: "read",
              last_meta_outbound_test_at: "2026-07-30T12:00:00.000Z",
            }),
          ],
          messages: [],
        },
        healthyFetch(),
      ),
      TENANT,
    );
    expect(state.checks.outbound).toBe("untested");
  });
});
