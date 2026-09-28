
CREATE OR REPLACE FUNCTION public.next_send_slot(p_user_id uuid, p_min_at timestamptz DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings jsonb;
  v_interval int;
  v_daily int;
  v_start int;
  v_end int;
  v_last timestamptz;
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

  SELECT MAX(scheduled_at) INTO v_last
  FROM public.send_queue
  WHERE user_id = p_user_id AND status IN ('pending','sent','sending');

  v_candidate := GREATEST(
    COALESCE(p_min_at, now()),
    COALESCE(v_last + (v_interval || ' minutes')::interval, now()),
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
    FROM public.send_queue
    WHERE user_id = p_user_id
      AND status IN ('pending','sent','sending')
      AND ((scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date) = v_day;

    IF v_count_today >= v_daily THEN
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;

    EXIT;
  END LOOP;

  RETURN v_candidate;
END;
$$;

CREATE OR REPLACE FUNCTION public.reschedule_pending_queue(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings jsonb;
  v_interval int;
  v_daily int;
  v_start int;
  v_end int;
  v_now timestamptz := now();
  v_last timestamptz;
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

  SELECT MAX(scheduled_at) INTO v_last
  FROM public.send_queue
  WHERE user_id = p_user_id AND status IN ('sent','sending');

  IF v_last IS NULL OR v_last < v_now THEN
    v_candidate := v_now;
  ELSE
    v_candidate := v_last + (v_interval || ' minutes')::interval;
  END IF;

  FOR rec IN
    SELECT id FROM public.send_queue
    WHERE user_id = p_user_id AND status = 'pending'
    ORDER BY scheduled_at, id
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
        FROM public.send_queue
        WHERE user_id = p_user_id
          AND status IN ('sent','sending')
          AND ((scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date) = v_current_day;
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
$$;

GRANT EXECUTE ON FUNCTION public.next_send_slot(uuid, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_pending_queue(uuid) TO service_role;

-- Reagenda as filas existentes
SELECT public.reschedule_pending_queue('215d58f3-d607-4449-9c97-89f4fa71022b');
SELECT public.reschedule_pending_queue('eb22ef7b-df8a-45dd-b773-154bd342f7bb');
