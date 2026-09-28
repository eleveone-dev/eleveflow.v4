-- Views de observabilidade (spec §5.2/§5.3). security_invoker: RLS de
-- api_calls / send_queue / flow_executions / leads aplica ao usuário logado.

create or replace view public.api_costs_daily with (security_invoker = on) as
select
  user_id,
  ((created_at at time zone 'America/Sao_Paulo')::date) as day,
  provider,
  feature,
  count(*)::bigint as calls,
  (count(*) filter (where status = 'error'))::bigint as errors,
  coalesce(sum(cost_usd_micros), 0)::bigint as cost_usd_micros,
  coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
  coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
from public.api_calls
where created_at >= now() - interval '35 days'
group by user_id, day, provider, feature;

create or replace view public.api_stats with (security_invoker = on) as
select
  user_id,
  coalesce(sum(cost_usd_micros) filter (
    where created_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
  ), 0)::bigint as cost_today_usd_micros,
  coalesce(sum(cost_usd_micros) filter (where created_at >= now() - interval '7 days'), 0)::bigint as cost_7d_usd_micros,
  coalesce(sum(cost_usd_micros) filter (where created_at >= now() - interval '30 days'), 0)::bigint as cost_30d_usd_micros,
  (count(*) filter (where created_at >= now() - interval '7 days'))::bigint as calls_7d,
  (count(*) filter (where status = 'error' and created_at >= now() - interval '7 days'))::bigint as errors_7d,
  percentile_cont(0.5) within group (order by latency_ms)
    filter (where created_at >= now() - interval '7 days') as latency_p50_ms,
  percentile_cont(0.95) within group (order by latency_ms)
    filter (where created_at >= now() - interval '7 days') as latency_p95_ms
from public.api_calls
group by user_id;

create or replace view public.whatsapp_health with (security_invoker = on) as
select
  user_id,
  (count(*) filter (where status = 'sent' and created_at >= now() - interval '7 days'))::bigint as sent_7d,
  (count(*) filter (where status = 'failed' and created_at >= now() - interval '7 days'))::bigint as failed_7d,
  (count(*) filter (where status = 'pending'))::bigint as pending_now,
  avg(extract(epoch from (sent_at - created_at))) filter (
    where sent_at is not null and created_at >= now() - interval '7 days'
  ) as avg_queue_delay_s
from public.send_queue
group by user_id;

create or replace view public.agent_sessions with (security_invoker = on) as
select
  fe.id as execution_id,
  fe.user_id,
  fe.lead_id,
  l.name as lead_name,
  l.phone as lead_phone,
  fe.flow_id,
  fe.context->'agent'->>'status' as agent_status,
  coalesce((fe.context->'agent'->>'turns')::int, 0) as turns,
  fe.context->'agent'->>'block_id' as block_id,
  fe.context->'agent'->>'started_at' as started_at,
  coalesce((
    select sum(ac.cost_usd_micros) from public.api_calls ac
    where ac.execution_id = fe.id
  ), 0)::bigint as cost_usd_micros,
  fe.created_at
from public.flow_executions fe
join public.leads l on l.id = fe.lead_id
where fe.context ? 'agent';
