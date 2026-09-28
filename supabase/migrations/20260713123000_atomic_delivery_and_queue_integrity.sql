-- Make queue delivery finalization atomic and protect every queue reference.
-- This migration follows 20260713120000, which is already applied to staging.

-- A queue claim is a lease. A worker must present the lease token when it
-- releases or completes the delivery, so an old/stale worker cannot overwrite
-- a newer claim after recovery.
ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS claim_token uuid;

-- Tie the durable outbound record to the queue item. This makes successful
-- finalization idempotent even if an Edge Function receives a retry after the
-- provider has already accepted the message.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS queue_item_id uuid REFERENCES public.send_queue(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_queue_item_id_unique_idx
  ON public.messages (queue_item_id)
  WHERE queue_item_id IS NOT NULL;

-- Recalculate contact identity on every write. A direct update to
-- phone_normalized must never leave a stale or forged lookup value behind.
CREATE OR REPLACE FUNCTION public.set_lead_phone_normalized()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_whatsapp text := public.normalize_phone_digits(NEW.whatsapp);
  v_phone text := public.normalize_phone_digits(NEW.phone);
BEGIN
  NEW.phone_normalized := CASE
    WHEN length(v_whatsapp) BETWEEN 10 AND 15 THEN v_whatsapp
    WHEN length(v_phone) BETWEEN 10 AND 15 THEN v_phone
    ELSE COALESCE(v_whatsapp, v_phone)
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_set_phone_normalized ON public.leads;
CREATE TRIGGER leads_set_phone_normalized
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_lead_phone_normalized();

-- Keep all queue foreign keys in the same tenant. The worker runs with service
-- role, so this invariant belongs in the database instead of only in Edge code.
CREATE OR REPLACE FUNCTION public.validate_send_queue_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_block_flow_id uuid;
BEGIN
  SELECT user_id INTO v_owner_id
  FROM public.leads
  WHERE id = NEW.lead_id;

  IF NOT FOUND OR v_owner_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'send_queue lead_id must belong to user_id';
  END IF;

  IF NEW.flow_id IS NOT NULL THEN
    SELECT user_id INTO v_owner_id
    FROM public.flows
    WHERE id = NEW.flow_id;

    IF NOT FOUND OR v_owner_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'send_queue flow_id must belong to user_id';
    END IF;
  END IF;

  IF NEW.block_id IS NOT NULL THEN
    SELECT user_id, flow_id INTO v_owner_id, v_block_flow_id
    FROM public.flow_blocks
    WHERE id = NEW.block_id;

    IF NOT FOUND OR v_owner_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'send_queue block_id must belong to user_id';
    END IF;

    IF NEW.flow_id IS NOT NULL AND v_block_flow_id IS DISTINCT FROM NEW.flow_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'send_queue block_id must belong to flow_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS send_queue_validate_references ON public.send_queue;
CREATE TRIGGER send_queue_validate_references
  BEFORE INSERT OR UPDATE OF user_id, lead_id, flow_id, block_id ON public.send_queue
  FOR EACH ROW EXECUTE FUNCTION public.validate_send_queue_references();

-- The older trigger gives a friendly no-op for ordinary duplicate attempts,
-- while this index closes the race between two concurrent inserts.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY lead_id, block_id ORDER BY created_at, id) AS rn
  FROM public.send_queue
  WHERE block_id IS NOT NULL
    AND status IN ('pending', 'sending', 'sent')
)
UPDATE public.send_queue AS queue_item
SET status = 'duplicate', sending_at = NULL, claim_token = NULL
FROM ranked
WHERE queue_item.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS send_queue_unique_active_delivery_idx
  ON public.send_queue (lead_id, block_id)
  WHERE block_id IS NOT NULL
    AND status IN ('pending', 'sending', 'sent');

-- Version 1 remains for a safe transition, but now enforces scheduled_at and
-- creates a lease token. New workers use the v2 wrapper below to receive it.
CREATE OR REPLACE FUNCTION public.claim_marketing_queue_item(
  p_queue_item_id uuid,
  p_user_id uuid,
  p_daily_cap integer,
  p_interval_minutes integer,
  p_force boolean DEFAULT false
)
RETURNS TABLE(claimed boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queue public.send_queue%ROWTYPE;
  v_lead public.leads%ROWTYPE;
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'America/Sao_Paulo')::date;
  v_sent_count integer := 0;
  v_unknown_delivery_count integer := 0;
  v_active_reservations integer := 0;
  v_last_sent_at timestamptz;
