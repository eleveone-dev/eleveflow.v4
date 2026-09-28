import { describe, it, expect } from "vitest";
import {
  phoneVariants,
  isMarketingOptOutMessage,
} from "../../supabase/functions/_shared/whatsapp/crm-parse";

describe("phoneVariants", () => {
  it("13 dígitos com 55 gera variante sem DDI", () => {
    expect(phoneVariants("5511999998888")).toEqual(
      expect.arrayContaining(["5511999998888", "11999998888"]),
    );
  });

  it("12 dígitos com 55 gera variante sem DDI", () => {
    expect(phoneVariants("551199999888")).toEqual(
      expect.arrayContaining(["551199999888", "1199999888"]),
    );
  });

  it("11 dígitos gera variante com 55", () => {
    expect(phoneVariants("11999998888")).toEqual(
      expect.arrayContaining(["11999998888", "5511999998888"]),
    );
  });

  it("10 dígitos gera variante com 55", () => {
    expect(phoneVariants("1199999888")).toEqual(
      expect.arrayContaining(["1199999888", "551199999888"]),
    );
  });

  it("fora das faixas conhecidas devolve só o próprio número", () => {
    expect(phoneVariants("123456789")).toEqual(["123456789"]);
  });

  it("string vazia gera lista vazia", () => {
    expect(phoneVariants("")).toEqual([]);
  });

  // A Meta normaliza celular brasileiro removendo o nono dígito: um lead
  // cadastrado com 13 dígitos precisa casar com o que o webhook entrega.
  it("celular com 9 gera a variante sem o nono dígito", () => {
    expect(phoneVariants("5537998204766")).toContain("553798204766");
  });

  it("celular sem 9 gera a variante com o nono dígito", () => {
    expect(phoneVariants("553798204766")).toContain("5537998204766");
  });

  it("variantes sem DDI também cobrem o nono dígito", () => {
    const variantes = phoneVariants("5537998204766");
    expect(variantes).toContain("37998204766");
    expect(variantes).toContain("3798204766");
  });

  it("fixo de 8 dígitos não ganha nono dígito indevido", () => {
    // 55 + DDD + 8 dígitos é fixo; inserir 9 aqui criaria um número inexistente.
    const variantes = phoneVariants("553733334444");
    expect(variantes).not.toContain("5537933334444");
  });

  it("não gera duplicatas", () => {
    const variantes = phoneVariants("5537998204766");
    expect(new Set(variantes).size).toBe(variantes.length);
  });
});

describe("isMarketingOptOutMessage", () => {
  it.each([
    "PARE",
    "parar",
    "stop agora",
    "cancelar",
    "descadastre-me",
    "remova me",
    "não quero receber",
    "nao me mande mais",
  ])("reconhece opt-out em %s", (text) => {
    expect(isMarketingOptOutMessage(text)).toBe(true);
  });

  it.each(["quero comprar", "pode parar de chover?", "ok"])(
    "não confunde %s com opt-out",
    (text) => {
      expect(isMarketingOptOutMessage(text)).toBe(false);
    },
  );
});
