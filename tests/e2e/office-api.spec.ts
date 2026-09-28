import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { adminClient } from "./helpers/agent-seed";
import { stagingUrl } from "./helpers/supabase-admin";

const BASE = `${stagingUrl()}/functions/v1/office-api/v1`;

function env(nome: string): string {
  const valor = process.env[nome]?.trim();
  if (!valor) throw new Error(`${nome} must be configured for E2E tests`);
  return valor;
}

const TOKEN_A = env("STAGING_SALES_COACH_E2E_TOKEN");
const TOKEN_B = env("STAGING_OFFICE_TOKEN_CONTA_B");
const TOKEN_SEM_ESCOPO = env("STAGING_OFFICE_TOKEN_SEM_ESCOPO");
const TOKEN_LIMITE = env("STAGING_OFFICE_TOKEN_LIMITE");

const CONTA_A = "e2e@eleveflow.test";
const CONTA_B = "admin@eleveflow.test";
const TEXTO_IA = "resposta da IA E2E (office-api)";

type Item = Record<string, any>;

let contaA = "";
let contaB = "";
let leadGanho = "";
let leadPerdido = "";
let mensagemDoPerdido = "";
let leadB = "";
let mensagemB = "";
const mensagensDoGanho: string[] = [];

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function usuario(email: string): Promise<string> {
  const { data } = await adminClient().auth.admin.listUsers();
  const user = data?.users.find((u) => u.email === email);
  if (!user) throw new Error(`usuário ${email} não existe`);
  return user.id;
}

async function etapa(userId: string, nome: string, funnelKey: string | null, posicao: number) {
  const admin = adminClient();
  const { data } = await admin
    .from("pipeline_stages")
    .select("id")
    .eq("user_id", userId)
    .eq("name", nome)
    .maybeSingle();
  if (data) return data.id as string;
  const criada = await admin
    .from("pipeline_stages")
    .insert({ user_id: userId, name: nome, position: posicao, funnel_key: funnelKey })
    .select("id")
    .single();
  if (criada.error) throw criada.error;
  return criada.data.id as string;
}

async function lead(userId: string, nome: string, telefone: string, stageId: string | null) {
  const admin = adminClient();
  await admin.from("leads").delete().eq("user_id", userId).eq("phone", telefone);
  const criado = await admin
    .from("leads")
    .insert({ user_id: userId, name: nome, phone: telefone, stage_id: stageId })
    .select("id")
    .single();
  if (criado.error) throw criado.error;
  return criado.data.id as string;
}

async function mensagens(linhas: Item[]): Promise<string[]> {
  const { data, error } = await adminClient().from("messages").insert(linhas).select("id");
  if (error) throw error;
  return (data ?? []).map((m) => m.id as string);
}

