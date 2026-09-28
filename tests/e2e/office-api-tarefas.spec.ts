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

const TOKEN_TAREFAS = env("STAGING_OFFICE_TOKEN_TAREFAS");
const TOKEN_COMERCIAL = env("STAGING_SALES_COACH_E2E_TOKEN");
const TOKEN_SO_LEITURA = env("STAGING_OFFICE_TOKEN_SEM_ESCOPO");
const ATOR = "api:E2E tarefas";

const CONTA_A = "e2e@eleveflow.test";
const CONTA_B = "admin@eleveflow.test";

type Item = Record<string, any>;

let contaA = "";
let contaB = "";
let leadA = "";
let leadB = "";
let tarefaB = "";
const criadas: string[] = [];

const cabecalhos = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  ...extra,
});

async function usuario(email: string): Promise<string> {
  const { data } = await adminClient().auth.admin.listUsers();
  const user = data?.users.find((u) => u.email === email);
  if (!user) throw new Error(`usuário ${email} não existe`);
  return user.id;
}

async function lead(userId: string, nome: string, telefone: string): Promise<string> {
  const admin = adminClient();
  await admin.from("leads").delete().eq("user_id", userId).eq("phone", telefone);
  const criado = await admin
    .from("leads")
    .insert({ user_id: userId, name: nome, phone: telefone })
    .select("id")
    .single();
  if (criado.error) throw criado.error;
  return criado.data.id as string;
}

async function criar(request: APIRequestContext, corpo: Item, chave: string = randomUUID()) {
  const res = await request.post(`${BASE}/tarefas`, {
    headers: cabecalhos(TOKEN_TAREFAS, { "Idempotency-Key": chave }),
    data: corpo,
  });
  const json = await res.json();
  if (json.tarefa_id && !criadas.includes(json.tarefa_id)) criadas.push(json.tarefa_id);
  return { status: res.status(), json };
}

function alterar(request: APIRequestContext, id: string, versao: number | null, corpo: Item) {
  return request.patch(`${BASE}/tarefas/${id}`, {
    headers: cabecalhos(TOKEN_TAREFAS, versao === null ? {} : { "If-Match": `"${versao}"` }),
    data: corpo,
  });
}

function entregar(request: APIRequestContext, id: string, versao: number, corpo: Item) {
  return request.post(`${BASE}/tarefas/${id}/entrega`, {
    headers: cabecalhos(TOKEN_TAREFAS, { "If-Match": `"${versao}"` }),
    data: corpo,
  });
}

