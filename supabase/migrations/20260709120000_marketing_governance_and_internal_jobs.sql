-- Marketing governance, attribution, and safe internal Edge Function dispatch.
--
-- `user_id` remains the current access boundary. `workspace_id` is deliberately
-- nullable so existing single-user data continues to work while the application
-- can introduce collaborative workspaces in a later, explicit migration.

-- -----------------------------------------------------------------------------
-- Workspace foundation (not yet a cross-user lead access boundary)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_settings_is_object CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_role_check CHECK (role IN ('admin', 'member', 'viewer'))
);

CREATE INDEX IF NOT EXISTS workspaces_owner_id_idx ON public.workspaces (owner_id);
CREATE INDEX IF NOT EXISTS workspace_members_user_id_idx ON public.workspace_members (user_id);

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    WHERE workspace.id = p_workspace_id
      AND workspace.owner_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1
    FROM public.workspace_members AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    WHERE workspace.id = p_workspace_id
      AND workspace.owner_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1
    FROM public.workspace_members AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = auth.uid()
      AND membership.role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_workspace_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_workspace_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(uuid) TO authenticated, service_role;

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.workspaces FROM anon;
REVOKE ALL ON public.workspace_members FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspaces TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_members TO authenticated;
GRANT ALL ON public.workspaces TO service_role;
GRANT ALL ON public.workspace_members TO service_role;

CREATE POLICY "workspaces_select_member_or_owner"
  ON public.workspaces FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_workspace_member(id));

CREATE POLICY "workspaces_insert_owner"
  ON public.workspaces FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "workspaces_update_owner"
  ON public.workspaces FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "workspaces_delete_owner"
  ON public.workspaces FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY "workspace_members_select_self_or_admin"
  ON public.workspace_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_workspace_admin(workspace_id));

CREATE POLICY "workspace_members_insert_admin"
  ON public.workspace_members FOR INSERT TO authenticated
  WITH CHECK (public.is_workspace_admin(workspace_id));

CREATE POLICY "workspace_members_update_admin"
  ON public.workspace_members FOR UPDATE TO authenticated
  USING (public.is_workspace_admin(workspace_id))
  WITH CHECK (public.is_workspace_admin(workspace_id));

CREATE POLICY "workspace_members_delete_admin"
  ON public.workspace_members FOR DELETE TO authenticated
  USING (public.is_workspace_admin(workspace_id));

DROP TRIGGER IF EXISTS workspaces_set_updated_at ON public.workspaces;
CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- Lead governance and attribution. Existing leads receive safe defaults only.
-- -----------------------------------------------------------------------------

ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS funnel_key text;

ALTER TABLE public.pipeline_stages
  ADD CONSTRAINT pipeline_stages_funnel_key_check
  CHECK (
    funnel_key IS NULL
    OR funnel_key IN ('prospecting', 'interested', 'demo', 'proposal', 'won', 'lost')
  );

CREATE INDEX IF NOT EXISTS pipeline_stages_user_funnel_key_idx
  ON public.pipeline_stages (user_id, funnel_key)
  WHERE funnel_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL DEFAULT 'draft',
  channel text,
  objective text,
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_status_check CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  CONSTRAINT campaigns_dates_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT campaigns_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS marketing_consent_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_consent_source text,
  ADD COLUMN IF NOT EXISTS marketing_consent_proof jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS marketing_opted_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_opt_out_reason text,
  ADD COLUMN IF NOT EXISTS is_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS suppression_reason text,
  ADD COLUMN IF NOT EXISTS attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS first_touch_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_touch_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_touch_source text,
  ADD COLUMN IF NOT EXISTS last_touch_source text,
  ADD COLUMN IF NOT EXISTS first_campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_marketing_consent_status_check
  CHECK (marketing_consent_status IN ('unknown', 'granted', 'denied', 'withdrawn', 'not_required')),
  ADD CONSTRAINT leads_marketing_consent_proof_is_object_check
  CHECK (jsonb_typeof(marketing_consent_proof) = 'object'),
  ADD CONSTRAINT leads_attribution_is_object_check
  CHECK (jsonb_typeof(attribution) = 'object');

