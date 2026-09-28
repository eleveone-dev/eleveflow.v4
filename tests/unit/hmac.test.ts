import { describe, it, expect } from "vitest";
import { hmacSha256Hex, constantTimeEqual, sha256Hex } from "../../supabase/functions/_shared/hmac";

describe("hmacSha256Hex", () => {
  it("gera o HMAC-SHA256 hex conhecido para 'key'/'The quick brown fox jumps over the lazy dog'", async () => {
    const hex = await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
    expect(hex).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("é sensível a mudança de um byte do payload", async () => {
    const a = await hmacSha256Hex("s", "payload");
    const b = await hmacSha256Hex("s", "payloae");
    expect(a).not.toBe(b);
  });
});

describe("constantTimeEqual", () => {
  it("verdadeiro para strings iguais", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("falso para tamanhos diferentes", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("falso para mesmo tamanho e conteúdo diferente", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("gera o SHA-256 hex conhecido de 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
