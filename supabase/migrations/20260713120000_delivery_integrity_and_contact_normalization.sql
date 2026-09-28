-- Contact identity, consent immutability, pipeline isolation, and atomic queue claims.

-- -----------------------------------------------------------------------------
-- Normalize contact numbers once in the database. Webhooks can then perform an
-- exact tenant-scoped lookup rather than a suffix ilike that may match a wrong
-- person. `whatsapp` takes precedence when it is available with DDI.
-- -----------------------------------------------------------------------------

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS phone_normalized text;

CREATE OR REPLACE FUNCTION public.normalize_phone_digits(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p_value, ''), '[^0-9]', '', 'g'), '')
$$;

CREATE OR REPLACE FUNCTION public.set_lead_phone_normalized()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.phone_normalized := public.normalize_phone_digits(
    COALESCE(NULLIF(NEW.whatsapp, ''), NULLIF(NEW.phone, ''))
  );
  RETURN NEW;
END;
$$;

UPDATE public.leads
SET phone_normalized = public.normalize_phone_digits(
  COALESCE(NULLIF(whatsapp, ''), NULLIF(phone, ''))
)
WHERE phone_normalized IS DISTINCT FROM public.normalize_phone_digits(
  COALESCE(NULLIF(whatsapp, ''), NULLIF(phone, ''))
);

DROP TRIGGER IF EXISTS leads_set_phone_normalized ON public.leads;
CREATE TRIGGER leads_set_phone_normalized
  BEFORE INSERT OR UPDATE OF phone, whatsapp ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_lead_phone_normalized();

CREATE INDEX IF NOT EXISTS leads_user_phone_normalized_idx
  ON public.leads (user_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Tenant ownership must hold for a lead's current stage and for the immutable
-- stage ledger, even when a privileged Edge Function writes with service role.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_lead_stage_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage_owner_id uuid;
BEGIN
  IF NEW.stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT user_id INTO v_stage_owner_id
  FROM public.pipeline_stages
  WHERE id = NEW.stage_id;

  IF NOT FOUND OR v_stage_owner_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'stage_id must belong to the lead user';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_validate_stage_assignment ON public.leads;
CREATE TRIGGER leads_validate_stage_assignment
  BEFORE INSERT OR UPDATE OF stage_id, user_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.validate_lead_stage_assignment();

CREATE OR REPLACE FUNCTION public.validate_lead_stage_event_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead_workspace_id uuid;
  lead_user_id uuid;
BEGIN
  SELECT workspace_id, user_id
    INTO lead_workspace_id, lead_user_id
  FROM public.leads
  WHERE id = NEW.lead_id;

  IF NOT FOUND OR lead_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lead_id must belong to the stage event user';
  END IF;

  IF NEW.workspace_id IS NULL THEN
    NEW.workspace_id := lead_workspace_id;
  ELSIF NEW.workspace_id IS DISTINCT FROM lead_workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lead_stage_event workspace_id must match the lead workspace';
  END IF;

  IF NEW.from_stage_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pipeline_stages
    WHERE id = NEW.from_stage_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'from_stage_id must belong to the stage event user';
  END IF;

  IF NEW.to_stage_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.pipeline_stages
    WHERE id = NEW.to_stage_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'to_stage_id must belong to the stage event user';
  END IF;

  RETURN NEW;
END;
$$;

-- A WhatsApp opt-out is a hard stop. Re-enrollment needs its own audited flow;
-- ordinary CRM editing cannot silently make the person marketable again.
CREATE OR REPLACE FUNCTION public.prevent_marketing_opt_out_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.marketing_opted_out_at IS NOT NULL
     AND (
       NEW.marketing_opted_out_at IS NULL
       OR NEW.marketing_consent_status IS DISTINCT FROM 'withdrawn'
       OR NEW.is_suppressed IS DISTINCT FROM true
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A marketing opt-out cannot be reversed outside an audited re-enrollment flow';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_prevent_marketing_opt_out_reversal ON public.leads;
CREATE TRIGGER leads_prevent_marketing_opt_out_reversal
  BEFORE UPDATE OF marketing_consent_status, marketing_opted_out_at, is_suppressed ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.prevent_marketing_opt_out_reversal();

-- -----------------------------------------------------------------------------
-- Delivery claims serialize per tenant. A claimed `sending` row is a short-lived
-- reservation, so simultaneous cron/browser workers cannot both pass the daily
-- cap or send-interval checks before either one writes a message.
-- -----------------------------------------------------------------------------

ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS sending_at timestamptz;

UPDATE public.send_queue
SET sending_at = created_at
WHERE status = 'sending' AND sending_at IS NULL;

CREATE INDEX IF NOT EXISTS send_queue_user_status_sending_at_idx
  ON public.send_queue (user_id, status, sending_at)
  WHERE status = 'sending';

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
  v_active_reservations integer := 0;
  v_last_sent_at timestamptz;
BEGIN
  IF p_queue_item_id IS NULL OR p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_request';
    RETURN;
  END IF;

  -- The transaction lock is only held while validating and claiming. The
  -- durable `sending` reservation carries the protection across the network
  -- call, without holding a database transaction open during Evolution I/O.
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

  SELECT * INTO v_lead
  FROM public.leads
  WHERE id = v_queue.lead_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    UPDATE public.send_queue
    SET status = 'failed', sending_at = NULL
    WHERE id = v_queue.id;
    RETURN QUERY SELECT false, 'lead_tenant_mismatch';
    RETURN;
  END IF;

  IF v_lead.is_suppressed
     OR v_lead.marketing_opted_out_at IS NOT NULL
     OR v_lead.marketing_consent_status NOT IN ('granted', 'not_required') THEN
    UPDATE public.send_queue
    SET status = 'failed', sending_at = NULL, attempts = COALESCE(attempts, 0) + 1
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

    SELECT COUNT(*) INTO v_active_reservations
    FROM public.send_queue
    WHERE user_id = p_user_id
      AND status = 'sending'
      AND sending_at >= v_now - interval '10 minutes';

    IF v_sent_count + v_active_reservations >= GREATEST(1, COALESCE(p_daily_cap, 40)) THEN
      RETURN QUERY SELECT false, 'daily_cap_reached';
      RETURN;
    END IF;

    IF GREATEST(0, COALESCE(p_interval_minutes, 0)) > 0 THEN
      SELECT MAX(created_at) INTO v_last_sent_at
      FROM public.messages
      WHERE user_id = p_user_id
        AND direction = 'outbound'
        AND status = 'sent';

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
  SET status = 'sending', sending_at = v_now
  WHERE id = v_queue.id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'queue_item_claim_lost';
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_marketing_queue_item(uuid, uuid, integer, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_marketing_queue_item(uuid, uuid, integer, integer, boolean)
  TO service_role;
