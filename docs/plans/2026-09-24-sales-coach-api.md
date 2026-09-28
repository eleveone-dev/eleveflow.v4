# Sales Coach — API de leitura: plano de implementação

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` ou `superpowers:executing-plans` para
> implementar tarefa a tarefa. Os passos usam checkbox (`- [x]`).

**Objetivo:** `GET /functions/v1/sales-coach`, só leitura, que entrega ao Eleve Sales
Coach o retrato comercial de uma conta, com token próprio preso a essa conta.

**Arquitetura:** Edge Function fina resolve a conta pelo SHA-256 do token (segredo
`SALES_COACH_TOKENS`), valida os parâmetros e chama `public.sales_coach_snapshot`
pelo service role. Regra de negócio e filtro de conta ficam numa função SQL
`STABLE`/`SECURITY INVOKER` que só o `service_role` executa.

**Stack:** Supabase Edge Functions (Deno 2), função SQL no Postgres, Vitest (unit),
Playwright (E2E contra produção).

**Spec:** `docs/specs/2026-09-23-sales-coach-api-design.md`, decisões 1 a 4.

**Base:** branch `feat/f1-evolution-provider`, `ecf83c3`. Linha de base em
2026-09-24: **39 arquivos, 479 testes, verde**.

**Pré-requisito (Implantação, passo 1):** feito em 2026-09-24. As 8 etapas da Eleve
One têm `funnel_key` conforme a decisão 1, conferido por SELECT.

## Global Constraints

- Português do Brasil em commits, comentários e documentos. Commit sem acentuação,
  seguindo o histórico.
- Conventional Commits, atômicos. **Sem rastro de IA** em commit, PR, código ou doc.
- **TDD**: teste, ver falhar, implementar, ver passar.
- **Nada é declarado pronto sem a saída do comando colada.**
- `_shared/`: proibido `import` por URL e proibido `Deno.env`. Quem lê ambiente é o
  `index.ts`.
- Banco: só `CREATE OR REPLACE FUNCTION` e REVOKE/GRANT. Nenhum `DROP`, nenhuma
  tabela.
- A conta **nunca** vem da requisição: sai do token.
- **Nunca logar** token, hash de token nem dado de lead (nome, empresa, telefone,
  texto).
- **Gate do dono:** `db push`, `functions deploy`, `secrets set SALES_COACH_TOKENS` e
  qualquer mudança na VPS do Eleve Office só com OK explícito.
- Todo comando Supabase via `bash scripts/sb-staging.sh`, que aponta para
  **PRODUÇÃO** (`xlycuunqpgpyfmafgajr`).
- Cobertura: o gate de 80% do `vitest.config.ts` continua; módulo novo entra em
  `coverage.include`.

## Decisões de implementação

O que a spec deixou para o código, decidido com dado de produção (2026-09-24):

1. **Lead sem etapa conta como etapa ativa** (não tem chave). Eleve One: 0 leads sem
   etapa.
2. **`is_test` fica fora de tudo**, listas e contagens: lead de teste não é comercial.
   `is_suppressed` fica fora só das listas, como a spec diz; nas contagens ele
   continua na etapa em que está.
3. **`taxa_resposta`** é fração de 0 a 1 com 2 casas, como no exemplo da spec. Regra
   do Dashboard (`calculateResponseRate`): contatado = outbound com
   `status = 'sent'` na janela; respondeu = inbound na janela entre os contatados.
   Sem contatado, 0.
4. **Nome de etapa sai com `btrim`**: no banco, "Demonstração " tem espaço no fim.
5. **`funil` traz todas as etapas** da conta, na ordem de `position`.
6. **Datas** saem como `timestamptz` nativo no JSON (ISO 8601 com offset).
7. **Trecho da mensagem**: `left(content, 200)`, ou seja, 200 code points.
8. **Sem CORS**: quem chama é servidor. Ordem das checagens: método → token →
   parâmetros. Parâmetro inválido sem token dá 401.
9. **Token do E2E** em texto só no `.env.staging` (`STAGING_SALES_COACH_E2E_TOKEN`).
   **Token do Eleve Office** gerado na hora da instalação (Task 6), sem ficar
   gravado nesta máquina.
10. **JWT de usuário comum no E2E**: `auth.admin.generateLink` + `verifyOtp`, sem
    senha. `E2E_PASSWORD` não existe nesta máquina.
11. **SQL validado antes do push como SELECT somente leitura** (corpo da função com
    parâmetros literais). Motivo: não há Postgres local (sem Docker), e DDL em
    produção só com OK. O vermelho/verde da função vem do E2E (Tasks 3 e 5).

## Arquivos

| arquivo | responsabilidade |
|---|---|
| `supabase/functions/_shared/sales-coach.ts` | puro: `sha256Hex`, `resolveCoachAccount`, `parseCoachParams` |
| `tests/unit/sales-coach.test.ts` | unit do módulo puro |
| `supabase/migrations/20260924192907_sales_coach_snapshot.sql` | função SQL + REVOKE/GRANT |
| `tests/e2e/sales-coach.spec.ts` | E2E contra produção, com isolamento e prova do REVOKE |
| `supabase/functions/sales-coach/index.ts` | handler fino |
| `supabase/config.toml` | `[functions.sales-coach] verify_jwt = false` |
| `vitest.config.ts` | módulo novo no `coverage.include` |
| `.env.staging` (gitignored) | `STAGING_SALES_COACH_E2E_TOKEN` |

---

### Task 1: Módulo puro — token → conta e parâmetros

**Files:**
- Create: `supabase/functions/_shared/sales-coach.ts`
- Create: `tests/unit/sales-coach.test.ts`
- Modify: `vitest.config.ts` (`coverage.include`)

**Interfaces:**
- Produces:
  - `sha256Hex(texto: string): Promise<string>` — hex minúsculo.
  - `resolveCoachAccount(authorization: string | null, tokensJson: string | undefined): Promise<string | null>`
    — `user_id` dono do token, ou `null`.
  - `interface CoachParams { periodo_dias: number; parado_dias: number; followup_horas: number; limite: number }`
  - `parseCoachParams(query: URLSearchParams): CoachParams` — lança `HttpError(400)`.

- [x] **Passo 1: Escrever o teste que falha**

`tests/unit/sales-coach.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import {
  parseCoachParams,
  resolveCoachAccount,
  sha256Hex,
} from "../../supabase/functions/_shared/sales-coach";

