
INSERT INTO public.flow_executions (user_id, lead_id, flow_id, current_block_id, status)
SELECT DISTINCT ON (sq.lead_id, sq.flow_id)
  sq.user_id, sq.lead_id, sq.flow_id, sq.block_id, 'waiting_response'
FROM public.send_queue sq
LEFT JOIN public.flow_executions fe
  ON fe.lead_id = sq.lead_id AND fe.flow_id = sq.flow_id
WHERE sq.status = 'sent'
  AND sq.flow_id IS NOT NULL
  AND sq.block_id IS NOT NULL
  AND sq.lead_id IS NOT NULL
  AND fe.id IS NULL
ORDER BY sq.lead_id, sq.flow_id, sq.scheduled_at DESC;
