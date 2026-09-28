# Tarefas pela API do Eleve Office (parte C): plano de implementação

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` ou `superpowers:executing-plans` para
> implementar tarefa a tarefa. Os passos usam checkbox (`- [x]`).

**Objetivo:** o Nexo (orquestrador do Office) lê, cria, altera e entrega tarefas do
EleveFlow pela `office-api`, com idempotência na criação, controle de conflito por versão,
histórico e exclusões; o dono revisa e conclui na tela Minhas Tarefas.

**Arquitetura:** `personal_tasks` ganha colunas aditivas (lead, criador, responsável,
origem, ordem externa, resultado, versão, chave de idempotência) e o status
`aguardando_revisao`. Triggers cuidam da versão, do lead da conta, do histórico e do
tombstone. As regras que precisam ser atômicas (versão, transição de status, chave) ficam
em funções SQL `office_tarefa_*`, chamadas só pelo `service_role`; a Edge Function valida
corpo e cabeçalhos, escolhe o escopo pelo método e traduz o resultado da função em status
HTTP.

**Stack:** Postgres (plpgsql), Edge Functions (Deno 2), Vitest, Playwright, React 19.

**Spec:** `docs/specs/2026-09-25-tarefas-office-design.md`.

**Base:** `feat/f1-evolution-provider`, `6a15f10`. Linha de base: 47 arquivos, 560 testes.

## Global Constraints

- Português do Brasil em commits, comentários e docs; mensagem de commit sem acentuação.
- Conventional Commits atômicos. **Sem rastro de IA** (nenhum Co-Authored-By).
- **TDD:** teste, ver falhar, implementar, ver passar.
- **Nada declarado pronto sem a saída do comando.**
- `_shared/`: sem `import` por URL e sem `Deno.env`.
- Banco só aditivo: coluna, tabela, índice, função e trigger novos. `DROP ... IF EXISTS`
  só para recriar constraint ou trigger, e o `DROP FUNCTION` de `office_exclusoes`, que
  troca de assinatura (o padrão do parâmetro novo mantém a chamada atual funcionando
  entre a migration e o deploy).
- **A conta nunca vem da requisição.** Nunca logar token, hash, texto de tarefa nem dado
  de lead. O histórico guarda nomes de campo e status, não texto.
- **Nenhuma rota conclui, apaga ou reabre tarefa.** Quem conclui é o dono, na tela.
- **Gate do dono:** ensaio da migration, migration, tokens, deploy da função, deploy do
  frontend e token do Nexo só com OK.
- Todo comando Supabase via `bash scripts/sb-staging.sh` (é **produção**).
- Cobertura: gate de 80%; módulo novo entra em `coverage.include`.
- Tela: skill `frontend-design`.

## Esclarecimentos sobre a spec (registrados nela na Task 1)

1. **Exclusões por escopo.** O token do Nexo não tem `comercial:leitura`; para ver a
   tarefa apagada, `GET /v1/exclusoes` aceita `comercial:leitura` **ou**
   `tarefas:leitura`, e cada escopo vê as entidades dele (lead e mensagem; tarefa).
2. **Ator `sistema`.** Escrita sem usuário logado e fora da API (script, service_role)
   fica no histórico como `sistema`, não como `tela`.
3. **Repetição com a mesma chave:** devolve a tarefa já criada sem aplicar o corpo, mas o
   corpo ainda passa pela validação (400 se inválido).
4. **Tamanhos:** título até 300 caracteres, descrição até 10.000, referências e ids
   externos até 200, resultado até 5.000, link do resultado até 2.000 (http ou https),
   `Idempotency-Key` de 1 a 200 caracteres visíveis sem espaço.
5. **409 e 412 levam a tarefa atual** em `tarefa`, para o Office decidir sem reler.
6. **405** traz o header `Allow` com os métodos da rota.

## Arquivos

| arquivo | responsabilidade |
|---|---|
| `supabase/migrations/20260925182501_tarefas_office.sql` | colunas, status, histórico, triggers, funções `office_tarefa*`, exclusões por escopo |
| `supabase/functions/_shared/api-token.ts` | token resolvido ganha o rótulo (ator do histórico) |
| `supabase/functions/_shared/office-api/erros.ts` | código por status; erro com a tarefa atual |
| `supabase/functions/_shared/office-api/rotas.ts` | rotas com escopo por método |
| `supabase/functions/_shared/office-api/tarefas-corpo.ts` | corpo, `If-Match`, `Idempotency-Key`, filtros |
| `supabase/functions/_shared/office-api/rpc.ts` | chamada de função SQL |
| `supabase/functions/_shared/office-api/tarefas.ts` | rotas de tarefa → função SQL → status HTTP |
| `supabase/functions/_shared/office-api/atender.ts` | pedido completo; exclusões por escopo; delega tarefas |
| `supabase/functions/office-api/index.ts`, `openapi.json` | método por rota, corpo JSON, ator; contrato |
| `src/lib/tarefas.ts`, `src/pages/Tasks.tsx`, `src/integrations/supabase/types.ts` | tela Minhas Tarefas |
| `tests/unit/*`, `tests/e2e/office-api-tarefas.spec.ts`, `tests/e2e/office-api.spec.ts` | testes |
| `docs/api/office-api.md`, `STATUS.md` | guia do Office e status |

---

### Task 1: Migration das tarefas

**Files:** Modify `supabase/migrations/20260925182501_tarefas_office.sql` (criado vazio
pelo `migration new`); Modify `docs/specs/2026-09-25-tarefas-office-design.md`.

**Interfaces — Produces:**

- colunas novas em `personal_tasks`: `origin`, `lead_id`, `project_ref`, `creator_type`,
  `creator_ref`, `assignee_type`, `assignee_ref`, `external_order_id`, `result`,
  `result_ref`, `version`, `idempotency_key`; status `aguardando_revisao`;
- tabela `personal_task_history(id, task_id, user_id, actor, action, fields, status_from,
  status_to, created_at)`; `api_deleted_records.entity` aceita `task`;
- `office_tarefas(p_user_id uuid, p_tarefa_id uuid, p_cursor_ts timestamptz, p_cursor_id
  uuid, p_limite integer, p_status text, p_responsavel_tipo text, p_responsavel_ref text,
  p_atualizado_desde timestamptz) → jsonb` (lista de tarefas, até `p_limite + 1`);
- `office_tarefa_criar(p_user_id uuid, p_ator text, p_chave text, p_dados jsonb) → jsonb`,
  `office_tarefa_alterar(p_user_id uuid, p_ator text, p_tarefa_id uuid, p_versao integer,
  p_campos jsonb) → jsonb`, `office_tarefa_entregar(p_user_id uuid, p_ator text,
  p_tarefa_id uuid, p_versao integer, p_resultado text, p_resultado_ref text) → jsonb`,
  todas devolvendo `{resultado, tarefa?}` com `resultado` em `criada`, `repetida`, `ok`,
  `nao_encontrada`, `versao`, `transicao`, `lead_invalido`;
- `p_dados` e `p_campos` usam os **nomes das colunas** (`title`, `description`,
  `priority`, `due_date`, `lead_id`, `project_ref`, `creator_ref`, `assignee_type`,
  `assignee_ref`, `external_order_id`, `status`), com os valores do banco;
- `office_exclusoes(p_user_id uuid, p_cursor_ts timestamptz, p_cursor_id bigint,
  p_limite integer, p_entidades text[] DEFAULT ARRAY['lead','message'])`.

A migration não tem teste unitário: é conferida pelo ensaio com ROLLBACK (Task 10) e
pelo E2E da Task 9, que falha antes da implantação.

- [x] **Passo 1: Migration**

Arquivo: `supabase/migrations/20260925182501_tarefas_office.sql`

```sql
-- Tarefas pelo Eleve Office (parte C). O EleveFlow e o registro da tarefa: o Nexo
-- cria, altera e entrega pela office-api; so o dono conclui, na tela. Agente nunca
-- vira usuario: e o tipo 'agente' com a referencia do Office.
-- Spec: docs/specs/2026-09-25-tarefas-office-design.md.

ALTER TABLE public.personal_tasks
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'eleveflow'
    CHECK (origin IN ('eleveflow', 'eleve_office')),
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_ref text CHECK (char_length(project_ref) <= 200),
  ADD COLUMN IF NOT EXISTS creator_type text NOT NULL DEFAULT 'dono'
    CHECK (creator_type IN ('dono', 'agente')),
  ADD COLUMN IF NOT EXISTS creator_ref text CHECK (char_length(creator_ref) <= 200),
  ADD COLUMN IF NOT EXISTS assignee_type text NOT NULL DEFAULT 'dono'
    CHECK (assignee_type IN ('dono', 'agente')),
  ADD COLUMN IF NOT EXISTS assignee_ref text CHECK (char_length(assignee_ref) <= 200),
  ADD COLUMN IF NOT EXISTS external_order_id text CHECK (char_length(external_order_id) <= 200),
  ADD COLUMN IF NOT EXISTS result text CHECK (char_length(result) <= 5000),
  ADD COLUMN IF NOT EXISTS result_ref text CHECK (char_length(result_ref) <= 2000),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key text
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200);

ALTER TABLE public.personal_tasks DROP CONSTRAINT IF EXISTS personal_tasks_status_check;
ALTER TABLE public.personal_tasks ADD CONSTRAINT personal_tasks_status_check
  CHECK (status IN ('pending', 'in_progress', 'aguardando_revisao', 'done'));

-- Agente sempre com a referencia do Office; dono sem.
ALTER TABLE public.personal_tasks DROP CONSTRAINT IF EXISTS personal_tasks_responsavel_ref_check;
ALTER TABLE public.personal_tasks ADD CONSTRAINT personal_tasks_responsavel_ref_check
  CHECK ((assignee_type = 'agente') = (assignee_ref IS NOT NULL));

-- A mesma chave na mesma conta e a mesma tarefa: repetir o POST nao duplica.
ALTER TABLE public.personal_tasks DROP CONSTRAINT IF EXISTS personal_tasks_idempotency_key_key;
ALTER TABLE public.personal_tasks ADD CONSTRAINT personal_tasks_idempotency_key_key
  UNIQUE (user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS personal_tasks_user_updated_idx
  ON public.personal_tasks (user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS personal_tasks_lead_idx
  ON public.personal_tasks (lead_id) WHERE lead_id IS NOT NULL;

-- Historico: quem mudou, quais campos e o status, sem o texto. Sem FK para a tarefa:
-- sobrevive a exclusao.
CREATE TABLE IF NOT EXISTS public.personal_task_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL,
  user_id uuid NOT NULL,
  actor text NOT NULL,
  action text NOT NULL CHECK (action IN ('criacao', 'alteracao')),
  fields text[] NOT NULL DEFAULT '{}',
  status_from text,
  status_to text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_task_history_task_idx
  ON public.personal_task_history (task_id, id);
ALTER TABLE public.personal_task_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.personal_task_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.personal_task_history TO service_role;

ALTER TABLE public.api_deleted_records DROP CONSTRAINT IF EXISTS api_deleted_records_entity_check;
ALTER TABLE public.api_deleted_records ADD CONSTRAINT api_deleted_records_entity_check
  CHECK (entity IN ('lead', 'message', 'task'));

-- Versao para o If-Match: sobe em toda alteracao de fato, pela tela ou pela API. O
-- valor mandado por quem grava e ignorado.
CREATE OR REPLACE FUNCTION public.personal_tasks_versao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSIF (to_jsonb(NEW) - 'updated_at' - 'version')
        IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'version') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$;

-- Lead vinculado e da conta da tarefa. Pela tela o RLS de leads ja esconde lead
-- alheio; pela API (service_role) vale a comparacao de user_id.
CREATE OR REPLACE FUNCTION public.personal_tasks_lead_da_conta()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l WHERE l.id = NEW.lead_id AND l.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'lead_id fora da conta da tarefa' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

-- SECURITY DEFINER: a tela (authenticated) altera tarefa, mas nao escreve no
-- historico. O ator vem da funcao da API (set_config local da transacao); sem ele e a
-- tela quando ha usuario logado, ou sistema (script, service_role).
CREATE OR REPLACE FUNCTION public.personal_tasks_historico()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ator text := COALESCE(
    NULLIF(current_setting('eleveflow.ator_tarefa', true), ''),
    CASE WHEN auth.uid() IS NULL THEN 'sistema' ELSE 'tela' END);
  v_campos text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.personal_task_history (task_id, user_id, actor, action, status_to)
    VALUES (NEW.id, NEW.user_id, v_ator, 'criacao', NEW.status);
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(n.key ORDER BY n.key), '{}')
    INTO v_campos
    FROM jsonb_each(to_jsonb(NEW)) n
    JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
   WHERE n.value IS DISTINCT FROM o.value
     AND n.key NOT IN ('updated_at', 'version');

  IF cardinality(v_campos) > 0 THEN
    INSERT INTO public.personal_task_history
      (task_id, user_id, actor, action, fields, status_from, status_to)
    VALUES (NEW.id, NEW.user_id, v_ator, 'alteracao', v_campos, OLD.status, NEW.status);
  END IF;
  RETURN NULL;
END;
$$;

-- SECURITY DEFINER pelo mesmo motivo: quem apaga pela tela nao escreve em
-- api_deleted_records.
CREATE OR REPLACE FUNCTION public.record_deleted_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.api_deleted_records (user_id, entity, entity_id)
  VALUES (OLD.user_id, 'task', OLD.id);
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.personal_tasks_versao() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.personal_tasks_lead_da_conta() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.personal_tasks_historico() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_deleted_task() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS personal_tasks_versao ON public.personal_tasks;
CREATE TRIGGER personal_tasks_versao
  BEFORE INSERT OR UPDATE ON public.personal_tasks
  FOR EACH ROW EXECUTE FUNCTION public.personal_tasks_versao();

DROP TRIGGER IF EXISTS personal_tasks_lead_da_conta ON public.personal_tasks;
CREATE TRIGGER personal_tasks_lead_da_conta
  BEFORE INSERT OR UPDATE OF lead_id, user_id ON public.personal_tasks
  FOR EACH ROW EXECUTE FUNCTION public.personal_tasks_lead_da_conta();

DROP TRIGGER IF EXISTS personal_tasks_historico ON public.personal_tasks;
CREATE TRIGGER personal_tasks_historico
  AFTER INSERT OR UPDATE ON public.personal_tasks
  FOR EACH ROW EXECUTE FUNCTION public.personal_tasks_historico();

DROP TRIGGER IF EXISTS personal_tasks_record_deleted ON public.personal_tasks;
CREATE TRIGGER personal_tasks_record_deleted
  AFTER DELETE ON public.personal_tasks
  FOR EACH ROW EXECUTE FUNCTION public.record_deleted_task();

-- Tarefa na API, no mesmo formato em toda rota.
CREATE OR REPLACE FUNCTION public.office_tarefa_json(t public.personal_tasks)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
SELECT jsonb_build_object(
  'tarefa_id', t.id,
  'conta_id', t.user_id,
  'titulo', t.title,
  'descricao', t.description,
  'prioridade', CASE t.priority WHEN 'low' THEN 'baixa' WHEN 'medium' THEN 'media'
                                WHEN 'high' THEN 'alta' END,
  'status', CASE t.status WHEN 'pending' THEN 'pendente' WHEN 'in_progress' THEN 'em_andamento'
                          WHEN 'aguardando_revisao' THEN 'aguardando_revisao'
                          WHEN 'done' THEN 'concluida' END,
  'criador', jsonb_build_object('tipo', t.creator_type, 'ref', t.creator_ref),
  'responsavel', jsonb_build_object('tipo', t.assignee_type, 'ref', t.assignee_ref),
  'prazo', t.due_date,
  'lead_id', t.lead_id,
  'projeto_ref', t.project_ref,
  'origem', t.origin,
  'ordem_externa_id', t.external_order_id,
  'resultado', t.result,
  'resultado_ref', t.result_ref,
  'versao', t.version,
  'criada_em', t.created_at,
  'atualizada_em', t.updated_at,
  'concluida_em', t.completed_at
);
$$;

-- Lista (p_tarefa_id nulo) ou uma tarefa. A lista ordena por (updated_at, id) e deixa
-- de fora os ultimos 5 s, como os outros feeds.
CREATE OR REPLACE FUNCTION public.office_tarefas(
  p_user_id uuid,
  p_tarefa_id uuid,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer,
  p_status text,
  p_responsavel_tipo text,
  p_responsavel_ref text,
  p_atualizado_desde timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
SELECT COALESCE(jsonb_agg(public.office_tarefa_json(p.t)
                          ORDER BY (p.t).updated_at, (p.t).id), '[]'::jsonb)
FROM (
  SELECT t
    FROM public.personal_tasks t
   WHERE t.user_id = p_user_id
     AND ((p_tarefa_id IS NOT NULL AND t.id = p_tarefa_id)
          OR (p_tarefa_id IS NULL AND t.updated_at <= now() - interval '5 seconds'))
     AND (p_status IS NULL OR t.status = p_status)
     AND (p_responsavel_tipo IS NULL OR t.assignee_type = p_responsavel_tipo)
     AND (p_responsavel_ref IS NULL OR t.assignee_ref = p_responsavel_ref)
     AND (p_atualizado_desde IS NULL OR t.updated_at >= p_atualizado_desde)
     AND (p_cursor_ts IS NULL OR (t.updated_at, t.id) > (p_cursor_ts, p_cursor_id))
   ORDER BY t.updated_at, t.id
   LIMIT p_limite + 1
) p;
$$;

-- Escrita. Cada funcao marca o ator da transacao para o historico e devolve
-- {resultado, tarefa}; a Edge Function traduz o resultado em status HTTP.
CREATE OR REPLACE FUNCTION public.office_tarefa_criar(
  p_user_id uuid,
  p_ator text,
  p_chave text,
  p_dados jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tarefa public.personal_tasks;
BEGIN
  PERFORM set_config('eleveflow.ator_tarefa', p_ator, true);

  SELECT * INTO v_tarefa FROM public.personal_tasks t
   WHERE t.user_id = p_user_id AND t.idempotency_key = p_chave;
  IF FOUND THEN
    RETURN jsonb_build_object('resultado', 'repetida', 'tarefa', public.office_tarefa_json(v_tarefa));
  END IF;

  IF p_dados->>'lead_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l
     WHERE l.id = (p_dados->>'lead_id')::uuid AND l.user_id = p_user_id
       AND l.is_test IS NOT TRUE
  ) THEN
    RETURN jsonb_build_object('resultado', 'lead_invalido');
  END IF;

  INSERT INTO public.personal_tasks (
    user_id, title, description, priority, status, due_date, lead_id, project_ref, origin,
    creator_type, creator_ref, assignee_type, assignee_ref, external_order_id, idempotency_key)
  VALUES (
    p_user_id, p_dados->>'title', p_dados->>'description',
    COALESCE(p_dados->>'priority', 'medium'), 'pending', (p_dados->>'due_date')::timestamptz,
    (p_dados->>'lead_id')::uuid, p_dados->>'project_ref', 'eleve_office',
    'agente', p_dados->>'creator_ref', COALESCE(p_dados->>'assignee_type', 'dono'),
    p_dados->>'assignee_ref', p_dados->>'external_order_id', p_chave)
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_tarefa;

  IF NOT FOUND THEN
    -- Outra chamada com a mesma chave gravou entre a busca e o INSERT.
    SELECT * INTO v_tarefa FROM public.personal_tasks t
     WHERE t.user_id = p_user_id AND t.idempotency_key = p_chave;
    RETURN jsonb_build_object('resultado', 'repetida', 'tarefa', public.office_tarefa_json(v_tarefa));
  END IF;
  RETURN jsonb_build_object('resultado', 'criada', 'tarefa', public.office_tarefa_json(v_tarefa));
END;
$$;

CREATE OR REPLACE FUNCTION public.office_tarefa_alterar(
  p_user_id uuid,
  p_ator text,
  p_tarefa_id uuid,
  p_versao integer,
  p_campos jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tarefa public.personal_tasks;
BEGIN
  PERFORM set_config('eleveflow.ator_tarefa', p_ator, true);

  SELECT * INTO v_tarefa FROM public.personal_tasks t
   WHERE t.id = p_tarefa_id AND t.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'nao_encontrada');
  END IF;
  IF v_tarefa.version <> p_versao THEN
    RETURN jsonb_build_object('resultado', 'versao', 'tarefa', public.office_tarefa_json(v_tarefa));
  END IF;
  -- Pela API o status so vai e volta entre pendente e em andamento. Revisao e
  -- conclusao sao do dono.
  IF p_campos ? 'status' AND (
       v_tarefa.status NOT IN ('pending', 'in_progress')
       OR COALESCE(p_campos->>'status', '') NOT IN ('pending', 'in_progress')) THEN
    RETURN jsonb_build_object('resultado', 'transicao', 'tarefa', public.office_tarefa_json(v_tarefa));
  END IF;
  IF p_campos->>'lead_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l
     WHERE l.id = (p_campos->>'lead_id')::uuid AND l.user_id = p_user_id
       AND l.is_test IS NOT TRUE
  ) THEN
    RETURN jsonb_build_object('resultado', 'lead_invalido');
  END IF;

  UPDATE public.personal_tasks t SET
    title = CASE WHEN p_campos ? 'title' THEN p_campos->>'title' ELSE t.title END,
    description = CASE WHEN p_campos ? 'description' THEN p_campos->>'description'
                       ELSE t.description END,
    priority = CASE WHEN p_campos ? 'priority' THEN p_campos->>'priority' ELSE t.priority END,
    due_date = CASE WHEN p_campos ? 'due_date' THEN (p_campos->>'due_date')::timestamptz
                    ELSE t.due_date END,
    lead_id = CASE WHEN p_campos ? 'lead_id' THEN (p_campos->>'lead_id')::uuid
                   ELSE t.lead_id END,
    project_ref = CASE WHEN p_campos ? 'project_ref' THEN p_campos->>'project_ref'
                       ELSE t.project_ref END,
    assignee_type = CASE WHEN p_campos ? 'assignee_type' THEN p_campos->>'assignee_type'
                         ELSE t.assignee_type END,
    assignee_ref = CASE WHEN p_campos ? 'assignee_type' THEN p_campos->>'assignee_ref'
                        ELSE t.assignee_ref END,
    status = CASE WHEN p_campos ? 'status' THEN p_campos->>'status' ELSE t.status END
   WHERE t.id = v_tarefa.id
  RETURNING * INTO v_tarefa;

  RETURN jsonb_build_object('resultado', 'ok', 'tarefa', public.office_tarefa_json(v_tarefa));
END;
$$;

CREATE OR REPLACE FUNCTION public.office_tarefa_entregar(
  p_user_id uuid,
  p_ator text,
  p_tarefa_id uuid,
  p_versao integer,
  p_resultado text,
  p_resultado_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tarefa public.personal_tasks;
BEGIN
  PERFORM set_config('eleveflow.ator_tarefa', p_ator, true);

  SELECT * INTO v_tarefa FROM public.personal_tasks t
   WHERE t.id = p_tarefa_id AND t.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'nao_encontrada');
  END IF;
  IF v_tarefa.version <> p_versao THEN
    RETURN jsonb_build_object('resultado', 'versao', 'tarefa', public.office_tarefa_json(v_tarefa));
  END IF;
  IF v_tarefa.status = 'done' THEN
    RETURN jsonb_build_object('resultado', 'transicao', 'tarefa', public.office_tarefa_json(v_tarefa));
  END IF;

  UPDATE public.personal_tasks t
     SET status = 'aguardando_revisao', result = p_resultado, result_ref = p_resultado_ref
   WHERE t.id = v_tarefa.id
  RETURNING * INTO v_tarefa;

  RETURN jsonb_build_object('resultado', 'ok', 'tarefa', public.office_tarefa_json(v_tarefa));
END;
$$;

-- Exclusoes por escopo: comercial:leitura ve lead e mensagem; tarefas:leitura ve
-- tarefa. O padrao de p_entidades mantem a chamada anterior funcionando entre a
-- migration e o deploy da funcao.
DROP FUNCTION IF EXISTS public.office_exclusoes(uuid, timestamptz, bigint, integer);
CREATE OR REPLACE FUNCTION public.office_exclusoes(
  p_user_id uuid,
  p_cursor_ts timestamptz,
  p_cursor_id bigint,
  p_limite integer,
  p_entidades text[] DEFAULT ARRAY['lead', 'message']
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'entidade', CASE d.entity WHEN 'lead' THEN 'lead' WHEN 'message' THEN 'mensagem'
                            ELSE 'tarefa' END,
  'id', d.entity_id,
  'excluido_em', d.deleted_at,
  'sequencia', d.id
) ORDER BY d.deleted_at, d.id), '[]'::jsonb)
FROM (
  SELECT r.id, r.entity, r.entity_id, r.deleted_at
    FROM public.api_deleted_records r
   WHERE r.user_id = p_user_id
     AND r.entity = ANY (p_entidades)
     AND r.deleted_at <= now() - interval '5 seconds'
     AND (p_cursor_ts IS NULL OR (r.deleted_at, r.id) > (p_cursor_ts, p_cursor_id))
   ORDER BY r.deleted_at, r.id
   LIMIT p_limite + 1
) d;
$$;

REVOKE ALL ON FUNCTION public.office_tarefa_json(public.personal_tasks) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_tarefa_json(public.personal_tasks) TO service_role;
REVOKE ALL ON FUNCTION public.office_tarefas(uuid, uuid, timestamptz, uuid, integer, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_tarefas(uuid, uuid, timestamptz, uuid, integer, text, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.office_tarefa_criar(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_tarefa_criar(uuid, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.office_tarefa_alterar(uuid, text, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_tarefa_alterar(uuid, text, uuid, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.office_tarefa_entregar(uuid, text, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_tarefa_entregar(uuid, text, uuid, integer, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.office_exclusoes(uuid, timestamptz, bigint, integer, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_exclusoes(uuid, timestamptz, bigint, integer, text[]) TO service_role;
```

- [x] **Passo 2: Esclarecimentos na spec.** Acrescentar ao fim de
  `docs/specs/2026-09-25-tarefas-office-design.md` a seção "Esclarecimentos da
  implementação (2026-09-25)" com os 6 itens de "Esclarecimentos sobre a spec" deste
  plano.

- [x] **Passo 3: Commit**

```bash
git add supabase/migrations/20260925182501_tarefas_office.sql docs/specs/2026-09-25-tarefas-office-design.md docs/plans/2026-09-25-tarefas-office.md
git commit -m "feat(db): tarefas pelo Eleve Office com versao, historico e entrega"
```

---

### Task 2: Token com rótulo

**Files:** Modify `supabase/functions/_shared/api-token.ts`, `tests/unit/api-token.test.ts`.

**Interfaces — Produces:** `TokenResolvido` ganha `label: string` (o ator do histórico é
`api:<label>`).

- [x] **Passo 1: Teste.** Em `tests/unit/api-token.test.ts`, o `banco()` ganha
  `label: "Eleve Office"` e o esperado de "token conhecido devolve conta, escopos e
  limite" passa a ser:

```ts
    expect(await resolveApiToken(client as any, `Bearer ${TOKEN}`)).toEqual({
      tokenId: "tok-1",
      userId: "conta-1",
      label: "Eleve Office",
      scopes: ["comercial:leitura"],
      rateLimitPerMinute: 120,
    });
```

- [x] **Passo 2: Ver falhar** — `npx vitest run tests/unit/api-token.test.ts`: falta
  `label`.

- [x] **Passo 3: Implementar.** Em `api-token.ts`: `label: string` na interface, `label`
  no `select("id, user_id, label, scopes, rate_limit_per_minute, revoked_at")` e
  `label: data.label` no retorno.

- [x] **Passo 4: Ver passar e commitar**

```bash
npx vitest run tests/unit/api-token.test.ts
git add supabase/functions/_shared/api-token.ts tests/unit/api-token.test.ts
git commit -m "feat(office-api): token resolvido traz o rotulo"
```

---

### Task 3: Erros e rotas com escopo por método

**Files:** Create `supabase/functions/_shared/office-api/erros.ts`; Modify
`supabase/functions/_shared/office-api/rotas.ts`, `tests/unit/office-api-modulos.test.ts`,
`vitest.config.ts`.

**Interfaces — Produces:**

- `CODIGOS: Record<number, string>`; `class ErroApi extends HttpError { extra:
  Record<string, unknown> }`; `corpoDeErro(status, mensagem, extra = {})` →
  `{ erro: { codigo, mensagem }, ...extra }`;
- `type Metodo = "GET" | "POST" | "PATCH"`; `type Metodos = Partial<Record<Metodo,
  string[] | null>>` (escopos aceitos, basta um; `null` = pública);
- `type Rota = { nome; modelo; metodos; id? }`; `encontrarRota(pathname): Rota | null`
  (`id` substitui `leadId`); `metodoDaRota(rota, metodo): Metodo | null`;
- `ROTAS: Array<{ nome; modelo; metodos }>`; nomes novos `tarefas`, `tarefa`,
  `tarefa_entrega`.

- [x] **Passo 1: Testes.** Em `tests/unit/office-api-modulos.test.ts`, importar
  `metodoDaRota` e `corpoDeErro`/`ErroApi`, trocar o `describe("rotas")` inteiro por:

```ts
describe("rotas", () => {
  it("resolve as rotas com e sem o prefixo da funcao", () => {
    expect(encontrarRota("/office-api/v1/leads")).toMatchObject({
      nome: "leads",
      metodos: { GET: ["comercial:leitura"] },
    });
    expect(encontrarRota(`/office-api/v1/leads/${ID}/mensagens`)).toMatchObject({
      nome: "lead_mensagens",
      modelo: "/v1/leads/{id}/mensagens",
      id: ID,
    });
    expect(encontrarRota("/v1/exclusoes")).toMatchObject({ nome: "exclusoes" });
    expect(encontrarRota(`/functions/v1/office-api/v1/tarefas/${ID}/entrega`)).toMatchObject({
      nome: "tarefa_entrega",
      modelo: "/v1/tarefas/{id}/entrega",
      id: ID,
    });
    expect(encontrarRota("/office-api/v1/openapi.json")).toMatchObject({
      nome: "openapi",
      metodos: { GET: null },
    });
  });

  it("rota desconhecida ou id invalido nao casa", () => {
    expect(encontrarRota("/office-api/v1/lembretes")).toBeNull();
    expect(encontrarRota("/office-api/v1/leads/123")).toBeNull();
    expect(encontrarRota("/office-api/v1/tarefas/123")).toBeNull();
  });

  it("escopo por metodo nas tarefas; exclusoes aceitam os dois escopos de leitura", () => {
    expect(encontrarRota("/v1/tarefas")!.metodos).toEqual({
      GET: ["tarefas:leitura"],
      POST: ["tarefas:escrita"],
    });
    expect(encontrarRota(`/v1/tarefas/${ID}`)!.metodos).toEqual({
      GET: ["tarefas:leitura"],
      PATCH: ["tarefas:escrita"],
    });
    expect(encontrarRota(`/v1/tarefas/${ID}/entrega`)!.metodos).toEqual({
      POST: ["tarefas:escrita"],
    });
    expect(encontrarRota("/v1/exclusoes")!.metodos).toEqual({
      GET: ["comercial:leitura", "tarefas:leitura"],
    });
  });

  it("toda rota com dado exige escopo, e so tarefa aceita escrita", () => {
    for (const r of ROTAS.filter((r) => r.nome !== "openapi")) {
      for (const [metodo, escopos] of Object.entries(r.metodos)) {
        expect(escopos?.length, `${metodo} ${r.modelo}`).toBeGreaterThan(0);
        if (metodo !== "GET") expect(escopos, `${metodo} ${r.modelo}`).toEqual(["tarefas:escrita"]);
      }
    }
  });

  it("metodoDaRota devolve so o metodo que a rota aceita", () => {
    expect(metodoDaRota(encontrarRota("/v1/tarefas")!, "POST")).toBe("POST");
    expect(metodoDaRota(encontrarRota(`/v1/tarefas/${ID}`)!, "PATCH")).toBe("PATCH");
    expect(metodoDaRota(encontrarRota("/v1/leads")!, "POST")).toBeNull();
    expect(metodoDaRota(encontrarRota("/v1/tarefas")!, "DELETE")).toBeNull();
    expect(metodoDaRota(encontrarRota("/v1/tarefas")!, "get")).toBeNull();
  });
});

describe("erros", () => {
  it("codigo pelo status, com a tarefa quando vem junto", () => {
    expect(corpoDeErro(412, "mudou", { tarefa: { versao: 2 } })).toEqual({
      erro: { codigo: "versao_desatualizada", mensagem: "mudou" },
      tarefa: { versao: 2 },
    });
    expect(corpoDeErro(428, "falta").erro.codigo).toBe("versao_obrigatoria");
    expect(corpoDeErro(409, "nao").erro.codigo).toBe("transicao_invalida");
    expect(corpoDeErro(405, "use GET").erro.codigo).toBe("metodo_nao_permitido");
    expect(corpoDeErro(418, "?").erro.codigo).toBe("erro_interno");
  });

  it("ErroApi e um HttpError com corpo extra", () => {
    const erro = new ErroApi(409, "nao", { tarefa: { status: "concluida" } });
    expect(erro).toBeInstanceOf(HttpError);
    expect(erro.status).toBe(409);
    expect(erro.extra).toEqual({ tarefa: { status: "concluida" } });
    expect(new ErroApi(400, "x").extra).toEqual({});
  });
});
```

- [x] **Passo 2: Ver falhar** — `npx vitest run tests/unit/office-api-modulos.test.ts`:
  `erros.ts` não existe; `metodos` e `id` ausentes.

- [x] **Passo 3: Implementar**

Arquivo: `supabase/functions/_shared/office-api/erros.ts`

```ts
// Corpo de erro da office-api: { erro: { codigo, mensagem } }, com a tarefa atual
// quando o Office precisa dela para decidir (409 e 412).

import { HttpError } from "../http-error.ts";

export const CODIGOS: Record<number, string> = {
  400: "parametro_invalido",
  401: "token_invalido",
  403: "escopo_insuficiente",
  404: "nao_encontrado",
  405: "metodo_nao_permitido",
  409: "transicao_invalida",
  412: "versao_desatualizada",
  428: "versao_obrigatoria",
  429: "limite_excedido",
  500: "erro_interno",
};

export class ErroApi extends HttpError {
  constructor(
    status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(status, message);
  }
}

export function corpoDeErro(
  status: number,
  mensagem: string,
  extra: Record<string, unknown> = {},
) {
  return { erro: { codigo: CODIGOS[status] ?? CODIGOS[500], mensagem }, ...extra };
}
```

Arquivo: `supabase/functions/_shared/office-api/rotas.ts`

```ts
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
```

`vitest.config.ts`: acrescentar `"supabase/functions/_shared/office-api/erros.ts"` ao
`coverage.include`, depois de `auditoria.ts`.

- [x] **Passo 4: Ver passar.** `atender.ts` ainda usa `leadId`: o typecheck do Deno
  quebra até a Task 5, mas o Vitest não checa tipo. Rodar
  `npx vitest run tests/unit/office-api-modulos.test.ts`.

- [x] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/office-api/erros.ts supabase/functions/_shared/office-api/rotas.ts tests/unit/office-api-modulos.test.ts vitest.config.ts
git commit -m "feat(office-api): escopo por metodo e erros de tarefa"
```

---

### Task 4: Corpo e cabeçalhos das tarefas

**Files:** Create `supabase/functions/_shared/office-api/tarefas-corpo.ts`,
`tests/unit/office-api-tarefas-corpo.test.ts`; Modify `vitest.config.ts`.

**Interfaces — Produces:** `STATUS_DB` (API → banco); `NovaTarefa` (colunas);
`lerNovaTarefa(corpo): NovaTarefa`; `lerAlteracao(corpo): Record<string, unknown>` (só
as colunas enviadas); `lerEntrega(corpo): { resultado: string; resultadoRef: string |
null }`; `lerVersao(ifMatch: string | null): number` (428 sem ele);
`lerChave(valor: string | null): string`; `lerFiltrosTarefas(query): FiltrosTarefas`
(`status`, `responsavelTipo`, `responsavelRef`, `atualizadoDesde`);
`lerJson(texto: string): unknown`. Todo erro é `HttpError(400)`, salvo o 428.

- [x] **Passo 1: Testes**

Arquivo: `tests/unit/office-api-tarefas-corpo.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import {
  lerAlteracao,
  lerChave,
  lerEntrega,
  lerFiltrosTarefas,
  lerJson,
  lerNovaTarefa,
  lerVersao,
} from "../../supabase/functions/_shared/office-api/tarefas-corpo";

const LEAD = "1c8d0b7f-2a3e-4d4c-9b0f-6e5d4c3b2a1f";

function statusDe(fn: () => unknown): number | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return null;
}

describe("lerNovaTarefa", () => {
  it("traduz o corpo minimo para as colunas, com os padroes", () => {
    expect(lerNovaTarefa({ titulo: "  Ligar  " })).toEqual({
      title: "Ligar",
      description: null,
      priority: "medium",
      due_date: null,
      lead_id: null,
      project_ref: null,
      creator_ref: null,
      assignee_type: "dono",
      assignee_ref: null,
      external_order_id: null,
    });
  });

  it("traduz o corpo completo", () => {
    expect(
      lerNovaTarefa({
        titulo: "Ligar",
        descricao: "Confirmar",
        prioridade: "alta",
        prazo: "2026-09-26T13:00:00-03:00",
        lead_id: LEAD,
        projeto_ref: "proj-1",
        responsavel: { tipo: "agente", ref: "sdr-1" },
        criador_ref: "nexo",
        ordem_externa_id: "ordem-123",
      }),
    ).toEqual({
      title: "Ligar",
      description: "Confirmar",
      priority: "high",
      due_date: "2026-09-26T13:00:00-03:00",
      lead_id: LEAD,
      project_ref: "proj-1",
      creator_ref: "nexo",
      assignee_type: "agente",
      assignee_ref: "sdr-1",
      external_order_id: "ordem-123",
    });
  });

  it("recusa corpo invalido com 400", () => {
    for (const corpo of [
      null,
      [],
      "texto",
      {},
      { titulo: "   " },
      { titulo: "x".repeat(301) },
      { titulo: "a", conta_id: LEAD },
      { titulo: "a", prioridade: "urgente" },
      { titulo: "a", prazo: "2026-09-26T13:00:00" },
      { titulo: "a", prazo: "2026-02-30T13:00:00Z" },
      { titulo: "a", prazo: "2026-09-26T25:00:00Z" },
      { titulo: "a", lead_id: "123" },
      { titulo: "a", responsavel: { tipo: "agente" } },
      { titulo: "a", responsavel: { tipo: "dono", ref: "sdr-1" } },
      { titulo: "a", responsavel: { tipo: "gerente" } },
      { titulo: "a", responsavel: { tipo: "agente", ref: "sdr", conta: 1 } },
      { titulo: "a", descricao: 5 },
    ]) {
      expect(statusDe(() => lerNovaTarefa(corpo)), JSON.stringify(corpo)).toBe(400);
    }
  });

  it("conta caracteres como o banco, nao unidades UTF-16", () => {
    expect(lerNovaTarefa({ titulo: "🎯".repeat(300) }).title).toHaveLength(600);
  });
});

describe("lerAlteracao", () => {
  it("so os campos enviados; null limpa", () => {
    expect(lerAlteracao({ descricao: null, prazo: null, status: "em_andamento" })).toEqual({
      description: null,
      due_date: null,
      status: "in_progress",
    });
    expect(lerAlteracao({ responsavel: { tipo: "dono" } })).toEqual({
      assignee_type: "dono",
      assignee_ref: null,
    });
  });

  it("status vira o do banco; a regra de transicao e do banco", () => {
    expect(lerAlteracao({ status: "concluida" })).toEqual({ status: "done" });
    expect(lerAlteracao({ status: "aguardando_revisao" })).toEqual({
      status: "aguardando_revisao",
    });
  });

  it("recusa vazio, campo fora da lista e nulo onde nao cabe", () => {
    for (const corpo of [
      {},
      { resultado: "x" },
      { titulo: null },
      { status: "feita" },
      { prioridade: null },
      { responsavel: null },
    ]) {
      expect(statusDe(() => lerAlteracao(corpo)), JSON.stringify(corpo)).toBe(400);
    }
  });
});

describe("lerEntrega", () => {
  it("resultado obrigatorio; link http ou https", () => {
    expect(lerEntrega({ resultado: "feito" })).toEqual({ resultado: "feito", resultadoRef: null });
    expect(lerEntrega({ resultado: "feito", resultado_ref: "https://x.com/r" })).toEqual({
      resultado: "feito",
      resultadoRef: "https://x.com/r",
    });
    for (const corpo of [
      {},
      { resultado: "" },
      { resultado: "x".repeat(5001) },
      { resultado: "a", resultado_ref: "ftp://x.com" },
      { resultado: "a", resultado_ref: "nao e url" },
      { resultado: "a", status: "concluida" },
    ]) {
      expect(statusDe(() => lerEntrega(corpo)), JSON.stringify(corpo)).toBe(400);
    }
  });
});

describe("cabecalhos e corpo", () => {
  it("If-Match: ausente da 428; versao com ou sem aspas", () => {
    expect(statusDe(() => lerVersao(null))).toBe(428);
    expect(lerVersao('"3"')).toBe(3);
    expect(lerVersao("12")).toBe(12);
    for (const valor of ['"3', 'W/"3"', "tres", "", '"-1"']) {
      expect(statusDe(() => lerVersao(valor)), valor).toBe(400);
    }
  });

  it("Idempotency-Key obrigatorio, de 1 a 200 caracteres visiveis", () => {
    expect(lerChave("ordem-123:tarefa-1")).toBe("ordem-123:tarefa-1");
    for (const valor of [null, "", "com espaco", "x".repeat(201)]) {
      expect(statusDe(() => lerChave(valor)), String(valor)).toBe(400);
    }
  });

  it("corpo JSON; vazio vira null", () => {
    expect(lerJson('{"a":1}')).toEqual({ a: 1 });
    expect(lerJson("")).toBeNull();
    expect(statusDe(() => lerJson("{"))).toBe(400);
  });
});

describe("lerFiltrosTarefas", () => {
  it("status e responsavel validados e traduzidos", () => {
    const query = new URLSearchParams(
      "status=em_andamento&responsavel_tipo=agente&responsavel_ref=sdr-1&atualizado_desde=2026-09-25T00:00:00Z",
    );
    expect(lerFiltrosTarefas(query)).toEqual({
      status: "in_progress",
      responsavelTipo: "agente",
      responsavelRef: "sdr-1",
      atualizadoDesde: "2026-09-25T00:00:00Z",
    });
    expect(lerFiltrosTarefas(new URLSearchParams())).toEqual({
      status: null,
      responsavelTipo: null,
      responsavelRef: null,
      atualizadoDesde: null,
    });
    for (const q of [
      "status=feita",
      "responsavel_tipo=gerente",
      "responsavel_ref=",
      "atualizado_desde=ontem",
    ]) {
      expect(statusDe(() => lerFiltrosTarefas(new URLSearchParams(q))), q).toBe(400);
    }
  });
});
```

- [x] **Passo 2: Ver falhar** — `npx vitest run tests/unit/office-api-tarefas-corpo.test.ts`:
  módulo inexistente.

- [x] **Passo 3: Implementar**

Arquivo: `supabase/functions/_shared/office-api/tarefas-corpo.ts`

```ts
// Corpo e cabecalhos das rotas de tarefa: valida e traduz a API (portugues) para as
// colunas de personal_tasks. Campo fora da lista da 400: o Office descobre o erro na
// hora, em vez de achar que gravou.

import { HttpError } from "../http-error.ts";
import { lerData, UUID } from "./parametros.ts";

export const STATUS_DB: Record<string, string> = {
  pendente: "pending",
  em_andamento: "in_progress",
  aguardando_revisao: "aguardando_revisao",
  concluida: "done",
};

const PRIORIDADE_DB: Record<string, string> = { baixa: "low", media: "medium", alta: "high" };
const TIPOS = ["dono", "agente"];
const NOVA = [
  "titulo",
  "descricao",
  "prioridade",
  "prazo",
  "lead_id",
  "projeto_ref",
  "responsavel",
  "criador_ref",
  "ordem_externa_id",
];
const ALTERAVEIS = [
  "titulo",
  "descricao",
  "prioridade",
  "prazo",
  "lead_id",
  "projeto_ref",
  "responsavel",
  "status",
];
// Prazo so com fuso: "13:00" sem fuso seria uma hora no Office e outra no banco.
const DATA_COM_FUSO =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const CHAVE = /^[\x21-\x7e]{1,200}$/;
const VERSAO = /^(?:"(\d{1,9})"|(\d{1,9}))$/;

type Obj = Record<string, unknown>;

export interface NovaTarefa {
  title: string;
  description: string | null;
  priority: string;
  due_date: string | null;
  lead_id: string | null;
  project_ref: string | null;
  creator_ref: string | null;
  assignee_type: string;
  assignee_ref: string | null;
  external_order_id: string | null;
}

export interface FiltrosTarefas {
  status: string | null;
  responsavelTipo: string | null;
  responsavelRef: string | null;
  atualizadoDesde: string | null;
}

function invalido(mensagem: string): never {
  throw new HttpError(400, mensagem);
}

function objeto(valor: unknown, nome: string): Obj {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    invalido(`${nome} deve ser um objeto JSON`);
  }
  return valor as Obj;
}

function soPermitidos(corpo: Obj, permitidos: string[], prefixo = ""): void {
  const fora = Object.keys(corpo).filter((campo) => !permitidos.includes(campo));
  if (fora.length) invalido(`campo nao permitido: ${fora.map((c) => prefixo + c).join(", ")}`);
}

/** Ausente → undefined; null → null (limpa). Tamanho em caracteres, como no banco. */
function texto(corpo: Obj, campo: string, maximo: number, nome = campo): string | null | undefined {
  const valor = corpo[campo];
  if (valor === undefined || valor === null) return valor;
  if (typeof valor !== "string" || valor.trim() === "" || [...valor].length > maximo) {
    invalido(`${nome} deve ser texto de 1 a ${maximo} caracteres`);
  }
  return valor;
}