const TOKEN = "efsc_token-de-teste-do-coach";
const OUTRO_TOKEN = "efsc_token-de-outra-conta";
const CONTA = "14448933-86df-47d4-a082-df69dbddeff1";
const OUTRA_CONTA = "ad3d7aef-f897-425c-a2b7-7b804a1b650d";

/** Segredo no formato de SALES_COACH_TOKENS: hash do token → conta. */
async function segredoCom(...pares: [string, unknown][]): Promise<string> {
  const mapa: Record<string, unknown> = {};
  for (const [token, conta] of pares) mapa[await sha256Hex(token)] = conta;
  return JSON.stringify(mapa);
}

describe("sha256Hex", () => {
  it("gera o SHA-256 hex conhecido de 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("resolveCoachAccount", () => {
  it("token certo devolve a conta do mapa", async () => {
    const segredo = await segredoCom([TOKEN, CONTA]);
    expect(await resolveCoachAccount(`Bearer ${TOKEN}`, segredo)).toBe(CONTA);
  });

  it("com dois tokens no mapa, cada um devolve a própria conta", async () => {
    const segredo = await segredoCom([TOKEN, CONTA], [OUTRO_TOKEN, OUTRA_CONTA]);
    expect(await resolveCoachAccount(`Bearer ${TOKEN}`, segredo)).toBe(CONTA);
    expect(await resolveCoachAccount(`Bearer ${OUTRO_TOKEN}`, segredo)).toBe(OUTRA_CONTA);
  });

  it("aceita o esquema Bearer em minúsculas", async () => {
    const segredo = await segredoCom([TOKEN, CONTA]);
    expect(await resolveCoachAccount(`bearer ${TOKEN}`, segredo)).toBe(CONTA);
  });

  it("token errado devolve nulo", async () => {
    const segredo = await segredoCom([TOKEN, CONTA]);
    expect(await resolveCoachAccount("Bearer efsc_errado", segredo)).toBeNull();
  });

  it("token vazio, sem Bearer ou header ausente devolvem nulo", async () => {
    const segredo = await segredoCom([TOKEN, CONTA]);
    for (const header of ["Bearer ", "Bearer", TOKEN, `Basic ${TOKEN}`, "", null]) {
      expect(await resolveCoachAccount(header, segredo)).toBeNull();
    }
  });

  it("segredo ausente ou JSON quebrado devolve nulo", async () => {
    for (const segredo of [undefined, "", "{", "null", "[]", "42"]) {
      expect(await resolveCoachAccount(`Bearer ${TOKEN}`, segredo)).toBeNull();
    }
  });

  it("conta que não é texto não vale", async () => {
    const segredo = await segredoCom([TOKEN, 123]);
    expect(await resolveCoachAccount(`Bearer ${TOKEN}`, segredo)).toBeNull();
  });
});

describe("parseCoachParams", () => {
  const parse = (query: string) => parseCoachParams(new URLSearchParams(query));

  function erroDe(query: string): HttpError {
    try {
      parse(query);
    } catch (error) {
      if (error instanceof HttpError) return error;
      throw error;
    }
    throw new Error(`"${query}" deveria ter sido recusado`);
  }

  it("sem parâmetros, usa os padrões", () => {
    expect(parse("")).toEqual({ periodo_dias: 30, parado_dias: 7, followup_horas: 24, limite: 50 });
  });

  it("aceita os extremos de cada limite", () => {
    expect(parse("periodo_dias=1&parado_dias=1&followup_horas=1&limite=1")).toEqual({
      periodo_dias: 1,
      parado_dias: 1,
      followup_horas: 1,
      limite: 1,
    });
    expect(parse("periodo_dias=90&parado_dias=90&followup_horas=720&limite=200")).toEqual({
      periodo_dias: 90,
      parado_dias: 90,
      followup_horas: 720,
      limite: 200,
    });
  });

  it("fora do limite responde 400 com o nome do parâmetro", () => {
    for (const query of [
      "periodo_dias=0",
      "periodo_dias=91",
      "parado_dias=0",
      "parado_dias=91",
      "followup_horas=0",
      "followup_horas=721",
      "limite=0",
      "limite=201",
    ]) {
      const erro = erroDe(query);
      expect(erro.status).toBe(400);
      expect(erro.message).toContain(query.split("=")[0]);
    }
  });

  it("texto não numérico responde 400", () => {
    for (const query of [
      "limite=abc",
      "limite=10.5",
      "limite=-3",
      "limite=",
      "limite=1e2",
      "limite= 5",
    ]) {
      expect(erroDe(query).status).toBe(400);
    }
  });

  it("ignora parâmetro desconhecido", () => {
    expect(parse("foo=bar").limite).toBe(50);
  });
});
```

- [x] **Passo 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/sales-coach.test.ts`
Esperado: FAIL — `Failed to resolve import "../../supabase/functions/_shared/sales-coach"`.

- [x] **Passo 3: Implementar**

`supabase/functions/_shared/sales-coach.ts`:

```ts
// Entrada da API de leitura do Eleve Sales Coach: quem chama e com quais
// parametros. Deno-free: o Vitest importa este arquivo em Node.
//
// O token e nosso, nao um JWT do Supabase. O segredo SALES_COACH_TOKENS guarda so
// o SHA-256 de cada token, apontando para a conta que ele le: a conta nunca vem
// da requisicao.

import { constantTimeEqual } from "./hmac.ts";
import { HttpError } from "./http-error.ts";

export interface CoachParams {
  periodo_dias: number;
  parado_dias: number;
  followup_horas: number;
  limite: number;
}

const LIMITES: Record<keyof CoachParams, { padrao: number; min: number; max: number }> = {
  periodo_dias: { padrao: 30, min: 1, max: 90 },
  parado_dias: { padrao: 7, min: 1, max: 90 },
  followup_horas: { padrao: 24, min: 1, max: 720 },
  limite: { padrao: 50, min: 1, max: 200 },
};

export async function sha256Hex(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Conta dona do token, ou null. Segredo ausente ou quebrado recusa todo mundo. */
export async function resolveCoachAccount(
  authorization: string | null,
  tokensJson: string | undefined,
): Promise<string | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "")?.[1];
  if (!token) return null;

  let mapa: unknown;
  try {
    mapa = JSON.parse(tokensJson ?? "");
  } catch {
    return null;
  }
  if (!mapa || typeof mapa !== "object" || Array.isArray(mapa)) return null;

  const hash = await sha256Hex(token);
  let conta: string | null = null;
  for (const [hashGuardado, userId] of Object.entries(mapa)) {
    if (constantTimeEqual(hash, hashGuardado) && typeof userId === "string" && userId) {
      conta = userId;
    }
  }
  return conta;
}

export function parseCoachParams(query: URLSearchParams): CoachParams {
  const params = {} as CoachParams;
  for (const nome of Object.keys(LIMITES) as (keyof CoachParams)[]) {
    const { padrao, min, max } = LIMITES[nome];
    const valor = query.get(nome);
    if (valor === null) {
      params[nome] = padrao;
    } else if (/^\d+$/.test(valor) && Number(valor) >= min && Number(valor) <= max) {
      params[nome] = Number(valor);
    } else {
      throw new HttpError(400, `${nome} deve ser um inteiro de ${min} a ${max}`);
    }
  }
  return params;
}
```

- [x] **Passo 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/sales-coach.test.ts`
Esperado: PASS, 13 testes.

- [x] **Passo 5: Cobertura**

Em `vitest.config.ts`, dentro de `coverage.include`, depois de
`"supabase/functions/_shared/hmac.ts",`:

```ts
        "supabase/functions/_shared/sales-coach.ts",
```

Run: `npx vitest run --coverage 2>&1 | grep -E "sales-coach|All files|ERROR"`
Esperado: `sales-coach.ts` com 100% de linhas; nenhum `ERROR: Coverage`.

- [x] **Passo 6: Lint e suíte inteira**

```bash
npx prettier --check --end-of-line auto supabase/functions/_shared/sales-coach.ts tests/unit/sales-coach.test.ts vitest.config.ts
npx eslint supabase/functions/_shared/sales-coach.ts tests/unit/sales-coach.test.ts
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/_shared/sales-coach.ts
npx vitest run
```

Esperado: prettier e eslint limpos; `deno check` sem erro; **40 arquivos, 492 testes**.

- [x] **Passo 7: Commit**

```bash
git add supabase/functions/_shared/sales-coach.ts tests/unit/sales-coach.test.ts vitest.config.ts
git commit -m "feat(sales-coach): resolve a conta pelo hash do token e valida os parametros

O token do coach e nosso, nao JWT do Supabase: o segredo SALES_COACH_TOKENS
guarda so o SHA-256 de cada token, apontando para a conta. Segredo ausente ou
quebrado recusa todo mundo."
```

---

### Task 2: Função SQL `sales_coach_snapshot`

**Files:**
- Modify: `supabase/migrations/20260924192907_sales_coach_snapshot.sql` (criado vazio
  por `bash scripts/sb-staging.sh migration new sales_coach_snapshot`)

**Interfaces:**
- Produces: `public.sales_coach_snapshot(p_user_id uuid, p_periodo_dias integer,
  p_parado_dias integer, p_followup_horas integer, p_limite integer) returns jsonb`,
  executável só por `service_role`. Chaves do JSON: `gerado_em`, `conta`, `periodo`,
  `etapas_sem_classificacao`, `funil`, `resultado_periodo`, `perdas_por_motivo`,
  `totais`, `follow_ups_atrasados`, `leads_parados`, `tarefas_atrasadas`.

- [x] **Passo 1: Escrever a migration**

```sql
-- Leitura do comercial de uma conta para o Eleve Sales Coach, servida pela Edge
-- Function sales-coach. Spec: docs/specs/2026-09-23-sales-coach-api-design.md.
--
-- Isolamento: toda CTE filtra user_id = p_user_id, e so o service_role executa.
-- O p_user_id sai do token resolvido na Edge Function, nunca da requisicao. Sem o
-- REVOKE, o default privileges do schema public daria EXECUTE a anon e
-- authenticated, e qualquer usuario logado leria outra conta pelo PostgREST.

CREATE OR REPLACE FUNCTION public.sales_coach_snapshot(
  p_user_id uuid,
  p_periodo_dias integer,
  p_parado_dias integer,
  p_followup_horas integer,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH janela AS (
  SELECT now() - make_interval(days => p_periodo_dias) AS de, now() AS ate
),
etapas AS (
  SELECT s.id, btrim(s.name) AS nome, s.funnel_key, s.position, s.created_at
    FROM public.pipeline_stages s
   WHERE s.user_id = p_user_id
),
leads_conta AS (
  SELECT l.id, l.name, l.company, l.city, l.stage_id, l.created_at, l.is_suppressed
    FROM public.leads l
   WHERE l.user_id = p_user_id
     AND l.is_test IS NOT TRUE
),
-- Envio que falhou nao e contato.
ultima_msg AS (
  SELECT DISTINCT ON (m.lead_id) m.lead_id, m.direction, m.content, m.created_at
    FROM public.messages m
   WHERE m.user_id = p_user_id
     AND (m.direction <> 'outbound' OR m.status IS DISTINCT FROM 'failed')
   ORDER BY m.lead_id, m.created_at DESC NULLS LAST, m.id DESC
),
eventos AS (
  SELECT ev.lead_id, ev.to_stage_id
    FROM public.lead_stage_events ev
    JOIN leads_conta l ON l.id = ev.lead_id
    CROSS JOIN janela j
   WHERE ev.user_id = p_user_id
     AND ev.occurred_at BETWEEN j.de AND j.ate
),
-- Mesma regra do Dashboard (calculateResponseRate): respondeu na janela quem
-- recebeu envio na janela.
contatados AS (
  SELECT DISTINCT m.lead_id
    FROM public.messages m
    JOIN leads_conta l ON l.id = m.lead_id
    CROSS JOIN janela j
   WHERE m.user_id = p_user_id
     AND m.direction = 'outbound'
     AND m.status = 'sent'
     AND m.created_at BETWEEN j.de AND j.ate
),
responderam AS (
  SELECT DISTINCT m.lead_id
    FROM public.messages m
    JOIN contatados c ON c.lead_id = m.lead_id
    CROSS JOIN janela j
   WHERE m.user_id = p_user_id
     AND m.direction = 'inbound'
     AND m.created_at BETWEEN j.de AND j.ate
),
-- As tres listas ficam sem corte aqui: "totais" conta tudo, e so a lista
-- devolvida para em p_limite.
follow_ups AS (
  SELECT l.id, l.name, l.company, l.city, e.nome AS etapa, u.created_at AS msg_em, u.content
    FROM leads_conta l
    JOIN ultima_msg u ON u.lead_id = l.id
    LEFT JOIN etapas e ON e.id = l.stage_id
   WHERE NOT l.is_suppressed
     AND COALESCE(e.funnel_key, '') NOT IN ('won', 'lost')
     AND u.direction = 'inbound'
     AND u.created_at < now() - make_interval(hours => p_followup_horas)
),
-- Prospeccao fica de fora: centenas de leads frios esperando o primeiro contato
-- enterrariam a lista.
parados AS (
  SELECT l.id, l.name, l.company, e.nome AS etapa,
         COALESCE(u.created_at, l.created_at) AS ultimo_contato
    FROM leads_conta l
    LEFT JOIN ultima_msg u ON u.lead_id = l.id
    LEFT JOIN etapas e ON e.id = l.stage_id
   WHERE NOT l.is_suppressed
     AND COALESCE(e.funnel_key, '') NOT IN ('won', 'lost', 'prospecting')
     AND COALESCE(u.created_at, l.created_at) < now() - make_interval(days => p_parado_dias)
),
tarefas AS (
  SELECT t.title, t.due_date, t.priority
    FROM public.personal_tasks t
   WHERE t.user_id = p_user_id
     AND t.completed_at IS NULL
     AND t.due_date < now()
)
SELECT jsonb_build_object(
  'gerado_em', now(),
  'conta', (SELECT a.name FROM public.accounts a
             WHERE a.user_id = p_user_id ORDER BY a.created_at LIMIT 1),
  'periodo', (SELECT jsonb_build_object('dias', p_periodo_dias, 'de', j.de, 'ate', j.ate)
                FROM janela j),
  'etapas_sem_classificacao', COALESCE(
    (SELECT jsonb_agg(e.nome ORDER BY e.position NULLS LAST, e.created_at)
       FROM etapas e WHERE e.funnel_key IS NULL), '[]'::jsonb),
  'funil', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'etapa', e.nome,
              'tipo', e.funnel_key,
              'leads_agora', (SELECT count(*) FROM leads_conta l WHERE l.stage_id = e.id),
              'entradas_no_periodo', (SELECT count(DISTINCT ev.lead_id)
                                        FROM eventos ev WHERE ev.to_stage_id = e.id)
            ) ORDER BY e.position NULLS LAST, e.created_at)
       FROM etapas e), '[]'::jsonb),
  'resultado_periodo', jsonb_build_object(
    'leads_novos', (SELECT count(*) FROM leads_conta l CROSS JOIN janela j
                     WHERE l.created_at BETWEEN j.de AND j.ate),
    'ganhos', (SELECT count(DISTINCT ev.lead_id) FROM eventos ev
                 JOIN etapas e ON e.id = ev.to_stage_id WHERE e.funnel_key = 'won'),
    'perdas', (SELECT count(DISTINCT ev.lead_id) FROM eventos ev
                 JOIN etapas e ON e.id = ev.to_stage_id WHERE e.funnel_key = 'lost'),
    'taxa_resposta', (SELECT CASE WHEN c.n = 0 THEN 0 ELSE round(r.n::numeric / c.n, 2) END
                        FROM (SELECT count(*) AS n FROM contatados) c,
                             (SELECT count(*) AS n FROM responderam) r)
  ),
  'perdas_por_motivo', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('motivo', p.nome, 'leads', p.leads)
                      ORDER BY p.leads DESC, p.nome)
       FROM (SELECT e.nome, count(DISTINCT ev.lead_id) AS leads
               FROM eventos ev JOIN etapas e ON e.id = ev.to_stage_id
              WHERE e.funnel_key = 'lost'
              GROUP BY e.id, e.nome) p), '[]'::jsonb),
  'totais', jsonb_build_object(
    'follow_ups_atrasados', (SELECT count(*) FROM follow_ups),
    'leads_parados', (SELECT count(*) FROM parados),
    'tarefas_atrasadas', (SELECT count(*) FROM tarefas)
  ),
  -- Listas do atraso mais recente para o mais antigo: o historico migrado tem
  -- centenas de conversas de meses atras, e na ordem inversa elas escondiam as
  -- da semana. Decisao do dono em 2026-09-24.
  'follow_ups_atrasados', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'lead_id', f.id,
              'nome', f.name,
              'empresa', f.company,
              'cidade', f.city,
              'etapa', f.etapa,
              'ultima_msg_do_lead_em', f.msg_em,
              'horas_sem_resposta', floor(extract(epoch FROM now() - f.msg_em) / 3600)::int,
              'ultima_msg_do_lead', left(f.content, 200)
            ) ORDER BY f.msg_em DESC)
       FROM (SELECT * FROM follow_ups ORDER BY msg_em DESC LIMIT p_limite) f), '[]'::jsonb),
  'leads_parados', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'lead_id', p.id,
              'nome', p.name,
              'empresa', p.company,
              'etapa', p.etapa,
              'ultimo_contato_em', p.ultimo_contato,
              'dias_parado', floor(extract(epoch FROM now() - p.ultimo_contato) / 86400)::int
            ) ORDER BY p.ultimo_contato DESC)
       FROM (SELECT * FROM parados ORDER BY ultimo_contato DESC LIMIT p_limite) p), '[]'::jsonb),
  'tarefas_atrasadas', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'titulo', t.title,
              'vencimento', t.due_date,
              'prioridade', t.priority
            ) ORDER BY t.due_date DESC)
       FROM (SELECT * FROM tarefas ORDER BY due_date DESC LIMIT p_limite) t), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.sales_coach_snapshot(uuid, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_coach_snapshot(uuid, integer, integer, integer, integer)
  TO service_role;
```

- [x] **Passo 2: Validar o corpo contra produção, só leitura**

Sem Postgres local, o corpo roda como SELECT com parâmetros literais. Script
descartável, fora do repositório (`$TMP` = pasta temporária da sessão):

```js
// $TMP/corpo-para-select.mjs — uso: node corpo-para-select.mjs <migration> <user_id> <saida>
import { readFileSync, writeFileSync } from "node:fs";

const [, , origem, userId, saida] = process.argv;
const sql = readFileSync(origem, "utf8");
const corpo = sql.slice(sql.indexOf("AS $$") + 5, sql.lastIndexOf("$$;")).trim().replace(/;\s*$/, "");

// search_path = '' na funcao: tudo que nao e CTE precisa vir qualificado.
const semComentario = corpo.replace(/--[^\n]*/g, "");
const ctes = new Set(
  [...semComentario.matchAll(/(?:WITH|,)\s*([a-z_]+)\s+AS\s*\(/g)].map((m) => m[1]),
);
const alvos = [...semComentario.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)(\s*\()?/g)]
  .filter((m) => !m[2])
  .map((m) => m[1]);
const soltos = alvos.filter((a) => !a.startsWith("public.") && !ctes.has(a));
if (soltos.length) {
  console.error("Referencias sem schema:", [...new Set(soltos)]);
  process.exit(1);
}

const literais = {
  p_user_id: `'${userId}'::uuid`,
  p_periodo_dias: "30",
  p_parado_dias: "7",
  p_followup_horas: "24",
  p_limite: "50",
};
let consulta = corpo;
for (const [nome, valor] of Object.entries(literais)) {
  consulta = consulta.replace(new RegExp(`\\b${nome}\\b`, "g"), valor);
}
writeFileSync(saida, `-- Somente leitura: corpo da sales_coach_snapshot com literais.\n${consulta};\n`);
console.log(`ok: ${ctes.size} CTEs, ${alvos.length} FROM/JOIN, nenhum sem schema`);
```

```bash
M=supabase/migrations/20260924192907_sales_coach_snapshot.sql
node "$TMP/corpo-para-select.mjs" "$M" 14448933-86df-47d4-a082-df69dbddeff1 "$TMP/t-eleve-one.sql"
bash scripts/sb-staging.sh db query --linked --file "$(cygpath -w "$TMP/t-eleve-one.sql")"
```

Esperado: `ok: 10 CTEs, 41 FROM/JOIN, nenhum sem schema` e um JSON com as 11
chaves. Conferir sem imprimir dado de lead: `conta = "Eleve One"`,
`etapas_sem_classificacao = ["Respondeu", "lead morno / vai comprar"]`, `totais`
presente, `horas_sem_resposta` crescendo ao longo da lista. Referência de
2026-09-24: `totais` 219/454/0, follow-ups de 53 h a 721 h, parados de 8 a 21 dias.

- [x] **Passo 3: Commit**

```bash
git add supabase/migrations/20260924192907_sales_coach_snapshot.sql
git commit -m "feat(db): sales_coach_snapshot le o comercial de uma conta

Funcao SQL STABLE e SECURITY INVOKER: toda CTE filtra pela conta, e so o
service_role executa. Sem o REVOKE, o default privileges do schema public
daria EXECUTE a anon e authenticated, e um usuario logado leria outra conta
pelo PostgREST."
```

---

### Task 3: E2E contra produção (vermelho antes do deploy)

**Files:**
- Create: `tests/e2e/sales-coach.spec.ts`

**Interfaces:**
- Consumes: endpoint `GET /functions/v1/sales-coach` (Task 4), RPC
  `sales_coach_snapshot` (Task 2), `adminClient()` de `tests/e2e/helpers/agent-seed.ts`,
  `stagingUrl()`/`stagingPublishableKey()` de `tests/e2e/helpers/supabase-admin.ts`.
- Produces: variável `STAGING_SALES_COACH_E2E_TOKEN` exigida pela suíte.

- [x] **Passo 1: Escrever o E2E**

`tests/e2e/sales-coach.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { adminClient } from "./helpers/agent-seed";
import { stagingPublishableKey, stagingUrl } from "./helpers/supabase-admin";

const ENDPOINT = `${stagingUrl()}/functions/v1/sales-coach`;
const TOKEN = process.env.STAGING_SALES_COACH_E2E_TOKEN?.trim();

if (!TOKEN) {
  throw new Error("STAGING_SALES_COACH_E2E_TOKEN must be configured for E2E tests");
}

const E2E_EMAIL = "e2e@eleveflow.test";
const TELEFONE = "5511999990020";
const TEXTO = "Oi! Pode me mandar o orçamento? (E2E coach)";
const comToken = { Authorization: `Bearer ${TOKEN}` };

type ItemComLead = { lead_id: string; horas_sem_resposta?: number };

let userId = "";
let leadId = "";

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users.find((u) => u.email === E2E_EMAIL);
  if (!user) throw new Error(`usuário ${E2E_EMAIL} não existe`);
  userId = user.id;

  // Etapa própria, sem funnel_key e sem fluxo: pôr o lead nela não dispara o
  // trigger-flow-by-stage.
  let { data: etapa } = await admin
    .from("pipeline_stages")
    .select("id")
    .eq("user_id", userId)
    .eq("name", "Coach E2E")
    .maybeSingle();
  if (!etapa) {
    const criada = await admin
      .from("pipeline_stages")
      .insert({ user_id: userId, name: "Coach E2E", position: 95 })
      .select("id")
      .single();
    if (criada.error) throw criada.error;
    etapa = criada.data;
  }

  await admin.from("leads").delete().eq("user_id", userId).eq("phone", TELEFONE);
  const lead = await admin
    .from("leads")
    .insert({
      user_id: userId,
      name: "Lead Coach E2E",
      phone: TELEFONE,
      company: "Empresa Coach E2E",
      city: "Vitória",
      stage_id: etapa!.id,
    })
    .select("id")
    .single();
  if (lead.error) throw lead.error;
  leadId = lead.data.id;

  const mensagem = await admin.from("messages").insert({
    user_id: userId,
    lead_id: leadId,
    direction: "inbound",
    status: "received",
    content: TEXTO,
    created_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
  });
  if (mensagem.error) throw mensagem.error;
});

