// HMAC e comparação de tempo constante compartilhados por webhooks.
// Roda em Deno (edge) e Node/Vitest: sem APIs Deno nem import por URL.

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let difference = aBytes.length ^ bBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }

  return difference === 0;
}

export async function sha256Hex(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