/** Lê todas as páginas de uma rota de lista. */
async function todasAsPaginas(
  request: APIRequestContext,
  caminho: string,
  token: string,
  limite: number,
): Promise<Item[]> {
  const itens: Item[] = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < 200; pagina++) {
    const separador = caminho.includes("?") ? "&" : "?";
    const url = `${BASE}${caminho}${separador}limite=${limite}${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await request.get(url, { headers: auth(token) });
    expect(res.status(), url).toBe(200);
    const corpo = await res.json();
    itens.push(...corpo.dados);
    if (!corpo.tem_mais) return itens;
    cursor = corpo.proximo_cursor;
  }
  throw new Error(`paginação sem fim em ${caminho}`);
}

test.beforeAll(async () => {
  const admin = adminClient();
  contaA = await usuario(CONTA_A);
  contaB = await usuario(CONTA_B);

  const ativa = await etapa(contaA, "Coach E2E", null, 95);
  const ganho = await etapa(contaA, "Ganho E2E", "won", 96);
  const perda = await etapa(contaA, "Perda E2E", "lost", 97);

  // Lead que passa por perda, reabertura e ganho.
  leadGanho = await lead(contaA, "Lead Office E2E", "5511999990030", ativa);
  for (const stageId of [perda, ativa, ganho]) {
    const { error } = await admin.from("leads").update({ stage_id: stageId }).eq("id", leadGanho);
    if (error) throw error;
  }

  // 7 mensagens no mesmo instante (e gravadas na mesma instrução) e 3 fora de ordem.
  const t0 = Date.now() - 60 * 60 * 1000;
  const iguais = Array.from({ length: 7 }, (_, i) => ({
    user_id: contaA,
    lead_id: leadGanho,
    direction: "inbound",
    status: "received",
    content: `mesmo instante ${i}`,
    created_at: new Date(t0).toISOString(),
  }));
  mensagensDoGanho.push(...(await mensagens(iguais)));
  for (const minutos of [3, 1, 2]) {
    mensagensDoGanho.push(
      ...(await mensagens([
        {
          user_id: contaA,
          lead_id: leadGanho,
          direction: "inbound",
          status: "received",
          content: `fora de ordem +${minutos}min`,
          created_at: new Date(t0 + minutos * 60_000).toISOString(),
        },
      ])),
    );
  }

  // Resposta da IA pelo caminho real da entrega: item da fila com origin 'ia'.
  const claim = randomUUID();
  const item = await admin
    .from("send_queue")
    .insert({
      user_id: contaA,
      lead_id: leadGanho,
      content: TEXTO_IA,
      status: "sending",
      claim_token: claim,
      sending_at: new Date().toISOString(),
      scheduled_at: new Date().toISOString(),
      origin: "ia",
    })
    .select("id")
    .single();
  if (item.error) throw item.error;
  const entrega = await admin.rpc("complete_marketing_queue_delivery", {
    p_queue_item_id: item.data.id,
    p_user_id: contaA,
    p_claim_token: claim,
    p_content: TEXTO_IA,
    p_whatsapp_id: null,
  });
  if (entrega.error) throw entrega.error;
  mensagensDoGanho.push(entrega.data[0].message_id);

  // Lead criado direto em perda: fechou antes de haver transição registrada.
  leadPerdido = await lead(contaA, "Lead Office E2E perdido", "5511999990031", perda);
  [mensagemDoPerdido] = await mensagens([
    {
      user_id: contaA,
      lead_id: leadPerdido,
      direction: "inbound",
      status: "received",
      content: "não tenho interesse",
    },
  ]);

  leadB = await lead(contaB, "Lead Office E2E conta B", "5511999990032", null);
  [mensagemB] = await mensagens([
    { user_id: contaB, lead_id: leadB, direction: "inbound", status: "received", content: "da B" },
  ]);
});

test.afterAll(async () => {
  const admin = adminClient();
  for (const id of [leadGanho, leadPerdido, leadB].filter(Boolean)) {
    await admin.from("send_queue").delete().eq("lead_id", id);
    await admin.from("leads").delete().eq("id", id);
  }
});

test("autenticacao, escopo, metodo e parametros", async ({ request }) => {
  const semToken = await request.get(`${BASE}/leads`);
  expect(semToken.status()).toBe(401);
  expect((await semToken.json()).erro.codigo).toBe("token_invalido");

  const errado = await request.get(`${BASE}/leads`, { headers: auth(`efsc_${"x".repeat(43)}`) });
  expect(errado.status()).toBe(401);

  expect((await request.post(`${BASE}/leads`, { headers: auth(TOKEN_A) })).status()).toBe(405);

  const semEscopo = await request.get(`${BASE}/leads`, { headers: auth(TOKEN_SEM_ESCOPO) });
  expect(semEscopo.status()).toBe(403);
  expect((await semEscopo.json()).erro.codigo).toBe("escopo_insuficiente");

  for (const query of ["limite=0", "cursor=lixo", "situacao=fechada"]) {
    const res = await request.get(`${BASE}/leads?${query}`, { headers: auth(TOKEN_A) });
    expect(res.status(), query).toBe(400);
  }
  // A rota existe (parte C); o token comercial nao tem tarefas:leitura.
  expect((await request.get(`${BASE}/tarefas`, { headers: auth(TOKEN_A) })).status()).toBe(403);
});

test("limite por token devolve 429 com Retry-After", async ({ request }) => {
  let bloqueio = null;
  for (let i = 0; i < 6 && !bloqueio; i++) {
    const res = await request.get(`${BASE}/leads?limite=1`, { headers: auth(TOKEN_LIMITE) });
    if (res.status() === 429) bloqueio = res;
    else expect(res.status()).toBe(200);
  }
  expect(bloqueio).not.toBeNull();
  expect((await bloqueio!.json()).erro.codigo).toBe("limite_excedido");
  expect(Number(bloqueio!.headers()["retry-after"])).toBeGreaterThan(0);
});

test("isolamento: uma conta nao ve nada da outra", async ({ request }) => {
  for (const caminho of [
    `/leads/${leadB}`,
    `/leads/${leadB}/mensagens`,
    `/leads/${leadB}/etapas`,
  ]) {
    const res = await request.get(`${BASE}${caminho}`, { headers: auth(TOKEN_A) });
    expect(res.status(), caminho).toBe(404);
  }
  expect(
    (await request.get(`${BASE}/leads/${leadGanho}`, { headers: auth(TOKEN_B) })).status(),
  ).toBe(404);

  await expect
    .poll(
      async () => (await todasAsPaginas(request, "/leads", TOKEN_A, 500)).map((l) => l.lead_id),
      {
        timeout: 20_000,
      },
    )
    .toEqual(expect.arrayContaining([leadGanho, leadPerdido]));

  const leadsA = await todasAsPaginas(request, "/leads", TOKEN_A, 500);
  expect(leadsA.map((l) => l.lead_id)).not.toContain(leadB);
  const mensagensA = await todasAsPaginas(request, "/mensagens", TOKEN_A, 500);
  expect(mensagensA.map((m) => m.mensagem_id)).not.toContain(mensagemB);
  expect(mensagensA.every((m) => m.lead_id !== leadB)).toBe(true);
  const eventosA = await todasAsPaginas(request, "/etapas", TOKEN_A, 500);
  expect(eventosA.every((e) => e.lead_id !== leadB)).toBe(true);

  const leadsB = await todasAsPaginas(request, "/leads", TOKEN_B, 500);
  expect(leadsB.map((l) => l.lead_id)).not.toContain(leadGanho);
});

test("paginacao sem perda nem repeticao, em ordem cronologica", async ({ request }) => {
  const conversa = await todasAsPaginas(request, `/leads/${leadGanho}/mensagens`, TOKEN_A, 2);
  const ids = conversa.map((m) => m.mensagem_id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual([...mensagensDoGanho].sort());

  const instantes = conversa.map((m) => new Date(m.enviada_em).getTime());
  expect(instantes).toEqual([...instantes].sort((a, b) => a - b));
  expect(conversa.filter((m) => m.texto.startsWith("fora de ordem")).map((m) => m.texto)).toEqual([
    "fora de ordem +1min",
    "fora de ordem +2min",
    "fora de ordem +3min",
  ]);

  await expect
    .poll(
      async () => {
        const feed = await todasAsPaginas(request, "/mensagens", TOKEN_A, 3);
        return feed.filter((m) => m.lead_id === leadGanho).map((m) => m.mensagem_id);
      },
      { timeout: 20_000 },
    )
    .toHaveLength(mensagensDoGanho.length);
  const feed = await todasAsPaginas(request, "/mensagens", TOKEN_A, 3);
  const doGanho = feed.filter((m) => m.lead_id === leadGanho).map((m) => m.mensagem_id);
  expect(new Set(doGanho).size).toBe(doGanho.length);
});

test("origem, tipo e texto integral da mensagem", async ({ request }) => {
  const conversa = await todasAsPaginas(request, `/leads/${leadGanho}/mensagens`, TOKEN_A, 100);
  expect(conversa.find((m) => m.texto === TEXTO_IA)).toMatchObject({
    origem: "ia",
    direcao: "enviada",
    status: "enviada",
    tipo: "texto",
    tem_texto: true,
    transcricao: null,
    atendente_id: null,
  });
  expect(conversa.find((m) => m.texto === "mesmo instante 0")).toMatchObject({
    origem: "lead",
    direcao: "recebida",
    conversa_id: leadGanho,
  });
});

test("historico de etapas com ganho, perda e reabertura, e o nome da epoca", async ({
  request,
}) => {
  const eventos = await todasAsPaginas(request, `/leads/${leadGanho}/etapas`, TOKEN_A, 100);
  expect(eventos.map((e) => [e.tipo, e.resultado])).toEqual([
    ["criacao", null],
    ["mudanca", "perda"],
    ["mudanca", "reabertura"],
    ["mudanca", "ganho"],
  ]);
  expect(eventos[1]).toMatchObject({
    motivo_perda: "Perda E2E",
    nome_da_epoca: true,
    para: { nome: "Perda E2E", tipo: "lost" },
    autor: { tipo: "automacao_ou_importacao", id: null },
  });
  const instantes = eventos.map((e) => new Date(e.ocorreu_em).getTime());
  expect(instantes).toEqual([...instantes].sort((a, b) => a - b));

  const ganho = await (
    await request.get(`${BASE}/leads/${leadGanho}`, { headers: auth(TOKEN_A) })
  ).json();
  expect(ganho).toMatchObject({ situacao: "ganha", motivo_perda: null, responsavel: null });
  expect(ganho.fechado_em).toBe(eventos[3].ocorreu_em);
});

test("lead que ja chegou perdido: motivo sem data de fechamento", async ({ request }) => {
  const res = await request.get(`${BASE}/leads/${leadPerdido}`, { headers: auth(TOKEN_A) });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    situacao: "perdida",
    motivo_perda: "Perda E2E",
    fechado_em: null,
    etapa: { nome: "Perda E2E", tipo: "lost" },
  });
});

test("exclusoes: mensagem e lead apagados aparecem; a cascata nao duplica", async ({ request }) => {
  const admin = adminClient();
  const apagada = mensagensDoGanho[0];
  await admin.from("messages").delete().eq("id", apagada);
  await admin.from("leads").delete().eq("id", leadPerdido);

  await expect
    .poll(
      async () => {
        const exclusoes = await todasAsPaginas(request, "/exclusoes", TOKEN_A, 500);
        return exclusoes.map((x) => `${x.entidade}:${x.id}`);
      },
      { timeout: 20_000 },
    )
    .toEqual(expect.arrayContaining([`mensagem:${apagada}`, `lead:${leadPerdido}`]));

  const exclusoes = await todasAsPaginas(request, "/exclusoes", TOKEN_A, 500);
  expect(exclusoes.map((x) => `${x.entidade}:${x.id}`)).not.toContain(
    `mensagem:${mensagemDoPerdido}`,
  );
  leadPerdido = "";
});