test.afterAll(async () => {
  // O lead fictício não pode sobreviver: apareceria como contato real da conta.
  if (!leadId) return;
  const admin = adminClient();
  await admin.from("messages").delete().eq("lead_id", leadId);
  await admin.from("leads").delete().eq("id", leadId);
});

test("sem token responde 401", async ({ request }) => {
  const res = await request.get(ENDPOINT);
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "Unauthorized" });
});

test("token errado responde 401 com o mesmo corpo de sem token", async ({ request }) => {
  const res = await request.get(ENDPOINT, {
    headers: { Authorization: `Bearer efsc_${"x".repeat(43)}` },
  });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "Unauthorized" });
});

test("POST responde 405", async ({ request }) => {
  const res = await request.post(ENDPOINT, { headers: comToken });
  expect(res.status()).toBe(405);
});

test("parâmetro fora do limite responde 400", async ({ request }) => {
  const res = await request.get(`${ENDPOINT}?limite=0`, { headers: comToken });
  expect(res.status()).toBe(400);
});

test("lead com mensagem inbound de 30 h aparece em follow_ups_atrasados", async ({ request }) => {
  const res = await request.get(ENDPOINT, { headers: comToken });
  expect(res.status()).toBe(200);
  const corpo = await res.json();

  const item = corpo.follow_ups_atrasados.find((i: ItemComLead) => i.lead_id === leadId);
  expect(item).toMatchObject({
    nome: "Lead Coach E2E",
    empresa: "Empresa Coach E2E",
    cidade: "Vitória",
    etapa: "Coach E2E",
    ultima_msg_do_lead: TEXTO,
  });
  expect(item.horas_sem_resposta).toBeGreaterThanOrEqual(30);
  expect(item.horas_sem_resposta).toBeLessThan(31);

  // Decisão 4 da spec: do atraso mais recente para o mais antigo, com o total.
  const horas = corpo.follow_ups_atrasados.map((i: ItemComLead) => i.horas_sem_resposta);
  expect(horas).toEqual([...horas].sort((a: number, b: number) => a - b));
  expect(corpo.totais.follow_ups_atrasados).toBeGreaterThanOrEqual(horas.length);
});

