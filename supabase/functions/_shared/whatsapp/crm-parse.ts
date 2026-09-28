// Regra de negócio de contato do CRM, independente de provedor: variantes de
// telefone brasileiro (DDI 55) e reconhecimento de opt-out de marketing.
// Movido de whatsapp-webhook para ser compartilhado e testável: roda em Deno
// (edge) e Node/Vitest.

/**
 * Gera as formas pelas quais o mesmo telefone pode estar gravado.
 *
 * Duas diferenças precisam ser cobertas, e a segunda custou uma mensagem
 * perdida em produção:
 *
 * 1. DDI: o número pode estar com ou sem o `55` na frente.
 * 2. Nono dígito: celulares brasileiros ganharam um `9` extra, mas a Meta
 *    normaliza removendo esse dígito no `from` do webhook. Um lead cadastrado
 *    como 5537998204766 nunca casaria com o 553798204766 que chega.
 */
export function phoneVariants(digits: string): string[] {
  if (!digits) return [];
  const out = new Set<string>([digits]);

  const local =
    digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
      ? digits.slice(2)
      : digits.length === 10 || digits.length === 11
        ? digits
        : null;

  if (local) {
    const ddd = local.slice(0, 2);
    const resto = local.slice(2);

    // 9 dígitos começando com 9 é celular com o nono dígito. 8 dígitos pode ser
    // celular antigo (inicia em 6–9) ou fixo (2–5); só o primeiro caso ganha o 9,
    // senão inventaríamos um número que não existe.
    const alternativo =
      resto.length === 9 && resto.startsWith("9")
        ? resto.slice(1)
        : resto.length === 8 && /^[6-9]/.test(resto)
          ? `9${resto}`
          : null;

    for (const numero of alternativo ? [resto, alternativo] : [resto]) {
      out.add(`${ddd}${numero}`);
      out.add(`55${ddd}${numero}`);
    }
  }

  return Array.from(out).filter(Boolean);
}

export function isMarketingOptOutMessage(text: string): boolean {
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  return [
    /^(pare|parar|stop)\b/,
    /^cancel(?:ar)?\b/,
    /^descadast(?:rar|re)[-\s]?me\b/,
    /^remova?[-\s]?me\b/,
    /\bnao\s+(?:quero|desejo)\s+(?:receber|mais receber|mensagens?)\b/,
    /\bnao\s+me\s+(?:mande|envie|contate)\b/,
  ].some((pattern) => pattern.test(normalized));
}
