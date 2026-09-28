// Cursor opaco da office-api: base64url de [instante, id]. O instante vai como o
// Postgres devolveu, com microssegundos: passar por Date perderia precisao e o
// cursor pularia ou repetiria linha.

import { HttpError } from "../http-error.ts";

export function codificarCursor(instante: string, id: string): string {
  return btoa(JSON.stringify([instante, id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodificarCursor(
  cursor: string,
  formatoId: RegExp,
): { instante: string; id: string } {
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const [instante, id] = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
    if (
      typeof instante === "string" &&
      !Number.isNaN(Date.parse(instante)) &&
      typeof id === "string" &&
      formatoId.test(id)
    ) {
      return { instante, id };
    }
  } catch {
    // cai no 400 abaixo
  }
  throw new HttpError(400, "cursor invalido");
}