test("isolamento: todo lead devolvido é da conta do token", async ({ request }) => {
  const res = await request.get(`${ENDPOINT}?limite=200&parado_dias=1&followup_horas=1`, {
    headers: comToken,
  });
  expect(res.status()).toBe(200);
  const corpo = await res.json();

  const ids = [
    ...new Set(
      [...corpo.follow_ups_atrasados, ...corpo.leads_parados].map((i: ItemComLead) => i.lead_id),
    ),
  ];
  expect(ids).toContain(leadId);

  const admin = adminClient();
  const { data: donos, error } = await admin.from("leads").select("id, user_id").in("id", ids);
  expect(error).toBeNull();
  expect(donos).toHaveLength(ids.length);
  for (const dono of donos!) expect(dono.user_id).toBe(userId);

  const { data: conta } = await admin
    .from("accounts")
    .select("name")
    .eq("user_id", userId)
    .single();
  expect(corpo.conta).toBe(conta!.name);
});

test("RPC direta com JWT de usuário comum é negada", async () => {
  // Sessão do usuário de E2E sem senha: link mágico gerado pelo admin, sem e-mail.
  const admin = adminClient();
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: E2E_EMAIL,
  });
  if (error) throw error;

  const usuario = createClient(stagingUrl(), stagingPublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const sessao = await usuario.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (sessao.error || !sessao.data.session) throw sessao.error ?? new Error("sem sessão");

  const args = {
    p_user_id: userId,
    p_periodo_dias: 30,
    p_parado_dias: 7,
    p_followup_horas: 24,
    p_limite: 50,
  };
  try {
    const comoUsuario = await usuario.rpc("sales_coach_snapshot", args);
    expect(comoUsuario.error?.code).toBe("42501");
    expect(comoUsuario.data).toBeNull();
  } finally {
    await usuario.auth.signOut({ scope: "local" });
  }

  const anonimo = createClient(stagingUrl(), stagingPublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const comoAnonimo = await anonimo.rpc("sales_coach_snapshot", args);
  expect(comoAnonimo.error?.code).toBe("42501");
});
```

- [x] **Passo 2: Rodar e ver falhar pelo motivo certo**

Token provisório só para esta rodada; o real nasce na Task 5. `E2E_BASE_URL` aponta
para o front publicado só para o Playwright não subir o dev server local: estes
testes usam URL absoluta.

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" STAGING_SALES_COACH_E2E_TOKEN=efsc_provisorio \
  E2E_BASE_URL=https://eleveflow-tan.vercel.app npx playwright test tests/e2e/sales-coach.spec.ts
```

