// Seed idempotente do ambiente de STAGING para os testes e2e.
// Uso: SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<key> node scripts/seed-staging.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY legada)");
  process.exit(1);
}
const apiKeyFetch = async (input, init) => {
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  const headers = new Headers(inputHeaders);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set("apikey", key);
  if (headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
  return fetch(input, { ...init, headers });
};
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: apiKeyFetch },
});

const EMAIL = "e2e@eleveflow.test";
const PASSWORD = "e2e-password-123";
const LEAD_PHONE = "5511999990000";

const { data: existing, error: listErr } = await admin.auth.admin.listUsers();
if (listErr) throw listErr;
let user = existing?.users?.find((u) => u.email === EMAIL);
if (!user) {
  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  user = data.user;
  console.log("Usuário e2e criado:", user.id);
} else {
  console.log("Usuário e2e já existe:", user.id);
}

const { error: accErr } = await admin.from("accounts").upsert(
  {
    user_id: user.id,
    name: "Conta E2E",
    email: EMAIL,
    onboarding_completed: true,
  },
  { onConflict: "user_id" },
);
if (accErr) throw accErr;

async function ensure(table, match, row) {
  const q = admin.from(table).select("*");
  for (const [k, v] of Object.entries(match)) q.eq(k, v);
  const { data: found, error: selErr } = await q.limit(1).maybeSingle();
  if (selErr) throw selErr;
  if (found) return found;
  const { data: created, error: insErr } = await admin.from(table).insert(row).select().single();
  if (insErr) throw insErr;
  return created;
}

const stage = await ensure(
  "pipeline_stages",
  { user_id: user.id, name: "Novo" },
  { user_id: user.id, name: "Novo", position: 0 },
);
console.log("Stage seed:", stage.id);

const lead = await ensure(
  "leads",
  { user_id: user.id, phone: LEAD_PHONE },
  {
    user_id: user.id,
    name: "Lead E2E",
    phone: LEAD_PHONE,
    stage_id: stage.id,
    marketing_consent_status: "not_required",
  },
);
console.log("Lead seed:", lead.id);
console.log("Seed concluído.");