function obrigatorio<T>(valor: T | null | undefined, nome: string): T {
  if (valor === undefined || valor === null) invalido(`${nome} e obrigatorio`);
  return valor;
}

function traduzido(corpo: Obj, campo: string, mapa: Record<string, string>): string | undefined {
  const valor = corpo[campo];
  if (valor === undefined) return undefined;
  if (typeof valor !== "string" || !Object.keys(mapa).includes(valor)) {
    invalido(`${campo} deve ser ${Object.keys(mapa).join(", ")}`);
  }
  return mapa[valor];
}

function dataValida(valor: string): boolean {
  const casou = DATA_COM_FUSO.exec(valor);
  if (!casou) return false;
  const [ano, mes, dia] = [Number(casou[1]), Number(casou[2]), Number(casou[3])];
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

function prazo(corpo: Obj): string | null | undefined {
  const valor = corpo.prazo;
  if (valor === undefined || valor === null) return valor;
  if (typeof valor !== "string" || !dataValida(valor)) {
    invalido("prazo deve ser ISO 8601 com fuso, como 2026-09-26T13:00:00-03:00");
  }
  return valor;
}

function leadId(corpo: Obj): string | null | undefined {
  const valor = corpo.lead_id;
  if (valor === undefined || valor === null) return valor;
  if (typeof valor !== "string" || !UUID.test(valor)) invalido("lead_id deve ser um uuid");
  return valor;
}

function responsavel(corpo: Obj): { assignee_type: string; assignee_ref: string | null } {
  const r = objeto(corpo.responsavel, "responsavel");
  soPermitidos(r, ["tipo", "ref"], "responsavel.");
  if (typeof r.tipo !== "string" || !TIPOS.includes(r.tipo)) {
    invalido("responsavel.tipo deve ser dono ou agente");
  }
  const ref = texto(r, "ref", 200, "responsavel.ref");
  if (r.tipo === "agente" && !ref) invalido("responsavel.ref e obrigatoria para agente");
  if (r.tipo === "dono" && ref) invalido("responsavel.ref so vale para agente");
  return { assignee_type: r.tipo, assignee_ref: ref ?? null };
}

export function lerNovaTarefa(valor: unknown): NovaTarefa {
  const corpo = objeto(valor, "corpo");
  soPermitidos(corpo, NOVA);
  const dono = { assignee_type: "dono", assignee_ref: null };
  return {
    title: obrigatorio(texto(corpo, "titulo", 300), "titulo").trim(),
    description: texto(corpo, "descricao", 10_000) ?? null,
    priority: traduzido(corpo, "prioridade", PRIORIDADE_DB) ?? "medium",
    due_date: prazo(corpo) ?? null,
    lead_id: leadId(corpo) ?? null,
    project_ref: texto(corpo, "projeto_ref", 200) ?? null,
    creator_ref: texto(corpo, "criador_ref", 200) ?? null,
    ...(corpo.responsavel === undefined ? dono : responsavel(corpo)),
    external_order_id: texto(corpo, "ordem_externa_id", 200) ?? null,
  };
}

export function lerAlteracao(valor: unknown): Record<string, unknown> {
  const corpo = objeto(valor, "corpo");
  soPermitidos(corpo, ALTERAVEIS);
  if (Object.keys(corpo).length === 0) invalido("nada para alterar");

  const campos: Record<string, unknown> = {};
  if ("titulo" in corpo) campos.title = obrigatorio(texto(corpo, "titulo", 300), "titulo").trim();
  if ("descricao" in corpo) campos.description = texto(corpo, "descricao", 10_000);
  if ("prioridade" in corpo) campos.priority = traduzido(corpo, "prioridade", PRIORIDADE_DB);
  if ("prazo" in corpo) campos.due_date = prazo(corpo);
  if ("lead_id" in corpo) campos.lead_id = leadId(corpo);
  if ("projeto_ref" in corpo) campos.project_ref = texto(corpo, "projeto_ref", 200);
  if ("responsavel" in corpo) Object.assign(campos, responsavel(corpo));
  if ("status" in corpo) campos.status = traduzido(corpo, "status", STATUS_DB);
  return campos;
}

function ehUrl(valor: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(valor).protocol);
  } catch {
    return false;
  }
}

