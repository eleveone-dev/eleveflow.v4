ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
GRANT ALL ON public.accounts TO service_role;
GRANT SELECT, UPDATE ON public.accounts TO authenticated;
