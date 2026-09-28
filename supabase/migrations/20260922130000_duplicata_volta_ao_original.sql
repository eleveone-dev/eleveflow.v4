-- A trava de duplicata da fila volta a valer para todo bloco, inclusive o de agente.
--
-- A migration 20260922120000 isentou o bloco de agente para que as respostas dele
-- entrassem na fila. Não bastava: o índice único send_queue_unique_active_delivery_idx
-- barra o mesmo (lead, bloco) em pending, sending e sent, e a resposta seguinte à
-- abertura batia nele do mesmo jeito. As respostas do agente agora entram na fila
-- sem block_id (ai-agent-reply), e item sem bloco a trava já deixa passar.
--
-- A isenção perdeu o motivo. Sem ela, a abertura do agente volta a ser tratada como
-- qualquer mensagem de fluxo: uma por lead, descartada em silêncio se repetida.

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