Esperado: os 7 FALHAM. Os de endpoint recebem `404` (função não publicada); o do
RPC recebe `PGRST202` em vez de `42501` (função não existe). Qualquer outra falha
(erro de seed, import) tem de ser corrigida antes de seguir.

- [x] **Passo 3: Lint e commit**

```bash
npx prettier --check --end-of-line auto tests/e2e/sales-coach.spec.ts
npx eslint tests/e2e/sales-coach.spec.ts
git add tests/e2e/sales-coach.spec.ts
git commit -m "test(e2e): sales-coach com isolamento entre contas e prova do REVOKE

Contra producao, com o usuario de E2E: 401 sem token e com token errado, 405
no POST, 400 em parametro fora do limite, lead semeado com inbound de 30 h em
follow_ups_atrasados, todo lead devolvido da conta do token e RPC direta
negada para usuario comum e anonimo."
```

---

### Task 4: Edge Function `sales-coach`

**Files:**
- Create: `supabase/functions/sales-coach/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `resolveCoachAccount`, `parseCoachParams` (Task 1);
  `sales_coach_snapshot` (Task 2); `createServiceRoleClient` de
  `_shared/supabase.ts`; `HttpError` de `_shared/http-error.ts`.
- Produces: `GET /functions/v1/sales-coach` — 200 JSON da função SQL; 401
  `{"error":"Unauthorized"}`; 405; 400 `{"error":"<parametro> deve ser ..."}`; 500
  `{"error":"Internal error"}`.

- [x] **Passo 1: Escrever o handler**

`supabase/functions/sales-coach/index.ts`:

```ts
// API de leitura do Eleve Sales Coach: GET com token proprio, que devolve o
// retrato comercial da conta dona do token. Spec:
// docs/specs/2026-09-23-sales-coach-api-design.md.
//
// Sem CORS de proposito: quem chama e o servidor do Eleve Office, nunca um
// navegador. O token nao e JWT do Supabase (verify_jwt = false no config.toml).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { HttpError } from "../_shared/http-error.ts";
import { parseCoachParams, resolveCoachAccount } from "../_shared/sales-coach.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const userId = await resolveCoachAccount(
    req.headers.get("authorization"),
    Deno.env.get("SALES_COACH_TOKENS"),
  );
  // Mesmo corpo para token ausente e errado: a resposta nao diz qual dos dois.
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const inicio = Date.now();
  try {
    const params = parseCoachParams(new URL(req.url).searchParams);
    const { data, error } = await createServiceRoleClient().rpc("sales_coach_snapshot", {
      p_user_id: userId,
      p_periodo_dias: params.periodo_dias,
      p_parado_dias: params.parado_dias,
      p_followup_horas: params.followup_horas,
      p_limite: params.limite,
    });
    if (error) throw new Error(error.message);

    console.log(
      JSON.stringify({
        event: "sales_coach_snapshot",
        user_id: userId,
        totais: data.totais,
        limite: params.limite,
        ms: Date.now() - inicio,
      }),
    );
    return json(data);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({
        event: "sales_coach_error",
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - inicio,
      }),
    );
    return json({ error: "Internal error" }, 500);
  }
});
```

- [x] **Passo 2: `config.toml`**

Ao fim de `supabase/config.toml`:

```toml

