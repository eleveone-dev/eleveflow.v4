// Cria ou importa um token de API com escopo.
//
//   set -a; source .env.staging; set +a
//   NODE_EXTRA_CA_CERTS=.avast-ca.pem node --experimental-strip-types scripts/criar-token-api.ts \
//     --conta <user_id> --rotulo "Eleve Office" --escopos comercial:leitura \
//     [--limite 120] [--env NOME_DA_VARIAVEL | --importar-hash <sha256 hex>]
//
// Sem --env e sem --importar-hash, o token aparece uma vez na saida e em nenhum
// outro lugar: no banco fica so o hash. Com --env, o texto vai para o
// .env.staging (tokens de E2E) e a saida mostra so id e hash. Com
// --importar-hash, grava o hash de um token que ja existe, sem gerar outro.

import { appendFileSync, readFileSync } from "node:fs";
import { clienteAdmin } from "./lib/cliente-admin.ts";
import { gerarToken, lerEscopos } from "./lib/token-api.ts";

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const conta = argumento("--conta");
const rotulo = argumento("--rotulo");
const escopos = lerEscopos(argumento("--escopos") ?? "");
const limite = Number(argumento("--limite") ?? 120);
const variavel = argumento("--env");
const hashImportado = argumento("--importar-hash");

if (!conta || !/^[0-9a-f-]{36}$/.test(conta)) throw new Error("--conta <user_id> obrigatorio");
if (!rotulo) throw new Error("--rotulo obrigatorio");
if (!Number.isInteger(limite) || limite < 1) throw new Error("--limite deve ser inteiro positivo");
if (variavel && hashImportado) throw new Error("--env e --importar-hash nao andam juntos");
if (hashImportado && !/^[0-9a-f]{64}$/.test(hashImportado)) {
  throw new Error("--importar-hash deve ser SHA-256 hex");
}

const envAtual = variavel ? readFileSync(".env.staging", "utf8") : "";
if (variavel && new RegExp(`^${variavel}=`, "m").test(envAtual)) {
  throw new Error(`${variavel} ja existe no .env.staging`);
}

const novo = hashImportado ? null : await gerarToken();
const hash = hashImportado ?? novo!.hash;

const { data, error } = await clienteAdmin()
  .from("api_tokens")
  .insert({
    user_id: conta,
    label: rotulo,
    token_hash: hash,
    scopes: escopos,
    rate_limit_per_minute: limite,
  })
  .select("id")
  .single();
if (error) throw error;

if (variavel) {
  appendFileSync(
    ".env.staging",
    (envAtual.endsWith("\n") ? "" : "\n") + `${variavel}=${novo!.token}\n`,
  );
  console.log(JSON.stringify({ id: data.id, hash, env: variavel }));
} else if (novo) {
  console.log(JSON.stringify({ id: data.id, hash }));
  console.log(`token (mostrado uma vez): ${novo.token}`);
} else {
  console.log(JSON.stringify({ id: data.id, hash, importado: true }));
}
