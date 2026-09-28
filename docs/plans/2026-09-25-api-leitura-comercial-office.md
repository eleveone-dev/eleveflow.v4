# API de leitura comercial para o Eleve Office (parte B): plano de implementação

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` ou `superpowers:executing-plans` para
> implementar tarefa a tarefa. Os passos usam checkbox (`- [x]`).

**Objetivo:** `office-api`, só leitura, com leads, mensagens, eventos de etapa e feeds de
sincronização, por token com escopo, auditoria e limite por token.

**Arquitetura:** a Edge Function resolve o token na tabela `api_tokens` (hash → conta,
escopos, limite), confere o escopo da rota, conta as chamadas do último minuto em
`api_request_log`, chama uma função SQL por recurso com a conta do token e monta a página
com cursor opaco. As funções SQL filtram pela conta em toda consulta e só o
`service_role` as executa.

**Stack:** Edge Functions (Deno 2), Postgres, Vitest, Playwright.

**Spec:** `docs/specs/2026-09-25-api-leitura-comercial-office-design.md`.

**Base:** `feat/f1-evolution-provider`, `d14e482`. Linha de base: 42 arquivos, 533 testes.

## Global Constraints

- Português do Brasil em commits, comentários e docs; commit sem acentuação.
- Conventional Commits atômicos. **Sem rastro de IA.**
- **TDD:** teste, ver falhar, implementar, ver passar.
- **Nada declarado pronto sem a saída do comando colada.**
- `_shared/`: sem `import` por URL e sem `Deno.env`.
- Banco só aditivo: tabela, coluna, índice, função e trigger novos; `CREATE OR REPLACE`
  preservando o corpo atual. `DROP ... IF EXISTS` só para recriar constraint ou trigger.
- **A conta nunca vem da requisição.** Nunca logar token, hash, texto de mensagem nem
  dado de lead.
- **Gate do dono:** migrations, tokens na tabela, deploys e a remoção do segredo só com OK.
- Todo comando Supabase via `bash scripts/sb-staging.sh` (é **produção**).
- Cobertura: gate de 80%; módulo novo entra em `coverage.include`.

## Arquivos

| arquivo | responsabilidade |
|---|---|
| `supabase/migrations/20260925150444_api_tokens_auditoria_exclusoes.sql` | `api_tokens`, `api_request_log`, `api_deleted_records` e triggers, `messages.inserted_at` |
| `supabase/migrations/20260925150452_origem_ia_e_nome_da_etapa.sql` | `send_queue.origin`, entrega com origem, nome da etapa no evento |
| `supabase/migrations/20260925150500_office_api_leitura.sql` | `office_leads`, `office_mensagens`, `office_eventos`, `office_exclusoes` |
| `supabase/functions/_shared/hmac.ts` | ganha `sha256Hex` |
| `supabase/functions/_shared/api-token.ts` | token → conta, escopos, limite; marca uso |
| `supabase/functions/_shared/office-api/cursor.ts` | cursor opaco |
| `supabase/functions/_shared/office-api/parametros.ts` | parâmetros de consulta |
| `supabase/functions/_shared/office-api/rotas.ts` | tabela de rotas e escopos |
| `supabase/functions/_shared/office-api/pagina.ts` | página com cursor |
| `supabase/functions/_shared/office-api/limite.ts` | limite por token |
| `supabase/functions/_shared/office-api/auditoria.ts` | linha de auditoria |
| `supabase/functions/_shared/office-api/atender.ts` | rota → função SQL → corpo |
| `supabase/functions/office-api/index.ts`, `openapi.json` | função e contrato |
| `supabase/functions/sales-coach/index.ts`, `_shared/sales-coach.ts` | token pela tabela |
| `supabase/functions/ai-agent-reply/index.ts` | `origin: "ia"` na fila |
| `scripts/lib/token-api.ts`, `scripts/criar-token-api.ts` | geração e importação de token |
| `tests/unit/*`, `tests/e2e/office-api.spec.ts` | testes |
| `docs/api/office-api.md` | guia do Office |

---

### Task 1: Tokens, auditoria, exclusões e `inserted_at`

**Files:** Modify `supabase/migrations/20260925150444_api_tokens_auditoria_exclusoes.sql`.

**Interfaces — Produces:** tabelas `api_tokens(id, user_id, label, token_hash, scopes,
rate_limit_per_minute, created_at, revoked_at, last_used_at)`,
`api_request_log(id, token_id, user_id, method, route, status, items, duration_ms,
created_at)`, `api_deleted_records(id, user_id, entity, entity_id, deleted_at)`; coluna
`messages.inserted_at`.

- [x] **Passo 1: Migration**

```sql
-- Base da API do Eleve Office (parte B): tokens com escopo, auditoria de chamada,
-- exclusoes para a sincronizacao incremental e o instante de gravacao das
-- mensagens. Spec: docs/specs/2026-09-25-api-leitura-comercial-office-design.md.

-- Token por conta, com escopo. So o service_role le: a Edge Function resolve o
-- token pelo hash, e a conta sai daqui, nunca da requisicao.
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['comercial:leitura', 'tarefas:leitura', 'tarefas:escrita']::text[]
  ),
  rate_limit_per_minute integer NOT NULL DEFAULT 120 CHECK (rate_limit_per_minute > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_tokens TO service_role;

-- Uma linha por chamada, sem conteudo nem dado de lead. E tambem o contador do
-- limite por token.
CREATE TABLE IF NOT EXISTS public.api_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id uuid REFERENCES public.api_tokens(id) ON DELETE SET NULL,
  user_id uuid,
  method text NOT NULL,
  route text NOT NULL,
  status integer NOT NULL,
  items integer,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_log_token_created_idx
  ON public.api_request_log (token_id, created_at DESC);
ALTER TABLE public.api_request_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_request_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_request_log TO service_role;

-- Exclusoes, para o Office nao ter de baixar tudo de novo para descobrir o que
-- sumiu.
CREATE TABLE IF NOT EXISTS public.api_deleted_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  entity text NOT NULL CHECK (entity IN ('lead', 'message')),
  entity_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_deleted_records_user_deleted_idx
  ON public.api_deleted_records (user_id, deleted_at, id);
ALTER TABLE public.api_deleted_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_deleted_records FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_deleted_records TO service_role;

-- SECURITY DEFINER: quem apaga lead pela tela e o authenticated, que nao escreve
-- em api_deleted_records.
CREATE OR REPLACE FUNCTION public.record_deleted_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.is_test IS NOT TRUE THEN
    INSERT INTO public.api_deleted_records (user_id, entity, entity_id)
    VALUES (OLD.user_id, 'lead', OLD.id);
  END IF;
  RETURN OLD;
END;
$$;

-- Na cascata da exclusao de um lead o lead ja nao existe: o tombstone dele basta.
-- Mensagem de lead de teste tambem fica de fora: a API nunca a mostrou.
CREATE OR REPLACE FUNCTION public.record_deleted_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.leads l WHERE l.id = OLD.lead_id AND l.is_test IS NOT TRUE
  ) THEN
    INSERT INTO public.api_deleted_records (user_id, entity, entity_id)
    VALUES (OLD.user_id, 'message', OLD.id);
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.record_deleted_lead() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_deleted_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS leads_record_deleted ON public.leads;
CREATE TRIGGER leads_record_deleted
  AFTER DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.record_deleted_lead();

DROP TRIGGER IF EXISTS messages_record_deleted ON public.messages;
CREATE TRIGGER messages_record_deleted
  AFTER DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.record_deleted_message();

-- Instante de gravacao: e o cursor da sincronizacao. created_at e o instante da
-- mensagem e pode ser antigo (recuperacao de historico da parte A).
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS inserted_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS messages_user_inserted_idx
  ON public.messages (user_id, inserted_at, id);

-- Auditoria guardada por 90 dias.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api-request-log-retencao') THEN
    PERFORM cron.unschedule('api-request-log-retencao');
  END IF;
END;
$$;
SELECT cron.schedule(
  'api-request-log-retencao',
  '17 3 * * *',
  $cron$DELETE FROM public.api_request_log WHERE created_at < now() - interval '90 days'$cron$
);
```

- [x] **Passo 2: Commit**

```bash
git add supabase/migrations/20260925150444_api_tokens_auditoria_exclusoes.sql
git commit -m "feat(db): tokens de API com escopo, auditoria, exclusoes e inserted_at"
```

O vermelho/verde desta task vem do E2E (Task 9) e da validação da Task 10.

---

### Task 2: Origem IA na entrega e nome da etapa no evento

**Files:** Modify `supabase/migrations/20260925150452_origem_ia_e_nome_da_etapa.sql`,
`supabase/functions/ai-agent-reply/index.ts`.

**Interfaces — Produces:** `send_queue.origin` (`null` ou `'ia'`); `messages.origin`
aceita `'ia'`; `lead_stage_events.metadata` com `de_nome`, `de_tipo`, `para_nome`,
`para_tipo` nos eventos novos.

- [x] **Passo 1: Migration.** As duas funções são as definições vivas em produção
  (lidas com `pg_get_functiondef` em 2026-09-25), com só o acréscimo comentado.

```sql
-- Dois registros que a API do Office le e que o banco nao guardava: a origem IA
-- da mensagem e o nome da etapa no momento da mudanca.

-- A resposta da IA vai para a fila sem bloco (ver ai-agent-reply), e a entrega
-- gravava a mensagem sem nada que a separasse de automacao.
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE public.send_queue DROP CONSTRAINT IF EXISTS send_queue_origin_check;
ALTER TABLE public.send_queue
  ADD CONSTRAINT send_queue_origin_check CHECK (origin IS NULL OR origin IN ('ia'));

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_origin_check
  CHECK (origin IS NULL OR origin IN ('crm', 'business_app', 'ia'));

-- Mesma funcao de 2026-07-13; a unica mudanca e copiar origin do item da fila.
CREATE OR REPLACE FUNCTION public.complete_marketing_queue_delivery(
  p_queue_item_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_content text,
  p_whatsapp_id text DEFAULT NULL::text
)
RETURNS TABLE(recorded boolean, queue_status text, message_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_queue public.send_queue%ROWTYPE;
  v_message_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_queue_item_id IS NULL
     OR p_user_id IS NULL
     OR p_claim_token IS NULL
     OR NULLIF(btrim(COALESCE(p_content, '')), '') IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_request', NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), 91331);

  SELECT * INTO v_queue
  FROM public.send_queue
  WHERE id = p_queue_item_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'queue_item_not_found', NULL::uuid;
    RETURN;
  END IF;

  IF v_queue.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN QUERY SELECT false, 'claim_lost', NULL::uuid;
    RETURN;
  END IF;

  IF v_queue.status NOT IN ('sending', 'failed') THEN
    RETURN QUERY SELECT false, 'queue_not_deliverable', NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.messages (
    user_id,
    lead_id,
    flow_id,
    block_id,
    content,
    direction,
    whatsapp_id,
    status,
    queue_item_id,
    created_at,
    origin
  )
  VALUES (
    v_queue.user_id,
    v_queue.lead_id,
    v_queue.flow_id,
    v_queue.block_id,
    p_content,
    'outbound',
    p_whatsapp_id,
    'sent',
    v_queue.id,
    v_now,
    v_queue.origin
  )
  ON CONFLICT (queue_item_id) WHERE queue_item_id IS NOT NULL
  DO UPDATE SET whatsapp_id = COALESCE(public.messages.whatsapp_id, EXCLUDED.whatsapp_id)
  RETURNING id INTO v_message_id;

  IF v_queue.status = 'sending' THEN
    UPDATE public.send_queue
    SET status = 'sent',
        sending_at = NULL,
        attempts = COALESCE(attempts, 0) + 1,
        scheduled_at = v_now,
        sent_at = v_now
    WHERE id = v_queue.id
      AND status = 'sending'
      AND claim_token = p_claim_token;

    IF FOUND THEN
      RETURN QUERY SELECT true, 'sent', v_message_id;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT true, 'delivery_recorded_after_cancellation', v_message_id;
END;
$function$;

-- Nome e tipo das etapas congelados no evento: a etapa pode ser renomeada ou
-- reclassificada depois, e o historico tem de dizer o que era na hora.
CREATE OR REPLACE FUNCTION public.record_lead_stage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.lead_stage_events (
      user_id,
      workspace_id,
      lead_id,
      from_stage_id,
      to_stage_id,
      event_type,
      changed_by,
      occurred_at,
      metadata
    ) VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.id,
      NULL,
      NEW.stage_id,
      'lead_created',
      auth.uid(),
      COALESCE(NEW.created_at, now()),
      jsonb_strip_nulls(jsonb_build_object(
        'para_nome', (SELECT btrim(s.name) FROM public.pipeline_stages s WHERE s.id = NEW.stage_id),
        'para_tipo', (SELECT s.funnel_key FROM public.pipeline_stages s WHERE s.id = NEW.stage_id)
      ))
    );
  ELSIF OLD.stage_id IS DISTINCT FROM NEW.stage_id
    AND NEW.stage_id IS NOT NULL THEN
    INSERT INTO public.lead_stage_events (
      user_id,
      workspace_id,
      lead_id,
      from_stage_id,
      to_stage_id,
      event_type,
      changed_by,
      metadata
    ) VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.id,
      OLD.stage_id,
      NEW.stage_id,
      'stage_changed',
      auth.uid(),
      jsonb_strip_nulls(jsonb_build_object(
        'de_nome', (SELECT btrim(s.name) FROM public.pipeline_stages s WHERE s.id = OLD.stage_id),
        'de_tipo', (SELECT s.funnel_key FROM public.pipeline_stages s WHERE s.id = OLD.stage_id),
        'para_nome', (SELECT btrim(s.name) FROM public.pipeline_stages s WHERE s.id = NEW.stage_id),
        'para_tipo', (SELECT s.funnel_key FROM public.pipeline_stages s WHERE s.id = NEW.stage_id)
      ))
    );
  END IF;

  RETURN NEW;
END;
$function$;
```

- [x] **Passo 2: `ai-agent-reply`.** No `insert` da resposta em `send_queue`, depois de
  `block_id: null,`: `origin: "ia",`. O comentário acima do insert ganha a frase: "A
  origem vai em `origin`: sem bloco, é ela que separa a resposta da IA de automação."

```bash
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/ai-agent-reply/index.ts
git add supabase/migrations/20260925150452_origem_ia_e_nome_da_etapa.sql supabase/functions/ai-agent-reply/index.ts
git commit -m "feat(ia): resposta da IA gravada com origem ia e nome da etapa congelado no evento"
```

---

### Task 3: Funções SQL de leitura

**Files:** Modify `supabase/migrations/20260925150500_office_api_leitura.sql`.

**Interfaces — Produces** (todas `jsonb`, array com até `p_limite + 1` itens):
- `office_leads(p_user_id uuid, p_lead_id uuid, p_cursor_ts timestamptz, p_cursor_id uuid, p_limite int, p_atualizado_desde timestamptz, p_criado_de timestamptz, p_criado_ate timestamptz, p_etapa_id uuid, p_situacao text)`
- `office_mensagens(p_user_id uuid, p_lead_id uuid, p_feed boolean, p_cursor_ts timestamptz, p_cursor_id uuid, p_limite int)`
- `office_eventos(p_user_id uuid, p_lead_id uuid, p_feed boolean, p_cursor_ts timestamptz, p_cursor_id uuid, p_limite int)`
- `office_exclusoes(p_user_id uuid, p_cursor_ts timestamptz, p_cursor_id bigint, p_limite int)`

- [x] **Passo 1: Migration**

```sql
-- Leitura da API do Eleve Office (parte B). Uma funcao por recurso; toda consulta
-- filtra pela conta p_user_id, que a Edge Function tira do token. So o
-- service_role executa: sem o REVOKE, o default privileges do schema public daria
-- EXECUTE a anon e authenticated, e um usuario logado leria outra conta.
--
-- Listas devolvem ate p_limite + 1 itens: o excedente diz a Edge Function que ha
-- mais pagina. Listagem e feed deixam de fora os ultimos 5 s: transacao que comecou
-- antes e terminou depois nao escapa do cursor de quem ja passou por aquele instante.

CREATE OR REPLACE FUNCTION public.office_leads(
  p_user_id uuid,
  p_lead_id uuid,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer,
  p_atualizado_desde timestamptz,
  p_criado_de timestamptz,
  p_criado_ate timestamptz,
  p_etapa_id uuid,
  p_situacao text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH base AS (
  SELECT l.id, l.name, l.company, l.source, l.created_at, l.updated_at,
         s.id AS etapa_id, btrim(s.name) AS etapa_nome, s.funnel_key,
         CASE s.funnel_key WHEN 'won' THEN 'ganha' WHEN 'lost' THEN 'perdida'
                           ELSE 'em_andamento' END AS situacao
    FROM public.leads l
    LEFT JOIN public.pipeline_stages s ON s.id = l.stage_id AND s.user_id = p_user_id
   WHERE l.user_id = p_user_id
     AND l.is_test IS NOT TRUE
     AND ((p_lead_id IS NOT NULL AND l.id = p_lead_id)
          OR (p_lead_id IS NULL AND l.updated_at <= now() - interval '5 seconds'))
     AND (p_atualizado_desde IS NULL OR l.updated_at >= p_atualizado_desde)
     AND (p_criado_de IS NULL OR l.created_at >= p_criado_de)
     AND (p_criado_ate IS NULL OR l.created_at <= p_criado_ate)
     AND (p_etapa_id IS NULL OR l.stage_id = p_etapa_id)
     AND (p_cursor_ts IS NULL OR (l.updated_at, l.id) > (p_cursor_ts, p_cursor_id))
),
pagina AS (
  SELECT * FROM base
   WHERE p_situacao IS NULL OR situacao = p_situacao
   ORDER BY updated_at, id
   LIMIT p_limite + 1
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'lead_id', p.id,
  'nome', p.name,
  'empresa', p.company,
  'origem', p.source,
  'responsavel', NULL,
  'etapa', CASE WHEN p.etapa_id IS NULL THEN NULL
                ELSE jsonb_build_object('id', p.etapa_id, 'nome', p.etapa_nome, 'tipo', p.funnel_key) END,
  'situacao', p.situacao,
  -- So mudanca registrada fecha: lead importado ja fechado fica sem data.
  'fechado_em', CASE WHEN p.situacao = 'em_andamento' THEN NULL ELSE (
      SELECT max(e.occurred_at) FROM public.lead_stage_events e
       WHERE e.user_id = p_user_id AND e.lead_id = p.id
         AND e.event_type = 'stage_changed' AND e.to_stage_id = p.etapa_id) END,
  'motivo_perda', CASE WHEN p.situacao = 'perdida' THEN p.etapa_nome END,
  'criado_em', p.created_at,
  'atualizado_em', p.updated_at
) ORDER BY p.updated_at, p.id), '[]'::jsonb)
FROM pagina p;
$$;

CREATE OR REPLACE FUNCTION public.office_mensagens(
  p_user_id uuid,
  p_lead_id uuid,
  p_feed boolean,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH base AS (
  SELECT m.id, m.lead_id, m.created_at, m.inserted_at, m.direction, m.origin, m.flow_id,
         m.content, m.media_type, m.status, b.type AS tipo_bloco,
         CASE WHEN p_feed THEN m.inserted_at ELSE m.created_at END AS chave
    FROM public.messages m
    JOIN public.leads l ON l.id = m.lead_id AND l.user_id = p_user_id AND l.is_test IS NOT TRUE
    LEFT JOIN public.flow_blocks b ON b.id = m.block_id
   WHERE m.user_id = p_user_id
     AND (p_lead_id IS NULL OR m.lead_id = p_lead_id)
     AND (NOT p_feed OR m.inserted_at <= now() - interval '5 seconds')
),
pagina AS (
  SELECT * FROM base
   WHERE p_cursor_ts IS NULL OR (chave, id) > (p_cursor_ts, p_cursor_id)
   ORDER BY chave, id
   LIMIT p_limite + 1
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'mensagem_id', p.id,
  'lead_id', p.lead_id,
  'conversa_id', p.lead_id,
  'enviada_em', p.created_at,
  'gravada_em', p.inserted_at,
  'direcao', CASE WHEN p.direction = 'inbound' THEN 'recebida' ELSE 'enviada' END,
  'origem', CASE
      WHEN p.direction = 'inbound' THEN 'lead'
      WHEN p.origin = 'business_app' THEN 'humano_aparelho'
      WHEN p.origin = 'ia' OR p.tipo_bloco = 'ai_agent' THEN 'ia'
      WHEN p.flow_id IS NULL THEN 'humano_crm'
      ELSE 'automacao' END,
  'atendente_id', NULL,
  'tipo', CASE p.media_type
      WHEN 'audio' THEN 'audio' WHEN 'image' THEN 'imagem' WHEN 'video' THEN 'video'
      WHEN 'document' THEN 'documento' WHEN 'sticker' THEN 'figurinha'
      WHEN 'location' THEN 'localizacao' WHEN 'contact' THEN 'contato'
      WHEN 'other' THEN 'outro' ELSE 'texto' END,
  'texto', p.content,
  'tem_texto', btrim(p.content) <> '',
  'transcricao', NULL,
  'status', CASE p.status
      WHEN 'received' THEN 'recebida' WHEN 'pending' THEN 'pendente'
      WHEN 'sent' THEN 'enviada' WHEN 'delivered' THEN 'enviada' WHEN 'read' THEN 'enviada'
      WHEN 'failed' THEN 'falhou' END
) ORDER BY p.chave, p.id), '[]'::jsonb)
FROM pagina p;
$$;

CREATE OR REPLACE FUNCTION public.office_eventos(
  p_user_id uuid,
  p_lead_id uuid,
  p_feed boolean,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH base AS (
  SELECT e.id, e.lead_id, e.event_type, e.from_stage_id, e.to_stage_id, e.changed_by,
         e.occurred_at, e.created_at,
         e.metadata ? 'para_nome' AS da_epoca,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'de_nome' ELSE btrim(sf.name) END AS de_nome,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'de_tipo' ELSE sf.funnel_key END AS de_tipo,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'para_nome' ELSE btrim(st.name) END AS para_nome,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'para_tipo' ELSE st.funnel_key END AS para_tipo,
         CASE WHEN p_feed THEN e.created_at ELSE e.occurred_at END AS chave
    FROM public.lead_stage_events e
    JOIN public.leads l ON l.id = e.lead_id AND l.user_id = p_user_id AND l.is_test IS NOT TRUE
    LEFT JOIN public.pipeline_stages sf ON sf.id = e.from_stage_id AND sf.user_id = p_user_id
    LEFT JOIN public.pipeline_stages st ON st.id = e.to_stage_id AND st.user_id = p_user_id
   WHERE e.user_id = p_user_id
     AND (p_lead_id IS NULL OR e.lead_id = p_lead_id)
     AND (NOT p_feed OR e.created_at <= now() - interval '5 seconds')
),
pagina AS (
  SELECT * FROM base
   WHERE p_cursor_ts IS NULL OR (chave, id) > (p_cursor_ts, p_cursor_id)
   ORDER BY chave, id
   LIMIT p_limite + 1
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'evento_id', p.id,
  'lead_id', p.lead_id,
  'tipo', CASE p.event_type WHEN 'lead_created' THEN 'criacao' ELSE 'mudanca' END,
  'de', CASE WHEN p.from_stage_id IS NULL THEN NULL
             ELSE jsonb_build_object('id', p.from_stage_id, 'nome', p.de_nome, 'tipo', p.de_tipo) END,
  'para', CASE WHEN p.to_stage_id IS NULL THEN NULL
               ELSE jsonb_build_object('id', p.to_stage_id, 'nome', p.para_nome, 'tipo', p.para_tipo) END,
  'nome_da_epoca', p.da_epoca,
  'ocorreu_em', p.occurred_at,
  'gravado_em', p.created_at,
  'autor', jsonb_build_object(
      'tipo', CASE WHEN p.changed_by IS NULL THEN 'automacao_ou_importacao' ELSE 'usuario' END,
      'id', p.changed_by),
  'resultado', CASE
      WHEN p.event_type <> 'stage_changed' THEN NULL
      WHEN p.para_tipo = 'won' THEN 'ganho'
      WHEN p.para_tipo = 'lost' THEN 'perda'
      WHEN p.de_tipo IN ('won', 'lost') THEN 'reabertura' END,
  'motivo_perda', CASE WHEN p.event_type = 'stage_changed' AND p.para_tipo = 'lost'
                       THEN p.para_nome END
) ORDER BY p.chave, p.id), '[]'::jsonb)
FROM pagina p;
$$;

CREATE OR REPLACE FUNCTION public.office_exclusoes(
  p_user_id uuid,
  p_cursor_ts timestamptz,
  p_cursor_id bigint,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'entidade', CASE d.entity WHEN 'lead' THEN 'lead' ELSE 'mensagem' END,
  'id', d.entity_id,
  'excluido_em', d.deleted_at,
  'sequencia', d.id
) ORDER BY d.deleted_at, d.id), '[]'::jsonb)
FROM (
  SELECT r.id, r.entity, r.entity_id, r.deleted_at
    FROM public.api_deleted_records r
   WHERE r.user_id = p_user_id
     AND r.deleted_at <= now() - interval '5 seconds'
     AND (p_cursor_ts IS NULL OR (r.deleted_at, r.id) > (p_cursor_ts, p_cursor_id))
   ORDER BY r.deleted_at, r.id
   LIMIT p_limite + 1
) d;
$$;

REVOKE ALL ON FUNCTION public.office_leads(uuid, uuid, timestamptz, uuid, integer, timestamptz, timestamptz, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_leads(uuid, uuid, timestamptz, uuid, integer, timestamptz, timestamptz, timestamptz, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.office_mensagens(uuid, uuid, boolean, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_mensagens(uuid, uuid, boolean, timestamptz, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.office_eventos(uuid, uuid, boolean, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_eventos(uuid, uuid, boolean, timestamptz, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.office_exclusoes(uuid, timestamptz, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_exclusoes(uuid, timestamptz, bigint, integer) TO service_role;
```

- [x] **Passo 2: Commit**

```bash
git add supabase/migrations/20260925150500_office_api_leitura.sql
git commit -m "feat(db): funcoes de leitura da office-api, filtradas pela conta do token"
```

A validação do corpo contra dado real depende das colunas das Tasks 1 e 2 e acontece no
gate (Task 10), antes do push desta migration.

---

### Task 4: Token pela tabela (`sha256Hex`, `api-token.ts`)

**Files:** Modify `supabase/functions/_shared/hmac.ts`, `tests/unit/hmac.test.ts`;
Create `supabase/functions/_shared/api-token.ts`, `tests/unit/api-token.test.ts`.

**Interfaces — Produces:**
- `sha256Hex(texto: string): Promise<string>` em `hmac.ts`.
- `tokenDoHeader(authorization: string | null): string | null`
- `resolveApiToken(client, authorization): Promise<{ tokenId; userId; scopes: string[]; rateLimitPerMinute: number } | null>`
- `marcarUso(client, tokenId, agora?: Date): Promise<void>`

- [x] **Passo 1: Testes que falham.** Em `tests/unit/hmac.test.ts`, no import,
  `sha256Hex` junto de `hmacSha256Hex, constantTimeEqual`, e:

```ts
describe("sha256Hex", () => {
  it("gera o SHA-256 hex conhecido de 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
```

`tests/unit/api-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  marcarUso,
  resolveApiToken,
  tokenDoHeader,
} from "../../supabase/functions/_shared/api-token";
import { sha256Hex } from "../../supabase/functions/_shared/hmac";
import { createFakeClient } from "./helpers/fake-supabase";

const TOKEN = "efsc_token-de-teste";

async function banco(over: Record<string, unknown> = {}) {
  return {
    api_tokens: [
      {
        id: "tok-1",
        user_id: "conta-1",
        token_hash: await sha256Hex(TOKEN),
        scopes: ["comercial:leitura"],
        rate_limit_per_minute: 120,
        revoked_at: null,
        last_used_at: null,
        ...over,
      },
    ],
  };
}

describe("tokenDoHeader", () => {
  it("le o Bearer em qualquer caixa e recusa o resto", () => {
    expect(tokenDoHeader(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(tokenDoHeader(`bearer ${TOKEN}`)).toBe(TOKEN);
    for (const header of [null, "", "Bearer", "Bearer ", `Basic ${TOKEN}`, TOKEN]) {
      expect(tokenDoHeader(header)).toBeNull();
    }
  });
});

describe("resolveApiToken", () => {
  it("token conhecido devolve conta, escopos e limite", async () => {
    const client = createFakeClient(await banco());
    expect(await resolveApiToken(client as any, `Bearer ${TOKEN}`)).toEqual({
      tokenId: "tok-1",
      userId: "conta-1",
      scopes: ["comercial:leitura"],
      rateLimitPerMinute: 120,
    });
  });

  it("token errado, ausente ou revogado devolve nulo", async () => {
    const client = createFakeClient(await banco());
    expect(await resolveApiToken(client as any, "Bearer efsc_outro")).toBeNull();
    expect(await resolveApiToken(client as any, null)).toBeNull();
    const revogado = createFakeClient(await banco({ revoked_at: "2026-09-25T00:00:00Z" }));
    expect(await resolveApiToken(revogado as any, `Bearer ${TOKEN}`)).toBeNull();
  });
});

describe("marcarUso", () => {
  it("atualiza last_used_at do token", async () => {
    const db = await banco();
    const client = createFakeClient(db);
    await marcarUso(client as any, "tok-1", new Date("2026-09-25T12:00:00.000Z"));
    expect(db.api_tokens[0].last_used_at).toBe("2026-09-25T12:00:00.000Z");
  });
});
```

- [x] **Passo 2: Ver falhar** — `npx vitest run tests/unit/hmac.test.ts tests/unit/api-token.test.ts`:
  `sha256Hex is not a function` e módulo `api-token` não encontrado.

- [x] **Passo 3: Implementar.** Em `hmac.ts`:

```ts
export async function sha256Hex(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

`supabase/functions/_shared/api-token.ts`:

```ts
// Token de API de terceiros (Eleve Office). O token e nosso, nao JWT do Supabase:
// api_tokens guarda so o SHA-256, com a conta, os escopos e o limite. A conta sai
// daqui, nunca da requisicao. Deno-free: o Vitest importa este arquivo em Node.

import { sha256Hex } from "./hmac.ts";

export interface TokenResolvido {
  tokenId: string;
  userId: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

export function tokenDoHeader(authorization: string | null): string | null {
  return /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "")?.[1] ?? null;
}

export async function resolveApiToken(
  client: { from: (table: string) => any },
  authorization: string | null,
): Promise<TokenResolvido | null> {
  const token = tokenDoHeader(authorization);
  if (!token) return null;

  const { data, error } = await client
    .from("api_tokens")
    .select("id, user_id, scopes, rate_limit_per_minute, revoked_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at) return null;

  return {
    tokenId: data.id,
    userId: data.user_id,
    scopes: data.scopes ?? [],
    rateLimitPerMinute: data.rate_limit_per_minute,
  };
}

/** Marca o uso, no maximo uma vez por minuto por token. */
export async function marcarUso(
  client: { from: (table: string) => any },
  tokenId: string,
  agora = new Date(),
): Promise<void> {
  const umMinutoAntes = new Date(agora.getTime() - 60_000).toISOString();
  const { error } = await client
    .from("api_tokens")
    .update({ last_used_at: agora.toISOString() })
    .eq("id", tokenId)
    .or(`last_used_at.is.null,last_used_at.lt.${umMinutoAntes}`);
  if (error) console.error(JSON.stringify({ event: "api_token_uso_falhou", error: error.message }));
}
```

- [x] **Passo 4: Ver passar** e `coverage.include` com
  `"supabase/functions/_shared/api-token.ts"`.

- [x] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/hmac.ts tests/unit/hmac.test.ts supabase/functions/_shared/api-token.ts tests/unit/api-token.test.ts vitest.config.ts
git commit -m "feat(api): token de terceiros resolvido pela tabela api_tokens"
```