# Token proprio do Sales Coach, nao JWT do Supabase: a funcao compara o SHA-256
# do Bearer com o segredo SALES_COACH_TOKENS. Ver _shared/sales-coach.ts.
[functions.sales-coach]
verify_jwt = false
```

- [x] **Passo 3: Checar**

```bash
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/sales-coach/index.ts
npx prettier --check --end-of-line auto supabase/functions/sales-coach/index.ts
npx eslint supabase/functions/sales-coach/index.ts
```

Esperado: os três limpos. O verde de comportamento vem do E2E, na Task 5.

- [x] **Passo 4: Commit**

```bash
git add supabase/functions/sales-coach/index.ts supabase/config.toml
git commit -m "feat(sales-coach): endpoint de leitura para o Eleve Sales Coach

GET com token proprio: metodo, token para conta, parametros, rpc. Mesmo 401
para token ausente e errado; 500 generico com o detalhe so no log. Sem CORS:
quem chama e o servidor do Eleve Office."
```

---

### Task 5: Implantação — gate do dono

**Nada desta task roda sem OK explícito do dono** (`db push`, deploy, segredo).

- [x] **Passo 1: Pedir o OK**, com o que vai acontecer: migration aditiva (uma
  função), deploy de uma função nova, segredo novo só com o hash do token de E2E.

- [x] **Passo 2: Conferir o que o push leva**

```bash
bash scripts/sb-staging.sh db push --dry-run
```

Esperado: só `20260924192907_sales_coach_snapshot.sql`. Qualquer outra migration
pendente = parar e investigar.

- [x] **Passo 3: Push e conferência do ACL**

```bash
bash scripts/sb-staging.sh db push
echo "select array_to_string(proacl, ' ') as acl from pg_proc where proname = 'sales_coach_snapshot';" > "$TMP/q-acl.sql"
bash scripts/sb-staging.sh db query --linked --file "$(cygpath -w "$TMP/q-acl.sql")"
```

Esperado: `postgres=X/postgres service_role=X/postgres` — sem `anon`, sem
`authenticated`, sem `=X/` (PUBLIC).

- [x] **Passo 4: Token do E2E**

Texto só no `.env.staging`; na tela, só o hash.

```bash
node -e "
const c = require('node:crypto');
const fs = require('node:fs');
const token = 'efsc_' + c.randomBytes(32).toString('base64url');
fs.appendFileSync('.env.staging', '\nSTAGING_SALES_COACH_E2E_TOKEN=' + token + '\n');
console.log(c.createHash('sha256').update(token).digest('hex'));
"
```

- [x] **Passo 5: Segredo**

JSON com aspas não atravessa `npx.cmd` na linha de comando: vai por arquivo, apagado
em seguida. Usuário de E2E: `ad3d7aef-f897-425c-a2b7-7b804a1b650d`.

```bash
printf "SALES_COACH_TOKENS='{\"%s\":\"%s\"}'\n" "<hash do passo 4>" "ad3d7aef-f897-425c-a2b7-7b804a1b650d" > "$TMP/sales-coach.env"
bash scripts/sb-staging.sh secrets set --env-file "$(cygpath -w "$TMP/sales-coach.env")"
rm "$TMP/sales-coach.env"
bash scripts/sb-staging.sh secrets list | grep SALES_COACH_TOKENS
```

- [x] **Passo 6: Deploy**

```bash
bash scripts/sb-staging.sh functions deploy sales-coach --use-api
```

- [x] **Passo 7: E2E verde**

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" E2E_BASE_URL=https://eleveflow-tan.vercel.app \
  npx playwright test tests/e2e/sales-coach.spec.ts
```