export function lerEntrega(valor: unknown): { resultado: string; resultadoRef: string | null } {
  const corpo = objeto(valor, "corpo");
  soPermitidos(corpo, ["resultado", "resultado_ref"]);
  const resultado = obrigatorio(texto(corpo, "resultado", 5000), "resultado");
  const resultadoRef = texto(corpo, "resultado_ref", 2000) ?? null;
  if (resultadoRef !== null && !ehUrl(resultadoRef)) {
    invalido("resultado_ref deve ser uma URL http ou https");
  }
  return { resultado, resultadoRef };
}

export function lerVersao(valor: string | null): number {
  if (valor === null) {
    throw new HttpError(428, 'envie If-Match com a versao da tarefa, como "3"');
  }
  const casou = VERSAO.exec(valor.trim());
  if (!casou) invalido('If-Match deve ser a versao da tarefa, como "3"');
  return Number(casou[1] ?? casou[2]);
}

export function lerChave(valor: string | null): string {
  if (valor === null || !CHAVE.test(valor)) {
    invalido("Idempotency-Key obrigatorio: de 1 a 200 caracteres visiveis, sem espaco");
  }
  return valor;
}

export function lerFiltrosTarefas(query: URLSearchParams): FiltrosTarefas {
  const status = query.get("status");
  const tipo = query.get("responsavel_tipo");
  const ref = query.get("responsavel_ref");
  if (status !== null && !Object.keys(STATUS_DB).includes(status)) {
    invalido(`status deve ser ${Object.keys(STATUS_DB).join(", ")}`);
  }
  if (tipo !== null && !TIPOS.includes(tipo)) invalido("responsavel_tipo deve ser dono ou agente");
  if (ref !== null && (ref === "" || [...ref].length > 200)) {
    invalido("responsavel_ref deve ter de 1 a 200 caracteres");
  }
  return {
    status: status === null ? null : STATUS_DB[status],
    responsavelTipo: tipo,
    responsavelRef: ref,
    atualizadoDesde: lerData("atualizado_desde", query.get("atualizado_desde")),
  };
}

