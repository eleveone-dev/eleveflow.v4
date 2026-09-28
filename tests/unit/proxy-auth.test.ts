import { describe, it, expect } from "vitest";
import {
  resolveProxyInstance,
  ProxyAuthError,
} from "../../supabase/functions/_shared/whatsapp/proxy-auth";
import { createFakeClient } from "./helpers/fake-supabase";

const CONTA_A = "11111111-1111-1111-1111-111111111111";
const CONTA_B = "22222222-2222-2222-2222-222222222222";

const comConexoes = (rows: any[] = []) => createFakeClient({ whatsapp_connections: rows }) as any;

describe("resolveProxyInstance", () => {
  it("sem usuario autenticado recusa com 401", async () => {
    await expect(
      resolveProxyInstance({ client: comConexoes(), authUserId: null, isAdmin: false }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("sem conexao ainda, cai na convencao: a instancia e o proprio user_id", async () => {
    // Este e o caso do primeiro pareamento: a linha so nasce depois do QR.
    const instancia = await resolveProxyInstance({
      client: comConexoes(),
      authUserId: CONTA_A,
      isAdmin: false,
    });
    expect(instancia).toBe(CONTA_A);
  });

  it("com conexao gravada, respeita o instance_name armazenado", async () => {
    const instancia = await resolveProxyInstance({
      client: comConexoes([
        { tenant_id: CONTA_A, provider: "evolution", instance_name: "instancia-antiga" },
      ]),
      authUserId: CONTA_A,
      isAdmin: false,
    });
    expect(instancia).toBe("instancia-antiga");
  });

  it("usuario comum apontando para outra conta recusa com 403", async () => {
    await expect(
      resolveProxyInstance({
        client: comConexoes(),
        authUserId: CONTA_A,
        isAdmin: false,
        targetUserId: CONTA_B,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("usuario comum apontando para si mesmo e permitido", async () => {
    const instancia = await resolveProxyInstance({
      client: comConexoes(),
      authUserId: CONTA_A,
      isAdmin: false,
      targetUserId: CONTA_A,
    });
    expect(instancia).toBe(CONTA_A);
  });

  it("admin alcanca outra conta com targetUserId explicito", async () => {
    const instancia = await resolveProxyInstance({
      client: comConexoes([
        { tenant_id: CONTA_B, provider: "evolution", instance_name: "instancia-do-b" },
      ]),
      authUserId: CONTA_A,
      isAdmin: true,
      targetUserId: CONTA_B,
    });
    expect(instancia).toBe("instancia-do-b");
  });

  it("targetUserId que nao e string e ignorado, nao promove acesso", async () => {
    for (const lixo of [42, {}, [], true]) {
      const instancia = await resolveProxyInstance({
        client: comConexoes(),
        authUserId: CONTA_A,
        isAdmin: false,
        targetUserId: lixo,
      });
      expect(instancia).toBe(CONTA_A);
    }
  });

  it("conexao de outro provedor nao empresta instance_name", async () => {
    const instancia = await resolveProxyInstance({
      client: comConexoes([
        { tenant_id: CONTA_A, provider: "meta_cloud", instance_name: null, phone_number_id: "1" },
      ]),
      authUserId: CONTA_A,
      isAdmin: false,
    });
    expect(instancia).toBe(CONTA_A);
  });

  it("erro de banco sobe em vez de virar convencao silenciosa", async () => {
    const quebrado = createFakeClient(
      { whatsapp_connections: [] },
      { errors: { whatsapp_connections: { message: "connection reset" } } },
    ) as any;
    await expect(
      resolveProxyInstance({ client: quebrado, authUserId: CONTA_A, isAdmin: false }),
    ).rejects.toThrow("connection reset");
  });

  it("ProxyAuthError carrega o status", () => {
    const erro = new ProxyAuthError(403, "nao pode");
    expect(erro).toBeInstanceOf(Error);
    expect(erro.status).toBe(403);
  });
});
