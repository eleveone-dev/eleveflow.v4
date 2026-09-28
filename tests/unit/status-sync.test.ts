import { describe, it, expect } from "vitest";
import { applyStatusUpdates } from "../../supabase/functions/_shared/whatsapp/status-sync";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

const message = (whatsappId: string, status: string) => ({
  id: `m-${whatsappId}`,
  user_id: TENANT,
  whatsapp_id: whatsappId,
  direction: "outbound",
  status,
});

describe("applyStatusUpdates", () => {
  it("avança pending → sent → delivered → read", async () => {
    const db = { messages: [message("wamid.A", "pending")] };
    const client = createFakeClient(db) as any;

    for (const status of ["sent", "delivered", "read"] as const) {
      await applyStatusUpdates(client, TENANT, [
        { providerMessageId: "wamid.A", status, timestamp: "2026-07-25T00:00:00.000Z" },
      ]);
    }
    expect(db.messages[0].status).toBe("read");
  });

  it("não regride status já mais avançado (webhook fora de ordem)", async () => {
    const db = { messages: [message("wamid.A", "read")] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "delivered", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(db.messages[0].status).toBe("read");
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it("failed sempre vence", async () => {
    const db = { messages: [message("wamid.A", "read")] };
    const client = createFakeClient(db) as any;
    await applyStatusUpdates(client, TENANT, [
      {
        providerMessageId: "wamid.A",
        status: "failed",
        timestamp: "2026-07-25T00:00:00.000Z",
        error: { code: "131049", message: "não entregue" },
      },
    ]);
    expect(db.messages[0].status).toBe("failed");
  });

  it("é idempotente: reaplicar o mesmo status não conta como aplicado", async () => {
    const db = { messages: [message("wamid.A", "delivered")] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "delivered", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it("não toca mensagem de outro tenant", async () => {
    const db = { messages: [{ ...message("wamid.A", "sent"), user_id: "tenant-2" }] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "read", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(db.messages[0].status).toBe("sent");
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it("status sem wamid é descartado antes de consultar o banco", async () => {
    const db = { messages: [message("wamid.A", "sent")] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "", status: "read", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(db.messages[0].status).toBe("sent");
  });

  it("erro de escrita não conta como aplicado", async () => {
    const db = { messages: [message("wamid.A", "sent")] };
    const client = createFakeClient(db, {
      errors: { messages: { message: "deadlock detected" } },
    }) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "read", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(db.messages[0].status).toBe("sent");
  });

  it("wamid desconhecido é ignorado sem erro", async () => {
    const db = { messages: [] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.Z", status: "sent", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });
});
