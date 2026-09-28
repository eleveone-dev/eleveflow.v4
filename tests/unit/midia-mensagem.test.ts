import { describe, it, expect } from "vitest";
import { previaMensagem, rotuloMidia } from "../../src/lib/midia-mensagem";

describe("rotuloMidia", () => {
  it("texto nao tem rotulo", () => {
    expect(rotuloMidia(null)).toBeNull();
    expect(rotuloMidia(undefined)).toBeNull();
  });

  it("audio avisa que nao foi transcrito", () => {
    expect(rotuloMidia("audio")).toBe("Áudio · não transcrito");
  });

  it("cada tipo tem nome proprio e o desconhecido vira Mídia", () => {
    expect(rotuloMidia("image")).toBe("Imagem");
    expect(rotuloMidia("sticker")).toBe("Figurinha");
    expect(rotuloMidia("location")).toBe("Localização");
    expect(rotuloMidia("tipo-novo")).toBe("Mídia");
  });
});

describe("previaMensagem", () => {
  it("texto passa como esta", () => {
    expect(previaMensagem("oi, tudo bem?", null)).toBe("oi, tudo bem?");
  });

  it("midia sem legenda mostra so o rotulo", () => {
    expect(previaMensagem("", "audio")).toBe("Áudio · não transcrito");
  });

  it("midia com legenda junta rotulo e legenda", () => {
    expect(previaMensagem("fachada nova", "image")).toBe("Imagem: fachada nova");
  });
});
