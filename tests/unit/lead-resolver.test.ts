import { describe, it, expect } from "vitest";
import { resolveLead } from "../../supabase/functions/_shared/whatsapp/lead-resolver";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

describe("resolveLead", () => {
  it("acha o lead pelo telefone normalizado", async () => {
    const client = createFakeClient({
      leads: [{ id: "lead-1", user_id: TENANT, phone_normalized: "5534953285885" }],
    });

    const result = await resolveLead(client as any, TENANT, "+55 34 95328-5885");

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.lead.id).toBe("lead-1");
  });

  it("acha o lead gravado sem o nono digito", async () => {
    const client = createFakeClient({
      leads: [{ id: "lead-2", user_id: TENANT, phone_normalized: "553453285885" }],
    });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.lead.id).toBe("lead-2");
  });

  it("devolve none quando nenhum lead casa", async () => {
    const client = createFakeClient({ leads: [] });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("none");
    expect(result.normalized).toBe("5534953285885");
  });

  it("devolve ambiguous quando mais de um lead casa", async () => {
    const client = createFakeClient({
      leads: [
        { id: "lead-a", user_id: TENANT, phone_normalized: "5534953285885" },
        { id: "lead-b", user_id: TENANT, phone_normalized: "553453285885" },
      ],
    });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.leads).toHaveLength(2);
  });

  it("ignora lead de outro tenant", async () => {
    const client = createFakeClient({
      leads: [{ id: "lead-x", user_id: "outro-tenant", phone_normalized: "5534953285885" }],
    });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("none");
  });
});
