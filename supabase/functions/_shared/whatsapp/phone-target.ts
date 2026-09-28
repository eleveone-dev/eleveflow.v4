// Decide se um lead tem telefone que o WhatsApp consegue receber.
//
// Existe porque o provedor recusa numero de fixo com `Bad Request` depois de o
// item ja estar na fila: o erro aparece como falha de envio, quando o problema e
// o cadastro. Barrar antes de enfileirar troca uma falha silenciosa por um motivo
// escrito no log.
//
// A regra do nono digito e a mesma de `phoneVariants` em `crm-parse.ts`:
// assinante de 8 digitos comecando em 6–9 e celular no formato antigo e ganha o
// 9; comecando em 2–5 e fixo. Inverter isso inventaria numero que nao existe.
//
// Quem decide e a forma do numero, nao a flag do lead. `leads.has_whatsapp` e
// `leads.phone_valid` tem DEFAULT false no banco: tratar false como "nao tem
// WhatsApp" barrava todo lead criado sem preencher a flag. E as flags dos leads
// migrados vem erradas na outra direcao — fixo marcado como WhatsApp.
//
// As flags continuam servindo para a tela avisar, porque este modulo as corrige
// quando recusa; mas nao entram na decisao.
//
// Deno-free: o Vitest importa este arquivo em Node.

export type PhoneKind = "mobile" | "legacy_mobile" | "landline" | "unusable" | "unknown";

export interface PhoneClassification {
  kind: PhoneKind;
  digits: string;
  /** Forma com o nono digito, só para `legacy_mobile`. */
  withNinthDigit?: string;
}

export type WhatsAppTarget = { ok: true } | { ok: false; reason: "landline" | "unusable_phone" };

export function classifyPhone(value: unknown): PhoneClassification {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return { kind: "unusable", digits };

  // Local = DDD + assinante, sem o DDI 55.
  const local =
    digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
      ? digits.slice(2)
      : digits.length === 10 || digits.length === 11
        ? digits
        : null;

  if (local === null) return { kind: digits.length < 10 ? "unusable" : "unknown", digits };

  const assinante = local.slice(2);

  if (assinante.length === 9 && assinante.startsWith("9")) return { kind: "mobile", digits };
  if (assinante.length === 8 && /^[6-9]/.test(assinante)) {
    const ddd = local.slice(0, 2);
    return { kind: "legacy_mobile", digits, withNinthDigit: `55${ddd}9${assinante}` };
  }
  if (assinante.length === 8) return { kind: "landline", digits };
  return { kind: "unknown", digits };
}

/**
 * O campo `whatsapp` vence o `phone` quando existe: e o numero que o operador
 * confirmou como WhatsApp.
 */
/**
 * Numero que o provedor deve receber: com DDI 55 e, no celular de formato antigo,
 * com o nono digito.
 *
 * O WhatsApp brasileiro exige o nono digito desde 2016. Os leads migrados do
 * sistema antigo guardaram 442 numeros no formato de 8 digitos; enviar como esta
 * cadastrado faz o provedor recusar. Fixo sai como esta — nao se inventa numero:
 * quem recusa fixo e o `canReceiveWhatsApp`, antes de enfileirar.
 */
export function whatsAppSendPhone(raw: unknown): string {
  const classificacao = classifyPhone(raw);
  if (classificacao.kind === "unusable") return "";
  if (classificacao.kind === "legacy_mobile") return classificacao.withNinthDigit ?? "";

  const digitos = classificacao.digits;
  if ((digitos.length === 10 || digitos.length === 11) && !digitos.startsWith("55")) {
    return `55${digitos}`;
  }
  return digitos;
}

export function canReceiveWhatsApp(lead: unknown): WhatsAppTarget {
  const l = (lead ?? {}) as Record<string, unknown>;
  const candidato = String(l.whatsapp ?? "").trim() || String(l.phone ?? "").trim();
  const { kind } = classifyPhone(candidato);

  if (kind === "landline") return { ok: false, reason: "landline" };
  if (kind === "unusable") return { ok: false, reason: "unusable_phone" };
  return { ok: true };
}
