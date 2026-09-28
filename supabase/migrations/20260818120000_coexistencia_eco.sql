-- Coexistência: origem da mensagem e pausa por atendimento humano.
--
-- `origin` nulo = legado ou envio do CRM. Só o eco do WhatsApp Business App
-- grava 'business_app'. Sem backfill: dado histórico é congelado no momento do
-- fato e nulo já carrega a informação necessária.

alter table public.messages
  add column if not exists origin text;

alter table public.messages
  drop constraint if exists messages_origin_check;

alter table public.messages
  add constraint messages_origin_check
  check (origin is null or origin in ('crm', 'business_app'));

alter table public.leads
  add column if not exists human_takeover_until timestamptz;

create index if not exists leads_human_takeover_idx
  on public.leads (human_takeover_until)
  where human_takeover_until is not null;

-- Cinto sobre suspensório. O dedupe por wamid existe em código, mas é SELECT
-- seguido de INSERT: duas entregas simultâneas do mesmo eco passam pelas duas.
create unique index if not exists messages_user_wamid_uidx
  on public.messages (user_id, whatsapp_id)
  where whatsapp_id is not null;
