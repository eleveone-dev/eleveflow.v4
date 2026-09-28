WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY scheduled_at) - 1 AS rn
  FROM public.send_queue
  WHERE status = 'pending'
)
UPDATE public.send_queue sq
SET scheduled_at = (
  TIMESTAMP WITH TIME ZONE '2026-06-16 11:00:00+00'
  + ((o.rn / 40) * INTERVAL '1 day')
  + ((o.rn % 40) * INTERVAL '4 minutes')
)
FROM ordered o
WHERE sq.id = o.id;