COMMENT ON COLUMN public.leads.marketing_consent_status IS
  'Governance status. Unknown must be treated as not approved for consent-based marketing.';
COMMENT ON COLUMN public.leads.is_suppressed IS
  'Do-not-contact flag. Suppressed or opted-out leads must not enter marketing sends.';
COMMENT ON COLUMN public.leads.attribution IS
  'Extensible first/last-touch and external attribution metadata; use explicit fields for common dashboard filters.';
COMMENT ON COLUMN public.pipeline_stages.funnel_key IS
  'Optional stable dashboard key; UI may temporarily fall back to a stage name when null.';

CREATE INDEX IF NOT EXISTS leads_workspace_id_idx
  ON public.leads (workspace_id)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_user_contact_governance_idx
  ON public.leads (user_id, is_suppressed, marketing_consent_status, marketing_opted_out_at);
CREATE INDEX IF NOT EXISTS leads_first_campaign_id_idx
  ON public.leads (first_campaign_id)
  WHERE first_campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_last_campaign_id_idx
  ON public.leads (last_campaign_id)
  WHERE last_campaign_id IS NOT NULL;

-- Ensure a user can only attach their own current/future records to a workspace
-- they own or belong to. This does not broaden read/write access across users.
CREATE OR REPLACE FUNCTION public.validate_workspace_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    WHERE workspace.id = NEW.workspace_id
      AND workspace.owner_id = NEW.user_id
    UNION ALL
    SELECT 1
    FROM public.workspace_members AS membership
    WHERE membership.workspace_id = NEW.workspace_id
      AND membership.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'workspace_id must belong to the record user';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_lead_marketing_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.first_campaign_id IS NOT NULL THEN
    PERFORM 1
    FROM public.campaigns
    WHERE id = NEW.first_campaign_id
      AND user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'first_campaign_id must belong to the lead user';
    END IF;
  END IF;

  IF NEW.last_campaign_id IS NOT NULL THEN
    PERFORM 1
    FROM public.campaigns
    WHERE id = NEW.last_campaign_id
      AND user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'last_campaign_id must belong to the lead user';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_validate_workspace_assignment ON public.leads;
CREATE TRIGGER leads_validate_workspace_assignment
  BEFORE INSERT OR UPDATE OF workspace_id, user_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_assignment();

DROP TRIGGER IF EXISTS campaigns_validate_workspace_assignment ON public.campaigns;
CREATE TRIGGER campaigns_validate_workspace_assignment
  BEFORE INSERT OR UPDATE OF workspace_id, user_id ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_assignment();

DROP TRIGGER IF EXISTS leads_validate_marketing_references ON public.leads;
CREATE TRIGGER leads_validate_marketing_references
  BEFORE INSERT OR UPDATE OF user_id, workspace_id, first_campaign_id, last_campaign_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.validate_lead_marketing_references();

