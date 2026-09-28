// AES-256-GCM para segredos de integração (tokens Meta, App Secret).
// A chave vem por parâmetro: este módulo roda em Deno (edge) e Node/Vitest,
// então não lê Deno.env nem importa por URL. Nunca logar plaintext nem chave.

const VERSION = "v1";
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// O parâmetro de ArrayBuffer é explícito porque BufferSource (Web Crypto) não
// aceita Uint8Array<ArrayBufferLike>: ArrayBufferLike inclui SharedArrayBuffer.
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const trimmed = String(keyBase64 ?? "").trim();
  if (!trimmed) throw new Error("WHATSAPP_TOKEN_ENC_KEY is required");

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(trimmed);
  } catch {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY is not valid base64");
  }
  if (raw.length !== 32) {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY must decode to exactly 32 bytes");
  }

  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `${VERSION}:${toBase64(iv)}.${toBase64(ciphertext)}`;
}

export async function decryptSecret(payload: string, keyBase64: string): Promise<string> {
  const raw = String(payload ?? "");
  const separator = raw.indexOf(":");
  if (separator === -1 || raw.slice(0, separator) !== VERSION) {
    throw new Error("Unsupported encrypted payload version");
  }

  const [ivPart, ciphertextPart] = raw.slice(separator + 1).split(".");
  if (!ivPart || !ciphertextPart) throw new Error("Malformed encrypted payload");

  const key = await importKey(keyBase64);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivPart) },
      key,
      fromBase64(ciphertextPart),
    );
  } catch {
    // Erro genérico de propósito: distinguir chave errada de tag inválida
    // vazaria informação sobre o segredo.
    throw new Error("Encrypted payload failed authentication");
  }

  return new TextDecoder().decode(plain);
}
