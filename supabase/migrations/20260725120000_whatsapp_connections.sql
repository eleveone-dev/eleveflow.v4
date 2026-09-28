-- Conexão oficial de WhatsApp (Meta Cloud API) por tenant. Não existe coluna
-- 'provider': a Evolution sai do produto e não há provedor alternativo.
-- A ausência de linha significa tenant sem WhatsApp configurado —
-- resolveProvider responde 409, nunca um fallback silencioso.
-- A migration é puramente aditiva: não toca nenhuma tabela existente.

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'disconnected', 'error')),
  meta_business_id text,
  waba_id text,
  phone_number_id text,
  display_phone_number text,
  display_name text,
  access_token_encrypted text,
  token_type text CHECK (token_type IN ('user', 'system_user')),
  token_expires_at timestamptz,
  coexistence_enabled boolean NOT NULL DEFAULT false,
  webhook_subscribed_at timestamptz,
  quality_rating text,
  messaging_limit_tier text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Uma conexão ativa por tenant.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_tenant_id_key
  ON public.whatsapp_connections (tenant_id);

-- O mesmo número nunca pode pertencer a dois tenants.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_phone_number_id_key
  ON public.whatsapp_connections (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- Escrita é exclusiva do service role: nenhuma policy de INSERT/UPDATE/DELETE.
REVOKE ALL ON public.whatsapp_connections FROM anon, authenticated;

-- Leitura da própria linha, exceto o token. GRANT por coluna mantém
-- access_token_encrypted fora do alcance do browser mesmo com a policy abaixo.
GRANT SELECT (
  id, tenant_id, status, meta_business_id, waba_id, phone_number_id,
  display_phone_number, display_name, token_type, token_expires_at,
  coexistence_enabled, webhook_subscribed_at, quality_rating,
  messaging_limit_tier, last_sync_at, created_at, updated_at
) ON public.whatsapp_connections TO authenticated;

DROP POLICY IF EXISTS "Tenants read their own whatsapp connection" ON public.whatsapp_connections;
CREATE POLICY "Tenants read their own whatsapp connection"
  ON public.whatsapp_connections
  FOR SELECT
  TO authenticated
  USING (tenant_id = auth.uid());

DROP TRIGGER IF EXISTS update_whatsapp_connections_updated_at ON public.whatsapp_connections;
CREATE TRIGGER update_whatsapp_connections_updated_at
  BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- O webhook da Meta atualiza status por wamid; sem este índice a busca é
-- sequencial em messages.
CREATE INDEX IF NOT EXISTS idx_messages_user_whatsapp_id
  ON public.messages (user_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL;

-- Configuração global da integração. Os demais valores (app id, secret,
-- verify token, config id) são gravados pelo dono no Bloco B.
INSERT INTO public.global_settings (key, value)
VALUES ('meta_graph_api_version', 'v25.0')
ON CONFLICT (key) DO NOTHING;
