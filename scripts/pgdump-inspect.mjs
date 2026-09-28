// Inspeciona um dump custom do pg_dump sem precisar de pg_restore.
//
// Uso:
//   node scripts/pgdump-inspect.mjs <arquivo.backup>                    inventario
//   node scripts/pgdump-inspect.mjs <arquivo.backup> <schema> <tabela>  linhas
//
// O dump carrega dado de cliente. Nao redirecione a saida para dentro do repo.

import { openArchive, readData, copyRows, readTable } from "./pgdump-reader.mjs";

const [, , arquivo, schema, tabela] = process.argv;

if (!arquivo) {
  console.error("uso: node scripts/pgdump-inspect.mjs <arquivo.backup> [schema] [tabela]");
  process.exit(1);
}

const ar = openArchive(arquivo);

if (schema && tabela) {
  const { columns, rows } = readTable(ar, schema, tabela);
  if (columns.length === 0) {
    console.error(`${schema}.${tabela} nao existe no dump`);
    process.exit(1);
  }
  console.error(`# ${schema}.${tabela}: ${rows.length} linhas`);
  console.error(`# colunas: ${columns.join(", ")}`);
  for (const row of rows) console.log(JSON.stringify(row));
  process.exit(0);
}

console.log(
  `banco=${ar.dbname} servidor=${ar.remoteVersion} pg_dump=${ar.dumpVersion} compressao=${ar.compression}`,
);

const porSchema = {};
for (const e of ar.toc.filter((x) => x.desc === "TABLE DATA")) {
  let linhas;
  try {
    linhas = copyRows(readData(ar, e)).length;
  } catch (err) {
    linhas = `ERRO: ${err.message}`;
  }
  (porSchema[e.namespace] ??= []).push([e.tag, linhas]);
}

for (const [schemaNome, tabelas] of Object.entries(porSchema).sort()) {
  const comLinhas = tabelas.filter(([, n]) => n !== 0);
  if (comLinhas.length === 0) continue;
  console.log(`\n=== ${schemaNome} ===`);
  for (const [tag, n] of comLinhas.sort((a, b) => Number(b[1]) - Number(a[1]))) {
    console.log(`  ${String(n).padStart(8)}  ${tag}`);
  }
}
