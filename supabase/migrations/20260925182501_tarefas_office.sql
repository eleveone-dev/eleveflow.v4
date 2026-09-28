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
