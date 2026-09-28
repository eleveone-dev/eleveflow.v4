ALTER TABLE public.leads 
ADD COLUMN IF NOT EXISTS is_test boolean DEFAULT false;

ALTER TABLE public.leads 
ADD COLUMN IF NOT EXISTS test_expires_at timestamptz NULL;

-- Garante que as colunas sejam visíveis para o PostgREST
NOTIFY pgrst, 'reload schema';