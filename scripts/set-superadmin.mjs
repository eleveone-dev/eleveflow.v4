#!/usr/bin/env node
// Semeia app_metadata.platform_role = 'superadmin' num usuário existente.
// Uso: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/set-superadmin.mjs <email>
// Produção só com autorização explícita do dono.

import { createClient } from "@supabase/supabase-js";

const email = process.argv[2];
const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!email || !url || !secretKey) {
  console.error(
    "Uso: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/set-superadmin.mjs <email>",
  );
  process.exit(1);
}

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

const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
  app_metadata: { ...(user.app_metadata ?? {}), platform_role: "superadmin" },
});
if (updateError) {
  console.error("Falha ao atualizar:", updateError.message);
  process.exit(1);
}

console.log(`platform_role=superadmin aplicado em ${email} (${user.id}).`);
console.log("O usuário precisa renovar a sessão para o claim aparecer no token.");