export function lerJson(texto: string): unknown {
  if (texto.trim() === "") return null;
  try {
    return JSON.parse(texto);
  } catch {
    invalido("corpo deve ser JSON valido");
  }
}
```

`vitest.config.ts`: acrescentar `"supabase/functions/_shared/office-api/tarefas-corpo.ts"`.

- [x] **Passo 4: Ver passar e commitar**

```bash
npx vitest run tests/unit/office-api-tarefas-corpo.test.ts
git add supabase/functions/_shared/office-api/tarefas-corpo.ts tests/unit/office-api-tarefas-corpo.test.ts vitest.config.ts
git commit -m "feat(office-api): valida corpo, If-Match e Idempotency-Key das tarefas"
```

---

### Task 5: Pedido completo, rotas de tarefa e exclusões por escopo

**Files:** Create `supabase/functions/_shared/office-api/rpc.ts`,
`supabase/functions/_shared/office-api/tarefas.ts`, `tests/unit/office-api-tarefas.test.ts`;
Modify `supabase/functions/_shared/office-api/atender.ts`,
`tests/unit/office-api-atender.test.ts`, `vitest.config.ts`.

**Interfaces:**

- Consumes: `lerNovaTarefa`, `lerAlteracao`, `lerEntrega`, `lerVersao`, `lerChave`,
  `lerFiltrosTarefas` (Task 4); `ErroApi` (Task 3); `Rota`, `Metodo`, `NomeRota`
  (Task 3); funções SQL da Task 1.
- Produces: `interface Pedido { metodo; userId; escopos; ator; query; ifMatch; chave;
  corpo }`; `interface Resposta { status; corpo; itens }`;
  `atender(client, rota: { nome: NomeRota; id?: string }, pedido: Pedido):
  Promise<Resposta>`; `atenderTarefas(client, rota, pedido): Promise<Resposta>`;
  `chamar<T>(client, fn, args): Promise<T>`.

Tradução do resultado da função SQL: `criada` → 201; `repetida` e `ok` → 200;
`nao_encontrada` → 404; `lead_invalido` → 400; `versao` → 412 e `transicao` → 409, as
duas com `tarefa`.

- [x] **Passo 1: Testes do atender.** Em `tests/unit/office-api-atender.test.ts`, importar
  `type Pedido` de `atender`, criar o ajudante e trocar toda chamada
  `atender(client, rota(...), CONTA, query)` por `atender(client, rota(...), pedido(query))`:

```ts
function pedido(query = new URLSearchParams(), extra: Partial<Pedido> = {}): Pedido {
  return {
    metodo: "GET",
    userId: CONTA,
    escopos: ["comercial:leitura"],
    ator: "api:Teste",
    query,
    ifMatch: null,
    chave: null,
    corpo: null,
    ...extra,
  };
}
```

e acrescentar:

```ts
  it("exclusoes mostram so as entidades dos escopos do token", async () => {
    const { client, chamadas } = cliente({ office_exclusoes: () => [] });
    for (const escopos of [
      ["comercial:leitura"],
      ["tarefas:leitura", "tarefas:escrita"],
      ["comercial:leitura", "tarefas:leitura"],
    ]) {
      await atender(client, rota("/v1/exclusoes"), pedido(undefined, { escopos }));
    }
    expect(chamadas.map((c) => c.args.p_entidades)).toEqual([
      ["lead", "message"],
      ["task"],
      ["lead", "message", "task"],
    ]);
  });

  it("resposta de leitura sai com 200", async () => {
    const { client } = cliente({ office_leads: () => [] });
    expect((await atender(client, rota("/v1/leads"), pedido())).status).toBe(200);
  });
