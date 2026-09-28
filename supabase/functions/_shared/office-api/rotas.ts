// Tabela de rotas da office-api: por metodo, os escopos aceitos (basta o token ter
// um); null = rota publica. O contrato (openapi.json) e conferido contra esta tabela
// por teste.

export type NomeRota =
  | "leads"
  | "lead"
  | "lead_mensagens"
  | "lead_etapas"
  | "mensagens"
  | "etapas"
  | "exclusoes"
  | "tarefas"
  | "tarefa"
  | "tarefa_entrega"
  | "openapi";

export type Metodo = "GET" | "POST" | "PATCH";
export type Metodos = Partial<Record<Metodo, string[] | null>>;
export type Rota = { nome: NomeRota; modelo: string; metodos: Metodos; id?: string };

const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const METODOS: Metodo[] = ["GET", "POST", "PATCH"];
const COMERCIAL = ["comercial:leitura"];
const TAREFAS_LEITURA = ["tarefas:leitura"];
const TAREFAS_ESCRITA = ["tarefas:escrita"];

const TABELA: Array<{ padrao: RegExp; nome: NomeRota; modelo: string; metodos: Metodos }> = [
  { padrao: /^\/v1\/leads$/, nome: "leads", modelo: "/v1/leads", metodos: { GET: COMERCIAL } },
  {
    padrao: new RegExp(`^/v1/leads/${ID}$`, "i"),
    nome: "lead",
    modelo: "/v1/leads/{id}",
    metodos: { GET: COMERCIAL },
  },
  {
    padrao: new RegExp(`^/v1/leads/${ID}/mensagens$`, "i"),
    nome: "lead_mensagens",
    modelo: "/v1/leads/{id}/mensagens",
    metodos: { GET: COMERCIAL },
  },
  {
    padrao: new RegExp(`^/v1/leads/${ID}/etapas$`, "i"),
    nome: "lead_etapas",
    modelo: "/v1/leads/{id}/etapas",
    metodos: { GET: COMERCIAL },
  },
  {
    padrao: /^\/v1\/mensagens$/,
    nome: "mensagens",
    modelo: "/v1/mensagens",
    metodos: { GET: COMERCIAL },
  },
  { padrao: /^\/v1\/etapas$/, nome: "etapas", modelo: "/v1/etapas", metodos: { GET: COMERCIAL } },
  // Cada escopo de leitura ve as exclusoes das entidades dele.
  {
    padrao: /^\/v1\/exclusoes$/,
    nome: "exclusoes",
    modelo: "/v1/exclusoes",
    metodos: { GET: ["comercial:leitura", "tarefas:leitura"] },
  },
  {
    padrao: /^\/v1\/tarefas$/,
    nome: "tarefas",
    modelo: "/v1/tarefas",
    metodos: { GET: TAREFAS_LEITURA, POST: TAREFAS_ESCRITA },
  },
  {
    padrao: new RegExp(`^/v1/tarefas/${ID}$`, "i"),
    nome: "tarefa",
    modelo: "/v1/tarefas/{id}",
    metodos: { GET: TAREFAS_LEITURA, PATCH: TAREFAS_ESCRITA },
  },
  {
    padrao: new RegExp(`^/v1/tarefas/${ID}/entrega$`, "i"),
    nome: "tarefa_entrega",
    modelo: "/v1/tarefas/{id}/entrega",
    metodos: { POST: TAREFAS_ESCRITA },
  },
  {
    padrao: /^\/v1\/openapi\.json$/,
    nome: "openapi",
    modelo: "/v1/openapi.json",
    metodos: { GET: null },
  },
];

export const ROTAS = TABELA.map(({ nome, modelo, metodos }) => ({ nome, modelo, metodos }));

export function encontrarRota(pathname: string): Rota | null {
  const caminho = pathname.replace(/^\/(functions\/v1\/)?office-api/, "");
  for (const rota of TABELA) {
    const casou = rota.padrao.exec(caminho);
    if (casou) return { nome: rota.nome, modelo: rota.modelo, metodos: rota.metodos, id: casou[1] };
  }
  return null;
}

/** O metodo, se a rota o aceita; null vira 405. */
export function metodoDaRota(rota: { metodos: Metodos }, metodo: string): Metodo | null {
  return METODOS.find((m) => m === metodo && rota.metodos[m] !== undefined) ?? null;
}
