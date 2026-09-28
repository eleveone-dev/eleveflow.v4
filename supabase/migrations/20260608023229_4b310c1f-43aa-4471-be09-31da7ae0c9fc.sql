ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS has_whatsapp BOOLEAN DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS phone_valid BOOLEAN DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS website TEXT;

COMMENT ON COLUMN public.leads.whatsapp IS 'Número formatado para WhatsApp (com DDI)';
COMMENT ON COLUMN public.leads.has_whatsapp IS 'Indica se o lead possui um WhatsApp provável';
COMMENT ON COLUMN public.leads.phone_valid IS 'Indica se o telefone segue o formato brasileiro válido';