```

- [x] **Passo 2: Testes das tarefas**

Arquivo: `tests/unit/office-api-tarefas.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { atender, type Pedido } from "../../supabase/functions/_shared/office-api/atender";
import { codificarCursor } from "../../supabase/functions/_shared/office-api/cursor";
import { ErroApi } from "../../supabase/functions/_shared/office-api/erros";
import { encontrarRota, type Metodo } from "../../supabase/functions/_shared/office-api/rotas";
import { createFakeClient } from "./helpers/fake-supabase";

const CONTA = "0b7c9a6e-1f2d-4c3b-8a9e-5d4c3b2a1f0e";
const TAREFA = "2d9e1c8a-3b4f-4e5d-8c1a-7f6e5d4c3b2a";
const T1 = "2026-09-25T10:00:00.000001+00:00";
const tarefa = { tarefa_id: TAREFA, versao: 2, status: "pendente", atualizada_em: T1 };

function cliente(respostas: Record<string, (args: any) => unknown>) {
  const chamadas: Array<{ nome: string; args: any }> = [];
  const rpc: Record<string, (args: any) => { data: unknown; error: null }> = {};
  for (const [nome, fn] of Object.entries(respostas)) {
    rpc[nome] = (args) => {
      chamadas.push({ nome, args });
      return { data: fn(args), error: null };
    };
  }
  return { client: createFakeClient({}, { rpc }) as any, chamadas };
}

function pedido(metodo: Metodo, extra: Partial<Pedido> = {}): Pedido {
  return {
    metodo,
    userId: CONTA,
    escopos: ["tarefas:leitura", "tarefas:escrita"],
    ator: "api:Nexo",
    query: new URLSearchParams(),
    ifMatch: null,
    chave: null,
    corpo: null,
    ...extra,
  };
}

const rota = (caminho: string) => encontrarRota(caminho)!;

async function recusa(promessa: Promise<unknown>): Promise<any> {
  try {
    await promessa;
  } catch (error) {
    return error;
  }
  throw new Error("esperava recusa");
}

describe("rotas de tarefa", () => {
  it("lista com filtros traduzidos, conta do token e cursor", async () => {
    const { client, chamadas } = cliente({ office_tarefas: () => [tarefa] });
    const query = new URLSearchParams("status=pendente&responsavel_tipo=agente&limite=10");
    const resposta = await atender(client, rota("/v1/tarefas"), pedido("GET", { query }));
    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_tarefa_id: null,
      p_status: "pending",
      p_responsavel_tipo: "agente",
      p_limite: 10,
    });
    expect(resposta).toEqual({
      status: 200,
      corpo: { dados: [tarefa], proximo_cursor: codificarCursor(T1, TAREFA), tem_mais: false },
      itens: 1,
    });
  });

  it("tarefa unica; de outra conta ou inexistente da 404", async () => {
    const { client, chamadas } = cliente({ office_tarefas: () => [tarefa] });
    const resposta = await atender(client, rota(`/v1/tarefas/${TAREFA}`), pedido("GET"));
    expect(resposta).toEqual({ status: 200, corpo: tarefa, itens: 1 });
    expect(chamadas[0].args).toMatchObject({ p_tarefa_id: TAREFA, p_user_id: CONTA });

    const vazio = cliente({ office_tarefas: () => [] });
    expect(
      await recusa(atender(vazio.client, rota(`/v1/tarefas/${TAREFA}`), pedido("GET"))),
    ).toMatchObject({ status: 404 });
  });

  it("criacao: 201 na primeira, 200 na repeticao, com chave, ator e colunas", async () => {
    const respostas = [
      { resultado: "criada", tarefa },
      { resultado: "repetida", tarefa },
    ];
    const { client, chamadas } = cliente({ office_tarefa_criar: () => respostas.shift() });
    const criar = () =>
      atender(
        client,
        rota("/v1/tarefas"),
        pedido("POST", { chave: "ordem-1", corpo: { titulo: "Ligar", prioridade: "baixa" } }),
      );
    expect(await criar()).toEqual({ status: 201, corpo: tarefa, itens: 1 });
    expect(await criar()).toEqual({ status: 200, corpo: tarefa, itens: 1 });
    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_ator: "api:Nexo",
      p_chave: "ordem-1",
      p_dados: { title: "Ligar", priority: "low", assignee_type: "dono" },
    });
  });

  it("criacao sem Idempotency-Key ou com corpo invalido nao chama o banco", async () => {
    const { client, chamadas } = cliente({
      office_tarefa_criar: () => ({ resultado: "criada", tarefa }),
    });
    for (const extra of [
      { corpo: { titulo: "x" } },
      { chave: "k", corpo: { titulo: "x", conta_id: CONTA } },
    ]) {
      expect(
        await recusa(atender(client, rota("/v1/tarefas"), pedido("POST", extra))),
      ).toMatchObject({ status: 400 });
    }
    expect(chamadas).toHaveLength(0);
  });

  it("lead de outra conta da 400", async () => {
    const { client } = cliente({ office_tarefa_criar: () => ({ resultado: "lead_invalido" }) });
    const corpo = { titulo: "x", lead_id: TAREFA };
    expect(
      await recusa(atender(client, rota("/v1/tarefas"), pedido("POST", { chave: "k", corpo }))),
    ).toMatchObject({ status: 400 });
  });

  it("alteracao: If-Match obrigatorio; versao e transicao voltam com a tarefa atual", async () => {
    const respostas = [
      { resultado: "ok", tarefa },
      { resultado: "versao", tarefa },
      { resultado: "transicao", tarefa },
      { resultado: "nao_encontrada" },
    ];
    const { client, chamadas } = cliente({ office_tarefa_alterar: () => respostas.shift() });
    const alterar = (ifMatch: string | null) =>
      atender(
        client,
        rota(`/v1/tarefas/${TAREFA}`),
        pedido("PATCH", { ifMatch, corpo: { status: "em_andamento" } }),
      );

    expect(await recusa(alterar(null))).toMatchObject({ status: 428 });
    expect(chamadas).toHaveLength(0);
    expect(await alterar('"2"')).toEqual({ status: 200, corpo: tarefa, itens: 1 });
    expect(chamadas[0].args).toMatchObject({
      p_tarefa_id: TAREFA,
      p_versao: 2,
      p_campos: { status: "in_progress" },
      p_ator: "api:Nexo",
    });

    const conflito = await recusa(alterar('"1"'));
    expect(conflito).toBeInstanceOf(ErroApi);
    expect(conflito).toMatchObject({ status: 412, extra: { tarefa } });
    expect(await recusa(alterar('"2"'))).toMatchObject({ status: 409, extra: { tarefa } });
    expect(await recusa(alterar('"2"'))).toMatchObject({ status: 404, extra: {} });
  });

  it("entrega: resultado e link vao ao banco; tarefa concluida da 409", async () => {
    const entregue = { ...tarefa, status: "aguardando_revisao" };
    const respostas = [
      { resultado: "ok", tarefa: entregue },
      { resultado: "transicao", tarefa },
    ];
    const { client, chamadas } = cliente({ office_tarefa_entregar: () => respostas.shift() });
    const entregar = () =>
      atender(
        client,
        rota(`/v1/tarefas/${TAREFA}/entrega`),
        pedido("POST", {
          ifMatch: '"2"',
          corpo: { resultado: "feito", resultado_ref: "https://x.com" },
        }),
      );
    expect(await entregar()).toEqual({ status: 200, corpo: entregue, itens: 1 });
    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_tarefa_id: TAREFA,
      p_versao: 2,
      p_resultado: "feito",
      p_resultado_ref: "https://x.com",
    });
    expect(await recusa(entregar())).toMatchObject({ status: 409 });
  });

  it("metodo sem par na rota cai em 404", async () => {
    const { client } = cliente({});
    expect(
      await recusa(atender(client, rota(`/v1/tarefas/${TAREFA}`), pedido("POST"))),
    ).toMatchObject({ status: 404 });
  });
});
```

- [x] **Passo 3: Ver falhar** — `npx vitest run tests/unit/office-api-atender.test.ts
  tests/unit/office-api-tarefas.test.ts`: `atender` ainda recebe `userId` e `query`.

- [x] **Passo 4: Implementar**

Arquivo: `supabase/functions/_shared/office-api/rpc.ts`

```ts
// Chamada de funcao SQL da office-api. Erro do banco vira 500; a mensagem vai so para
// o log da funcao.

export type Cliente = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};
export type Item = Record<string, any>;

export async function chamar<T = Item[]>(
  client: Cliente,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data ?? []) as T;
}
```

Arquivo: `supabase/functions/_shared/office-api/tarefas.ts`

```ts
// Rotas de tarefa da office-api. O que precisa ser atomico (versao, transicao de
// status, chave de idempotencia) fica nas funcoes SQL; aqui o resultado delas vira
// status HTTP. Nenhuma rota conclui, apaga ou reabre: isso e do dono, na tela.

import { HttpError } from "../http-error.ts";
import type { Pedido, Resposta } from "./atender.ts";
import { ErroApi } from "./erros.ts";
import { montarPagina } from "./pagina.ts";
import { lerCursor, lerLimite, UUID } from "./parametros.ts";
import { chamar, type Cliente, type Item } from "./rpc.ts";
import type { NomeRota } from "./rotas.ts";
import {
  lerAlteracao,
  lerChave,
  lerEntrega,
  lerFiltrosTarefas,
  lerNovaTarefa,
  lerVersao,
} from "./tarefas-corpo.ts";

type Escrita = { resultado: string; tarefa?: Item };

const RECUSAS: Record<string, [number, string]> = {
  nao_encontrada: [404, "tarefa nao encontrada"],
  lead_invalido: [400, "lead_id nao encontrado na conta"],
  versao: [412, "a tarefa mudou: refaca a alteracao sobre a versao atual, que vai em tarefa"],
  transicao: [
    409,
    "pela API o status so vai e volta entre pendente e em_andamento, e tarefa concluida nao recebe entrega",
  ],
};

function responder(escrita: Escrita, status: number): Resposta {
  const recusa = RECUSAS[escrita.resultado];
  if (recusa) {
    throw new ErroApi(recusa[0], recusa[1], escrita.tarefa ? { tarefa: escrita.tarefa } : {});
  }
  return { status, corpo: escrita.tarefa, itens: 1 };
}

function listar(client: Cliente, userId: string, args: Record<string, unknown>) {
  return chamar<Item[]>(client, "office_tarefas", {
    p_user_id: userId,
    p_tarefa_id: null,
    p_cursor_ts: null,
    p_cursor_id: null,
    p_limite: 1,
    p_status: null,
    p_responsavel_tipo: null,
    p_responsavel_ref: null,
    p_atualizado_desde: null,
    ...args,
  });
}

export async function atenderTarefas(
  client: Cliente,
  rota: { nome: NomeRota; id?: string },
  pedido: Pedido,
): Promise<Resposta> {
  const { userId, ator } = pedido;
  switch (`${pedido.metodo} ${rota.nome}`) {
    case "GET tarefas": {
      const limite = lerLimite(pedido.query.get("limite"));
      const recebido = pedido.query.get("cursor");
      const cursor = lerCursor(recebido, UUID);
      const filtros = lerFiltrosTarefas(pedido.query);
      const itens = await listar(client, userId, {
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
        p_status: filtros.status,
        p_responsavel_tipo: filtros.responsavelTipo,
        p_responsavel_ref: filtros.responsavelRef,
        p_atualizado_desde: filtros.atualizadoDesde,
      });
      const corpo = montarPagina(itens, limite, recebido, (t) => [t.atualizada_em, t.tarefa_id]);
      return { status: 200, corpo, itens: corpo.dados.length };
    }
    case "GET tarefa": {
      // Tarefa de outra conta e inexistente respondem igual: 404.
      const [tarefa] = await listar(client, userId, { p_tarefa_id: rota.id });
      if (!tarefa) throw new HttpError(404, "tarefa nao encontrada");
      return { status: 200, corpo: tarefa, itens: 1 };
    }
    case "POST tarefas": {
      const chave = lerChave(pedido.chave);
      const dados = lerNovaTarefa(pedido.corpo);
      const escrita = await chamar<Escrita>(client, "office_tarefa_criar", {
        p_user_id: userId,
        p_ator: ator,
        p_chave: chave,
        p_dados: dados,
      });
      return responder(escrita, escrita.resultado === "criada" ? 201 : 200);
    }
    case "PATCH tarefa": {
      const versao = lerVersao(pedido.ifMatch);
      const campos = lerAlteracao(pedido.corpo);
      const escrita = await chamar<Escrita>(client, "office_tarefa_alterar", {
        p_user_id: userId,
        p_ator: ator,
        p_tarefa_id: rota.id,
        p_versao: versao,
        p_campos: campos,
      });
      return responder(escrita, 200);
    }
    case "POST tarefa_entrega": {
      const versao = lerVersao(pedido.ifMatch);
      const { resultado, resultadoRef } = lerEntrega(pedido.corpo);
      const escrita = await chamar<Escrita>(client, "office_tarefa_entregar", {
        p_user_id: userId,
        p_ator: ator,
        p_tarefa_id: rota.id,
        p_versao: versao,
        p_resultado: resultado,
        p_resultado_ref: resultadoRef,
      });
      return responder(escrita, 200);
    }
    default:
      throw new HttpError(404, "rota inexistente");
  }
}
```

Arquivo: `supabase/functions/_shared/office-api/atender.ts`

```ts
// Rota da office-api → funcao SQL → resposta. A conta e sempre a do token, recebida
// no pedido; nada da requisicao vira conta.

import { HttpError } from "../http-error.ts";
import { montarPagina } from "./pagina.ts";
import {
  lerCursor,
  lerData,
  lerLimite,
  lerSituacao,
  lerUuid,
  SEQUENCIA,
  UUID,
} from "./parametros.ts";
import { chamar, type Cliente, type Item } from "./rpc.ts";
import type { Metodo, NomeRota } from "./rotas.ts";
import { atenderTarefas } from "./tarefas.ts";

