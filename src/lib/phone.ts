/** Normaliza um número para 55 + DDD + número, sem fazer nenhum envio. */
export const normalizeBrazilPhone = (phone: string | number): string => {
  if (!phone) return "";
  let cleaned = String(phone).replace(/\D/g, "");
  if (!cleaned) return "";
  if (!cleaned.startsWith("55") && (cleaned.length === 10 || cleaned.length === 11)) {
    cleaned = `55${cleaned}`;
  }
  return cleaned;
};
