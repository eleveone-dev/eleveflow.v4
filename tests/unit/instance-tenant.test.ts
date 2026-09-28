import { describe, it, expect } from "vitest";
import { resolveTenantByInstance } from "../../supabase/functions/_shared/whatsapp/instance-tenant";
import { createFakeClient } from "./helpers/fake-supabase";

const CONTA_A = "11111111-1111-1111-1111-111111111111";
const CONTA_B = "22222222-2222-2222-2222-222222222222";
const CONTA_META = "33333333-3333-3333-3333-333333333333";

function client() {
  return createFakeClient({
    whatsapp_connections: [
      {
        tenant_id: CONTA_A,
        provider: "evolution",
        instance_name: "eleve-conta-a",
        status: "connected",
      },
      {
        tenant_id: CONTA_B,
        provider: "evolution",
        instance_name: "eleve-conta-b",
        status: "connected",
      },
      {
        tenant_id: CONTA_META,
        provider: "meta_cloud",
        instance_name: null,
        phone_number_id: "123",
        status: "connected",
      },
    ],
  });
}

describe("resolveTenantByInstance", () => {
  it("instancia conhecida devolve o tenant dono", async () => {
    expect(await resolveTenantByInstance(client(), "eleve-conta-b")).toEqual({
      ok: true,
      tenantId: CONTA_B,
    });
  });

  it("nao confunde as instancias entre si", async () => {
    expect(await resolveTenantByInstance(client(), "eleve-conta-a")).toEqual({
      ok: true,
      tenantId: CONTA_A,
    });
  });

  it("aparas em volta do nome nao impedem a resolucao", async () => {
    expect(await resolveTenantByInstance(client(), "  eleve-conta-a  ")).toEqual({
      ok: true,
      tenantId: CONTA_A,
    });
  });

  it("instancia desconhecida nao vira tenant", async () => {
    expect(await resolveTenantByInstance(client(), "instancia-que-nao-existe")).toEqual({
      ok: false,
      reason: "unknown_instance",
    });
  });

  it("instancia ausente, vazia ou nao-string nao vira tenant", async () => {
    for (const valor of [undefined, null, "", "   ", 42, {}]) {
      expect(await resolveTenantByInstance(client(), valor)).toEqual({
        ok: false,
        reason: "missing_instance",
      });
    }
  });

  it("nao resolve inbound de Evolution por linha meta_cloud", async () => {
    // A linha da Meta nao tem instance_name, entao so poderia casar por acidente.
    // O filtro por provider e o que garante que nao casa.
    const comColisao = createFakeClient({
      whatsapp_connections: [
        {
          tenant_id: CONTA_META,
          provider: "meta_cloud",
          instance_name: "eleve-conta-a",
          phone_number_id: "123",
          status: "connected",
        },
      ],
    });
    expect(await resolveTenantByInstance(comColisao, "eleve-conta-a")).toEqual({
      ok: false,
      reason: "unknown_instance",
    });
  });

  it("erro de banco sobe em vez de virar tenant ausente", async () => {
    const quebrado = createFakeClient(
      { whatsapp_connections: [] },
      { errors: { whatsapp_connections: { message: "boom" } } },
    );
    await expect(resolveTenantByInstance(quebrado, "eleve-conta-a")).rejects.toThrow("boom");
  });
});
