-- A trava de duplicata da fila deixa de barrar o bloco de agente de IA.
--
-- prevent_duplicate_send_queue descarta em silêncio (RETURN NULL) o item de um
-- bloco que o lead já recebeu — pending, sending ou sent. Faz sentido para bloco de
-- mensagem: a mesma mensagem de fluxo não sai duas vezes para a mesma pessoa.
--
-- Para o bloco de agente era fatal. A abertura e todas as respostas do agente
-- usam o MESMO block_id, então tudo depois da primeira mensagem era descartado: o
-- agente nunca conversava. Pior, quem inseria ignorava a linha ausente e gravava a
-- mensagem em `messages` mesmo assim — ficava na conversa como "pendente" para
-- sempre, sem ter saído. Medido na conta Eleve One em 2026-09-22: três aberturas
-- gravadas para o lead de teste, um único item na fila.
--
-- Agora o bloco de agente passa direto. Bloco de mensagem continua travado.

CREATE OR REPLACE FUNCTION public.prevent_duplicate_send_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  existing_id uuid;
BEGIN
  IF NEW.lead_id IS NULL OR NEW.block_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Bloco que conversa manda várias mensagens para o mesmo lead por natureza.
  IF EXISTS (
    SELECT 1 FROM public.flow_blocks
    WHERE id = NEW.block_id AND type = 'ai_agent'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO existing_id
  FROM public.send_queue
  WHERE lead_id = NEW.lead_id
    AND block_id = NEW.block_id
    AND status IN ('pending', 'sending', 'sent')
  LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RAISE NOTICE 'Duplicate send_queue insert blocked for lead=% block=% (existing=%)',
      NEW.lead_id, NEW.block_id, existing_id;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;
