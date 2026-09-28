import { describe, it, expect } from "vitest";
import { isAlreadyRegistered } from "../../supabase/functions/_shared/whatsapp/message-dedupe";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

describe("isAlreadyRegistered", () => {
  it("reconhece wamid ja gravado na mesma direcao", async () => {
    const client = createFakeClient({
      messages: [{ id: "m1", user_id: TENANT, whatsapp_id: "wamid.AAA", direction: "inbound" }],
    });

    expect(await isAlreadyRegistered(client as any, TENANT, "wamid.AAA", "inbound")).toBe(true);
  });

  it("nao confunde direcoes diferentes", async () => {
    const client = createFakeClient({
      messages: [{ id: "m1", user_id: TENANT, whatsapp_id: "wamid.AAA", direction: "inbound" }],
    });

    expect(await isAlreadyRegistered(client as any, TENANT, "wamid.AAA", "outbound")).toBe(false);
  });

  it("nao vaza entre tenants", async () => {
    const client = createFakeClient({
      messages: [{ id: "m1", user_id: "outro", whatsapp_id: "wamid.AAA", direction: "inbound" }],
    });

    expect(await isAlreadyRegistered(client as any, TENANT, "wamid.AAA", "inbound")).toBe(false);
  });

  it("devolve false para wamid vazio", async () => {
    const client = createFakeClient({ messages: [] });

    expect(await isAlreadyRegistered(client as any, TENANT, "", "inbound")).toBe(false);
  });
});
