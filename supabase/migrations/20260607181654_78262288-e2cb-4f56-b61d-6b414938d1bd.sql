-- Adicionar coluna trigger_type na tabela flows
ALTER TABLE public.flows ADD COLUMN trigger_type TEXT DEFAULT 'manual';

-- Atualizar tipos e permissões se necessário (GRANT já deve existir para a tabela)
COMMENT ON COLUMN public.flows.trigger_type IS 'Tipo de gatilho do fluxo: manual ou stage_enter';