Esperado: 7 passed.

- [x] **Passo 8: Smoke no ar**

```bash
set -a; source .env.staging; set +a
U="$VITE_SUPABASE_URL/functions/v1/sales-coach"
curl -s --ssl-no-revoke -o /dev/null -w "sem token: %{http_code}\n" "$U"
curl -s --ssl-no-revoke -o /dev/null -w "com token: %{http_code}\n" -H "Authorization: Bearer $STAGING_SALES_COACH_E2E_TOKEN" "$U"
```

Esperado: `sem token: 401`, `com token: 200`.

- [x] **Passo 9: STATUS.md e commit**

Seção nova no topo do `STATUS.md`: o que foi publicado, a saída do E2E e do
smoke, o formato do segredo, como gerar e revogar token, e o que falta (Task 6).

```bash
git add STATUS.md
git commit -m "docs: registra a API de leitura do Sales Coach em producao"
```

---

### Task 6: Eleve Office — gate do dono e acesso à VPS

- [x] **Passo 1: Pedir ao dono** o acesso à VPS do Eleve Office e onde o serviço lê
  o token (arquivo de ambiente e nome da variável).

- [x] **Passo 2: Gerar o token do Eleve Office**, mostrado uma vez ao dono:

```bash
node -e "
const c = require('node:crypto');
const token = 'efsc_' + c.randomBytes(32).toString('base64url');
console.log(token);
console.log(c.createHash('sha256').update(token).digest('hex'));
"
```

