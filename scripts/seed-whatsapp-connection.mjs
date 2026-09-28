#!/usr/bin/env node
// Grava a conexão WhatsApp de um tenant — mas só depois que a Meta confirmar
// que o token é válido e que o Phone Number ID existe de verdade.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... WHATSAPP_TOKEN_ENC_KEY=... \
//   node scripts/seed-whatsapp-connection.mjs <email> <phone_number_id> <access_token> [waba_id]
//
// O token nunca é impresso. Os campos gravados (número visível, nome, qualidade)
// vêm da resposta da Meta, nunca de argumento — foi assim que dados inventados
// acabaram exibidos como se fossem reais.

import { createClient } from "@supabase/supabase-js";
import { webcrypto } from "node:crypto";

const [email, phoneNumberId, accessToken, wabaIdArg] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const encKey = process.env.WHATSAPP_TOKEN_ENC_KEY;
const graphVersion = process.env.META_GRAPH_API_VERSION || "v25.0";

if (!email || !phoneNumberId || !accessToken || !url || !secretKey || !encKey) {
  console.error(
    "Uso: SUPABASE_URL=... SUPABASE_SECRET_KEY=... WHATSAPP_TOKEN_ENC_KEY=... " +
      "node scripts/seed-whatsapp-connection.mjs <email> <phone_number_id> <access_token> [waba_id]",
  );
  process.exit(1);
}

async function graphGet(path) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message ?? `Erro ${response.status} na Graph API`);
  }
  return data;
}

async function encryptSecret(plaintext, keyBase64) {
  const raw = Buffer.from(keyBase64.trim(), "base64");
  if (raw.length !== 32) throw new Error("WHATSAPP_TOKEN_ENC_KEY must decode to exactly 32 bytes");
  const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return `v1:${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;
}

// 1. o token precisa ser aceito pela Meta
const debug = await graphGet(`debug_token?input_token=${encodeURIComponent(accessToken)}`);
if (debug?.data?.is_valid !== true) {
  console.error("A Meta recusou este access token. Nada foi gravado.");
  process.exit(1);
}

const wabaId =
  wabaIdArg ||
  (debug.data.granular_scopes ?? [])
    .filter((entry) => entry?.scope === "whatsapp_business_management")
    .flatMap((entry) => entry?.target_ids ?? [])[0];

if (!wabaId) {
  console.error("O token não dá acesso a nenhuma WABA. Nada foi gravado.");
  process.exit(1);
}

// 2. o número precisa existir de fato
let phone;
try {
  phone = await graphGet(
    `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
  );
} catch (error) {
  console.error(`A Meta não reconheceu o Phone Number ID ${phoneNumberId}: ${error.message}`);
  process.exit(1);
}

// 3. só agora grava, com os dados que vieram da Meta
const admin = createClient(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: list, error: listError } = await admin.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
if (listError) {
  console.error("Falha ao listar usuários:", listError.message);
  process.exit(1);
}

const user = list.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`Usuário não encontrado: ${email}`);
  process.exit(1);
}

const subscribed = await graphGet(`${wabaId}/subscribed_apps`).catch(() => ({ data: [] }));
const webhookSubscribed = Array.isArray(subscribed?.data) && subscribed.data.length > 0;

const { error } = await admin.from("whatsapp_connections").upsert(
  {
    tenant_id: user.id,
    status: "connected",
    phone_number_id: String(phone.id ?? phoneNumberId),
    waba_id: String(wabaId),
    display_phone_number: phone.display_phone_number ?? null,
    display_name: phone.verified_name ?? null,
    quality_rating: phone.quality_rating ?? null,
    access_token_encrypted: await encryptSecret(accessToken, encKey),
    webhook_subscribed_at: webhookSubscribed ? new Date().toISOString() : null,
    last_sync_at: new Date().toISOString(),
  },
  { onConflict: "tenant_id" },
);

if (error) {
  console.error("Falha ao gravar a conexão:", error.message);
  process.exit(1);
}

console.log(
  `Conexão gravada para ${email}: ${phone.display_phone_number ?? phoneNumberId} ` +
    `(Phone Number ID ${phone.id ?? phoneNumberId}, WABA ${wabaId}), ` +
    `webhook ${webhookSubscribed ? "inscrito" : "NÃO inscrito"}.`,
);