/** Lê todas as páginas de uma rota de lista. */
async function todas(
  request: APIRequestContext,
  caminho: string,
  token = TOKEN_TAREFAS,
  limite = 500,
): Promise<Item[]> {
  const itens: Item[] = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < 200; pagina++) {
    const separador = caminho.includes("?") ? "&" : "?";
    const url = `${BASE}${caminho}${separador}limite=${limite}${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await request.get(url, { headers: cabecalhos(token) });
    expect(res.status(), url).toBe(200);
    const corpo = await res.json();
    itens.push(...corpo.dados);
    if (!corpo.tem_mais) return itens;
    cursor = corpo.proximo_cursor;
  }
  throw new Error(`paginação sem fim em ${caminho}`);
}

async function historico(tarefaId: string) {
  const { data, error } = await adminClient()
    .from("personal_task_history")
    .select("actor, action, fields, status_from, status_to")
    .eq("task_id", tarefaId)
    .order("id");
  if (error) throw error;
  return data ?? [];
}

test.beforeAll(async () => {
  contaA = await usuario(CONTA_A);
  contaB = await usuario(CONTA_B);
  leadA = await lead(contaA, "Lead Tarefas E2E", "5511999990040");
  leadB = await lead(contaB, "Lead Tarefas E2E conta B", "5511999990041");
  const { data, error } = await adminClient()
    .from("personal_tasks")
    .insert({ user_id: contaB, title: "Tarefa E2E da conta B" })
    .select("id")
    .single();
  if (error) throw error;
  tarefaB = data.id as string;
});

test.afterAll(async () => {
  const admin = adminClient();
  const ids = [...criadas, tarefaB].filter(Boolean);
  if (ids.length) {
    await admin.from("personal_tasks").delete().in("id", ids);
    await admin.from("personal_task_history").delete().in("task_id", ids);
  }
  for (const id of [leadA, leadB].filter(Boolean)) {
    await admin.from("leads").delete().eq("id", id);
  }
});

test("criacao idempotente: a mesma chave devolve a mesma tarefa", async ({ request }) => {
  const chave = randomUUID();
  const corpo = {
    titulo: "Ligar para o lead E2E",
    descricao: "Confirmar a demonstração",
    prioridade: "alta",
    prazo: "2026-09-26T13:00:00-03:00",
    lead_id: leadA,
    responsavel: { tipo: "agente", ref: "sdr-e2e" },
    criador_ref: "nexo",
    ordem_externa_id: "ordem-e2e-1",
  };
  const primeira = await criar(request, corpo, chave);
  expect(primeira.status).toBe(201);
  expect(primeira.json).toMatchObject({
    conta_id: contaA,
    titulo: "Ligar para o lead E2E",
    prioridade: "alta",
    status: "pendente",
    origem: "eleve_office",
    criador: { tipo: "agente", ref: "nexo" },
    responsavel: { tipo: "agente", ref: "sdr-e2e" },
    lead_id: leadA,
    ordem_externa_id: "ordem-e2e-1",
    resultado: null,
    versao: 1,
    concluida_em: null,
  });
  expect(new Date(primeira.json.prazo).toISOString()).toBe("2026-09-26T16:00:00.000Z");

  const repetida = await criar(request, { ...corpo, titulo: "outro título" }, chave);
  expect(repetida.status).toBe(200);
  expect(repetida.json.tarefa_id).toBe(primeira.json.tarefa_id);
  expect(repetida.json.titulo).toBe("Ligar para o lead E2E");

  const { count } = await adminClient()
    .from("personal_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", contaA)
    .eq("idempotency_key", chave);
  expect(count).toBe(1);

  const semChave = await request.post(`${BASE}/tarefas`, {
    headers: cabecalhos(TOKEN_TAREFAS),
    data: corpo,
  });
  expect(semChave.status()).toBe(400);
});

test("corpo invalido da 400 e nao cria", async ({ request }) => {
  for (const corpo of [
    { titulo: "sem fuso", prazo: "2026-09-26T13:00:00" },
    { titulo: "lead da conta B", lead_id: leadB },
    { titulo: "campo de fora", conta_id: contaB },
    { titulo: "agente sem ref", responsavel: { tipo: "agente" } },
    { descricao: "sem título" },
  ]) {
    const { status, json } = await criar(request, corpo);
    expect(status, JSON.stringify(corpo)).toBe(400);
    expect(json.erro.codigo).toBe("parametro_invalido");
  }
});

test("alteracao com If-Match: conflito da 412 com a tarefa atual", async ({ request }) => {
  const { json: tarefa } = await criar(request, { titulo: "Tarefa para alterar" });

  const semVersao = await alterar(request, tarefa.tarefa_id, null, { titulo: "x" });
  expect(semVersao.status()).toBe(428);
  expect((await semVersao.json()).erro.codigo).toBe("versao_obrigatoria");

  const primeira = await alterar(request, tarefa.tarefa_id, 1, {
    titulo: "Alterada",
    status: "em_andamento",
  });
  expect(primeira.status()).toBe(200);
  expect(await primeira.json()).toMatchObject({
    titulo: "Alterada",
    status: "em_andamento",
    versao: 2,
  });

  const conflito = await alterar(request, tarefa.tarefa_id, 1, { titulo: "Perdida" });
  expect(conflito.status()).toBe(412);
  const corpo = await conflito.json();
  expect(corpo.erro.codigo).toBe("versao_desatualizada");
  expect(corpo.tarefa).toMatchObject({ titulo: "Alterada", versao: 2 });

  for (const campos of [{ resultado: "x" }, { prazo: "2026-09-26 13:00" }, { lead_id: leadB }]) {
    const res = await alterar(request, tarefa.tarefa_id, 2, campos);
    expect(res.status(), JSON.stringify(campos)).toBe(400);
  }

  const concluir = await alterar(request, tarefa.tarefa_id, 2, { status: "concluida" });
  expect(concluir.status()).toBe(409);
  expect((await concluir.json()).erro.codigo).toBe("transicao_invalida");
});

test("entrega leva a aguardando_revisao; so o dono conclui", async ({ request }) => {
  const { json: tarefa } = await criar(request, {
    titulo: "Tarefa para entregar",
    responsavel: { tipo: "agente", ref: "sdr-e2e" },
  });

  expect((await entregar(request, tarefa.tarefa_id, 1, {})).status()).toBe(400);

  const entregue = await entregar(request, tarefa.tarefa_id, 1, {
    resultado: "Liguei; demonstração confirmada",
    resultado_ref: "https://exemplo.com/relatorio",
  });
  expect(entregue.status()).toBe(200);
  expect(await entregue.json()).toMatchObject({
    status: "aguardando_revisao",
    resultado: "Liguei; demonstração confirmada",
    resultado_ref: "https://exemplo.com/relatorio",
    versao: 2,
    concluida_em: null,
  });

  for (const status of ["concluida", "pendente", "em_andamento"]) {
    const res = await alterar(request, tarefa.tarefa_id, 2, { status });
    expect(res.status(), status).toBe(409);
    const corpo = await res.json();
    expect(corpo.erro.codigo).toBe("transicao_invalida");
    expect(corpo.tarefa.status).toBe("aguardando_revisao");
  }

  // O dono conclui (aqui pela chave de serviço, que o histórico marca como sistema).
  const { error } = await adminClient()
    .from("personal_tasks")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", tarefa.tarefa_id);
  if (error) throw error;
  const lida = await request.get(`${BASE}/tarefas/${tarefa.tarefa_id}`, {
    headers: cabecalhos(TOKEN_TAREFAS),
  });
  expect(await lida.json()).toMatchObject({ status: "concluida", versao: 3 });
  expect((await entregar(request, tarefa.tarefa_id, 3, { resultado: "de novo" })).status()).toBe(
    409,
  );
  expect((await historico(tarefa.tarefa_id)).at(-1)).toMatchObject({
    actor: "sistema",
    status_from: "aguardando_revisao",
    status_to: "done",
  });
});

test("escopos: comercial nao ve tarefa, tarefas nao le lead, leitura nao escreve", async ({
  request,
}) => {
  expect(
    (await request.get(`${BASE}/tarefas`, { headers: cabecalhos(TOKEN_COMERCIAL) })).status(),
  ).toBe(403);
  const escritaComercial = await request.post(`${BASE}/tarefas`, {
    headers: cabecalhos(TOKEN_COMERCIAL, { "Idempotency-Key": randomUUID() }),
    data: { titulo: "não pode" },
  });
  expect(escritaComercial.status()).toBe(403);
  expect((await escritaComercial.json()).erro.codigo).toBe("escopo_insuficiente");

  expect(
    (await request.get(`${BASE}/leads`, { headers: cabecalhos(TOKEN_TAREFAS) })).status(),
  ).toBe(403);
  expect(
    (await request.get(`${BASE}/tarefas`, { headers: cabecalhos(TOKEN_SO_LEITURA) })).status(),
  ).toBe(200);
  const escritaLeitura = await request.post(`${BASE}/tarefas`, {
    headers: cabecalhos(TOKEN_SO_LEITURA, { "Idempotency-Key": randomUUID() }),
    data: { titulo: "não pode" },
  });
  expect(escritaLeitura.status()).toBe(403);

  const apagar = await request.delete(`${BASE}/tarefas`, { headers: cabecalhos(TOKEN_TAREFAS) });
  expect(apagar.status()).toBe(405);
  expect(apagar.headers()["allow"]).toBe("GET, POST");
});

test("isolamento: tarefa da outra conta responde 404 e nao muda", async ({ request }) => {
  expect(
    (
      await request.get(`${BASE}/tarefas/${tarefaB}`, { headers: cabecalhos(TOKEN_TAREFAS) })
    ).status(),
  ).toBe(404);
  expect((await alterar(request, tarefaB, 1, { titulo: "invasão" })).status()).toBe(404);
  expect((await entregar(request, tarefaB, 1, { resultado: "invasão" })).status()).toBe(404);

  const { data } = await adminClient()
    .from("personal_tasks")
    .select("title, version, status")
    .eq("id", tarefaB)
    .single();
  expect(data).toEqual({ title: "Tarefa E2E da conta B", version: 1, status: "pending" });
});

test("lista por atualizacao, com filtros e sem a outra conta", async ({ request }) => {
  const { json: tarefa } = await criar(request, {
    titulo: "Tarefa da lista",
    responsavel: { tipo: "agente", ref: "sdr-lista" },
  });

  await expect
    .poll(
      async () =>
        (await todas(request, "/tarefas?responsavel_tipo=agente&responsavel_ref=sdr-lista")).map(
          (t) => t.tarefa_id,
        ),
      { timeout: 20_000 },
    )
    .toContain(tarefa.tarefa_id);

  const lista = await todas(request, "/tarefas", TOKEN_TAREFAS, 2);
  const ids = lista.map((t) => t.tarefa_id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain(tarefaB);
  const instantes = lista.map((t) => new Date(t.atualizada_em).getTime());
  expect(instantes).toEqual([...instantes].sort((a, b) => a - b));

  const pendentes = await todas(request, "/tarefas?status=pendente");
  expect(pendentes.every((t) => t.status === "pendente")).toBe(true);
  expect(
    (
      await request.get(`${BASE}/tarefas?status=feita`, { headers: cabecalhos(TOKEN_TAREFAS) })
    ).status(),
  ).toBe(400);
});

test("historico com o ator da API; tarefa apagada aparece so no feed de tarefas", async ({
  request,
}) => {
  const { json: tarefa } = await criar(request, { titulo: "Tarefa do histórico" });
  expect(
    (
      await alterar(request, tarefa.tarefa_id, 1, {
        titulo: "Tarefa do histórico alterada",
        prioridade: "baixa",
      })
    ).status(),
  ).toBe(200);
  expect((await entregar(request, tarefa.tarefa_id, 2, { resultado: "feito" })).status()).toBe(200);

  expect(await historico(tarefa.tarefa_id)).toEqual([
    { actor: ATOR, action: "criacao", fields: [], status_from: null, status_to: "pending" },
    {
      actor: ATOR,
      action: "alteracao",
      fields: ["priority", "title"],
      status_from: "pending",
      status_to: "pending",
    },
    {
      actor: ATOR,
      action: "alteracao",
      fields: ["result", "status"],
      status_from: "pending",
      status_to: "aguardando_revisao",
    },
  ]);

  const { error } = await adminClient().from("personal_tasks").delete().eq("id", tarefa.tarefa_id);
  if (error) throw error;

  await expect
    .poll(async () => (await todas(request, "/exclusoes")).map((x) => `${x.entidade}:${x.id}`), {
      timeout: 20_000,
    })
    .toContain(`tarefa:${tarefa.tarefa_id}`);
  const doComercial = await todas(request, "/exclusoes", TOKEN_COMERCIAL);
  expect(doComercial.every((x) => x.entidade !== "tarefa")).toBe(true);
  expect(await historico(tarefa.tarefa_id)).toHaveLength(3);
});
