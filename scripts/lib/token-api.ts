import { sha256Hex } from "../../supabase/functions/_shared/hmac.ts";

const ESCOPOS = ["comercial:leitura", "tarefas:leitura", "tarefas:escrita"];

export async function gerarToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    "efsc_" +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return { token, hash: await sha256Hex(token) };
}

export function lerEscopos(texto: string): string[] {
  const escopos = texto
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const invalidos = escopos.filter((e) => !ESCOPOS.includes(e));
  if (escopos.length === 0 || invalidos.length) {
    throw new Error(
      `escopo invalido: ${invalidos.join(", ") || "vazio"}; use ${ESCOPOS.join(", ")}`,
    );
  }
  return escopos;
}
