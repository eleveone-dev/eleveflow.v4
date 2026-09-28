ALTER TABLE public.flows 
ADD COLUMN IF NOT EXISTS canvas_state jsonb 
DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.flows.canvas_state IS 'Armazena o estado completo do ReactFlow (nós e conexões) para persistência de layout.';