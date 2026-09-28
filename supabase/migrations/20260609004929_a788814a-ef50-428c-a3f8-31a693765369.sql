GRANT ALL ON public.global_settings TO service_role;
REVOKE ALL ON public.global_settings FROM anon, authenticated;
CREATE POLICY "Deny all client access to global_settings" ON public.global_settings FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);