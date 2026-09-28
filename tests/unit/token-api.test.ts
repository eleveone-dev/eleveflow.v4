import { describe, it, expect } from "vitest";
import { gerarToken, lerEscopos } from "../../scripts/lib/token-api";
import { sha256Hex } from "../../supabase/functions/_shared/hmac";

describe("gerarToken", () => {
  it("token efsc_ de 48 caracteres com o hash dele", async () => {
    const { token, hash } = await gerarToken();
    expect(token).toMatch(/^efsc_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(await sha256Hex(token));
  });

  it("dois tokens nunca se repetem", async () => {
    expect((await gerarToken()).token).not.toBe((await gerarToken()).token);
  });
});

describe("lerEscopos", () => {
  it("aceita os escopos conhecidos", () => {
    expect(lerEscopos("comercial:leitura,tarefas:leitura")).toEqual([
      "comercial:leitura",
      "tarefas:leitura",
    ]);
  });

  it("recusa escopo desconhecido ou vazio", () => {
    expect(() => lerEscopos("tudo")).toThrow(/escopo/);
    expect(() => lerEscopos("")).toThrow(/escopo/);
  });
});
