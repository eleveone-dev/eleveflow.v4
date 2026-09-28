import { describe, it, expect } from "vitest";
import {
  aplicarSpintax,
  primeiroNome,
  renderizarMensagem,
  saudacao,
} from "../../supabase/functions/_shared/message-humanize";

// Sorteio controlado: devolve os valores em ordem, para o teste saber qual opção
// cada grupo escolhe.
const sequencia = (...valores: number[]) => {
  let i = 0;
  return () => valores[i++ % valores.length];
};

describe("aplicarSpintax", () => {
  it("sorteia uma opção de cada grupo", () => {
    expect(aplicarSpintax("{Oi|Olá|Opa}, tudo bem?", sequencia(0))).toBe("Oi, tudo bem?");
    expect(aplicarSpintax("{Oi|Olá|Opa}, tudo bem?", sequencia(0.5))).toBe("Olá, tudo bem?");
    expect(aplicarSpintax("{Oi|Olá|Opa}, tudo bem?", sequencia(0.99))).toBe("Opa, tudo bem?");
  });

  it("resolve vários grupos na mesma mensagem", () => {
    expect(aplicarSpintax("{Oi|Olá}! {Tudo bem|Como vai}?", sequencia(0, 0.9))).toBe(
      "Oi! Como vai?",
    );
  });

  it("resolve grupo aninhado de dentro para fora", () => {
    expect(aplicarSpintax("{a|{b|c}}", sequencia(0.9, 0.9))).toBe("c");
  });

  it("chave sem barra não é spintax e fica intacta", () => {
    // Texto do cliente pode ter chave literal; só vira sorteio com `|` dentro.
    expect(aplicarSpintax("preço {promo}", sequencia(0))).toBe("preço {promo}");
  });
});

describe("saudacao", () => {
  it("segue o relógio de Brasília, não o do servidor", () => {
    // Servidor roda em UTC: 12:00Z é 09:00 em Brasília.
    expect(saudacao(new Date("2026-09-21T12:00:00Z"))).toBe("bom dia");
    expect(saudacao(new Date("2026-09-21T16:00:00Z"))).toBe("boa tarde");
    expect(saudacao(new Date("2026-09-21T22:00:00Z"))).toBe("boa noite");
  });

  it("vira a chave exatamente ao meio-dia e às 18h de Brasília", () => {
    expect(saudacao(new Date("2026-09-21T14:59:00Z"))).toBe("bom dia");
    expect(saudacao(new Date("2026-09-21T15:00:00Z"))).toBe("boa tarde");
    expect(saudacao(new Date("2026-09-21T21:00:00Z"))).toBe("boa noite");
  });
});

describe("primeiroNome", () => {
  it("pega só o primeiro nome", () => {
    expect(primeiroNome("Maria da Silva")).toBe("Maria");
    expect(primeiroNome("  João  ")).toBe("João");
  });

  it("sem nome devolve vazio, sem quebrar", () => {
    expect(primeiroNome("")).toBe("");
    expect(primeiroNome(null)).toBe("");
  });
});

describe("renderizarMensagem", () => {
  const lead = { name: "Maria da Silva", company: "Pet Feliz", phone: "5542999887766" };
  const noveHoras = new Date("2026-09-21T12:00:00Z");

  it("substitui as variáveis antes do sorteio, para o spintax não comer {{nome}}", () => {
    const texto = renderizarMensagem("{Oi|Olá} {{primeiro_nome}}, da {{empresa}}!", lead, {
      sortear: sequencia(0),
      agora: noveHoras,
    });
    expect(texto).toBe("Oi Maria, da Pet Feliz!");
  });

  it("saudação em minúscula e com inicial maiúscula", () => {
    expect(
      renderizarMensagem("{{Saudacao}}, {{nome}}. Tenha um {{saudacao}}!", lead, {
        agora: noveHoras,
      }),
    ).toBe("Bom dia, Maria da Silva. Tenha um bom dia!");
  });

  it("variável sem valor vira vazio, não fica o marcador cru", () => {
    expect(renderizarMensagem("Olá {{empresa}}", { name: "Ana" }, { agora: noveHoras })).toBe(
      "Olá ",
    );
  });
});
