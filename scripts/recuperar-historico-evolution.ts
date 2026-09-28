// Recupera o historico da Evolution que casa com lead, uma vez.
//
//   set -a; source .env.staging; set +a
//   NODE_EXTRA_CA_CERTS=.avast-ca.pem node --experimental-strip-types \
//     scripts/recuperar-historico-evolution.ts --conta <user_id> [--aplicar]
//
// Sem --aplicar e ensaio: so contagens. Le a Evolution por SSH (Host hostinger),
// dentro do container, e so a instancia da conta. Nunca imprime texto nem telefone.

import { spawnSync } from "node:child_process";
import { clienteAdmin } from "./lib/cliente-admin.ts";
import {
  chaveTelefone,
  planejarImportacao,
  telefoneDoRegistro,
  type RegistroEvolution,
} from "./lib/historico-evolution.ts";

const args = process.argv.slice(2);
const conta = args[args.indexOf("--conta") + 1];
const aplicar = args.includes("--aplicar");
if (!conta || !/^[0-9a-f-]{36}$/.test(conta)) throw new Error("--conta <user_id> obrigatorio");

const admin = clienteAdmin();

async function todas<T>(
  consulta: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const linhas: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await consulta(de, de + 999);
    if (error) throw error;
    linhas.push(...(data ?? []));
    if (!data || data.length < 1000) return linhas;
  }
}

const { data: conexao, error: erroConexao } = await admin
  .from("whatsapp_connections")
  .select("instance_name, provider")
  .eq("tenant_id", conta)
  .single();
if (erroConexao) throw erroConexao;
// Convencao do sistema: instancia = user_id. Qualquer outra coisa (a Atual, por
// exemplo) nao e nossa.
if (conexao.provider !== "evolution" || conexao.instance_name !== conta) {
  throw new Error("instancia da conta fora da convencao instance_name = user_id");
}

const leads = await todas<{ id: string; phone: string; phone_normalized: string | null }>(
  (de, ate) =>
    admin
      .from("leads")
      .select("id, phone, phone_normalized")
      .eq("user_id", conta)
      .not("is_test", "is", true)
      .range(de, ate),
);
const porChave = new Map<string, string>();
const ambiguas = new Set<string>();
for (const lead of leads) {
  const k = chaveTelefone(lead.phone_normalized || lead.phone);
  if (porChave.has(k)) ambiguas.add(k);
  porChave.set(k, lead.id);
}
for (const k of ambiguas) porChave.delete(k);

const programa = `
const telefoneDoRegistro = ${telefoneDoRegistro.toString()};
const chaveTelefone = ${chaveTelefone.toString()};
const chaves = new Set(${JSON.stringify([...porChave.keys()])});
(async () => {
  const inst = ${JSON.stringify(conta)};
  if (inst === "Atual") throw new Error("instancia proibida");
  const headers = { apikey: process.env.AUTHENTICATION_API_KEY, "Content-Type": "application/json" };
  for (const fromMe of [true, false]) {
    for (let page = 1; page <= 200; page++) {
      const r = await fetch("http://localhost:8080/chat/findMessages/" + inst, {
        method: "POST", headers,
        body: JSON.stringify({ where: { key: { fromMe } }, page, offset: 500 }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const p = (await r.json()).messages;
      for (const m of p.records ?? []) {
        if (!chaves.has(chaveTelefone(telefoneDoRegistro(m.key ?? {})))) continue;
        console.log(JSON.stringify({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp, source: m.source }));
      }
      if (!p.pages || page >= p.pages) break;
    }
  }
})().catch((e) => { console.error("erro: " + e.message); process.exit(1); });
`;

const container = spawnSync(
  "ssh",
  [
    "-o",
    "BatchMode=yes",
    "hostinger",
    "docker ps --filter name=evolutionapi_evolution-api --format '{{.Names}}' | head -1",
  ],
  { encoding: "utf8" },
).stdout.trim();
if (!container) throw new Error("container da Evolution nao encontrado");

const extracao = spawnSync(
  "ssh",
  ["-o", "BatchMode=yes", "hostinger", `docker exec -i ${container} node -`],
  { input: programa, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
);
if (extracao.status !== 0) throw new Error(`extracao falhou: ${extracao.stderr.slice(0, 200)}`);
const registros: RegistroEvolution[] = extracao.stdout
  .split("\n")
  .filter(Boolean)
  .map((linha) => JSON.parse(linha));

const wamids = await todas<{ whatsapp_id: string }>((de, ate) =>
  admin
    .from("messages")
    .select("whatsapp_id")
    .eq("user_id", conta)
    .not("whatsapp_id", "is", null)
    .range(de, ate),
);
const plano = planejarImportacao(
  registros,
  porChave,
  new Set(wamids.map((w) => w.whatsapp_id)),
  conta,
);

const porTipo: Record<string, number> = {};
for (const linha of plano.inserir) {
  const k = `${linha.direction}${linha.origin ? "/" + linha.origin : ""}/${linha.media_type ?? "texto"}`;
  porTipo[k] = (porTipo[k] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      modo: aplicar ? "aplicar" : "ensaio",
      leads: leads.length,
      telefones_ambiguos: ambiguas.size,
      registros_de_leads: registros.length,
      a_inserir: plano.inserir.length,
      por_tipo: porTipo,
      fora: plano.contagem,
    },
    null,
    2,
  ),
);

if (aplicar) {
  let inseridas = 0;
  for (let i = 0; i < plano.inserir.length; i += 200) {
    const lote = plano.inserir.slice(i, i + 200);
    const { error } = await admin.from("messages").insert(lote);
    if (error) throw error;
    inseridas += lote.length;
  }
  console.log(`inseridas: ${inseridas}`);
}