export interface Pedido {
  metodo: Metodo;
  userId: string;
  /** Escopos do token: decidem o que o feed de exclusoes mostra. */
  escopos: string[];
  /** Autor das escritas no historico das tarefas: api:<rotulo do token>. */
  ator: string;
  query: URLSearchParams;
  ifMatch: string | null;
  chave: string | null;
  corpo: unknown;
}

export interface Resposta {
  status: number;
  corpo: unknown;
  itens: number | null;
}

const TAREFAS: NomeRota[] = ["tarefas", "tarefa", "tarefa_entrega"];

async function leadDaConta(client: Cliente, userId: string, leadId: string): Promise<Item> {
  const [lead] = await chamar(client, "office_leads", {
    p_user_id: userId,
    p_lead_id: leadId,
    p_cursor_ts: null,
    p_cursor_id: null,
    p_limite: 1,
    p_atualizado_desde: null,
    p_criado_de: null,
    p_criado_ate: null,
    p_etapa_id: null,
    p_situacao: null,
  });
  // Lead de outra conta e inexistente respondem igual: 404.
  if (!lead) throw new HttpError(404, "lead nao encontrado");
  return lead;
}

function entidadesExcluidas(escopos: string[]): string[] {
  return [
    ...(escopos.includes("comercial:leitura") ? ["lead", "message"] : []),
    ...(escopos.includes("tarefas:leitura") ? ["task"] : []),
  ];
}

export async function atender(
  client: Cliente,
  rota: { nome: NomeRota; id?: string },
  pedido: Pedido,
): Promise<Resposta> {
  if (TAREFAS.includes(rota.nome)) return atenderTarefas(client, rota, pedido);

  const { userId, query } = pedido;
  const limite = lerLimite(query.get("limite"));
  const recebido = query.get("cursor");

  const pagina = (itens: Item[], chave: (i: Item) => [string, string]) => {
    const corpo = montarPagina(itens, limite, recebido, chave);
    return { status: 200, corpo, itens: corpo.dados.length };
  };

  switch (rota.nome) {
    case "leads": {
      const cursor = lerCursor(recebido, UUID);
      const itens = await chamar(client, "office_leads", {
        p_user_id: userId,
        p_lead_id: null,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
        p_atualizado_desde: lerData("atualizado_desde", query.get("atualizado_desde")),
        p_criado_de: lerData("criado_de", query.get("criado_de")),
        p_criado_ate: lerData("criado_ate", query.get("criado_ate")),
        p_etapa_id: lerUuid("etapa_id", query.get("etapa_id")),
        p_situacao: lerSituacao(query.get("situacao")),
      });
      return pagina(itens, (l) => [l.atualizado_em, l.lead_id]);
    }
    case "lead":
      return { status: 200, corpo: await leadDaConta(client, userId, rota.id!), itens: 1 };
    case "lead_mensagens":
    case "mensagens": {
      const feed = rota.nome === "mensagens";
      const cursor = lerCursor(recebido, UUID);
      if (!feed) await leadDaConta(client, userId, rota.id!);
      const itens = await chamar(client, "office_mensagens", {
        p_user_id: userId,
        p_lead_id: feed ? null : rota.id,
        p_feed: feed,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
      });
      return pagina(itens, (m) => [feed ? m.gravada_em : m.enviada_em, m.mensagem_id]);
    }
    case "lead_etapas":
    case "etapas": {
      const feed = rota.nome === "etapas";
      const cursor = lerCursor(recebido, UUID);
      if (!feed) await leadDaConta(client, userId, rota.id!);
      const itens = await chamar(client, "office_eventos", {
        p_user_id: userId,
        p_lead_id: feed ? null : rota.id,
        p_feed: feed,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limite: limite,
      });
      return pagina(itens, (e) => [feed ? e.gravado_em : e.ocorreu_em, e.evento_id]);
    }
    case "exclusoes": {
      const cursor = lerCursor(recebido, SEQUENCIA);
      const itens = await chamar(client, "office_exclusoes", {
        p_user_id: userId,
        p_cursor_ts: cursor?.instante ?? null,
        p_cursor_id: cursor ? Number(cursor.id) : null,
        p_limite: limite,
        p_entidades: entidadesExcluidas(pedido.escopos),
      });
      return pagina(itens, (x) => [x.excluido_em, String(x.sequencia)]);
    }
    default:
      throw new HttpError(404, "rota inexistente");
  }
}
```

`vitest.config.ts`: acrescentar `rpc.ts` e `tarefas.ts` de `_shared/office-api/`.

- [x] **Passo 5: Ver passar, com a suíte inteira e o typecheck do Deno das partes
  compartilhadas**

```bash
npx vitest run
```

- [x] **Passo 6: Commit**

```bash
git add supabase/functions/_shared/office-api/rpc.ts supabase/functions/_shared/office-api/tarefas.ts supabase/functions/_shared/office-api/atender.ts tests/unit/office-api-atender.test.ts tests/unit/office-api-tarefas.test.ts vitest.config.ts
git commit -m "feat(office-api): rotas de tarefa e exclusoes por escopo"
```

---

### Task 6: Função `office-api` com método, corpo e ator

**Files:** Modify `supabase/functions/office-api/index.ts`.

**Interfaces — Consumes:** `metodoDaRota`, `encontrarRota` (Task 3); `corpoDeErro`,
`ErroApi` (Task 3); `lerJson` (Task 4); `atender` com `Pedido` (Task 5); `label` do
token (Task 2).

Ordem: rota (404) → método (405 com `Allow`) → `openapi.json` → token (401) → escopo do
método (403) → limite (429) → corpo JSON (400) → `atender`.

- [x] **Passo 1: Implementar**

Arquivo: `supabase/functions/office-api/index.ts`

```ts
// API do Eleve Office: leitura comercial (parte B) e tarefas (parte C). Token
// proprio: a conta sai do token (api_tokens), nunca da requisicao. Specs:
// docs/specs/2026-09-25-api-leitura-comercial-office-design.md e
// docs/specs/2026-09-25-tarefas-office-design.md.
//
// Sem CORS de proposito: quem chama e o servidor do Eleve Office.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { HttpError } from "../_shared/http-error.ts";
import { marcarUso, resolveApiToken, type TokenResolvido } from "../_shared/api-token.ts";
import { atender } from "../_shared/office-api/atender.ts";
import { registrarChamada } from "../_shared/office-api/auditoria.ts";
import { corpoDeErro, ErroApi } from "../_shared/office-api/erros.ts";
import { verificarLimite } from "../_shared/office-api/limite.ts";
import { encontrarRota, metodoDaRota } from "../_shared/office-api/rotas.ts";
import { lerJson } from "../_shared/office-api/tarefas-corpo.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import openapi from "./openapi.json" with { type: "json" };

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const erro = (status: number, mensagem: string, headers: Record<string, string> = {}) =>
  json(corpoDeErro(status, mensagem), status, headers);