- [ ] **Passo 3: Instalar o token na VPS**, sem gravar o texto nesta máquina. Decisão
  do dono em 2026-09-24: quem instala é o agente do Eleve Office, por um prompt que o
  dono levou.

- [x] **Passo 4: Segredo com os dois hashes** (OK do dono). O hash do E2E sai de
  novo do `.env.staging`; conta da Eleve One: `14448933-86df-47d4-a082-df69dbddeff1`.

```bash
set -a; source .env.staging; set +a
E2E_HASH=$(node -e "console.log(require('node:crypto').createHash('sha256').update(process.env.STAGING_SALES_COACH_E2E_TOKEN).digest('hex'))")
printf "SALES_COACH_TOKENS='{\"%s\":\"%s\",\"%s\":\"%s\"}'\n" \
  "$E2E_HASH" "ad3d7aef-f897-425c-a2b7-7b804a1b650d" \
  "<hash do passo 2>" "14448933-86df-47d4-a082-df69dbddeff1" > "$TMP/sales-coach.env"
bash scripts/sb-staging.sh secrets set --env-file "$(cygpath -w "$TMP/sales-coach.env")"
rm "$TMP/sales-coach.env"
```

- [ ] **Passo 5: Conferir da VPS**: `curl` sem token dá 401; com token dá 200 e
  `"conta": "Eleve One"`. Rodar de novo o E2E (o token dele continua valendo). Feito
  daqui em 2026-09-24 (200, conta Eleve One; E2E 7 passed); falta o aceite de lá.

- [x] **Passo 6: STATUS.md e commit**

```bash
git add STATUS.md
git commit -m "docs: registra o token do Eleve Office instalado e conferido"
```
