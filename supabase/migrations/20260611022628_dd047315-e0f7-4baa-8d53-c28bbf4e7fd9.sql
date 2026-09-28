CREATE UNIQUE INDEX IF NOT EXISTS leads_user_phone_normalized_uidx
ON public.leads (user_id, (regexp_replace(COALESCE(phone,''),'\D','','g')))
WHERE regexp_replace(COALESCE(phone,''),'\D','','g') <> '';