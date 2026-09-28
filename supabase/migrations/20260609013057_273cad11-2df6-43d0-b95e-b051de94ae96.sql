ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS content TEXT;
COMMENT ON COLUMN public.send_queue.content IS 'Conteúdo processado da mensagem a ser enviada';