
-- Restrictive deny-all policy for authenticated/anon (silences linter, defense in depth)
CREATE POLICY "Deny all client access" ON public.account_secrets
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- Auto-create account_secrets row on account creation
CREATE OR REPLACE FUNCTION public.create_account_secrets_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_secrets (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_create_secrets ON public.accounts;
CREATE TRIGGER accounts_create_secrets
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.create_account_secrets_row();
