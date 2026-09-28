
-- 1) Create server-only secrets table
CREATE TABLE IF NOT EXISTS public.account_secrets (
  user_id uuid PRIMARY KEY,
  integrations jsonb NOT NULL DEFAULT '{"serpapi": {"key": ""}, "evolution": {"key": "", "url": ""}, "openrouter": {"key": "", "model": "gpt-4o-mini", "use_ia": false}}'::jsonb,
  whatsapp_session jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) Grants: server_role only. NO grants to anon or authenticated.
GRANT ALL ON public.account_secrets TO service_role;

-- 3) Enable RLS (no policies for authenticated => no access from client)
ALTER TABLE public.account_secrets ENABLE ROW LEVEL SECURITY;

-- 4) updated_at trigger
DROP TRIGGER IF EXISTS account_secrets_set_updated_at ON public.account_secrets;
CREATE TRIGGER account_secrets_set_updated_at
  BEFORE UPDATE ON public.account_secrets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5) Migrate existing data from accounts
INSERT INTO public.account_secrets (user_id, integrations, whatsapp_session)
SELECT DISTINCT ON (user_id) user_id,
       COALESCE(integrations, '{"serpapi": {"key": ""}, "evolution": {"key": "", "url": ""}, "openrouter": {"key": "", "model": "gpt-4o-mini", "use_ia": false}}'::jsonb),
       whatsapp_session
FROM public.accounts
WHERE user_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

-- 6) Drop sensitive columns from accounts (no longer client-readable)
ALTER TABLE public.accounts DROP COLUMN IF EXISTS integrations;
ALTER TABLE public.accounts DROP COLUMN IF EXISTS whatsapp_session;
