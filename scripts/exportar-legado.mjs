#!/usr/bin/env node
// Exporta as linhas de UM usuário do projeto legado (Lovable, `aoanp…`) usando a
// sessão dele próprio.
//
// Por que assim: o projeto legado não é do time e não temos service key dele. O
// que temos é a chave publicável (no `.env`) e, com o login do dono da conta, um
// token de usuário — que a RLS já limita às linhas dele. Nenhuma credencial
// entra neste arquivo nem na linha de comando: vêm de `.env.legado`, que o
// `.gitignore` cobre por `.env.*`.
//
// Uso:
//   1) criar `.env.legado` com:
//        LEGADO_EMAIL=...
//        LEGADO_PASSWORD=...
//   2) node scripts/exportar-legado.mjs
//
// Saída: `migracao-<AAAA-MM-DD>/<tabela>.json`, mais um `resumo.json` com as
// contagens. Dado de cliente: o diretório é ignorado pelo git (`migracao*/`).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const TABELAS = [
  "leads",
  "pipeline_stages",
  "flows",
  "flow_blocks",
  "messages",
  "flow_executions",
  "send_queue",
  "personal_tasks",
  "objections",
  "extraction_history",
  "logs",
];

const PAGINA = 1000;

function lerEnv(caminho) {
  if (!existsSync(caminho)) return {};
  const out = {};
  for (const linha of readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const base = lerEnv(".env");
const legado = lerEnv(".env.legado");

const url = (base.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const apikey = base.VITE_SUPABASE_PUBLISHABLE_KEY || base.SUPABASE_PUBLISHABLE_KEY;
const email = legado.LEGADO_EMAIL;
const senha = legado.LEGADO_PASSWORD;

if (!url || !apikey) {
  console.error("Falta VITE_SUPABASE_URL ou VITE_SUPABASE_PUBLISHABLE_KEY no .env");
  process.exit(1);
}
if (!email || !senha) {
  console.error("Falta LEGADO_EMAIL ou LEGADO_PASSWORD no .env legado (.env.legado)");
  process.exit(1);
}

console.log(`Projeto legado: ${url}`);
console.log(`Conta: ${email}`);

const entrar = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: senha }),
});
const sessao = await entrar.json();
if (!entrar.ok || !sessao.access_token) {
  console.error(`Login recusado (${entrar.status}): ${sessao.msg || sessao.error_description || JSON.stringify(sessao)}`);
  process.exit(1);
}
const token = sessao.access_token;
const userId = sessao.user?.id;
console.log(`Login OK. user_id no legado: ${userId}`);

const dir = `migracao-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(dir, { recursive: true });

const resumo = { exportado_em: new Date().toISOString(), projeto: url, user_id: userId, tabelas: {} };

for (const tabela of TABELAS) {
  const linhas = [];
  let de = 0;
  let status = 200;

  // Paginação explícita: o PostgREST corta em 1000 por resposta, e silenciosamente
  // — sem isto o export parece completo e não está.
  for (;;) {
    const r = await fetch(`${url}/rest/v1/${tabela}?select=*&order=id.asc&offset=${de}&limit=${PAGINA}`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
    status = r.status;
    if (!r.ok) break;
    const lote = await r.json();
    linhas.push(...lote);
    if (lote.length < PAGINA) break;
    de += PAGINA;
  }

  if (status !== 200) {
    console.log(`  ${tabela.padEnd(20)} HTTP ${status} — pulada`);
    resumo.tabelas[tabela] = { erro: status };
    continue;
  }

  writeFileSync(`${dir}/${tabela}.json`, JSON.stringify(linhas, null, 1));
  console.log(`  ${tabela.padEnd(20)} ${linhas.length} linhas`);
  resumo.tabelas[tabela] = { linhas: linhas.length };
}

writeFileSync(`${dir}/resumo.json`, JSON.stringify(resumo, null, 2));
console.log(`\nExportado em ${dir}/ — nenhuma credencial foi gravada junto.`);
