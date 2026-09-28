import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../../supabase/functions/_shared/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("crypto", () => {
  it("round-trip devolve o texto original", async () => {
    const payload = await encryptSecret("EAAJB-token-secreto", KEY);
    expect(await decryptSecret(payload, KEY)).toBe("EAAJB-token-secreto");
  });

  it("payload é versionado e não contém o plaintext", async () => {
    const payload = await encryptSecret("EAAJB-token-secreto", KEY);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(payload).not.toContain("EAAJB-token-secreto");
  });

  it("duas cifragens do mesmo texto diferem (IV aleatório)", async () => {
    const a = await encryptSecret("mesmo", KEY);
    const b = await encryptSecret("mesmo", KEY);
    expect(a).not.toBe(b);
  });

  it("adulteração do ciphertext é detectada", async () => {
    const payload = await encryptSecret("token", KEY);
    const [head, tail] = payload.split(".");
    const flipped = tail[0] === "A" ? "B" + tail.slice(1) : "A" + tail.slice(1);
    await expect(decryptSecret(`${head}.${flipped}`, KEY)).rejects.toThrow(
      "Encrypted payload failed authentication",
    );
  });

  it("chave errada não decifra", async () => {
    const payload = await encryptSecret("token", KEY);
    await expect(decryptSecret(payload, OTHER_KEY)).rejects.toThrow(
      "Encrypted payload failed authentication",
    );
  });

  it("chave com tamanho inválido falha com erro claro", async () => {
    await expect(encryptSecret("x", btoa("curta"))).rejects.toThrow(
      "WHATSAPP_TOKEN_ENC_KEY must decode to exactly 32 bytes",
    );
  });

  it("chave ausente falha com erro claro", async () => {
    await expect(encryptSecret("x", "")).rejects.toThrow("WHATSAPP_TOKEN_ENC_KEY is required");
  });

  it("versão desconhecida é rejeitada", async () => {
    await expect(decryptSecret("v2:aaa.bbb", KEY)).rejects.toThrow(
      "Unsupported encrypted payload version",
    );
  });

  it("payload malformado é rejeitado", async () => {
    await expect(decryptSecret("v1:semponto", KEY)).rejects.toThrow("Malformed encrypted payload");
  });
});
