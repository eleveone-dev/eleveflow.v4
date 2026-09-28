import { describe, it, expect } from "vitest";
import {
  canReceiveWhatsApp,
  classifyPhone,
  whatsAppSendPhone,
} from "../../supabase/functions/_shared/whatsapp/phone-target";

describe("classifyPhone", () => {
  it("celular com nono dígito é destino válido", () => {
    expect(classifyPhone("5542999887766").kind).toBe("mobile");
    expect(classifyPhone("42999887766").kind).toBe("mobile");
    expect(classifyPhone("(42) 99988-7766").kind).toBe("mobile");
  });

  it("assinante de 8 dígitos começando em 2 a 5 é fixo", () => {
    // Foi o numero que a Evolution recusou com Bad Request: 55 + 42 + 32315889.
    expect(classifyPhone("554232315889").kind).toBe("landline");
    expect(classifyPhone("4232315889").kind).toBe("landline");
    expect(classifyPhone("554225551234").kind).toBe("landline");
  });

  it("assinante de 8 dígitos começando em 6 a 9 é celular no formato antigo", () => {
    // Regra da casa, igual a de `phoneVariants`: so este caso ganha o nono
    // digito, senao inventariamos um numero que nao existe.
    expect(classifyPhone("554298887766").kind).toBe("legacy_mobile");
    expect(classifyPhone("554298887766").withNinthDigit).toBe("5542998887766");
  });

  it("sem DDD ou curto demais é inutilizável", () => {
    expect(classifyPhone("32315889").kind).toBe("unusable");
    expect(classifyPhone("").kind).toBe("unusable");
    expect(classifyPhone(null).kind).toBe("unusable");
    expect(classifyPhone("123").kind).toBe("unusable");
  });

  it("número internacional fora do Brasil não é classificado como fixo", () => {
    // 14 digitos nao casa com nenhum formato brasileiro; recusar como fixo seria
    // afirmar algo que nao sabemos.
    expect(classifyPhone("12025550123456").kind).toBe("unknown");
  });
});

describe("canReceiveWhatsApp", () => {
  const lead = (extra: Record<string, unknown> = {}) => ({
    phone: "5542999887766",
    ...extra,
  });

  it("celular passa", () => {
    expect(canReceiveWhatsApp(lead())).toEqual({ ok: true });
  });

  it("prefere o campo whatsapp quando existe", () => {
    const r = canReceiveWhatsApp({ phone: "554232315889", whatsapp: "5542999887766" });
    expect(r).toEqual({ ok: true });
  });

  it("fixo é recusado com motivo", () => {
    expect(canReceiveWhatsApp(lead({ phone: "554232315889" }))).toEqual({
      ok: false,
      reason: "landline",
    });
  });

  it("sem telefone utilizável é recusado", () => {
    expect(canReceiveWhatsApp(lead({ phone: "" }))).toEqual({
      ok: false,
      reason: "unusable_phone",
    });
  });

  it("flag do lead não decide: `false` é o padrão do banco, não evidência", () => {
    // `leads.has_whatsapp` e `leads.phone_valid` têm DEFAULT false. Tratar false
    // como "não tem WhatsApp" barrava todo lead criado sem preencher a flag —
    // inclusive os do seed e os criados por integração. Quem decide é a forma do
    // número, que é o que o provedor recusa.
    expect(canReceiveWhatsApp(lead({ has_whatsapp: false }))).toEqual({ ok: true });
    expect(canReceiveWhatsApp(lead({ phone_valid: false }))).toEqual({ ok: true });
    expect(canReceiveWhatsApp(lead({ has_whatsapp: null, phone_valid: null }))).toEqual({
      ok: true,
    });
  });

  it("fixo continua recusado mesmo marcado como WhatsApp", () => {
    // Foi o caso real: os leads migrados de 12 dígitos vieram todos com
    // has_whatsapp = true, e o fixo entre eles falhou no envio.
    expect(canReceiveWhatsApp({ phone: "554232315889", has_whatsapp: true })).toEqual({
      ok: false,
      reason: "landline",
    });
  });

  it("celular no formato antigo passa, porque pode ser corrigido no envio", () => {
    expect(canReceiveWhatsApp(lead({ phone: "554298887766" }))).toEqual({ ok: true });
  });
});

describe("whatsAppSendPhone", () => {
  it("celular com nono dígito só ganha o DDI", () => {
    expect(whatsAppSendPhone("5542999887766")).toBe("5542999887766");
    expect(whatsAppSendPhone("42999887766")).toBe("5542999887766");
    expect(whatsAppSendPhone("(42) 99988-7766")).toBe("5542999887766");
  });

  it("celular no formato antigo ganha o nono dígito", () => {
    // O WhatsApp brasileiro exige o nono dígito. 442 leads da base migrada estão
    // no formato de 8 dígitos e falhariam no envio sem esta correção.
    expect(whatsAppSendPhone("554298887766")).toBe("5542998887766");
    expect(whatsAppSendPhone("4298887766")).toBe("5542998887766");
  });

  it("fixo não é inventado: sai como está, e o portão é quem recusa", () => {
    expect(whatsAppSendPhone("554232315889")).toBe("554232315889");
  });

  it("sem número utilizável devolve vazio", () => {
    expect(whatsAppSendPhone("")).toBe("");
    expect(whatsAppSendPhone(null)).toBe("");
    expect(whatsAppSendPhone("123")).toBe("");
  });

  it("número fora do padrão brasileiro não ganha DDI", () => {
    expect(whatsAppSendPhone("12025550123456")).toBe("12025550123456");
  });
});