DROP TRIGGER IF EXISTS leads_set_updated_at ON public.leads;
CREATE TRIGGER leads_set_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- Immutable marketing ledger: campaigns, touchpoints, and stage transitions.
-- The application role gets append-only permissions; deliberate administrative
-- maintenance remains possible so foreign-key retention actions keep working.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (btrim(channel) <> ''),
  touch_type text NOT NULL CHECK (btrim(touch_type) <> ''),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  external_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT touchpoints_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS public.lead_stage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  from_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_stage_events_event_type_check CHECK (event_type IN ('lead_created', 'stage_changed')),
  CONSTRAINT lead_stage_events_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS campaigns_user_created_at_idx
  ON public.campaigns (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_workspace_created_at_idx
  ON public.campaigns (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS touchpoints_user_lead_occurred_at_idx
  ON public.touchpoints (user_id, lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS touchpoints_campaign_occurred_at_idx
  ON public.touchpoints (campaign_id, occurred_at DESC)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS touchpoints_workspace_occurred_at_idx
  ON public.touchpoints (workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS touchpoints_user_channel_external_id_uidx
  ON public.touchpoints (user_id, channel, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_stage_events_user_lead_occurred_at_idx
  ON public.lead_stage_events (user_id, lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lead_stage_events_user_to_stage_occurred_at_idx
  ON public.lead_stage_events (user_id, to_stage_id, occurred_at DESC)
  WHERE to_stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_stage_events_workspace_occurred_at_idx
  ON public.lead_stage_events (workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_touchpoint_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead_workspace_id uuid;
  lead_user_id uuid;
  campaign_workspace_id uuid;
BEGIN
  SELECT workspace_id, user_id
    INTO lead_workspace_id, lead_user_id
  FROM public.leads
  WHERE id = NEW.lead_id;

  IF NOT FOUND OR lead_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'lead_id must belong to the touchpoint user';
  END IF;

  IF NEW.workspace_id IS NULL THEN
    NEW.workspace_id := lead_workspace_id;
  ELSIF NEW.workspace_id IS DISTINCT FROM lead_workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'touchpoint workspace_id must match the lead workspace';
  END IF;

  IF NEW.campaign_id IS NOT NULL THEN
    SELECT workspace_id INTO campaign_workspace_id
    FROM public.campaigns
    WHERE id = NEW.campaign_id
      AND user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'campaign_id must belong to the touchpoint user';
    END IF;

    IF campaign_workspace_id IS NOT NULL
       AND campaign_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'campaign_id must use the touchpoint workspace';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touchpoints_validate_references ON public.touchpoints;
CREATE TRIGGER touchpoints_validate_references
  BEFORE INSERT ON public.touchpoints
  FOR EACH ROW EXECUTE FUNCTION public.validate_touchpoint_references();

DROP TRIGGER IF EXISTS lead_stage_events_validate_references ON public.lead_stage_events;
CREATE TRIGGER lead_stage_events_validate_references
  BEFORE INSERT ON public.lead_stage_events
  FOR EACH ROW EXECUTE FUNCTION public.validate_lead_stage_event_references();

CREATE OR REPLACE FUNCTION public.record_lead_stage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.lead_stage_events (
      user_id,
      workspace_id,
      lead_id,
      from_stage_id,
      to_stage_id,
      event_type,
      changed_by,
      occurred_at
    ) VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.id,
      NULL,
      NEW.stage_id,
      'lead_created',
      auth.uid(),
      COALESCE(NEW.created_at, now())
    );
  ELSIF OLD.stage_id IS DISTINCT FROM NEW.stage_id
    AND NEW.stage_id IS NOT NULL THEN
    INSERT INTO public.lead_stage_events (
      user_id,
      workspace_id,
      lead_id,
      from_stage_id,
      to_stage_id,
      event_type,
      changed_by
    ) VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.id,
      OLD.stage_id,
      NEW.stage_id,
      'stage_changed',
      auth.uid()
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_record_stage_event ON public.leads;
CREATE TRIGGER leads_record_stage_event
  AFTER INSERT OR UPDATE OF stage_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.record_lead_stage_event();

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.touchpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_stage_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.campaigns FROM anon;
REVOKE ALL ON public.touchpoints FROM anon;
REVOKE ALL ON public.lead_stage_events FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.campaigns FROM authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.touchpoints FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.lead_stage_events FROM authenticated;
GRANT SELECT, INSERT ON public.campaigns TO authenticated;
GRANT SELECT, INSERT ON public.touchpoints TO authenticated;
GRANT SELECT ON public.lead_stage_events TO authenticated;
GRANT ALL ON public.campaigns TO service_role;
GRANT ALL ON public.touchpoints TO service_role;
GRANT ALL ON public.lead_stage_events TO service_role;

CREATE POLICY "campaigns_select_own"
  ON public.campaigns FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "campaigns_insert_own"
  ON public.campaigns FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "touchpoints_select_own"
  ON public.touchpoints FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "touchpoints_insert_own"
  ON public.touchpoints FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "lead_stage_events_select_own"
  ON public.lead_stage_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Internal Edge Function dispatch. Runtime configuration is injected by an
-- operator; this migration never creates a URL or secret. Missing configuration
-- is a no-op so cron and stage changes cannot call an unintended endpoint.
-- -----------------------------------------------------------------------------

-- Previous migrations seeded a production URL and an anon key into this table.
-- Clear those legacy values before scheduling the protected jobs: every
-- environment must now receive its own reviewed URL and internal secret.
DELETE FROM public.global_settings
WHERE key IN ('edge_functions_base_url', 'edge_functions_anon_key');

DELETE FROM public.global_settings
WHERE key = 'whatsapp_webhook_secret'
  AND value = 'eleveflow_secret_placeholder_123';

CREATE OR REPLACE FUNCTION public.auto_trigger_flow_on_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_flow_exists boolean;
  v_base_url text;
  v_internal_secret text;
BEGIN
  IF NEW.stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.flows
    WHERE user_id = NEW.user_id
      AND trigger_stage_id = NEW.stage_id
      AND is_active = true
  ) INTO v_flow_exists;

  IF NOT v_flow_exists THEN
    RETURN NEW;
  END IF;

  SELECT nullif(btrim(value), '')
    INTO v_base_url
  FROM public.global_settings
  WHERE key = 'edge_functions_base_url';

  SELECT nullif(btrim(value), '')
    INTO v_internal_secret
  FROM public.global_settings
  WHERE key = 'edge_functions_internal_secret';

  IF v_base_url IS NULL OR v_internal_secret IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/trigger-flow-by-stage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-function-secret', v_internal_secret
    ),
    body := jsonb_build_object(
      'lead_id', NEW.id,
      'user_id', NEW.user_id,
      'new_stage_id', NEW.stage_id
    )
  );

  RETURN NEW;
END;
$function$;

-- Older production databases may already have this function attached through an
-- unversioned trigger. A fresh database needs the trigger, while an existing
-- attachment must not be duplicated and enqueue the same flow twice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.leads'::regclass
      AND tgfoid = 'public.auto_trigger_flow_on_stage()'::regprocedure
      AND NOT tgisinternal
  ) THEN
    EXECUTE $trigger$
      CREATE TRIGGER leads_auto_trigger_flow_on_stage
      AFTER INSERT OR UPDATE OF stage_id ON public.leads
      FOR EACH ROW EXECUTE FUNCTION public.auto_trigger_flow_on_stage()
    $trigger$;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-flows-cron') THEN
    PERFORM cron.unschedule('process-flows-cron');
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-queue-cron') THEN
    PERFORM cron.unschedule('process-queue-cron');
  END IF;
END;
$$;

SELECT cron.schedule(
  'process-flows-cron',
  '* * * * *',
  $cron$
    DO $job$
    DECLARE
      v_base_url text;
      v_internal_secret text;
    BEGIN
      SELECT nullif(btrim(value), '')
        INTO v_base_url
      FROM public.global_settings
      WHERE key = 'edge_functions_base_url';

      SELECT nullif(btrim(value), '')
        INTO v_internal_secret
      FROM public.global_settings
      WHERE key = 'edge_functions_internal_secret';

      IF v_base_url IS NULL OR v_internal_secret IS NULL THEN
        RETURN;
      END IF;

      PERFORM net.http_post(
        url := rtrim(v_base_url, '/') || '/functions/v1/process-flows',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-internal-function-secret', v_internal_secret
        ),
        body := '{}'::jsonb
      );
    END;
    $job$;
  $cron$
);

SELECT cron.schedule(
  'process-queue-cron',
  '* * * * *',
  $cron$
    DO $job$
    DECLARE
      v_base_url text;
      v_internal_secret text;
    BEGIN
      SELECT nullif(btrim(value), '')
        INTO v_base_url
      FROM public.global_settings
      WHERE key = 'edge_functions_base_url';

      SELECT nullif(btrim(value), '')
        INTO v_internal_secret
      FROM public.global_settings
      WHERE key = 'edge_functions_internal_secret';

      IF v_base_url IS NULL OR v_internal_secret IS NULL THEN
        RETURN;
      END IF;

      PERFORM net.http_post(
        url := rtrim(v_base_url, '/') || '/functions/v1/process-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-internal-function-secret', v_internal_secret
        ),
        body := '{}'::jsonb
      );
    END;
    $job$;
  $cron$
);
