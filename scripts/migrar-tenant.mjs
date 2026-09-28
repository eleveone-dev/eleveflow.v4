#!/usr/bin/env node
// Migra UMA conta do backup do projeto legado (pg_dump custom) para o xlycu,
// gerando arquivos SQL numerados. Nao fala com banco nenhum: quem aplica e o
// `supabase db query --linked -f`, um arquivo por vez, parando no primeiro erro.
//
// Uso:
//   node scripts/migrar-tenant.mjs \
//     --dump <arquivo.backup> --de <user_id legado> --para <user_id no xlycu> \
//     --colunas <colunas.json> --saida <diretorio FORA do repositorio>
//
// `--colunas` e a saida JSON de:
//   select table_name, array_agg(column_name order by ordinal_position) as cols
//   from information_schema.columns where table_schema = 'public'
//   and table_name in ('pipeline_stages','flows','flow_blocks','leads','messages','personal_tasks')
//   group by table_name
//
// O que NAO e migrado, de proposito:
//   - send_queue: item pendente importado dispara mensagem velha assim que a
//     conta parear o WhatsApp. O conteudo enviado ja esta em `messages`.
//   - flow_executions: o cron retoma execucao em espera e enfileiraria envio.
//   - logs: ruido operacional do sistema antigo.
//
// O que e transformado, e por que:
//   - fluxos entram com is_active = false. O trigger de estagio so dispara fluxo
//     ativo; sem isso, cada lead importado num estagio com gatilho viraria envio.
//   - estado de execucao do lead e zerado (active_flow_id, active_flow_step,
//     flow_waiting_reply): nao ha execucao migrada para ele retomar.
//   - opted_out do legado vira consentimento `withdrawn` e supressao. Perder
//     isso faria o sistema novo voltar a mandar marketing para quem recusou.
//   - phone_invalid vira supressao com motivo `phone_invalid`.
//   - os estagios padrao que o cadastro criou na conta nova saem, se nada os
//     referenciar: o funil fica igual ao do sistema antigo, sem duplicata.
//
// Idempotente: todo INSERT e ON CONFLICT (id) DO NOTHING.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { openArchive, readTable } from "./pgdump-reader.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOTE_LEADS = 200;
const LOTE_MENSAGENS = 500;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argumentos(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`argumento inesperado: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ["dump", "de", "para", "colunas", "saida"]) {
    if (!out[k]) throw new Error(`falta --${k}`);
  }
  if (!UUID.test(out.de) || !UUID.test(out.para))
    throw new Error("--de e --para precisam ser uuid");
  return out;
}

function dentroDoRepo(caminho) {
  const rel = relative(REPO, resolve(caminho));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Literal SQL. Com standard_conforming_strings ligado (padrao do Supabase), so
 *  a aspa simples precisa dobrar; barra invertida e literal. */
function lit(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const DEFAULT = Symbol("DEFAULT");
const sqlValor = (v) => (v === DEFAULT ? "DEFAULT" : lit(v));

function insert(tabela, colunas, linhas) {
  if (linhas.length === 0) return `-- ${tabela}: nada a inserir\n`;
  const valores = linhas.map((l) => `  (${colunas.map((c) => sqlValor(l[c])).join(", ")})`);
  return (
    `INSERT INTO public.${tabela} (${colunas.map((c) => `"${c}"`).join(", ")}) VALUES\n` +
    `${valores.join(",\n")}\nON CONFLICT (id) DO NOTHING;\n`
  );
}

const transacao = (corpo) => `BEGIN;\n${corpo}COMMIT;\n`;

function lotes(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------------------

const a = argumentos(process.argv.slice(2));
if (dentroDoRepo(a.saida)) {
  throw new Error(
    `--saida esta dentro do repositorio (${a.saida}). O SQL gerado e dado de cliente.`,
  );
}

const bruto = readFileSync(a.colunas, "utf8");
const jsonColunas = JSON.parse(bruto.slice(bruto.indexOf("{")));
const destino = Object.fromEntries(
  (jsonColunas.rows ?? jsonColunas).map((r) => [
    r.table_name,
    Array.isArray(r.cols) ? r.cols : String(r.cols).replace(/^{|}$/g, "").split(","),
  ]),
);

const ar = openArchive(a.dump);
const agora = new Date().toISOString();
const resumo = {
  gerado_em: agora,
  de: a.de,
  para: a.para,
  tabelas: {},
  descartado: {},
  transformado: {},
};

function linhasDoTenant(tabela) {
  const { columns, rows } = readTable(ar, "public", tabela);
  if (columns.length === 0) throw new Error(`public.${tabela} nao existe no dump`);
  if (!destino[tabela]) throw new Error(`public.${tabela} nao veio em --colunas`);
  return { origem: columns, rows: rows.filter((r) => r.user_id === a.de) };
}

/** Colunas que existem nos dois lados, na ordem do destino. O que so existe no
 *  legado e contado quando tem valor — nada some em silencio. */
function colunasComuns(tabela, origem, rows, tratadas = []) {
  const comuns = destino[tabela].filter((c) => origem.includes(c));
  for (const c of origem.filter((c) => !destino[tabela].includes(c) && !tratadas.includes(c))) {
    const n = rows.filter((r) => r[c] !== null && r[c] !== "").length;
    if (n > 0) resumo.descartado[`${tabela}.${c}`] = n;
  }
  return comuns;
}

// --- estagios ---------------------------------------------------------------
const est = linhasDoTenant("pipeline_stages");
const colEst = colunasComuns("pipeline_stages", est.origem, est.rows);
const idsEstagios = new Set(est.rows.map((r) => r.id));
const estagios = est.rows.map((r) => ({ ...r, user_id: a.para }));
const limpaPadrao =
  `-- Estagios padrao criados no cadastro da conta nova, se nada os referencia.\n` +
  `DELETE FROM public.pipeline_stages ps\n` +
  ` WHERE ps.user_id = ${lit(a.para)}\n` +
  (idsEstagios.size ? `   AND ps.id NOT IN (${[...idsEstagios].map(lit).join(", ")})\n` : "") +
  `   AND NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.stage_id = ps.id)\n` +
  `   AND NOT EXISTS (SELECT 1 FROM public.flows f WHERE f.trigger_stage_id = ps.id)\n` +
  `   AND NOT EXISTS (SELECT 1 FROM public.lead_stage_events e WHERE e.from_stage_id = ps.id OR e.to_stage_id = ps.id);\n`;

// --- fluxos -------------------------------------------------------------------
const flu = linhasDoTenant("flows");
const colFlu = colunasComuns("flows", flu.origem, flu.rows);
const idsFluxos = new Set(flu.rows.map((r) => r.id));
resumo.transformado["flows.is_active true->false"] = flu.rows.filter(
  (r) => r.is_active === "t",
).length;
const fluxos = flu.rows.map((r) => ({
  ...r,
  user_id: a.para,
  is_active: "f",
  trigger_stage_id: idsEstagios.has(r.trigger_stage_id) ? r.trigger_stage_id : null,
}));

const blo = linhasDoTenant("flow_blocks");
const colBlo = colunasComuns("flow_blocks", blo.origem, blo.rows);
const blocos = blo.rows
  .filter((r) => idsFluxos.has(r.flow_id))
  .map((r) => ({ ...r, user_id: a.para }));
const idsBlocos = new Set(blocos.map((r) => r.id));

// --- leads ----------------------------------------------------------------------
const lea = linhasDoTenant("leads");
const EXTRAS_LEAD = [
  "marketing_consent_status",
  "marketing_opted_out_at",
  "marketing_opt_out_reason",
  "is_suppressed",
  "suppressed_at",
  "suppression_reason",
];
const colLea = [
  ...new Set([
    ...colunasComuns("leads", lea.origem, lea.rows, ["opted_out", "opted_out_at", "phone_invalid"]),
    ...EXTRAS_LEAD.filter((c) => destino.leads.includes(c)),
  ]),
];
let optOut = 0;
let invalidos = 0;
let aguardando = 0;
const leads = lea.rows.map((r) => {
  const l = { ...r, user_id: a.para };
  for (const c of EXTRAS_LEAD) l[c] = DEFAULT;
  if (r.flow_waiting_reply === "t") aguardando++;
  l.active_flow_id = null;
  l.active_flow_step = null;
  l.flow_waiting_reply = "f";
  if (r.stage_id && !idsEstagios.has(r.stage_id)) l.stage_id = null;
  if (r.opted_out === "t") {
    optOut++;
    const quando = r.opted_out_at ?? agora;
    Object.assign(l, {
      marketing_consent_status: "withdrawn",
      marketing_opted_out_at: quando,
      marketing_opt_out_reason: "opt-out registrado no sistema anterior",
      is_suppressed: "t",
      suppressed_at: quando,
      suppression_reason: "opted_out",
    });
  } else if (r.phone_invalid === "t") {
    invalidos++;
    Object.assign(l, {
      is_suppressed: "t",
      suppressed_at: agora,
      suppression_reason: "phone_invalid",
    });
  }
  return l;
});
const idsLeads = new Set(leads.map((r) => r.id));
Object.assign(resumo.transformado, {
  "leads.opted_out -> withdrawn + supressao": optOut,
  "leads.phone_invalid -> supressao": invalidos,
  "leads.flow_waiting_reply true -> false": aguardando,
});

// --- mensagens ------------------------------------------------------------------
const men = linhasDoTenant("messages");
const colMen = colunasComuns("messages", men.origem, men.rows);
// O destino deduplica por (user_id, whatsapp_id, direction) — e o que segura a
// retentativa da Evolution. O legado nao deduplicava e guardou copias da mesma
// mensagem. Fica a mais antiga de cada chave.
const vistas = new Set();
let duplicadas = 0;
const unicas = [...men.rows]
  .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))
  .filter((r) => {
    if (!r.whatsapp_id) return true;
    const chave = `${r.whatsapp_id}|${r.direction}`;
    if (vistas.has(chave)) {
      duplicadas++;
      return false;
    }
    vistas.add(chave);
    return true;
  });
resumo.transformado["messages duplicadas por whatsapp_id + direction (puladas)"] = duplicadas;
const mensagens = unicas
  .filter((r) => idsLeads.has(r.lead_id))
  .map((r) => ({
    ...r,
    user_id: a.para,
    flow_id: idsFluxos.has(r.flow_id) ? r.flow_id : null,
    block_id: idsBlocos.has(r.block_id) ? r.block_id : null,
  }));
resumo.transformado["messages sem lead migrado (puladas)"] = unicas.length - mensagens.length;

// --- tarefas --------------------------------------------------------------------
const tar = linhasDoTenant("personal_tasks");
const colTar = colunasComuns("personal_tasks", tar.origem, tar.rows);
for (const t of tar.rows) {
  if (t.priority && !["low", "medium", "high"].includes(t.priority)) {
    throw new Error(`personal_tasks ${t.id}: priority "${t.priority}" fora do dominio do destino`);
  }
  if (t.status && !["pending", "in_progress", "done"].includes(t.status)) {
    throw new Error(`personal_tasks ${t.id}: status "${t.status}" fora do dominio do destino`);
  }
}
const tarefas = tar.rows.map((r) => ({
  ...r,
  user_id: a.para,
  ...("lead_id" in r ? { lead_id: idsLeads.has(r.lead_id) ? r.lead_id : null } : {}),
}));

// --- arquivos -------------------------------------------------------------------
mkdirSync(a.saida, { recursive: true });
const arquivos = [];
const grava = (nome, sql) => {
  writeFileSync(resolve(a.saida, nome), sql);
  arquivos.push(nome);
};

grava("01-estagios.sql", transacao(limpaPadrao + insert("pipeline_stages", colEst, estagios)));
grava(
  "02-fluxos.sql",
  transacao(insert("flows", colFlu, fluxos) + insert("flow_blocks", colBlo, blocos)),
);
lotes(leads, LOTE_LEADS).forEach((l, i) =>
  grava(`03-leads-${String(i + 1).padStart(2, "0")}.sql`, transacao(insert("leads", colLea, l))),
);
lotes(mensagens, LOTE_MENSAGENS).forEach((l, i) =>
  grava(
    `04-mensagens-${String(i + 1).padStart(2, "0")}.sql`,
    transacao(insert("messages", colMen, l)),
  ),
);
grava("05-tarefas.sql", transacao(insert("personal_tasks", colTar, tarefas)));

Object.assign(resumo.tabelas, {
  pipeline_stages: estagios.length,
  flows: fluxos.length,
  flow_blocks: blocos.length,
  leads: leads.length,
  messages: mensagens.length,
  personal_tasks: tarefas.length,
});
resumo.arquivos = arquivos;
writeFileSync(resolve(a.saida, "resumo.json"), JSON.stringify(resumo, null, 2));
console.log(JSON.stringify(resumo, null, 2));
