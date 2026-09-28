-- A conexao deixa de ser sempre Meta. instance_name e a chave de resolucao do
-- inbound da Evolution: e por ela que o webhook descobre de quem e a mensagem.
ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta_cloud',
  ADD COLUMN IF NOT EXISTS instance_name text;

ALTER TABLE public.whatsapp_connections
  DROP CONSTRAINT IF EXISTS whatsapp_connections_provider_check;
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_check
  CHECK (provider IN ('meta_cloud', 'evolution'));

-- Duas contas nao podem apontar para a mesma instancia: e o defeito de
-- isolamento do outro repositorio, impedido aqui pelo banco e nao por codigo.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_instance_uidx
  ON public.whatsapp_connections (instance_name)
  WHERE instance_name IS NOT NULL;

-- Conexao Evolution precisa de instance_name; conexao Meta precisa de
-- phone_number_id. Uma so regra, checada pelo banco.
ALTER TABLE public.whatsapp_connections
  DROP CONSTRAINT IF EXISTS whatsapp_connections_provider_fields_check;
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_fields_check
  CHECK (
    (provider = 'evolution' AND instance_name IS NOT NULL)
    OR (provider = 'meta_cloud' AND phone_number_id IS NOT NULL)
  );

-- O GRANT SELECT por coluna criado em 20260725120000 nao cobre colunas novas.
-- Sem isto o cliente autenticado nao enxerga provider nem instance_name.
GRANT SELECT (provider, instance_name) ON public.whatsapp_connections TO authenticated;
