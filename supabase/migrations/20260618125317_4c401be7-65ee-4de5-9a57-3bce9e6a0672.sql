
REVOKE EXECUTE ON FUNCTION public.next_send_slot(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reschedule_pending_queue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_send_slot(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_pending_queue(uuid) TO service_role;
