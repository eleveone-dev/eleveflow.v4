-- 1. Create global settings table for server-side secrets
CREATE TABLE IF NOT EXISTS public.global_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Deny all access to authenticated/anon for global_settings
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.global_settings TO service_role;

-- 2. Insert a default webhook secret if it doesn't exist (user should change this via Edge Function env if needed, but here we provide a way to store it)
-- Note: In a real scenario, this would be set during the integration setup.
INSERT INTO public.global_settings (key, value) 
VALUES ('whatsapp_webhook_secret', 'eleveflow_secret_placeholder_123')
ON CONFLICT (key) DO NOTHING;

-- No direct table changes needed for IDOR, will be fixed in function logic.
