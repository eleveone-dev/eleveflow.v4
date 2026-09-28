-- next_send_slot derrubava com hora gravada como texto ("08:00").
--
-- A função fazia (settings->>'start_hour')::int, e há conta com a hora no formato
-- HH:MM. O erro não aparecia: o execute-flow ignora o erro da RPC e cai num
-- fallback em JS com intervalo fixo e sem limite diário. Agora as duas formas são
-- aceitas. Achado ao testar a migration anterior contra a conta de E2E.

CREATE OR REPLACE FUNCTION public.next_send_slot(
  p_user_id uuid,
  p_min_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_settings jsonb;
  v_min_min numeric;
  v_max_min numeric;
  v_gap interval;
  v_daily int;
  v_start int;
  v_end int;
  v_last_pending timestamptz;
  v_last_sent timestamptz;
  v_candidate timestamptz;
  v_br timestamp;
  v_day date;
  v_count_today int;
  v_scheduled_today int;
  v_max_iter int := 0;
BEGIN
  SELECT settings INTO v_settings FROM public.accounts WHERE user_id = p_user_id;

  v_min_min := GREATEST(1, COALESCE(
    NULLIF(v_settings->>'send_interval_min_minutes', '')::numeric,
    NULLIF(v_settings->>'send_interval_minutes', '')::numeric,
    5
  ));
  v_max_min := GREATEST(v_min_min, COALESCE(
    NULLIF(v_settings->>'send_interval_max_minutes', '')::numeric,
    round(v_min_min * 1.8)
  ));
  v_gap := public.send_gap(v_min_min, v_max_min);

  v_daily := GREATEST(1, COALESCE((v_settings->>'daily_limit')::int, 40));
  -- Aceita 8 e '08:00': há conta com a hora gravada como texto, e o ::int direto
  -- derrubava a função — o execute-flow caía num fallback sem sorteio e sem limite
  -- diário, em silêncio.
  v_start := COALESCE(NULLIF(split_part(v_settings->>'start_hour', ':', 1), '')::int, 8);
  v_end   := COALESCE(NULLIF(split_part(v_settings->>'end_hour', ':', 1), '')::int, 18);

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
    COALESCE(v_last_pending + v_gap, now()),
    COALESCE(v_last_sent + v_gap, now()),
    now()
  );

  -- Pausa longa: sorteada por envio, com a mesma frequência média do app antigo.
  SELECT COUNT(*) INTO v_scheduled_today
  FROM public.send_queue
  WHERE user_id = p_user_id
    AND status IN ('pending','sending','sent')
    AND ((scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date)
      = ((v_candidate AT TIME ZONE 'America/Sao_Paulo')::date);
  IF v_scheduled_today > 0 AND random() < (1.0 / 11.5) THEN
    v_candidate := v_candidate + make_interval(mins => 10 + floor(random() * 16)::int);
  END IF;

  LOOP
    v_max_iter := v_max_iter + 1;
    EXIT WHEN v_max_iter > 500;

    v_br := (v_candidate AT TIME ZONE 'America/Sao_Paulo');

    -- Ao pular para o início do expediente, a abertura ganha 0 a 20 minutos: sem
    -- isto todo primeiro envio do dia sairia às 08:00:00 em ponto.
    IF EXTRACT(DOW FROM v_br)::int IN (0,6) THEN
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval
        + make_interval(secs => random() * 20 * 60)) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;
    IF EXTRACT(HOUR FROM v_br)::int < v_start THEN
      v_candidate := (date_trunc('day', v_br) + (v_start || ' hours')::interval
        + make_interval(secs => random() * 20 * 60)) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;
    IF EXTRACT(HOUR FROM v_br)::int >= v_end THEN
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval
        + make_interval(secs => random() * 20 * 60)) AT TIME ZONE 'America/Sao_Paulo';
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
      v_candidate := ((date_trunc('day', v_br) + interval '1 day') + (v_start || ' hours')::interval
        + make_interval(secs => random() * 20 * 60)) AT TIME ZONE 'America/Sao_Paulo';
      CONTINUE;
    END IF;

    EXIT;
  END LOOP;

  RETURN v_candidate;
END;
$function$;