---

### Task 5: Módulos da `office-api` (cursor, parâmetros, rotas, página, limite, auditoria)

**Files:** Create em `supabase/functions/_shared/office-api/`: `cursor.ts`,
`parametros.ts`, `rotas.ts`, `pagina.ts`, `limite.ts`, `auditoria.ts`; testes em
`tests/unit/office-api-*.test.ts`.

**Interfaces — Produces:**
- `codificarCursor(instante: string, id: string): string`;
  `decodificarCursor(cursor: string, formatoId: RegExp): { instante: string; id: string }` (400 em lixo)
- `UUID: RegExp`; `SEQUENCIA: RegExp`; `lerLimite(v)`, `lerData(nome, v)`,
  `lerUuid(nome, v)`, `lerSituacao(v)`, `lerCursor(v, formatoId)`
- `ROTAS: { nome, modelo, escopo }[]`; `encontrarRota(pathname): { nome, modelo, escopo, leadId? } | null`
- `montarPagina(itens, limite, cursorRecebido, chave)`: `{ dados, proximo_cursor, tem_mais }`
- `verificarLimite(client, tokenId, limitePorMinuto, agora?)`: `{ ok: true } | { ok: false; retryAfter: number }`
- `registrarChamada(client, { tokenId, userId, metodo, rota, status, itens, duracaoMs })`

