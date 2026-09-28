-- Dois registros que a API do Office le e que o banco nao guardava: a origem IA
-- da mensagem e o nome da etapa no momento da mudanca.

-- A resposta da IA vai para a fila sem bloco (ver ai-agent-reply), e a entrega
-- gravava a mensagem sem nada que a separasse de automacao.
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE public.send_queue DROP CONSTRAINT IF EXISTS send_queue_origin_check;
ALTER TABLE public.send_queue
  ADD CONSTRAINT send_queue_origin_check CHECK (origin IS NULL OR origin IN ('ia'));

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_origin_check
  CHECK (origin IS NULL OR origin IN ('crm', 'business_app', 'ia'));

-- Mesma funcao de 2026-07-13; a unica mudanca e copiar origin do item da fila.
CREATE OR REPLACE FUNCTION public.complete_marketing_queue_delivery(
  p_queue_item_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_content text,
  p_whatsapp_id text DEFAULT NULL::text
)
RETURNS TABLE(recorded boolean, queue_status text, message_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_queue public.send_queue%ROWTYPE;
  v_message_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_queue_item_id IS NULL
     OR p_user_id IS NULL
     OR p_claim_token IS NULL
     OR NULLIF(btrim(COALESCE(p_content, '')), '') IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_request', NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), 91331);

  SELECT * INTO v_queue
  FROM public.send_queue
  WHERE id = p_queue_item_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'queue_item_not_found', NULL::uuid;
    RETURN;
  END IF;

  IF v_queue.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN QUERY SELECT false, 'claim_lost', NULL::uuid;
    RETURN;
  END IF;

  IF v_queue.status NOT IN ('sending', 'failed') THEN
    RETURN QUERY SELECT false, 'queue_not_deliverable', NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.messages (
    user_id,
    lead_id,
    flow_id,
    block_id,
    content,
    direction,
    whatsapp_id,
    status,
    queue_item_id,
    created_at,
    origin
  )
  VALUES (
    v_queue.user_id,
    v_queue.lead_id,
    v_queue.flow_id,
    v_queue.block_id,
    p_content,
    'outbound',
    p_whatsapp_id,
    'sent',
    v_queue.id,
    v_now,
    v_queue.origin
  )
  ON CONFLICT (queue_item_id) WHERE queue_item_id IS NOT NULL
  DO UPDATE SET whatsapp_id = COALESCE(public.messages.whatsapp_id, EXCLUDED.whatsapp_id)
  RETURNING id INTO v_message_id;

  IF v_queue.status = 'sending' THEN
    UPDATE public.send_queue
    SET status = 'sent',
        sending_at = NULL,
        attempts = COALESCE(attempts, 0) + 1,
        scheduled_at = v_now,
        sent_at = v_now
    WHERE id = v_queue.id
      AND status = 'sending'
      AND claim_token = p_claim_token;

    IF FOUND THEN
      RETURN QUERY SELECT true, 'sent', v_message_id;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT true, 'delivery_recorded_after_cancellation', v_message_id;
END;
$function$;

-- Nome e tipo das etapas congelados no evento: a etapa pode ser renomeada ou
-- reclassificada depois, e o historico tem de dizer o que era na hora.
CREATE OR REPLACE FUNCTION public.record_lead_stage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.lead_stage_events (
      user_id,
      workspace_id,
      lead_id,
      from_stage_id,
      to_stage_id,
      event_type,
      changed_by,
      occurred_at,
      metadata
    ) VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.id,
      NULL,
      NEW.stage_id,
      'lead_created',
      auth.uid(),
      COALESCE(NEW.created_at, now()),
      jsonb_strip_nulls(jsonb_build_object(
        'para_nome', (SELECT btrim(s.name) FROM public.pipeline_stages s WHERE s.id = NEW.stage_id),
        'para_tipo', (SELECT s.funnel_key FROM public.pipeline_stages s WHERE s.id = NEW.stage_id)
      ))
    );
  ELSIF OLD.stage_id IS DISTINCT FROM NEW.stage_id
    AND NEW.stage_id IS NOT NULL THEN
    INSERT INTO public.lead_stage_events (
      user_id,
      workspace_id,
      lead_id,
      from_stage_id,
      to_stage_id,
      event_type,
      changed_by,
      metadata
    ) VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.id,
      OLD.stage_id,
      NEW.stage_id,
      'stage_changed',
      auth.uid(),
      jsonb_strip_nulls(jsonb_build_object(
        'de_nome', (SELECT btrim(s.name) FROM public.pipeline_stages s WHERE s.id = OLD.stage_id),
        'de_tipo', (SELECT s.funnel_key FROM public.pipeline_stages s WHERE s.id = OLD.stage_id),
        'para_nome', (SELECT btrim(s.name) FROM public.pipeline_stages s WHERE s.id = NEW.stage_id),
        'para_tipo', (SELECT s.funnel_key FROM public.pipeline_stages s WHERE s.id = NEW.stage_id)
      ))
    );
  END IF;

  RETURN NEW;
END;
$function$;
