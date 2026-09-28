// Leitor do formato custom do pg_dump (-Fc), sem depender de pg_restore.
//
// Existe porque a maquina de desenvolvimento nao tem cliente do Postgres nem
// Docker, e o dump do projeto legado do Lovable veio nesse formato, comprimido
// com zstd. O Node 22.15+ traz zstd nativo em `node:zlib`, entao da para ler o
// arquivo inteiro sem instalar nada.
//
// Estrutura do formato: src/bin/pg_dump/pg_backup_archiver.h do Postgres.
// Cabecalho com versao e tamanhos, indice (TOC) com uma entrada por objeto, e
// blocos de dados no fim, cada um sendo COPY em texto comprimido.

import fs from "node:fs";
import zlib from "node:zlib";

export function openArchive(path) {
  const d = fs.readFileSync(path);
  if (d.subarray(0, 5).toString() !== "PGDMP") {
    throw new Error(`${path} nao e um dump custom do pg_dump`);
  }
  let p = 5;
  const byte = () => d[p++];
  const vmaj = byte(), vmin = byte(), vrev = byte();
  const intSize = byte(), offSize = byte(), format = byte();
  const ver = vmaj * 100 + vmin;

  const readInt = () => {
    const sign = byte();
    let v = 0;
    for (let i = 0; i < intSize; i++) v += byte() * 2 ** (8 * i);
    return sign ? -v : v;
  };
  const readStr = () => {
    const n = readInt();
    if (n < 0) return null;
    const s = d.subarray(p, p + n).toString("utf8");
    p += n;
    return s;
  };
  const readOffset = () => {
    const flag = byte();
    let v = 0;
    for (let i = 0; i < offSize; i++) v += d[p++] * 2 ** (8 * i);
    return { flag, value: v };
  };

  // A partir da v1.15 a compressao virou um byte de algoritmo:
  // 0 nenhuma, 1 gzip, 2 lz4, 3 zstd.
  const compression = ver >= 115 ? byte() : readInt();
  for (let i = 0; i < 7; i++) readInt(); // sec min hour mday mon year isdst
  const dbname = readStr();
  const remoteVersion = readStr();
  const dumpVersion = readStr();
  const count = readInt();

  const toc = [];
  for (let i = 0; i < count; i++) {
    const e = {};
    e.dumpId = readInt();
    readInt(); // hadDumper
    readStr(); // tableoid
    readStr(); // oid
    e.tag = readStr();
    e.desc = readStr();
    if (ver >= 111) readInt(); // section
    e.defn = readStr();
    readStr(); // dropStmt
    e.copyStmt = readStr();
    e.namespace = readStr();
    readStr(); // tablespace
    if (ver >= 114) readStr(); // tableam
    if (ver >= 116) readInt(); // relkind
    e.owner = readStr();
    if (ver < 109) readStr(); // withOids
    while (readStr() !== null) {} // dependencias, terminadas por string nula
    e.offset = readOffset();
    toc.push(e);
  }

  return { buf: d, ver, intSize, offSize, format, compression, dbname, remoteVersion, dumpVersion, toc };
}

/** Descomprime o bloco de dados de uma entrada TABLE DATA. Devolve COPY em texto. */
export function readData(ar, entry) {
  if (entry.offset.flag !== 2) return null; // 2 = K_OFFSET_POS_SET
  const d = ar.buf;
  let p = entry.offset.value;
  const byte = () => d[p++];
  const readInt = () => {
    const sign = byte();
    let v = 0;
    for (let i = 0; i < ar.intSize; i++) v += byte() * 2 ** (8 * i);
    return sign ? -v : v;
  };

  const blockType = byte();
  const dumpId = readInt();
  if (dumpId !== entry.dumpId) {
    throw new Error(`bloco fora de lugar: dumpId ${dumpId} != ${entry.dumpId}`);
  }
  if (blockType !== 1) return null; // 1 = BLK_DATA

  const chunks = [];
  for (;;) {
    const len = readInt();
    if (len <= 0) break;
    chunks.push(d.subarray(p, p + len));
    p += len;
  }
  const raw = Buffer.concat(chunks);
  if (ar.compression === 0) return raw.toString("utf8");
  if (ar.compression === 1) return zlib.inflateSync(raw).toString("utf8");
  if (ar.compression === 3) return zlib.zstdDecompressSync(raw).toString("utf8");
  throw new Error(`compressao ${ar.compression} nao suportada por este leitor`);
}

// O COPY termina numa linha com barra invertida e ponto. String.raw e proposital:
// "\." em JavaScript vira ".", e foi assim que a primeira versao contou uma
// linha a mais em cada tabela.
const TERMINADOR = String.raw`\.`;

export function copyRows(text) {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .filter((l) => l !== "" && l !== TERMINADOR);
}

/** Nomes das colunas, lidos do COPY statement da entrada do indice. */
export function columnsOf(entry) {
  const inside = entry.copyStmt?.match(/\(([^)]*)\)/)?.[1] ?? "";
  return inside.split(",").map((c) => c.trim().replace(/"/g, ""));
}

const COPY_ESCAPES = { t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v" };

/**
 * Desfaz os escapes do formato texto do COPY numa passada so, da esquerda para
 * a direita. A barra escapada precisa ser consumida antes de olhar a letra
 * seguinte: em passes separados de `replace`, o `\n` de dentro de `\\n` virava
 * quebra de linha real e corrompia o JSON dos blocos de fluxo. O COPY TO nunca
 * emite escape octal nem hexadecimal, so estes.
 */
function decodeCopyField(v) {
  if (!v.includes("\\")) return v;
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c !== "\\" || i === v.length - 1) {
      out += c;
      continue;
    }
    const next = v[++i];
    out += COPY_ESCAPES[next] ?? next;
  }
  return out;
}

/** Uma linha de COPY em objeto, desfazendo os escapes do formato texto. */
export function parseRow(line, cols) {
  const vals = line
    .split("\t")
    .map((v) => (v === String.raw`\N` ? null : decodeCopyField(v)));
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

/** Atalho: todas as linhas de uma tabela, ja como objetos. */
export function readTable(ar, namespace, tag) {
  const entry = ar.toc.find(
    (e) => e.desc === "TABLE DATA" && e.namespace === namespace && e.tag === tag,
  );
  if (!entry) return { columns: [], rows: [] };
  const columns = columnsOf(entry);
  const rows = copyRows(readData(ar, entry)).map((l) => parseRow(l, columns));
  return { columns, rows };
}
