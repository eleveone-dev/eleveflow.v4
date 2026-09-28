import { describe, it, expect } from "vitest";
import {
  isSuperadmin,
  assertSuperadmin,
  generateWebhookVerifyToken,
} from "../../supabase/functions/_shared/platform-role";

describe("isSuperadmin", () => {
  it("verdadeiro só com app_metadata.platform_role === 'superadmin'", () => {
    expect(isSuperadmin({ app_metadata: { platform_role: "superadmin" } })).toBe(true);
  });

  it("ignora user_metadata (o cliente consegue escrever nele)", () => {
    expect(isSuperadmin({ user_metadata: { platform_role: "superadmin" } })).toBe(false);
  });

  it("falso para papel diferente, ausente, nulo ou objeto vazio", () => {
    expect(isSuperadmin({ app_metadata: { platform_role: "admin" } })).toBe(false);
    expect(isSuperadmin({ app_metadata: {} })).toBe(false);
    expect(isSuperadmin({})).toBe(false);
    expect(isSuperadmin(null)).toBe(false);
    expect(isSuperadmin(undefined)).toBe(false);
  });

  it("não aceita variação de caixa", () => {
    expect(isSuperadmin({ app_metadata: { platform_role: "SuperAdmin" } })).toBe(false);
  });
});

describe("assertSuperadmin", () => {
  it("não lança para superadmin", () => {
    expect(() => assertSuperadmin({ app_metadata: { platform_role: "superadmin" } })).not.toThrow();
  });

  it("lança 403 para qualquer outro", () => {
    expect(() => assertSuperadmin({ app_metadata: {} })).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
  });
});

describe("generateWebhookVerifyToken", () => {
  it("gera token hex de 64 caracteres, diferente a cada chamada", () => {
    const first = generateWebhookVerifyToken();
    const second = generateWebhookVerifyToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});
