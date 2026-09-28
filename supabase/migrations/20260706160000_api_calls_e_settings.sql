-- Observabilidade de APIs externas (spec §5.1).
-- feature é enum aberto: valores documentados —
-- agent_reply | agent_opening | stage_classifier | photo_vision |
-- extract_search | enrich_details | enrich_photos | enrich_reviews | instagram_profile.
-- Nova feature exige novo valor documentado aqui.
CREATE TABLE IF NOT EXISTS public.api_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  flow_id uuid,
  execution_id uuid,
  block_id uuid,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'serpapi', 'evolution')),
  feature text NOT NULL,
  model text,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  error_message text,
  latency_ms integer NOT NULL DEFAULT 0,
  prompt_tokens integer,
  completion_tokens integer,
  -- microdólares (1 USD = 1.000.000). Centavos não têm precisão para LLM; float nunca.
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  request jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_calls_user_created ON public.api_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_calls_feature ON public.api_calls (feature);
CREATE INDEX IF NOT EXISTS idx_api_calls_lead ON public.api_calls (lead_id);
CREATE INDEX IF NOT EXISTS idx_api_calls_execution ON public.api_calls (execution_id);

ALTER TABLE public.api_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.api_calls TO authenticated;
GRANT ALL ON public.api_calls TO service_role;

-- Usuário lê apenas as próprias linhas; escrita só via service role (sem policy de INSERT/UPDATE).
CREATE POLICY "api_calls_select_own" ON public.api_calls
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Defaults de modelo (validados contra openrouter.ai/api/v1/models em 2026-07-06)
-- e custo derivado do SerpAPI (15000 micros = $0.015/busca; ajustável por ambiente).
INSERT INTO public.global_settings (key, value) VALUES
  ('ai_model_economy', 'google/gemini-2.5-flash-lite'),
  ('ai_model_agent_default', 'google/gemini-2.5-flash'),
  ('serpapi_cost_per_search_usd_micros', '15000')
ON CONFLICT (key) DO NOTHING;

-- Momento real do envio (views de saúde WhatsApp calculam tempo em fila).
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS sent_at timestamptz;
