ALTER TABLE public.flow_executions 
ADD COLUMN IF NOT EXISTS is_test boolean DEFAULT false;

-- Garante que as colunas sejam visíveis para o PostgREST
NOTIFY pgrst, 'reload schema';