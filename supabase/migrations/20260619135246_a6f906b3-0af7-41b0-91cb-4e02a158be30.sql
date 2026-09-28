CREATE OR REPLACE FUNCTION public.next_send_slot(p_user_id uuid, p_min_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settings jsonb;
  v_interval int;
  v_daily int;
  v_start int;
  v_end int;
  v_last_pending timestamptz;
  v_last_sent timestamptz;
  v_candidate timestamptz;
  v_br timestamp;
  v_day date;
  v_count_today int;
  v_max_iter int := 0;
BEGIN
  SELECT settings INTO v_settings FROM public.accounts WHERE user_id = p_user_id;
  v_interval := GREATEST(1, COALESCE((v_settings->>'send_interval_minutes')::int, 5));
  v_daily    := GREATEST(1, COALESCE((v_settings->>'daily_limit')::int, 40));
  v_start    := COALESCE((v_settings->>'start_hour')::int, 8);
  v_end      := COALESCE((v_settings->>'end_hour')::int, 18);

  SELECT MAX(scheduled_at) INTO v_last_pending
  FROM public.send_queue
  WHERE user_id = p_user_id AND status IN ('pending','sending');

  SELECT MAX(created_at) INTO v_last_sent
  FROM public.messages
  WHERE user_id = p_user_id
    AND direction = 'outbound'
    AND status = 'sent';

  v_candidate := GREATEST(
    COALESCE(p_min_at, now()),
    COALESCE(v_last_pending + (v_interval || ' minutes')::interval, now()),
    COALESCE(v_last_sent + (v_interval || ' minutes')::interval, now()),
    now()
  );

  LOOP
    v_max_iter := v_max_iter + 1;
    EXIT WHEN v_max_iter > 500;

    v_br := (v_candidate AT TIME ZONE 'America/Sao_Paulo');

    IF EXTRACT(DOW FROM v_br)::int IN (0,6) THEN
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;
    IF EXTRACT(HOUR FROM v_br)::int < v_start THEN
      v_candidate := (date_trunc('day', v_br) + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;
    IF EXTRACT(HOUR FROM v_br)::int >= v_end THEN
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;

    v_day := v_br::date;
    SELECT COUNT(*) INTO v_count_today
    FROM public.messages
    WHERE user_id = p_user_id
      AND direction = 'outbound'
      AND status = 'sent'
      AND ((created_at AT TIME ZONE 'America/Sao_Paulo')::date) = v_day;

    v_count_today := v_count_today + COALESCE((
      SELECT COUNT(*)
      FROM public.send_queue
      WHERE user_id = p_user_id
        AND status IN ('pending','sending')
        AND ((scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date) = v_day
    ), 0);

    IF v_count_today >= v_daily THEN
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;

    EXIT;
  END LOOP;

  RETURN v_candidate;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_pending_queue(p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settings jsonb;
  v_interval int;
  v_daily int;
  v_start int;
  v_end int;
  v_now timestamptz := now();
  v_last_sent timestamptz;
  v_candidate timestamptz;
  v_br timestamp;
  v_day date;
  v_current_day date := NULL;
  v_count_today int := 0;
  v_max_iter int;
  v_updated int := 0;
  rec record;
BEGIN
  SELECT settings INTO v_settings FROM public.accounts WHERE user_id = p_user_id;
  v_interval := GREATEST(1, COALESCE((v_settings->>'send_interval_minutes')::int, 5));
  v_daily    := GREATEST(1, COALESCE((v_settings->>'daily_limit')::int, 40));
  v_start    := COALESCE((v_settings->>'start_hour')::int, 8);
  v_end      := COALESCE((v_settings->>'end_hour')::int, 18);

  SELECT MAX(created_at) INTO v_last_sent
  FROM public.messages
  WHERE user_id = p_user_id
    AND direction = 'outbound'
    AND status = 'sent';

  v_candidate := GREATEST(
    v_now,
    COALESCE(v_last_sent + (v_interval || ' minutes')::interval, v_now)
  );

  FOR rec IN
    SELECT id FROM public.send_queue
    WHERE user_id = p_user_id AND status = 'pending'
    ORDER BY scheduled_at, created_at, id
  LOOP
    v_max_iter := 0;
    LOOP
      v_max_iter := v_max_iter + 1;
      EXIT WHEN v_max_iter > 500;

      v_br := (v_candidate AT TIME ZONE 'America/Sao_Paulo');
      v_day := v_br::date;

      IF EXTRACT(DOW FROM v_br)::int IN (0,6) THEN
        v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
        v_current_day := NULL;
        CONTINUE;
      END IF;
      IF EXTRACT(HOUR FROM v_br)::int < v_start THEN
        v_candidate := (date_trunc('day', v_br) + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
        v_current_day := NULL;
        CONTINUE;
      END IF;
      IF EXTRACT(HOUR FROM v_br)::int >= v_end THEN
        v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
        v_current_day := NULL;
        CONTINUE;
      END IF;

      IF v_current_day IS DISTINCT FROM v_day THEN
        v_current_day := v_day;
        SELECT COUNT(*) INTO v_count_today
        FROM public.messages
        WHERE user_id = p_user_id
          AND direction = 'outbound'
          AND status = 'sent'
          AND ((created_at AT TIME ZONE 'America/Sao_Paulo')::date) = v_current_day;
      END IF;

      IF v_count_today >= v_daily THEN
        v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
        v_current_day := NULL;
        CONTINUE;
      END IF;

      EXIT;
    END LOOP;

    UPDATE public.send_queue SET scheduled_at = v_candidate WHERE id = rec.id;
    v_updated := v_updated + 1;
    v_count_today := v_count_today + 1;
    v_candidate := v_candidate + (v_interval || ' minutes')::interval;
  END LOOP;

  RETURN v_updated;
END;
$function$;

WITH real_sent AS (
  SELECT sq.id, MAX(m.created_at) AS real_sent_at
  FROM public.send_queue sq
  JOIN public.messages m
    ON m.user_id = sq.user_id
   AND m.lead_id = sq.lead_id
   AND m.direction = 'outbound'
   AND m.status = 'sent'
   AND m.content = sq.content
  WHERE sq.status = 'sent'
    AND sq.scheduled_at > now()
  GROUP BY sq.id
)
UPDATE public.send_queue sq
SET scheduled_at = real_sent.real_sent_at
FROM real_sent
WHERE sq.id = real_sent.id;

SELECT public.reschedule_pending_queue('215d58f3-d607-4449-9c97-89f4fa71022b'::uuid);
SELECT public.reschedule_pending_queue('eb22ef7b-df8a-45dd-b773-154bd342f7bb'::uuid);

REVOKE ALL ON FUNCTION public.next_send_slot(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reschedule_pending_queue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_send_slot(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_pending_queue(uuid) TO service_role;