- [x] **Passo 1: Testes que falham** (`tests/unit/office-api-modulos.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import {
  codificarCursor,
  decodificarCursor,
} from "../../supabase/functions/_shared/office-api/cursor";
import {
  lerData,
  lerLimite,
  lerSituacao,
  lerUuid,
  SEQUENCIA,
  UUID,
} from "../../supabase/functions/_shared/office-api/parametros";
import { encontrarRota, ROTAS } from "../../supabase/functions/_shared/office-api/rotas";
import { montarPagina } from "../../supabase/functions/_shared/office-api/pagina";
import { verificarLimite } from "../../supabase/functions/_shared/office-api/limite";
import { registrarChamada } from "../../supabase/functions/_shared/office-api/auditoria";
import { createFakeClient } from "./helpers/fake-supabase";

const ID = "0b7c9a6e-1f2d-4c3b-8a9e-5d4c3b2a1f0e";
const INSTANTE = "2026-09-25T13:53:51.753744+00:00";

function status400(fn: () => unknown): number | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return null;
}

describe("cursor", () => {
  it("ida e volta preserva microssegundos e id", () => {
    const c = codificarCursor(INSTANTE, ID);
    expect(c).not.toMatch(/[+/=]/);
    expect(decodificarCursor(c, UUID)).toEqual({ instante: INSTANTE, id: ID });
  });

  it("lixo, id no formato errado e instante invalido dao 400", () => {
    expect(status400(() => decodificarCursor("lixo", UUID))).toBe(400);
    expect(status400(() => decodificarCursor(codificarCursor(INSTANTE, "123"), UUID))).toBe(400);
    expect(status400(() => decodificarCursor(codificarCursor("ontem", ID), UUID))).toBe(400);
  });

  it("cursor de exclusao usa a sequencia numerica", () => {
    expect(decodificarCursor(codificarCursor(INSTANTE, "42"), SEQUENCIA).id).toBe("42");
  });
});

describe("parametros", () => {
  it("limite padrao 100, de 1 a 500", () => {
    expect(lerLimite(null)).toBe(100);
    expect(lerLimite("500")).toBe(500);
    for (const v of ["0", "501", "abc", "1.5", ""]) expect(status400(() => lerLimite(v))).toBe(400);
  });

  it("data ISO 8601; outra coisa da 400", () => {
    expect(lerData("criado_de", null)).toBeNull();
    expect(lerData("criado_de", "2026-09-25")).toBe("2026-09-25");
    expect(lerData("criado_de", "2026-09-25T10:00:00Z")).toBe("2026-09-25T10:00:00Z");
    expect(status400(() => lerData("criado_de", "ontem"))).toBe(400);
  });

  it("uuid e situacao validados", () => {
    expect(lerUuid("etapa_id", ID)).toBe(ID);
    expect(status400(() => lerUuid("etapa_id", "1"))).toBe(400);
    expect(lerSituacao("perdida")).toBe("perdida");
    expect(lerSituacao(null)).toBeNull();
    expect(status400(() => lerSituacao("fechada"))).toBe(400);
  });
});

describe("rotas", () => {
  it("resolve as rotas com e sem o prefixo da funcao", () => {
    expect(encontrarRota("/office-api/v1/leads")).toMatchObject({ nome: "leads", escopo: "comercial:leitura" });
    expect(encontrarRota(`/office-api/v1/leads/${ID}/mensagens`)).toMatchObject({
      nome: "lead_mensagens",
      modelo: "/v1/leads/{id}/mensagens",
      leadId: ID,
    });
    expect(encontrarRota("/v1/exclusoes")).toMatchObject({ nome: "exclusoes" });
    expect(encontrarRota("/office-api/v1/openapi.json")).toMatchObject({ nome: "openapi", escopo: null });
  });

  it("rota desconhecida ou id invalido nao casa", () => {
    expect(encontrarRota("/office-api/v1/tarefas")).toBeNull();
    expect(encontrarRota("/office-api/v1/leads/123")).toBeNull();
  });

  it("toda rota com dado exige escopo", () => {
    for (const r of ROTAS.filter((r) => r.nome !== "openapi")) expect(r.escopo).toBe("comercial:leitura");
  });
});

describe("montarPagina", () => {
  const itens = [{ t: "a", id: "1" }, { t: "b", id: "2" }, { t: "c", id: "3" }];
  const chave = (i: { t: string; id: string }) => [i.t, i.id] as [string, string];

  it("corta no limite, marca tem_mais e aponta o cursor para o ultimo devolvido", () => {
    const p = montarPagina(itens, 2, null, chave);
    expect(p.dados).toHaveLength(2);
    expect(p.tem_mais).toBe(true);
    expect(p.proximo_cursor).toBe(codificarCursor("b", "2"));
  });

  it("pagina vazia devolve o cursor recebido", () => {
    expect(montarPagina([], 2, "abc", chave)).toEqual({ dados: [], proximo_cursor: "abc", tem_mais: false });
  });
});

describe("verificarLimite", () => {
  const agora = new Date("2026-09-25T12:01:00.000Z").getTime();
  const log = (segundosAtras: number[]) => ({
    api_request_log: segundosAtras.map((s, i) => ({
      id: i,
      token_id: "tok-1",
      created_at: new Date(agora - s * 1000).toISOString(),
    })),
  });

  it("abaixo do limite passa", async () => {
    const client = createFakeClient(log([10, 20]));
    expect(await verificarLimite(client as any, "tok-1", 3, agora)).toEqual({ ok: true });
  });

  it("no limite dentro de 60 s recusa com o tempo ate liberar", async () => {
    const client = createFakeClient(log([5, 10, 50]));
    expect(await verificarLimite(client as any, "tok-1", 3, agora)).toEqual({ ok: false, retryAfter: 10 });
  });

  it("chamadas mais velhas que 60 s nao contam", async () => {
    const client = createFakeClient(log([5, 10, 61]));
    expect(await verificarLimite(client as any, "tok-1", 3, agora)).toEqual({ ok: true });
  });
});

describe("registrarChamada", () => {
  it("grava a linha sem conteudo", async () => {
    const db = { api_request_log: [] as any[] };
    await registrarChamada(createFakeClient(db) as any, {
      tokenId: "tok-1",
      userId: "conta-1",
      metodo: "GET",
      rota: "/v1/leads",
      status: 200,
      itens: 3,
      duracaoMs: 42,
    });
    expect(db.api_request_log[0]).toEqual({
      token_id: "tok-1",
      user_id: "conta-1",
      method: "GET",
      route: "/v1/leads",
      status: 200,
      items: 3,
      duration_ms: 42,
    });
  });
});
```

- [x] **Passo 2: Ver falhar** — módulos não encontrados.

- [x] **Passo 3: Implementar.**

`cursor.ts`:

```ts
// Cursor opaco da office-api: base64url de [instante, id]. O instante vai como o
// Postgres devolveu, com microssegundos: passar por Date perderia precisao e o
// cursor pularia ou repetiria linha.

import { HttpError } from "../http-error.ts";

export function codificarCursor(instante: string, id: string): string {
  return btoa(JSON.stringify([instante, id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodificarCursor(
  cursor: string,
  formatoId: RegExp,
): { instante: string; id: string } {
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const [instante, id] = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
    if (
      typeof instante === "string" &&
      !Number.isNaN(Date.parse(instante)) &&
      typeof id === "string" &&
      formatoId.test(id)
    ) {
      return { instante, id };
    }
  } catch {
    // cai no 400 abaixo
  }
  throw new HttpError(400, "cursor invalido");
}
```

`parametros.ts`:

```ts
import { HttpError } from "../http-error.ts";
import { decodificarCursor } from "./cursor.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SEQUENCIA = /^\d+$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SITUACOES = ["em_andamento", "ganha", "perdida"] as const;

export function lerLimite(valor: string | null): number {
  if (valor === null) return 100;
  if (!/^\d+$/.test(valor) || Number(valor) < 1 || Number(valor) > 500) {
    throw new HttpError(400, "limite deve ser um inteiro de 1 a 500");
  }
  return Number(valor);
}

export function lerData(nome: string, valor: string | null): string | null {
  if (valor === null) return null;
  if (!DATA_ISO.test(valor) || Number.isNaN(Date.parse(valor))) {
    throw new HttpError(400, `${nome} deve ser uma data ISO 8601`);
  }
  return valor;
}

export function lerUuid(nome: string, valor: string | null): string | null {
  if (valor === null) return null;
  if (!UUID.test(valor)) throw new HttpError(400, `${nome} deve ser um uuid`);
  return valor;
}

export function lerSituacao(valor: string | null): (typeof SITUACOES)[number] | null {
  if (valor === null) return null;
  if (!(SITUACOES as readonly string[]).includes(valor)) {
    throw new HttpError(400, `situacao deve ser ${SITUACOES.join(", ")}`);
  }
  return valor as (typeof SITUACOES)[number];
}

export function lerCursor(
  valor: string | null,
  formatoId: RegExp,
): { instante: string; id: string } | null {
  return valor === null ? null : decodificarCursor(valor, formatoId);
}
```

`rotas.ts`:

```ts
// Tabela de rotas da office-api. Toda rota com dado exige comercial:leitura; o
// contrato (openapi.json) e conferido contra esta tabela por teste.

export type NomeRota =
  | "leads"
  | "lead"
  | "lead_mensagens"
  | "lead_etapas"
  | "mensagens"
  | "etapas"
  | "exclusoes"
  | "openapi";

const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const LEITURA = "comercial:leitura";

const TABELA: Array<{ padrao: RegExp; nome: NomeRota; modelo: string; escopo: string | null }> = [
  { padrao: /^\/v1\/leads$/, nome: "leads", modelo: "/v1/leads", escopo: LEITURA },
  { padrao: new RegExp(`^/v1/leads/${ID}$`, "i"), nome: "lead", modelo: "/v1/leads/{id}", escopo: LEITURA },
  {
    padrao: new RegExp(`^/v1/leads/${ID}/mensagens$`, "i"),
    nome: "lead_mensagens",
    modelo: "/v1/leads/{id}/mensagens",
    escopo: LEITURA,
  },
  {
    padrao: new RegExp(`^/v1/leads/${ID}/etapas$`, "i"),
    nome: "lead_etapas",
    modelo: "/v1/leads/{id}/etapas",
    escopo: LEITURA,
  },
  { padrao: /^\/v1\/mensagens$/, nome: "mensagens", modelo: "/v1/mensagens", escopo: LEITURA },
  { padrao: /^\/v1\/etapas$/, nome: "etapas", modelo: "/v1/etapas", escopo: LEITURA },
  { padrao: /^\/v1\/exclusoes$/, nome: "exclusoes", modelo: "/v1/exclusoes", escopo: LEITURA },
  { padrao: /^\/v1\/openapi\.json$/, nome: "openapi", modelo: "/v1/openapi.json", escopo: null },
];

export const ROTAS = TABELA.map(({ nome, modelo, escopo }) => ({ nome, modelo, escopo }));

export function encontrarRota(
  pathname: string,
): { nome: NomeRota; modelo: string; escopo: string | null; leadId?: string } | null {
  const caminho = pathname.replace(/^\/(functions\/v1\/)?office-api/, "");
  for (const rota of TABELA) {
    const casou = rota.padrao.exec(caminho);
    if (casou) return { nome: rota.nome, modelo: rota.modelo, escopo: rota.escopo, leadId: casou[1] };
  }
  return null;
}
```

`pagina.ts`:

```ts
import { codificarCursor } from "./cursor.ts";

export interface Pagina<T> {
  dados: T[];
  proximo_cursor: string | null;
  tem_mais: boolean;
}

/** `itens` vem com ate limite + 1: o excedente so diz que ha mais. */
export function montarPagina<T>(
  itens: T[],
  limite: number,
  cursorRecebido: string | null,
  chave: (item: T) => [string, string],
): Pagina<T> {
  const dados = itens.slice(0, limite);
  const ultimo = dados[dados.length - 1];
  return {
    dados,
    proximo_cursor: ultimo ? codificarCursor(...chave(ultimo)) : cursorRecebido,
    tem_mais: itens.length > limite,
  };
}
```

`limite.ts`:

```ts
// Limite por token: as ultimas chamadas em api_request_log. Se a de numero
// `limitePorMinuto` foi ha menos de 60 s, a janela esta cheia.

export async function verificarLimite(
  client: { from: (table: string) => any },
  tokenId: string,
  limitePorMinuto: number,
  agora = Date.now(),
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const { data, error } = await client
    .from("api_request_log")
    .select("created_at")
    .eq("token_id", tokenId)
    .order("created_at", { ascending: false })
    .limit(limitePorMinuto);
  if (error) throw error;

  const chamadas = data ?? [];
  if (chamadas.length < limitePorMinuto) return { ok: true };

  const decorrido = agora - new Date(chamadas[limitePorMinuto - 1].created_at).getTime();
  if (decorrido >= 60_000) return { ok: true };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - decorrido) / 1000)) };
}
```

`auditoria.ts`:

```ts
// Uma linha por chamada, sem conteudo, parametro com dado de lead ou token.
// Falha aqui nao derruba a resposta: vai para o log da funcao.

export interface Chamada {
  tokenId: string | null;
  userId: string | null;
  metodo: string;
  rota: string;
  status: number;
  itens: number | null;
  duracaoMs: number;
}

export async function registrarChamada(
  client: { from: (table: string) => any },
  chamada: Chamada,
): Promise<void> {
  const { error } = await client.from("api_request_log").insert({
    token_id: chamada.tokenId,
    user_id: chamada.userId,
    method: chamada.metodo,
    route: chamada.rota,
    status: chamada.status,
    items: chamada.itens,
    duration_ms: chamada.duracaoMs,
  });
  if (error) console.error(JSON.stringify({ event: "api_request_log_falhou", error: error.message }));
}
```

- [x] **Passo 4: Ver passar**, `coverage.include` com os seis módulos, lint e commit:

```bash
git add supabase/functions/_shared/office-api tests/unit/office-api-modulos.test.ts vitest.config.ts
git commit -m "feat(office-api): cursor, parametros, rotas, pagina, limite e auditoria"
```

---

### Task 6: Atendimento das rotas (`atender.ts`)

**Files:** Create `supabase/functions/_shared/office-api/atender.ts`,
`tests/unit/office-api-atender.test.ts`.

**Interfaces:**
- Consumes: Task 5.
- Produces: `atender(client, rota, userId, query: URLSearchParams): Promise<{ corpo: unknown; itens: number | null }>`
  — lança `HttpError(404)` para lead inexistente ou de outra conta.

- [x] **Passo 1: Testes que falham** (`tests/unit/office-api-atender.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import { atender } from "../../supabase/functions/_shared/office-api/atender";
import { encontrarRota } from "../../supabase/functions/_shared/office-api/rotas";
import { codificarCursor } from "../../supabase/functions/_shared/office-api/cursor";
import { createFakeClient } from "./helpers/fake-supabase";

const CONTA = "0b7c9a6e-1f2d-4c3b-8a9e-5d4c3b2a1f0e";
const LEAD = "1c8d0b7f-2a3e-4d4c-9b0f-6e5d4c3b2a1f";
const T1 = "2026-09-25T10:00:00.000001+00:00";
const T2 = "2026-09-25T10:00:00.000002+00:00";

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

const rota = (caminho: string) => encontrarRota(caminho)!;

describe("atender", () => {
  it("leads passa filtros e conta do token e monta a pagina", async () => {
    const { client, chamadas } = cliente({
      office_leads: () => [
        { lead_id: "a", atualizado_em: T1 },
        { lead_id: "b", atualizado_em: T2 },
        { lead_id: "c", atualizado_em: T2 },
      ],
    });
    const query = new URLSearchParams("limite=2&situacao=perdida&criado_de=2026-09-01");

    const { corpo, itens } = await atender(client, rota("/v1/leads"), CONTA, query);

    expect(chamadas[0].args).toMatchObject({
      p_user_id: CONTA,
      p_lead_id: null,
      p_limite: 2,
      p_situacao: "perdida",
      p_criado_de: "2026-09-01",
      p_cursor_ts: null,
    });
    expect(corpo).toEqual({
      dados: [
        { lead_id: "a", atualizado_em: T1 },
        { lead_id: "b", atualizado_em: T2 },
      ],
      proximo_cursor: codificarCursor(T2, "b"),
      tem_mais: true,
    });
    expect(itens).toBe(2);
  });

  it("cursor recebido vira instante e id na chamada", async () => {
    const { client, chamadas } = cliente({ office_mensagens: () => [] });
    const cursor = codificarCursor(T1, LEAD);

    await atender(client, rota("/v1/mensagens"), CONTA, new URLSearchParams({ cursor }));

    expect(chamadas[0].args).toMatchObject({ p_feed: true, p_cursor_ts: T1, p_cursor_id: LEAD });
  });

  it("lead de outra conta ou inexistente da 404, sem chamar as mensagens", async () => {
    const { client, chamadas } = cliente({ office_leads: () => [], office_mensagens: () => [] });

    await expect(
      atender(client, rota(`/v1/leads/${LEAD}/mensagens`), CONTA, new URLSearchParams()),
    ).rejects.toMatchObject({ status: 404 });
    expect(chamadas.map((c) => c.nome)).toEqual(["office_leads"]);
  });

  it("lead unico devolve o objeto, nao a lista", async () => {
    const { client } = cliente({ office_leads: () => [{ lead_id: LEAD, atualizado_em: T1 }] });
    const { corpo } = await atender(client, rota(`/v1/leads/${LEAD}`), CONTA, new URLSearchParams());
    expect(corpo).toEqual({ lead_id: LEAD, atualizado_em: T1 });
  });

  it("mensagens do lead ordenam pela data da mensagem, nao pela gravacao", async () => {
    const { client, chamadas } = cliente({
      office_leads: () => [{ lead_id: LEAD }],
      office_mensagens: () => [{ mensagem_id: LEAD, enviada_em: T1, gravada_em: T2 }],
    });
    const { corpo } = await atender(client, rota(`/v1/leads/${LEAD}/mensagens`), CONTA, new URLSearchParams());
    expect(chamadas[1].args).toMatchObject({ p_lead_id: LEAD, p_feed: false });
    expect((corpo as any).proximo_cursor).toBe(codificarCursor(T1, LEAD));
  });

  it("exclusoes usam a sequencia no cursor", async () => {
    const { client } = cliente({ office_exclusoes: () => [{ id: LEAD, excluido_em: T1, sequencia: 7 }] });
    const { corpo } = await atender(client, rota("/v1/exclusoes"), CONTA, new URLSearchParams());
    expect((corpo as any).proximo_cursor).toBe(codificarCursor(T1, "7"));
  });

  it("parametro invalido da 400 antes de consultar", async () => {
    const { client, chamadas } = cliente({ office_leads: () => [] });
    await expect(
      atender(client, rota("/v1/leads"), CONTA, new URLSearchParams("limite=0")),
    ).rejects.toBeInstanceOf(HttpError);
    expect(chamadas).toHaveLength(0);
  });
});
```

- [x] **Passo 2: Ver falhar** — módulo não encontrado.

- [x] **Passo 3: Implementar** (`atender.ts`):

```ts
// Rota da office-api → funcao SQL → corpo. A conta e sempre a do token, recebida
// por parametro; nada da requisicao vira conta.

import { HttpError } from "../http-error.ts";
import { montarPagina } from "./pagina.ts";
import { lerCursor, lerData, lerLimite, lerSituacao, lerUuid, SEQUENCIA, UUID } from "./parametros.ts";
import type { NomeRota } from "./rotas.ts";

type Cliente = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };
type Item = Record<string, any>;

async function chamar(client: Cliente, fn: string, args: Record<string, unknown>): Promise<Item[]> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data ?? []) as Item[];
}

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

export async function atender(
  client: Cliente,
  rota: { nome: NomeRota; leadId?: string },
  userId: string,
  query: URLSearchParams,
): Promise<{ corpo: unknown; itens: number | null }> {
  const limite = lerLimite(query.get("limite"));
  const recebido = query.get("cursor");

  const pagina = (itens: Item[], chave: (i: Item) => [string, string]) => {
    const corpo = montarPagina(itens, limite, recebido, chave);
    return { corpo, itens: corpo.dados.length };
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
      return { corpo: await leadDaConta(client, userId, rota.leadId!), itens: 1 };
    case "lead_mensagens":
    case "mensagens": {
      const feed = rota.nome === "mensagens";
      const cursor = lerCursor(recebido, UUID);
      if (!feed) await leadDaConta(client, userId, rota.leadId!);
      const itens = await chamar(client, "office_mensagens", {
        p_user_id: userId,
        p_lead_id: feed ? null : rota.leadId,
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
      if (!feed) await leadDaConta(client, userId, rota.leadId!);
      const itens = await chamar(client, "office_eventos", {
        p_user_id: userId,
        p_lead_id: feed ? null : rota.leadId,
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
      });
      return pagina(itens, (x) => [x.excluido_em, String(x.sequencia)]);
    }
    default:
      throw new HttpError(404, "rota inexistente");
  }
}
```

- [x] **Passo 4: Ver passar**, `coverage.include`, lint, commit:

```bash
git add supabase/functions/_shared/office-api/atender.ts tests/unit/office-api-atender.test.ts vitest.config.ts
git commit -m "feat(office-api): rota para funcao SQL com a conta do token e pagina por cursor"
```

---

### Task 7: Função `office-api`, contrato OpenAPI e `config.toml`

**Files:** Create `supabase/functions/office-api/index.ts`,
`supabase/functions/office-api/openapi.json`, `tests/unit/office-api-openapi.test.ts`;
Modify `supabase/config.toml`.

- [x] **Passo 1: Teste que falha** (`tests/unit/office-api-openapi.test.ts`): o contrato
  cobre toda rota da tabela, com os erros da spec.

```ts
import { describe, it, expect } from "vitest";
import openapi from "../../supabase/functions/office-api/openapi.json";
import { ROTAS } from "../../supabase/functions/_shared/office-api/rotas";

describe("openapi.json", () => {
  it("e OpenAPI 3.1 com Bearer", () => {
    expect(openapi.openapi).toMatch(/^3\.1/);
    expect(openapi.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
  });

  it("documenta toda rota da tabela como GET", () => {
    for (const rota of ROTAS) {
      expect((openapi.paths as Record<string, any>)[rota.modelo]?.get, rota.modelo).toBeTruthy();
    }
  });

  it("toda rota com dado documenta 401, 403, 429 e 500", () => {
    for (const rota of ROTAS.filter((r) => r.escopo)) {
      const respostas = (openapi.paths as Record<string, any>)[rota.modelo].get.responses;
      for (const status of ["200", "401", "403", "429", "500"]) {
        expect(respostas[status], `${rota.modelo} ${status}`).toBeTruthy();
      }
    }
  });

  it("todo $ref aponta para um schema que existe", () => {
    const refs = JSON.stringify(openapi).match(/#\/components\/[a-zA-Z]+\/[A-Za-z]+/g) ?? [];
    for (const ref of refs) {
      const [, , secao, nome] = ref.split("/");
      expect((openapi.components as Record<string, any>)[secao]?.[nome], ref).toBeTruthy();
    }
  });
});
```

- [x] **Passo 2: Ver falhar** — arquivo não encontrado.

- [x] **Passo 3: `openapi.json`** — OpenAPI 3.1 com: `info` (título "EleveFlow — API do
  Eleve Office", versão `1.0.0`, descrição com a regra da conta e da cobertura),
  `servers` (`https://xlycuunqpgpyfmafgajr.supabase.co/functions/v1/office-api`),
  `security: [{ bearer: [] }]`, as 8 rotas da tabela como `get` (a de `openapi.json` com
  `security: []`), parâmetros (`limite`, `cursor`, `atualizado_desde`, `criado_de`,
  `criado_ate`, `etapa_id`, `situacao`, `id`), schemas `Lead`, `Etapa`, `Mensagem`,
  `Evento`, `Exclusao`, `PaginaLeads`, `PaginaMensagens`, `PaginaEventos`,
  `PaginaExclusoes`, `Erro`, e respostas `NaoAutorizado`, `EscopoInsuficiente`,
  `NaoEncontrado`, `ParametroInvalido`, `LimiteExcedido` (com header `Retry-After`),
  `ErroInterno`. Exemplos sanitizados (nomes e ids fictícios). Valores e regras exatamente
  os da spec.

- [x] **Passo 4: `index.ts`**

```ts
// API de leitura do Eleve Office (parte B). GET com token proprio: a conta sai do
// token (api_tokens), nunca da requisicao. Spec:
// docs/specs/2026-09-25-api-leitura-comercial-office-design.md.
//
// Sem CORS de proposito: quem chama e o servidor do Eleve Office.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { HttpError } from "../_shared/http-error.ts";
import { marcarUso, resolveApiToken, type TokenResolvido } from "../_shared/api-token.ts";
import { atender } from "../_shared/office-api/atender.ts";
import { registrarChamada } from "../_shared/office-api/auditoria.ts";
import { verificarLimite } from "../_shared/office-api/limite.ts";
import { encontrarRota } from "../_shared/office-api/rotas.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import openapi from "./openapi.json" with { type: "json" };

const CODIGOS: Record<number, string> = {
  400: "parametro_invalido",
  401: "token_invalido",
  403: "escopo_insuficiente",
  404: "nao_encontrado",
  405: "metodo_nao_permitido",
  429: "limite_excedido",
  500: "erro_interno",
};

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const erro = (status: number, mensagem: string, headers: Record<string, string> = {}) =>
  json({ erro: { codigo: CODIGOS[status], mensagem } }, status, headers);

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
    if (req.method !== "GET") return responder(erro(405, "use GET"));
    if (rota.nome === "openapi") return responder(json(openapi));

    token = await resolveApiToken(client, req.headers.get("authorization"));
    // Mesmo corpo para token ausente, errado e revogado.
    if (!token) return responder(erro(401, "token ausente, errado ou revogado"));
    if (rota.escopo && !token.scopes.includes(rota.escopo)) {
      return responder(erro(403, `a rota exige o escopo ${rota.escopo}`));
    }

    const limite = await verificarLimite(client, token.tokenId, token.rateLimitPerMinute);
    if (!limite.ok) {
      return responder(
        erro(429, "limite de chamadas por minuto excedido", {
          "Retry-After": String(limite.retryAfter),
        }),
      );
    }

    const { corpo, itens: quantos } = await atender(client, rota, token.userId, url.searchParams);
    return responder(json(corpo), quantos);
  } catch (error) {
    if (error instanceof HttpError) return responder(erro(error.status, error.message));
    console.error(
      JSON.stringify({
        event: "office_api_erro",
        rota: rota?.modelo,
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

`supabase/config.toml`, ao fim:

```toml

# Token proprio do Eleve Office (api_tokens), nao JWT do Supabase. Ver
# _shared/api-token.ts.
[functions.office-api]
verify_jwt = false
```

- [x] **Passo 5: Checar e commitar**

```bash
npx vitest run tests/unit/office-api-openapi.test.ts
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/office-api/index.ts
git add supabase/functions/office-api supabase/config.toml tests/unit/office-api-openapi.test.ts
git commit -m "feat(office-api): funcao de leitura com escopo, limite, auditoria e contrato OpenAPI"
```

---

### Task 8: `sales-coach` lê o token da tabela

**Files:** Modify `supabase/functions/_shared/sales-coach.ts`,
`tests/unit/sales-coach.test.ts`, `supabase/functions/sales-coach/index.ts`.

- [x] **Passo 1: Testes.** Em `sales-coach.test.ts`, sai o `describe("resolveCoachAccount")`
  e o `describe("sha256Hex")` (coberto em `hmac.test.ts`); o import fica só com
  `parseCoachParams`. Rodar: a suíte passa sem os testes do código que vai sair.

- [x] **Passo 2: Módulo.** `sales-coach.ts` perde `resolveCoachAccount` e `sha256Hex` (e o
  import de `constantTimeEqual`); o comentário do topo passa a dizer que o token é
  resolvido por `_shared/api-token.ts`.

- [x] **Passo 3: `index.ts`.**

```ts
  const client = createServiceRoleClient();
  const token = await resolveApiToken(client, req.headers.get("authorization"));
  // Mesmo corpo para token ausente, errado ou sem o escopo: o contrato do
  // sales-coach so conhece 401.
  if (!token || !token.scopes.includes("comercial:leitura")) {
    return json({ error: "Unauthorized" }, 401);
  }
  const userId = token.userId;
```

no lugar do `resolveCoachAccount(..., Deno.env.get("SALES_COACH_TOKENS"))`; o
`createServiceRoleClient()` do `rpc` passa a usar `client`; depois da resposta,
`registrarChamada` (rota `/sales-coach`) e `marcarUso`, como na `office-api`. O resto do
arquivo não muda.

- [x] **Passo 4: Checar e commitar**

```bash
npx vitest run
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/sales-coach/index.ts
git add supabase/functions/_shared/sales-coach.ts tests/unit/sales-coach.test.ts supabase/functions/sales-coach/index.ts
git commit -m "refactor(sales-coach): token vem de api_tokens com escopo comercial:leitura"
```

---

### Task 9: Script de token e E2E (vermelho antes do deploy)

**Files:** Create `scripts/lib/token-api.ts`, `tests/unit/token-api.test.ts`,
`scripts/criar-token-api.ts`, `tests/e2e/office-api.spec.ts`.

**Interfaces — Produces:** `gerarToken(): Promise<{ token: string; hash: string }>`;
`lerEscopos(texto): string[]` (erro em escopo desconhecido); script
`criar-token-api.ts --conta <uuid> --rotulo <texto> --escopos a,b [--limite N] [--env VAR | --importar-hash <hex>]`.

- [x] **Passo 1: Testes do script** (`tests/unit/token-api.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { gerarToken, lerEscopos } from "../../scripts/lib/token-api";
import { sha256Hex } from "../../supabase/functions/_shared/hmac";

describe("gerarToken", () => {
  it("token efsc_ de 48 caracteres com o hash dele", async () => {
    const { token, hash } = await gerarToken();
    expect(token).toMatch(/^efsc_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(await sha256Hex(token));
  });

  it("dois tokens nunca se repetem", async () => {
    expect((await gerarToken()).token).not.toBe((await gerarToken()).token);
  });
});

describe("lerEscopos", () => {
  it("aceita os escopos conhecidos", () => {
    expect(lerEscopos("comercial:leitura,tarefas:leitura")).toEqual(["comercial:leitura", "tarefas:leitura"]);
  });

  it("recusa escopo desconhecido ou vazio", () => {
    expect(() => lerEscopos("tudo")).toThrow(/escopo/);
    expect(() => lerEscopos("")).toThrow(/escopo/);
  });
});
```

- [x] **Passo 2: Ver falhar; implementar** `scripts/lib/token-api.ts`:

```ts
import { sha256Hex } from "../../supabase/functions/_shared/hmac.ts";

const ESCOPOS = ["comercial:leitura", "tarefas:leitura", "tarefas:escrita"];

export async function gerarToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    "efsc_" +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return { token, hash: await sha256Hex(token) };
}

export function lerEscopos(texto: string): string[] {
  const escopos = texto.split(",").map((e) => e.trim()).filter(Boolean);
  const invalidos = escopos.filter((e) => !ESCOPOS.includes(e));
  if (escopos.length === 0 || invalidos.length) {
    throw new Error(`escopo invalido: ${invalidos.join(", ") || "vazio"}; use ${ESCOPOS.join(", ")}`);
  }
  return escopos;
}
```

e `scripts/criar-token-api.ts` (insere a linha com a chave de serviço; com `--env VAR`
acrescenta `VAR=<token>` ao `.env.staging` e imprime só id e hash; com
`--importar-hash` grava o hash de um token existente sem gerar outro; sem os dois,
imprime o token uma vez). Ver passar, `coverage.include` com `scripts/lib/token-api.ts`,
commit:

```bash
git add scripts/lib/token-api.ts tests/unit/token-api.test.ts scripts/criar-token-api.ts vitest.config.ts
git commit -m "feat(scripts): cria e importa token de API com escopo"
```

- [x] **Passo 3: E2E** (`tests/e2e/office-api.spec.ts`). Contas: A = `e2e@eleveflow.test`
  (token `STAGING_SALES_COACH_E2E_TOKEN`), B = `admin@eleveflow.test`
  (`STAGING_OFFICE_TOKEN_CONTA_B`); tokens da conta A sem escopo
  (`STAGING_OFFICE_TOKEN_SEM_ESCOPO`, só `tarefas:leitura`) e com limite 3
  (`STAGING_OFFICE_TOKEN_LIMITE`). Semeia na conta A etapas persistentes "Ganho E2E"
  (`won`) e "Perda E2E" (`lost`), um lead que passa por Coach E2E → Perda E2E → Coach E2E
  → Ganho E2E, 7 mensagens com o mesmo `created_at` e 3 gravadas fora de ordem, e um
  lead criado direto em "Perda E2E" com 1 mensagem; na conta B, um lead com 1 mensagem.
  Testes (listas e feeds com `expect.poll` de até 20 s, por causa da janela de 5 s):
  1. sem token e token errado → 401 `token_invalido`; `POST` → 405; token sem escopo →
     403 `escopo_insuficiente`; `limite=0` e `cursor=lixo` → 400;
  2. 4 chamadas seguidas com o token de limite 3 → a quarta 429 com `Retry-After`;
  3. isolamento: `GET leads/{lead da B}` com o token A → 404; listas, `mensagens`,
     `etapas` e `exclusoes` do token A sem nenhum id da conta B;
  4. paginação: mensagens do lead lidas de 2 em 2 → 10 ids únicos, em ordem de
     `enviada_em`; o feed `mensagens` a partir de um cursor anterior ao seed traz as 10
     uma vez só;
  5. eventos do lead: `criacao`, `perda` com `motivo_perda = "Perda E2E"`, `reabertura`,
     `ganho`, todos com `nome_da_epoca = true` e autor `automacao_ou_importacao`;
  6. lead importado perdido: `situacao = perdida`, `motivo_perda = "Perda E2E"`,
     `fechado_em = null`; lead que passou por ganho: `fechado_em` = o evento de ganho;
  7. mensagem com a IA: item de fila com `origin = 'ia'` completado por
     `complete_marketing_queue_delivery` → a mensagem vem com `origem = "ia"`;
  8. exclusões: apagar 1 mensagem do lead → `exclusoes` traz a `mensagem`; apagar o lead
     importado → traz o `lead` e nenhuma `mensagem` dele.
  Cleanup no `afterAll` (leads semeados; etapas ficam para reuso).

- [x] **Passo 4: Ver falhar pelo motivo certo** — `office-api` não existe (404), e o
  sales-coach ainda lê o segredo:

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" E2E_BASE_URL=https://eleveflow-tan.vercel.app \
  npx playwright test tests/e2e/office-api.spec.ts
git add tests/e2e/office-api.spec.ts
git commit -m "test(e2e): office-api com isolamento, escopo, limite, paginacao e historico"
```

---

### Task 10: Guia do Office e implantação (gate do dono)

**Files:** Create `docs/api/office-api.md`; Modify `STATUS.md`.

- [x] **Passo 1: Guia** `docs/api/office-api.md`: configuração no Office (URL base,
  variável `ELEVE_FLOW_SALES_COACH_TOKEN` já instalada, que passa a ler também a
  `office-api`), rotas e escopos, sincronização incremental (guardar `proximo_cursor`
  por feed; `exclusoes` para o que sumiu; a janela de 5 s), repetição (tabela da spec),
  definição de estoque atual, entradas no período e transições, e a cobertura histórica.
  Commit `docs: guia da office-api para o Eleve Office`.

- [x] **Passo 2: Pedir o OK** para a sequência abaixo, que para no primeiro erro.

- [x] **Passo 3: Migrations 1 e 2**, conferência (tabelas, coluna, constraints, ACL das
  funções de trigger), e validação somente leitura do corpo da migration 3 contra a
  conta Eleve One (SELECT com literais, como no sales-coach).

- [x] **Passo 4: Migration 3** e ACL das 4 funções (`postgres` e `service_role` só).

- [x] **Passo 5: Tokens.** Importar os dois hashes de `SALES_COACH_TOKENS` com
  `comercial:leitura` (E2E → `e2e@eleveflow.test`; Eleve Office → Eleve One) e criar os
  três tokens de E2E com `--env`.

- [x] **Passo 6: Deploy** de `office-api`, `sales-coach` e `ai-agent-reply` (`--use-api`).

- [x] **Passo 7: E2E verde:** `office-api.spec.ts`, `sales-coach.spec.ts`,
  `evolution-inbound-webhook.spec.ts`.

- [ ] **Passo 8: Conferir com o token do Office** (o texto está só com o dono e no
  servidor do Office): pedir ao dono ou ao agente do Office o `curl` de
  `GET /v1/leads?limite=1` → 200. Daqui, conferir no `api_request_log` a chamada com o
  `token_id` do Office.

- [x] **Passo 9: Apagar o segredo** `SALES_COACH_TOKENS`
  (`bash scripts/sb-staging.sh secrets unset SALES_COACH_TOKENS`) e rodar o
  `sales-coach.spec.ts` de novo.

- [x] **Passo 10: STATUS.md e commit**; instruções ao Office na resposta final.
