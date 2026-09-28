CREATE OR REPLACE FUNCTION public.prevent_duplicate_send_queue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

DROP TRIGGER IF EXISTS prevent_duplicate_send_queue_trg ON public.send_queue;
CREATE TRIGGER prevent_duplicate_send_queue_trg
BEFORE INSERT ON public.send_queue
FOR EACH ROW
EXECUTE FUNCTION public.prevent_duplicate_send_queue();

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY lead_id, block_id ORDER BY created_at) AS rn
  FROM public.send_queue
  WHERE status IN ('pending','sending','sent')
)
UPDATE public.send_queue sq
SET status = 'duplicate'
FROM ranked r
WHERE sq.id = r.id AND r.rn > 1;