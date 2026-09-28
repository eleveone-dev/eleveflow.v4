import { describe, it, expect } from "vitest";
import {
  isRealMetaPhoneNumberId,
  isRealMetaWamid,
  recordOutboundProof,
  recordInboundProof,
} from "../../supabase/functions/_shared/whatsapp/connection-proof";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";
const PNID = "106540352242922";

const connection = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: TENANT,
  status: "connected",
  phone_number_id: PNID,
  access_token_encrypted: "v1:aa.bb",
  last_meta_outbound_wamid: null,
  last_meta_outbound_status: null,
  last_meta_outbound_test_at: null,
  last_meta_inbound_wamid: null,
  last_meta_inbound_test_at: null,
  ...overrides,
});

describe("isRealMetaPhoneNumberId", () => {
  it("aceita só id numérico da Meta", () => {
    expect(isRealMetaPhoneNumberId("106540352242922")).toBe(true);
  });

  it.each(["E2E-PNID-c6c1d9fccd86", "", null, undefined, "abc123", "+5511999990000"])(
    "rejeita %s",
    (value) => {
      expect(isRealMetaPhoneNumberId(value as any)).toBe(false);
    },
  );
});

describe("isRealMetaWamid", () => {
  it("aceita wamid da Meta", () => {
    expect(isRealMetaWamid("wamid.HBgLMTY1MDM4Nzk0Mzk=")).toBe(true);
  });

  it.each(["mock-1784207880470", "E2E-GOAL-123", "", null, undefined, "ABC123"])(
    "rejeita %s",
    (value) => {
      expect(isRealMetaWamid(value as any)).toBe(false);
    },
  );
});

describe("recordOutboundProof", () => {
  it("grava wamid, status e data quando o webhook confirma entrega", async () => {
    const db = { whatsapp_connections: [connection()] };
    const client = createFakeClient(db) as any;

    const saved = await recordOutboundProof(client, TENANT, PNID, {
      providerMessageId: "wamid.ABC",
      status: "delivered",
    });

    expect(saved).toBe(true);
    expect(db.whatsapp_connections[0]).toMatchObject({
      last_meta_outbound_wamid: "wamid.ABC",
      last_meta_outbound_status: "delivered",
    });
    expect(db.whatsapp_connections[0].last_meta_outbound_test_at).toMatch(/^\d{4}-/);
  });

  it("wamid que não é da Meta não vira prova", async () => {
    const db = { whatsapp_connections: [connection()] };
    const client = createFakeClient(db) as any;

    const saved = await recordOutboundProof(client, TENANT, PNID, {
      providerMessageId: "mock-1784207880470",
      status: "sent",
    });

    expect(saved).toBe(false);
    expect(db.whatsapp_connections[0].last_meta_outbound_wamid).toBeNull();
  });

  it("status fora de sent/delivered/read não vira prova", async () => {
    const db = { whatsapp_connections: [connection()] };
    const client = createFakeClient(db) as any;
    const saved = await recordOutboundProof(client, TENANT, PNID, {
      providerMessageId: "wamid.ABC",
      status: "failed",
    });
    expect(saved).toBe(false);
    expect(db.whatsapp_connections[0].last_meta_outbound_wamid).toBeNull();
  });

  it("phone number id não numérico não vira prova", async () => {
    const db = { whatsapp_connections: [connection({ phone_number_id: "E2E-PNID-x" })] };
    const client = createFakeClient(db) as any;
    const saved = await recordOutboundProof(client, TENANT, "E2E-PNID-x", {
      providerMessageId: "wamid.ABC",
      status: "delivered",
    });
    expect(saved).toBe(false);
  });

  it("não regride de delivered para sent", async () => {
    const db = {
      whatsapp_connections: [
        connection({
          last_meta_outbound_wamid: "wamid.OLD",
          last_meta_outbound_status: "delivered",
          last_meta_outbound_test_at: "2026-07-30T10:00:00.000Z",
        }),
      ],
    };
    const client = createFakeClient(db) as any;

    await recordOutboundProof(client, TENANT, PNID, {
      providerMessageId: "wamid.NEW",
      status: "sent",
    });

    expect(db.whatsapp_connections[0].last_meta_outbound_status).toBe("delivered");
    expect(db.whatsapp_connections[0].last_meta_outbound_wamid).toBe("wamid.OLD");
  });

  it("avança de sent para read", async () => {
    const db = {
      whatsapp_connections: [
        connection({ last_meta_outbound_wamid: "wamid.OLD", last_meta_outbound_status: "sent" }),
      ],
    };
    const client = createFakeClient(db) as any;

    await recordOutboundProof(client, TENANT, PNID, {
      providerMessageId: "wamid.NEW",
      status: "read",
    });

    expect(db.whatsapp_connections[0].last_meta_outbound_status).toBe("read");
    expect(db.whatsapp_connections[0].last_meta_outbound_wamid).toBe("wamid.NEW");
  });
});

describe("recordInboundProof", () => {
  it("grava quando o número do webhook é o da conexão", async () => {
    const db = { whatsapp_connections: [connection()] };
    const client = createFakeClient(db) as any;

    const saved = await recordInboundProof(client, TENANT, PNID, "wamid.IN");

    expect(saved).toBe(true);
    expect(db.whatsapp_connections[0]).toMatchObject({ last_meta_inbound_wamid: "wamid.IN" });
    expect(db.whatsapp_connections[0].last_meta_inbound_test_at).toMatch(/^\d{4}-/);
  });

  it("webhook de outro phone number id não vira prova", async () => {
    const db = { whatsapp_connections: [connection()] };
    const client = createFakeClient(db) as any;

    const saved = await recordInboundProof(client, TENANT, "999999999999999", "wamid.IN");

    expect(saved).toBe(false);
    expect(db.whatsapp_connections[0].last_meta_inbound_wamid).toBeNull();
  });

  it("wamid que não é da Meta não vira prova", async () => {
    const db = { whatsapp_connections: [connection()] };
    const client = createFakeClient(db) as any;
    expect(await recordInboundProof(client, TENANT, PNID, "E2E-GOAL-1")).toBe(false);
  });

  it("conexão de outro tenant não é tocada", async () => {
    const db = { whatsapp_connections: [connection({ tenant_id: "outro" })] };
    const client = createFakeClient(db) as any;
    expect(await recordInboundProof(client, TENANT, PNID, "wamid.IN")).toBe(false);
    expect(db.whatsapp_connections[0].last_meta_inbound_wamid).toBeNull();
  });
});
