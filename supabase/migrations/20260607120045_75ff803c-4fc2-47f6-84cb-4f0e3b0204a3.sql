create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade unique not null,
  name text not null,
  email text,
  whatsapp_status text default 'disconnected',
  whatsapp_session jsonb,
  created_at timestamptz default now()
);

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  color text default '#6366f1',
  position integer default 0,
  created_at timestamptz default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  phone text not null,
  email text,
  company text,
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  active_flow_id uuid,
  active_flow_step integer default 0,
  flow_waiting_reply boolean default false,
  tags text[],
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  description text,
  trigger_stage_id uuid references public.pipeline_stages(id) on delete set null,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.flow_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  flow_id uuid references public.flows(id) on delete cascade not null,
  type text not null,
  position integer default 0,
  config jsonb default '{}'::jsonb,
  next_block_id uuid,
  created_at timestamptz default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  lead_id uuid references public.leads(id) on delete cascade not null,
  flow_id uuid,
  block_id uuid,
  direction text not null,
  content text not null,
  status text default 'pending',
  whatsapp_id text,
  created_at timestamptz default now()
);

create table public.send_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  lead_id uuid references public.leads(id) on delete cascade not null,
  flow_id uuid references public.flows(id) on delete cascade,
  block_id uuid references public.flow_blocks(id) on delete cascade,
  scheduled_at timestamptz default now(),
  status text default 'pending',
  attempts integer default 0,
  created_at timestamptz default now()
);

create table public.objections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  lead_id uuid references public.leads(id) on delete cascade not null,
  content text not null,
  resolved boolean default false,
  created_at timestamptz default now()
);

create table public.logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  lead_id uuid,
  flow_id uuid,
  block_id uuid,
  event text not null,
  details jsonb,
  created_at timestamptz default now()
);

grant all on public.accounts to authenticated;
grant all on public.pipeline_stages to authenticated;
grant all on public.leads to authenticated;
grant all on public.flows to authenticated;
grant all on public.flow_blocks to authenticated;
grant all on public.messages to authenticated;
grant all on public.send_queue to authenticated;
grant all on public.objections to authenticated;
grant all on public.logs to authenticated;

alter table public.accounts enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.leads enable row level security;
alter table public.flows enable row level security;
alter table public.flow_blocks enable row level security;
alter table public.messages enable row level security;
alter table public.send_queue enable row level security;
alter table public.objections enable row level security;
alter table public.logs enable row level security;

create policy "accounts_own" on public.accounts for all using (user_id = auth.uid());
create policy "stages_own" on public.pipeline_stages for all using (user_id = auth.uid());
create policy "leads_own" on public.leads for all using (user_id = auth.uid());
create policy "flows_own" on public.flows for all using (user_id = auth.uid());
create policy "blocks_own" on public.flow_blocks for all using (user_id = auth.uid());
create policy "messages_own" on public.messages for all using (user_id = auth.uid());
create policy "queue_own" on public.send_queue for all using (user_id = auth.uid());
create policy "objections_own" on public.objections for all using (user_id = auth.uid());
create policy "logs_own" on public.logs for all using (user_id = auth.uid());