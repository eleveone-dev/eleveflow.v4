-- Prova de tráfego real pela Meta Cloud API.
--
-- Antes, "envio testado" e "recebimento testado" eram derivados da existência
-- de qualquer mensagem do tenant em `messages`. Isso marcava como concluído
-- registros que não provam nada: mocks da Evolution (`whatsapp_id` começando
-- com `mock-`) e fixtures de E2E, muitos anteriores a qualquer conexão Meta.
--
-- Agora a prova é gravada por evento, aqui, e só por quem passou pela
-- verificação de assinatura do webhook da Meta.

ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS last_meta_outbound_wamid text,
  ADD COLUMN IF NOT EXISTS last_meta_outbound_status text
    CHECK (last_meta_outbound_status IN ('sent', 'delivered', 'read')),
  ADD COLUMN IF NOT EXISTS last_meta_outbound_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_meta_inbound_wamid text,
  ADD COLUMN IF NOT EXISTS last_meta_inbound_test_at timestamptz;

-- Leitura pelo tenant: são identificadores públicos e datas, nada sensível.
GRANT SELECT (
  last_meta_outbound_wamid, last_meta_outbound_status, last_meta_outbound_test_at,
  last_meta_inbound_wamid, last_meta_inbound_test_at
) ON public.whatsapp_connections TO authenticated;

-- Trocar o número, desconectar ou zerar as credenciais invalida qualquer prova
-- anterior: ela pertencia a outra conexão. Fica no banco, e não só na aplicação,
-- para valer também para escrita direta por script ou painel.
CREATE OR REPLACE FUNCTION public.reset_meta_connection_proof()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id
     OR NEW.access_token_encrypted IS DISTINCT FROM OLD.access_token_encrypted
     OR NEW.status <> 'connected'
  THEN
    NEW.last_meta_outbound_wamid := NULL;
    NEW.last_meta_outbound_status := NULL;
    NEW.last_meta_outbound_test_at := NULL;
    NEW.last_meta_inbound_wamid := NULL;
    NEW.last_meta_inbound_test_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reset_meta_connection_proof ON public.whatsapp_connections;
CREATE TRIGGER reset_meta_connection_proof
  BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.reset_meta_connection_proof();
