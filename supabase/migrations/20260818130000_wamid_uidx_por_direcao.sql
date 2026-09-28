-- Alinha o índice único de wamid ao dedupe do código, que sempre filtrou por
-- direção. Sem `direction`, uma mensagem de entrada e uma de saída com o mesmo
-- wamid colidem — e a colisão estoura como exceção no RPC de finalização de
-- entrega, que só declara ON CONFLICT (queue_item_id).

create unique index if not exists messages_user_wamid_direction_uidx
  on public.messages (user_id, whatsapp_id, direction)
  where whatsapp_id is not null;

drop index if exists public.messages_user_wamid_uidx;
