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