serve(async (req) => {
  const inicio = Date.now();
  const client = createServiceRoleClient();
  const url = new URL(req.url);
  const rota = encontrarRota(url.pathname);
  let token: TokenResolvido | null = null;
  let status = 500;
  let itens: number | null = null;

  const responder = (resposta: Response, quantos: number | null = null) => {
    status = resposta.status;
    itens = quantos;
    return resposta;
  };

  try {
    if (!rota) return responder(erro(404, "rota inexistente"));
    const metodo = metodoDaRota(rota, req.method);
    if (!metodo) {
      const aceitos = Object.keys(rota.metodos).join(", ");
      return responder(erro(405, `a rota aceita ${aceitos}`, { Allow: aceitos }));
    }
    const escopos = rota.metodos[metodo];
    if (!escopos) return responder(json(openapi));

    token = await resolveApiToken(client, req.headers.get("authorization"));
    // Mesmo corpo para token ausente, errado e revogado.
    if (!token) return responder(erro(401, "token ausente, errado ou revogado"));
    const { scopes } = token;
    if (!escopos.some((escopo) => scopes.includes(escopo))) {
      return responder(erro(403, `a rota exige o escopo ${escopos.join(" ou ")}`));
    }

    const limite = await verificarLimite(client, token.tokenId, token.rateLimitPerMinute);
    if (!limite.ok) {
      return responder(
        erro(429, "limite de chamadas por minuto excedido", {
          "Retry-After": String(limite.retryAfter),
        }),
      );
    }

    const resposta = await atender(client, rota, {
      metodo,
      userId: token.userId,
      escopos: token.scopes,
      ator: `api:${token.label}`,
      query: url.searchParams,
      ifMatch: req.headers.get("if-match"),
      chave: req.headers.get("idempotency-key"),
      corpo: metodo === "GET" ? null : lerJson(await req.text()),
    });
    return responder(json(resposta.corpo, resposta.status), resposta.itens);
  } catch (error) {
    if (error instanceof HttpError) {
      const extra = error instanceof ErroApi ? error.extra : {};
      return responder(json(corpoDeErro(error.status, error.message, extra), error.status));
    }
    console.error(
      JSON.stringify({
        event: "office_api_erro",
        rota: rota?.modelo,
        metodo: req.method,
        user_id: token?.userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return responder(erro(500, "falha interna"));
  } finally {
    if (rota && rota.nome !== "openapi") {
      await registrarChamada(client, {
        tokenId: token?.tokenId ?? null,
        userId: token?.userId ?? null,
        metodo: req.method,
        rota: rota.modelo,
        status,
        itens,
        duracaoMs: Date.now() - inicio,
      });
      if (token) await marcarUso(client, token.tokenId);
    }
  }
});
```

- [x] **Passo 2: Typecheck do Deno e commit**

```bash
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/office-api/index.ts supabase/functions/sales-coach/index.ts
git add supabase/functions/office-api/index.ts
git commit -m "feat(office-api): metodo por rota, corpo JSON e ator das escritas"
```

---

### Task 7: Contrato OpenAPI

**Files:** Modify `supabase/functions/office-api/openapi.json`,
`tests/unit/office-api-openapi.test.ts`.

- [x] **Passo 1: Testes.** Trocar os testes 2 e 3 de `office-api-openapi.test.ts` por:

```ts
  it("documenta toda rota da tabela com os metodos dela, e nada alem", () => {
    const paths = openapi.paths as Record<string, Record<string, unknown>>;
    for (const rota of ROTAS) {
      expect(Object.keys(paths[rota.modelo] ?? {}).sort(), rota.modelo).toEqual(
        Object.keys(rota.metodos)
          .map((m) => m.toLowerCase())
          .sort(),
      );
    }
    expect(Object.keys(paths).sort()).toEqual(ROTAS.map((r) => r.modelo).sort());
  });

  it("toda operacao com escopo documenta sucesso, 401, 403, 429 e 500", () => {
    const paths = openapi.paths as Record<string, Record<string, any>>;
    for (const rota of ROTAS) {
      for (const [metodo, escopos] of Object.entries(rota.metodos)) {
        if (!escopos) continue;
        const respostas = paths[rota.modelo][metodo.toLowerCase()].responses;
        const nome = `${metodo} ${rota.modelo}`;
        expect(respostas["200"] ?? respostas["201"], nome).toBeTruthy();
        for (const status of ["401", "403", "429", "500"]) {
          expect(respostas[status], `${nome} ${status}`).toBeTruthy();
        }
      }
    }
  });

  it("escrita de tarefa documenta a chave, o If-Match e os erros de conflito", () => {
    const paths = openapi.paths as Record<string, Record<string, any>>;
    const parametros = (op: any) => JSON.stringify(op.parameters ?? []);
    expect(parametros(paths["/v1/tarefas"].post)).toContain("idempotencyKey");
    expect(paths["/v1/tarefas"].post.responses["201"]).toBeTruthy();
    for (const op of [paths["/v1/tarefas/{id}"].patch, paths["/v1/tarefas/{id}/entrega"].post]) {
      expect(parametros(op)).toContain("ifMatch");
      for (const status of ["400", "404", "409", "412", "428"]) {
        expect(op.responses[status], status).toBeTruthy();
      }
    }
  });
```

- [x] **Passo 2: Ver falhar** — `npx vitest run tests/unit/office-api-openapi.test.ts`:
  faltam as rotas de tarefa.

- [x] **Passo 3: Implementar** com um script de uma vez só (`node`), que lê
  `openapi.json`, aplica o que segue e grava; depois `npx prettier --write`.

  - `info.version` = `1.1.0`; `info.description` passa a dizer "Leitura comercial e
    tarefas do EleveFlow para os agentes do Eleve Office" e explica que tarefa é criada,
    alterada e entregue pelo Office, e só o dono conclui.
  - `components.securitySchemes.bearer.description`: escopos `comercial:leitura` (leads,
    mensagens, etapas), `tarefas:leitura` e `tarefas:escrita`.
  - `/v1/exclusoes`: resumo "Feed de leads, mensagens e tarefas apagados"; descrição com
    a regra por escopo.
  - `components.schemas.Exclusao.entidade.enum` ganha `tarefa`;
    `components.schemas.Erro.erro.codigo.enum` ganha `transicao_invalida`,
    `versao_desatualizada`, `versao_obrigatoria`; `NaoEncontrado` passa a "Lead ou tarefa
    inexistente, ou de outra conta. Não repetir."
  - parâmetros novos: `tarefaId` (path `id`), `statusTarefa`, `responsavelTipo`,
    `responsavelRef` (query), `ifMatch` e `idempotencyKey` (header, obrigatórios);
  - schemas novos: `Responsavel`, `Tarefa` (campos e exemplo da spec), `TarefaNova`,
    `TarefaAlteracao`, `Entrega`, `PaginaTarefas`, `ErroComTarefa`
    (`allOf` de `Erro` + `tarefa`);
  - respostas novas: `TransicaoInvalida` (409, `ErroComTarefa`), `VersaoDesatualizada`
    (412, `ErroComTarefa`), `VersaoObrigatoria` (428, `Erro`);
  - paths: `/v1/tarefas` (`get` com filtros e `PaginaTarefas`; `post` com
    `idempotencyKey`, `TarefaNova`, 201 e 200), `/v1/tarefas/{id}` (`get`; `patch` com
    `ifMatch` e `TarefaAlteracao`, 409/412/428), `/v1/tarefas/{id}/entrega` (`post` com
    `ifMatch` e `Entrega`, 409/412/428). Toda operação com 200/201, 401, 403, 429 e
    500; as de escrita também 400 e as de id também 404.

- [x] **Passo 4: Ver passar e commitar**

```bash
npx vitest run tests/unit/office-api-openapi.test.ts
git add supabase/functions/office-api/openapi.json tests/unit/office-api-openapi.test.ts
git commit -m "docs(office-api): contrato das rotas de tarefa"
```

---

### Task 8: Tela Minhas Tarefas

**Files:** Create `src/lib/tarefas.ts`, `tests/unit/tarefas-tela.test.ts`; Modify
`src/pages/Tasks.tsx`, `src/integrations/supabase/types.ts`, `vitest.config.ts`.

**Interfaces — Produces:** `type StatusTarefa`; `interface Mudanca { status;
completed_at }`; `ordenarTarefas(tarefas)`; `concluir(agora?)`; `devolver()`;
`alternar(status, agora?)`; `nomeDoResponsavel({ assignee_type, assignee_ref })`.

**Plano de design (skill `frontend-design`).** Página dentro do app escuro do EleveFlow:
a paleta e a tipografia são as do app, não se inventa outra para uma página só.

- Cor: base `#0d0d14`, linha `#1e1e2e`, texto `#e2e8f0`, apagado `#94a3b8`, violeta
  `#7c3aed` (ações primárias do app), âmbar `#f59e0b` **só** para "espera você".
- Tipo: família do app; título 2xl negrito, cartão semibold, metadados xs.
- Layout: coluna única (`max-w-5xl`). Quando há entrega, um grupo "Esperando sua
  revisão" abre a lista; o resto segue abaixo, como hoje.

```
Minhas Tarefas                                        [+ Nova tarefa]
Sua rotina e as entregas dos agentes do Eleve Office.
[Todas 7] [• Para revisar 2] [Pendentes 3] [Em andamento 1] [Concluídas 1]

Esperando sua revisão (2)
┃ Entregue há 5 min por Agente sdr-1
┃ Ligar para a Barbearia Exemplo  Alta
┃ │ Liguei; a demonstração ficou para quinta, 10h.
┃   Abrir resultado
┃ [Barbearia Exemplo]                    [Devolver] [Concluir]

☐ Revisar proposta  Média  Pendente
  Amanhã 10:00  [Eleve Office] [Agente sdr-2] [Lead X]        ✎ 🗑
```

- Princípios: a entrega (o texto do resultado) é o que o dono veio ver, então é o centro
  do cartão, com a régua âmbar; o resto da lista fica quieto. Etiquetas só quando há
  informação (origem Office, agente, lead). Nenhuma animação nova.
- Revisão contra o padrão genérico: um quadro kanban ou um cabeçalho de números grandes
  seriam o default e não ajudam a decidir; ficou a fila de decisão com a ação no próprio
  cartão.

- [x] **Passo 1: Testes**

Arquivo: `tests/unit/tarefas-tela.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  alternar,
  concluir,
  devolver,
  nomeDoResponsavel,
  ordenarTarefas,
  type StatusTarefa,
} from "../../src/lib/tarefas";

const AGORA = new Date("2026-09-25T12:00:00.000Z");
const t = (id: string, status: StatusTarefa, due_date: string | null, created_at: string) => ({
  id,
  status,
  due_date,
  created_at,
});

describe("ordenarTarefas", () => {
  it("revisao, em andamento, pendente e concluida; prazo mais proximo antes; sem prazo por ultimo", () => {
    const tarefas = [
      t("d", "done", null, "2026-09-20T00:00:00Z"),
      t("p-sem-prazo", "pending", null, "2026-09-21T00:00:00Z"),
      t("p-27", "pending", "2026-09-27T00:00:00Z", "2026-09-21T00:00:00Z"),
      t("p-26", "pending", "2026-09-26T00:00:00Z", "2026-09-21T00:00:00Z"),
      t("i", "in_progress", null, "2026-09-22T00:00:00Z"),
      t("r", "aguardando_revisao", null, "2026-09-23T00:00:00Z"),
    ];
    expect(ordenarTarefas(tarefas).map((x) => x.id)).toEqual([
      "r",
      "i",
      "p-26",
      "p-27",
      "p-sem-prazo",
      "d",
    ]);
  });

  it("no empate, a criada por ultimo vem antes; a lista original fica igual", () => {
    const tarefas = [
      t("velha", "pending", null, "2026-09-20T00:00:00Z"),
      t("nova", "pending", null, "2026-09-24T00:00:00Z"),
    ];
    expect(ordenarTarefas(tarefas).map((x) => x.id)).toEqual(["nova", "velha"]);
    expect(tarefas.map((x) => x.id)).toEqual(["velha", "nova"]);
  });
});

describe("acoes do dono", () => {
  it("concluir marca a hora; devolver volta a tarefa para em andamento", () => {
    expect(concluir(AGORA)).toEqual({ status: "done", completed_at: "2026-09-25T12:00:00.000Z" });
    expect(devolver()).toEqual({ status: "in_progress", completed_at: null });
  });

  it("o quadrado conclui a aberta e reabre a concluida", () => {
    expect(alternar("pending", AGORA)).toEqual(concluir(AGORA));
    expect(alternar("in_progress", AGORA)).toEqual(concluir(AGORA));
    expect(alternar("done", AGORA)).toEqual({ status: "pending", completed_at: null });
  });
});

describe("nomeDoResponsavel", () => {
  it("agente pela referencia do Office; dono e voce", () => {
    expect(nomeDoResponsavel({ assignee_type: "agente", assignee_ref: "sdr-1" })).toBe(
      "Agente sdr-1",
    );
    expect(nomeDoResponsavel({ assignee_type: "dono", assignee_ref: null })).toBe("Você");
  });
});
```

- [x] **Passo 2: Ver falhar** — `npx vitest run tests/unit/tarefas-tela.test.ts`.

- [x] **Passo 3: Implementar**

Arquivo: `src/lib/tarefas.ts`

```ts
// Regras da tela Minhas Tarefas. A entrega de um agente espera o dono no topo e só
// sai de lá por Concluir ou Devolver: nenhuma rota da API conclui tarefa.

export type StatusTarefa = "pending" | "in_progress" | "aguardando_revisao" | "done";

export interface Mudanca {
  status: StatusTarefa;
  completed_at: string | null;
}

const ORDEM: Record<StatusTarefa, number> = {
  aguardando_revisao: 0,
  in_progress: 1,
  pending: 2,
  done: 3,
};

const prazo = (t: { due_date: string | null }) =>
  t.due_date ? Date.parse(t.due_date) : Number.POSITIVE_INFINITY;

export function ordenarTarefas<
  T extends { status: StatusTarefa; due_date: string | null; created_at: string },
>(tarefas: T[]): T[] {
  return [...tarefas].sort(
    (a, b) =>
      ORDEM[a.status] - ORDEM[b.status] ||
      prazo(a) - prazo(b) ||
      b.created_at.localeCompare(a.created_at),
  );
}

export function concluir(agora = new Date()): Mudanca {
  return { status: "done", completed_at: agora.toISOString() };
}

export function devolver(): Mudanca {
  return { status: "in_progress", completed_at: null };
}

/** Clique no quadrado da tarefa: conclui a aberta, reabre a concluída. */
export function alternar(status: StatusTarefa, agora = new Date()): Mudanca {
  return status === "done" ? { status: "pending", completed_at: null } : concluir(agora);
}

export function nomeDoResponsavel(t: {
  assignee_type: string;
  assignee_ref: string | null;
}): string {
  return t.assignee_type === "agente" ? `Agente ${t.assignee_ref}` : "Você";
}
```

`vitest.config.ts`: acrescentar `"src/lib/tarefas.ts"`.

`src/integrations/supabase/types.ts`, em `personal_tasks`: `Row` ganha
`assignee_ref: string | null; assignee_type: string; creator_ref: string | null;
creator_type: string; external_order_id: string | null; idempotency_key: string | null;
lead_id: string | null; origin: string; project_ref: string | null; result: string |
null; result_ref: string | null; version: number` (em ordem alfabética, como o gerado);
`Insert` e `Update` ganham os mesmos, opcionais; `Relationships` passa a:

```ts
        Relationships: [
          {
            foreignKeyName: "personal_tasks_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
```

Arquivo: `src/pages/Tasks.tsx`

```tsx
import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus,
  Trash2,
  Pencil,
  CheckCircle2,
  Clock,
  AlertCircle,
  Calendar as CalendarIcon,
  Bot,
  ExternalLink,
  Inbox,
  Undo2,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow, isToday, isPast, isTomorrow } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  alternar,
  concluir,
  devolver,
  nomeDoResponsavel,
  ordenarTarefas,
  type Mudanca,
  type StatusTarefa,
} from "@/lib/tarefas";

type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: "low" | "medium" | "high";
  status: StatusTarefa;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  origin: string;
  assignee_type: string;
  assignee_ref: string | null;
  result: string | null;
  result_ref: string | null;
  lead: { id: string; name: string } | null;
};

type Filtro = "all" | StatusTarefa;

const priorityConfig = {
  low: { label: "Baixa", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  medium: { label: "Média", color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  high: { label: "Alta", color: "bg-red-500/15 text-red-400 border-red-500/30" },
};

const statusConfig: Record<StatusTarefa, { label: string; icon: LucideIcon; color: string }> = {
  aguardando_revisao: { label: "Aguardando revisão", icon: Inbox, color: "text-amber-300" },
  in_progress: { label: "Em andamento", icon: AlertCircle, color: "text-sky-400" },
  pending: { label: "Pendente", icon: Clock, color: "text-[#94a3b8]" },
  done: { label: "Concluída", icon: CheckCircle2, color: "text-green-400" },
};

const FILTROS: Array<{ chave: Filtro; rotulo: string }> = [
  { chave: "all", rotulo: "Todas" },
  { chave: "aguardando_revisao", rotulo: "Para revisar" },
  { chave: "pending", rotulo: "Pendentes" },
  { chave: "in_progress", rotulo: "Em andamento" },
  { chave: "done", rotulo: "Concluídas" },
];

const VAZIO: Record<Filtro, string> = {
  all: "Nenhuma tarefa ainda. Crie a primeira.",
  aguardando_revisao:
    "Nada esperando revisão. Quando um agente do Eleve Office entregar uma tarefa, ela aparece aqui.",
  pending: "Nenhuma tarefa pendente.",
  in_progress: "Nenhuma tarefa em andamento.",
  done: "Nenhuma tarefa concluída.",
};

function Etiqueta({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#1e1e2e] bg-[#12121c] px-2 py-0.5 text-xs text-[#94a3b8]">
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

function Resultado({
  texto,
  link,
  destaque,
}: {
  texto: string;
  link: string | null;
  destaque: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const longo = texto.length > 280;
  return (
    <div>
      <p
        className={`whitespace-pre-wrap text-sm ${
          destaque ? "border-l-2 border-[#f59e0b]/60 pl-3 text-[#e2e8f0]" : "text-[#94a3b8]"
        } ${longo && !aberto ? "line-clamp-4" : ""}`}
      >
        {texto}
      </p>
      {(longo || link) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
          {longo && (
            <button
              type="button"
              onClick={() => setAberto(!aberto)}
              className="text-[#94a3b8] underline-offset-2 hover:text-white hover:underline"
            >
              {aberto ? "Mostrar menos" : "Mostrar tudo"}
            </button>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#a78bfa] underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden /> Abrir resultado
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filtro>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "medium" as Task["priority"],
    status: "pending" as StatusTarefa,
    due_date: "",
  });

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["personal_tasks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("personal_tasks")
        .select("*, lead:leads(id, name)");
      if (error) throw error;
      return ordenarTarefas(data as unknown as Task[]);
    },
  });

  const saveTask = useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");
      const payload = {
        user_id: user.id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        status: form.status,
        due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
        completed_at: form.status === "done" ? new Date().toISOString() : null,
      };
      if (editingTask) {
        const { error } = await supabase
          .from("personal_tasks")
          .update(payload)
          .eq("id", editingTask.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("personal_tasks").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personal_tasks"] });
      toast.success(editingTask ? "Tarefa atualizada" : "Tarefa criada");
      closeDialog();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mudarStatus = useMutation({
    mutationFn: async ({ task, mudanca }: { task: Task; mudanca: Mudanca; aviso?: string }) => {
      const { error } = await supabase.from("personal_tasks").update(mudanca).eq("id", task.id);
      if (error) throw error;
    },
    onSuccess: (_, { aviso }) => {
      queryClient.invalidateQueries({ queryKey: ["personal_tasks"] });
      if (aviso) toast.success(aviso);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTask = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("personal_tasks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personal_tasks"] });
      toast.success("Tarefa removida");
    },
  });

  const openNew = () => {
    setEditingTask(null);
    setForm({ title: "", description: "", priority: "medium", status: "pending", due_date: "" });
    setDialogOpen(true);
  };

  const openEdit = (t: Task) => {
    setEditingTask(t);
    setForm({
      title: t.title,
      description: t.description || "",
      priority: t.priority,
      status: t.status,
      due_date: t.due_date ? t.due_date.slice(0, 16) : "",
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingTask(null);
  };

  const filtered = tasks.filter((t) => filter === "all" || t.status === filter);
  const paraRevisar = filtered.filter((t) => t.status === "aguardando_revisao");
  const demais = filtered.filter((t) => t.status !== "aguardando_revisao");
  const contagem = (f: Filtro) =>
    f === "all" ? tasks.length : tasks.filter((t) => t.status === f).length;

  const formatDue = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isToday(d)) return { label: `Hoje ${format(d, "HH:mm")}`, tone: "text-yellow-400" };
    if (isTomorrow(d)) return { label: `Amanhã ${format(d, "HH:mm")}`, tone: "text-blue-400" };
    if (isPast(d))
      return {
        label: `Atrasada — ${format(d, "dd/MM HH:mm", { locale: ptBR })}`,
        tone: "text-red-400",
      };
    return { label: format(d, "dd/MM HH:mm", { locale: ptBR }), tone: "text-[#94a3b8]" };
  };

  const renderRevisao = (t: Task) => (
    <Card
      key={t.id}
      className="relative overflow-hidden border-[#f59e0b]/30 bg-[#f59e0b]/[0.04] p-4 pl-5"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[#f59e0b]" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-amber-300/90">
            Entregue{" "}
            {formatDistanceToNow(new Date(t.updated_at), { addSuffix: true, locale: ptBR })}
            {t.assignee_type === "agente" ? ` por ${nomeDoResponsavel(t)}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{t.title}</h3>
            <Badge variant="outline" className={priorityConfig[t.priority].color}>
              {priorityConfig[t.priority].label}
            </Badge>
          </div>
          {t.result && (
            <div className="mt-3">
              <Resultado texto={t.result} link={t.result_ref} destaque />
            </div>
          )}
          {t.lead && (
            <div className="mt-3">
              <Etiqueta icon={UserRound}>{t.lead.name}</Etiqueta>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mudarStatus.isPending}
            onClick={() =>
              mudarStatus.mutate({
                task: t,
                mudanca: devolver(),
                aviso: "Tarefa devolvida para o agente",
              })
            }
            className="border-[#2a2a3a] bg-transparent"
          >
            <Undo2 className="h-4 w-4 mr-1.5" /> Devolver
          </Button>
          <Button
            size="sm"
            disabled={mudarStatus.isPending}
            onClick={() =>
              mudarStatus.mutate({ task: t, mudanca: concluir(), aviso: "Tarefa concluída" })
            }
            className="bg-[#f59e0b] text-[#1c1405] hover:bg-[#fbbf24]"
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" /> Concluir
          </Button>
        </div>
      </div>
    </Card>
  );

  const renderTarefa = (t: Task) => {
    const Icon = statusConfig[t.status].icon;
    const due = formatDue(t.due_date);
    const doOffice = t.origin === "eleve_office";
    const deAgente = t.assignee_type === "agente";
    return (
      <Card
        key={t.id}
        className={`p-4 bg-[#0d0d14] border-[#1e1e2e] hover:border-[#7c3aed]/30 transition ${
          t.status === "done" ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-start gap-3">
          <Checkbox
            checked={t.status === "done"}
            onCheckedChange={() => mudarStatus.mutate({ task: t, mudanca: alternar(t.status) })}
            aria-label={t.status === "done" ? "Reabrir tarefa" : "Concluir tarefa"}
            className="mt-1"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className={`font-semibold ${t.status === "done" ? "line-through text-[#94a3b8]" : ""}`}
              >
                {t.title}
              </h3>
              <Badge variant="outline" className={priorityConfig[t.priority].color}>
                {priorityConfig[t.priority].label}
              </Badge>
              <span
                className={`text-xs flex items-center gap-1 ${statusConfig[t.status].color}`}
              >
                <Icon className="h-3 w-3" /> {statusConfig[t.status].label}
              </span>
            </div>
            {t.description && (
              <p className="text-sm text-[#94a3b8] mt-1 whitespace-pre-wrap">{t.description}</p>
            )}
            {t.result && (
              <div className="mt-2 rounded-md bg-[#12121c] px-3 py-2">
                <p className="mb-1 text-xs font-medium text-[#94a3b8]">Última entrega</p>
                <Resultado texto={t.result} link={t.result_ref} destaque={false} />
              </div>
            )}
            {(due || doOffice || deAgente || t.lead) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {due && (
                  <span className={`mr-1 text-xs flex items-center gap-1 ${due.tone}`}>
                    <CalendarIcon className="h-3 w-3" /> {due.label}
                  </span>
                )}
                {doOffice && <Etiqueta icon={Workflow}>Eleve Office</Etiqueta>}
                {deAgente && <Etiqueta icon={Bot}>{nomeDoResponsavel(t)}</Etiqueta>}
                {t.lead && <Etiqueta icon={UserRound}>{t.lead.name}</Etiqueta>}
              </div>
            )}
          </div>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" aria-label="Editar tarefa" onClick={() => openEdit(t)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Remover tarefa"
              onClick={() => {
                if (confirm("Remover esta tarefa?")) deleteTask.mutate(t.id);
              }}
            >
              <Trash2 className="h-4 w-4 text-red-400" />
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Minhas Tarefas</h1>
          <p className="text-sm text-[#94a3b8] mt-1">
            Sua rotina e as entregas dos agentes do Eleve Office.
          </p>
        </div>
        <Button onClick={openNew} className="bg-[#7c3aed] hover:bg-[#6d28d9]">
          <Plus className="h-4 w-4 mr-2" /> Nova tarefa
        </Button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {FILTROS.map(({ chave, rotulo }) => {
          const n = contagem(chave);
          return (
            <button
              key={chave}
              type="button"
              onClick={() => setFilter(chave)}
              aria-pressed={filter === chave}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                filter === chave
                  ? "bg-[#7c3aed15] text-[#7c3aed] border-[#7c3aed]/40"
                  : "bg-[#0d0d14] text-[#94a3b8] border-[#1e1e2e] hover:text-white"
              }`}
            >
              {chave === "aguardando_revisao" && n > 0 && (
                <span
                  aria-hidden
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#f59e0b] align-middle"
                />
              )}
              {rotulo}
              <span className="ml-2 text-xs opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p className="text-[#94a3b8]">Carregando…</p>
      ) : filtered.length === 0 ? (
        <Card className="p-12 text-center bg-[#0d0d14] border-[#1e1e2e]">
          <CheckCircle2 className="h-10 w-10 mx-auto text-[#475569] mb-3" />
          <p className="text-[#94a3b8]">{VAZIO[filter]}</p>
        </Card>
      ) : (
        <div className="space-y-8">
          {paraRevisar.length > 0 && (
            <section aria-labelledby="revisao-titulo" className="space-y-2">
              <h2
                id="revisao-titulo"
                className="flex items-center gap-2 text-sm font-semibold text-amber-200"
              >
                Esperando sua revisão
                <span className="rounded-full bg-[#f59e0b]/15 px-2 py-0.5 text-xs text-amber-300">
                  {paraRevisar.length}
                </span>
              </h2>
              {paraRevisar.map(renderRevisao)}
            </section>
          )}
          {demais.length > 0 && <div className="space-y-2">{demais.map(renderTarefa)}</div>}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="bg-[#0d0d14] border-[#1e1e2e]">
          <DialogHeader>
            <DialogTitle>{editingTask ? "Editar tarefa" : "Nova tarefa"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Título</label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Ex: Responder e-mails da manhã"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Descrição (opcional)</label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Prioridade</label>
                <Select
                  value={form.priority}
                  onValueChange={(v: Task["priority"]) => setForm({ ...form, priority: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Baixa</SelectItem>
                    <SelectItem value="medium">Média</SelectItem>
                    <SelectItem value="high">Alta</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Status</label>
                <Select
                  value={form.status}
                  onValueChange={(v: StatusTarefa) => setForm({ ...form, status: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pendente</SelectItem>
                    <SelectItem value="in_progress">Em andamento</SelectItem>
                    {editingTask?.status === "aguardando_revisao" && (
                      <SelectItem value="aguardando_revisao">Aguardando revisão</SelectItem>
                    )}
                    <SelectItem value="done">Concluída</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Prazo (opcional)</label>
              <Input
                type="datetime-local"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Cancelar
            </Button>
            <Button
              onClick={() => saveTask.mutate()}
              disabled={!form.title.trim() || saveTask.isPending}
              className="bg-[#7c3aed] hover:bg-[#6d28d9]"
            >
              {saveTask.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [x] **Passo 4: Ver passar; typecheck, lint e build**

```bash
npx vitest run tests/unit/tarefas-tela.test.ts
npx tsc --noEmit
npx eslint src/pages/Tasks.tsx src/lib/tarefas.ts
npx prettier --check --end-of-line auto src/pages/Tasks.tsx src/lib/tarefas.ts src/integrations/supabase/types.ts
npm run build:staging
```

**Ajuste depois da conferência visual em produção (2026-09-26):** o `Button` padrão do
app pinta com gradiente violeta, que cobria o `bg-[#f59e0b]` do Concluir e deixava o
texto escuro sem contraste; Concluir passa a usar o botão primário do app (violeta, texto
branco), e o âmbar fica só na sinalização, como diz o desenho. O cartão de revisão ganha
`hover:border-[#f59e0b]/60` (o `Card` base troca a borda para violeta no hover) e os
filtros, `whitespace-nowrap`.

- [x] **Passo 5: Commit**

```bash
git add src/lib/tarefas.ts tests/unit/tarefas-tela.test.ts src/pages/Tasks.tsx src/integrations/supabase/types.ts vitest.config.ts
git commit -m "feat(tarefas): tela revisa a entrega do agente com Concluir e Devolver"
```

---

### Task 9: E2E das tarefas (vermelho antes da implantação)

**Files:** Create `tests/e2e/office-api-tarefas.spec.ts`; Modify
`tests/e2e/office-api.spec.ts`.

Tokens: `STAGING_OFFICE_TOKEN_TAREFAS` (conta A, rótulo `E2E tarefas`, escopos
`tarefas:leitura,tarefas:escrita`, criado na Task 10), `STAGING_SALES_COACH_E2E_TOKEN`
(conta A, `comercial:leitura`), `STAGING_OFFICE_TOKEN_SEM_ESCOPO` (conta A, só
`tarefas:leitura`).

- [x] **Passo 1: Ajuste da parte B.** Em `office-api.spec.ts`, o último `expect` de
  "autenticacao, escopo, metodo e parametros" passa de 404 para 403 (a rota existe e o
  token comercial não tem `tarefas:leitura`).

- [x] **Passo 2: E2E**

Arquivo: `tests/e2e/office-api-tarefas.spec.ts`

```ts
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
    (await request.get(`${BASE}/tarefas/${tarefaB}`, { headers: cabecalhos(TOKEN_TAREFAS) })).status(),
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
    (await request.get(`${BASE}/tarefas?status=feita`, { headers: cabecalhos(TOKEN_TAREFAS) })).status(),
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
```

- [x] **Passo 3: Ver falhar pelo motivo certo** (depois de criar o token de E2E, antes da
  migration e do deploy): as rotas de tarefa respondem 404.

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" E2E_BASE_URL=https://eleveflow-tan.vercel.app \
  npx playwright test tests/e2e/office-api-tarefas.spec.ts tests/e2e/office-api.spec.ts
```

- [x] **Passo 4: Commit**

```bash
git add tests/e2e/office-api-tarefas.spec.ts tests/e2e/office-api.spec.ts
git commit -m "test(e2e): tarefas pela office-api com idempotencia, conflito, escopo e historico"
```

---

### Task 10: Guia do Office e implantação (gate do dono)

**Files:** Modify `docs/api/office-api.md`, `STATUS.md`.

- [x] **Passo 1: Guia.** Em `docs/api/office-api.md`: abertura passa a "leitura comercial
  e tarefas"; seção **Tarefas (Nexo)** com o token próprio (`tarefas:leitura` e
  `tarefas:escrita`, variável sugerida `ELEVE_FLOW_NEXO_TOKEN`), as 5 rotas, criação com
  `Idempotency-Key` (usar o id da ordem ou da tarefa no Office), alteração e entrega com
  `If-Match`, a regra de status, quem conclui, sincronização por `/v1/tarefas` +
  `/v1/exclusoes` (`entidade = tarefa`), e a tabela de erros com 409, 412 e 428; a linha
  do 405 passa a "usar o método da rota (header `Allow`)". Commit
  `docs: guia das tarefas pela office-api`.

- [x] **Passo 2: Pedir o OK** para a sequência abaixo, que para no primeiro erro.

- [x] **Passo 3: Ensaio da migration.** Um `DO` só (`gera-ensaio.cjs` no scratchpad): `EXECUTE`
  da migration, criação, repetição, alteração (versão certa, versão errada, transição,
  lead alheio, inexistente), entrega e leitura pela API na conta E2E; depois, com
  `SET LOCAL ROLE authenticated` e `request.jwt.claims` do usuário E2E, conclusão e
  exclusão pela "tela" (ator `tela`, tombstone `task`, RLS sem tarefa alheia). Termina em
  `RAISE EXCEPTION ENSAIO OK`: o comando inteiro é desfeito e nenhuma transação fica
  aberta segurando lock (um `BEGIN` que falhasse no meio deixaria). Depois, conferir que
  nada ficou (`personal_task_history` inexistente, sem `version`, sem lock).

- [x] **Passo 4: Token de E2E** (`--env STAGING_OFFICE_TOKEN_TAREFAS`, rótulo
  `E2E tarefas`, conta `e2e@eleveflow.test`) e o **E2E vermelho** da Task 9.

- [x] **Passo 5: Migration** (`bash scripts/sb-staging.sh db push`) e conferência:
  colunas, constraints, triggers, ACL das funções (`postgres` e `service_role`), 5
  tarefas do dono intactas com `version = 1`.

- [x] **Passo 6: Deploy** da `office-api`; E2E da parte B, das tarefas e do sales-coach.

- [x] **Passo 7: Frontend** (`npm run build:staging`, `npx vercel deploy --prebuilt --prod`,
  `npx vercel alias set <url> eleveflow-tan.vercel.app`) e conferência da tela.

- [x] **Passo 8: Token do Nexo** (rótulo `Nexo`, conta Eleve One, `tarefas:leitura` e
  `tarefas:escrita`), mostrado uma vez ao dono.

- [x] **Passo 9: STATUS** com o que está no ar, o verificado e o pendente (a primeira
  chamada do Nexo; o teste entre os dois sistemas). Commit
  `docs: registra as tarefas pela office-api em producao`.
