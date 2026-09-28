
CREATE OR REPLACE FUNCTION public.auto_trigger_flow_on_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_flow_exists boolean;
  v_anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvYW5wdmlvemZhYnJyeGpxYXlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDc1NjEsImV4cCI6MjA5NjM4MzU2MX0.DQcuI3CUWbIWVn96WflG0ApB4BiI9l92Ir7TuIrJZ-8';
BEGIN
  IF NEW.stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.flows
    WHERE user_id = NEW.user_id
      AND trigger_stage_id = NEW.stage_id
      AND is_active = true
  ) INTO v_flow_exists;

  IF NOT v_flow_exists THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://aoanpviozfabrrxjqayk.supabase.co/functions/v1/trigger-flow-by-stage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_anon_key,
      'Authorization', 'Bearer ' || v_anon_key
    ),
    body := jsonb_build_object(
      'lead_id', NEW.id,
      'user_id', NEW.user_id,
      'new_stage_id', NEW.stage_id
    )
  );

  RETURN NEW;
END;
$function$;

UPDATE public.send_queue
SET scheduled_at = TIMESTAMP WITH TIME ZONE '2026-06-16 11:00:00+00'
WHERE user_id = 'eb22ef7b-df8a-45dd-b773-154bd342f7bb'
  AND status = 'pending';