BEGIN
  IF p_queue_item_id IS NULL OR p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_request';
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), 91331);

  SELECT * INTO v_queue
  FROM public.send_queue
  WHERE id = p_queue_item_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'queue_item_not_found';
    RETURN;
  END IF;

  IF v_queue.status IS DISTINCT FROM 'pending' THEN
    RETURN QUERY SELECT false, 'queue_item_not_pending';
    RETURN;
  END IF;

  IF NOT p_force AND COALESCE(v_queue.scheduled_at, v_now) > v_now THEN
    RETURN QUERY SELECT false, 'scheduled_in_future';
    RETURN;
  END IF;

  SELECT * INTO v_lead
  FROM public.leads
  WHERE id = v_queue.lead_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    UPDATE public.send_queue
    SET status = 'failed', sending_at = NULL, claim_token = NULL
    WHERE id = v_queue.id;
    RETURN QUERY SELECT false, 'lead_tenant_mismatch';
    RETURN;
  END IF;

  IF v_lead.is_suppressed
     OR v_lead.marketing_opted_out_at IS NOT NULL
     OR v_lead.marketing_consent_status NOT IN ('granted', 'not_required') THEN
    UPDATE public.send_queue
    SET status = 'failed', sending_at = NULL, claim_token = NULL,
        attempts = COALESCE(attempts, 0) + 1
    WHERE id = v_queue.id;
    RETURN QUERY SELECT false, 'marketing_suppression_check';
    RETURN;
  END IF;

  IF NOT p_force THEN
    SELECT COUNT(*) INTO v_sent_count
    FROM public.messages
    WHERE user_id = p_user_id
      AND direction = 'outbound'
      AND status = 'sent'
      AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = v_today;

    -- A provider-confirmed send whose database finalization failed is not
    -- retried automatically. Count it conservatively until reconciled.
    SELECT COUNT(*) INTO v_unknown_delivery_count
    FROM public.send_queue
    WHERE user_id = p_user_id
      AND status = 'delivery_unknown'
      AND sent_at IS NOT NULL
      AND (sent_at AT TIME ZONE 'America/Sao_Paulo')::date = v_today;

    SELECT COUNT(*) INTO v_active_reservations
    FROM public.send_queue
    WHERE user_id = p_user_id
      AND status = 'sending'
      AND sending_at >= v_now - interval '10 minutes';

    IF v_sent_count + v_unknown_delivery_count + v_active_reservations
       >= GREATEST(1, COALESCE(p_daily_cap, 40)) THEN
      RETURN QUERY SELECT false, 'daily_cap_reached';
      RETURN;
    END IF;

    IF GREATEST(0, COALESCE(p_interval_minutes, 0)) > 0 THEN
      SELECT MAX(delivered_at) INTO v_last_sent_at
      FROM (
        SELECT created_at AS delivered_at
        FROM public.messages
        WHERE user_id = p_user_id
          AND direction = 'outbound'
          AND status = 'sent'
        UNION ALL
        SELECT sent_at AS delivered_at
        FROM public.send_queue
        WHERE user_id = p_user_id
          AND status = 'delivery_unknown'
          AND sent_at IS NOT NULL
      ) AS deliveries;

      IF v_active_reservations > 0 THEN
        RETURN QUERY SELECT false, 'interval_reservation_active';
        RETURN;
      END IF;

      IF v_last_sent_at IS NOT NULL
         AND v_last_sent_at > v_now - (GREATEST(0, p_interval_minutes) || ' minutes')::interval THEN
        RETURN QUERY SELECT false, 'interval_not_reached';
        RETURN;
      END IF;
    END IF;
  END IF;

  UPDATE public.send_queue
  SET status = 'sending', sending_at = v_now, claim_token = gen_random_uuid()
  WHERE id = v_queue.id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'queue_item_claim_lost';
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_marketing_queue_item_v2(
  p_queue_item_id uuid,
  p_user_id uuid,
  p_daily_cap integer,
  p_interval_minutes integer,
  p_force boolean DEFAULT false
)
RETURNS TABLE(claimed boolean, reason text, claim_token uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim record;
  v_claim_token uuid;
BEGIN
  SELECT * INTO v_claim
  FROM public.claim_marketing_queue_item(
    p_queue_item_id,
    p_user_id,
    p_daily_cap,
    p_interval_minutes,
    p_force
  );

  IF COALESCE(v_claim.claimed, false) THEN
    SELECT queue_item.claim_token INTO v_claim_token
    FROM public.send_queue AS queue_item
    WHERE queue_item.id = p_queue_item_id
      AND queue_item.user_id = p_user_id;
  END IF;

  RETURN QUERY SELECT
    COALESCE(v_claim.claimed, false),
    COALESCE(v_claim.reason, 'queue_item_claim_lost'),
    v_claim_token;
END;
$$;

-- Persist the provider-confirmed outbound message and change the queue state in
-- one transaction. If an opt-out won the race, retain the delivery audit but do
-- not resurrect the cancelled queue or advance the flow.
CREATE OR REPLACE FUNCTION public.complete_marketing_queue_delivery(
  p_queue_item_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_content text,
  p_whatsapp_id text DEFAULT NULL
)
RETURNS TABLE(recorded boolean, queue_status text, message_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    created_at
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
    v_now
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
$$;

REVOKE ALL ON FUNCTION public.claim_marketing_queue_item_v2(uuid, uuid, integer, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_marketing_queue_item_v2(uuid, uuid, integer, integer, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_marketing_queue_delivery(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_marketing_queue_delivery(uuid, uuid, uuid, text, text)
  TO service_role;
