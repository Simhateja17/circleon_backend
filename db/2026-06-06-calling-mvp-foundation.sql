create table if not exists public.workspace_telephony (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  provider text not null default 'retell_twilio' check (provider in ('retell_twilio')),
  from_number text,
  retell_phone_number text,
  phone_number_status text not null default 'missing' check (phone_number_status in ('missing', 'attached', 'verified', 'error')),
  calling_enabled boolean not null default false,
  daily_call_cap integer not null default 25,
  timezone text not null default 'Asia/Singapore',
  business_hours_start time not null default '09:00',
  business_hours_end time not null default '18:00',
  active_days integer[] not null default array[1,2,3,4,5],
  last_error text,
  launch_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.voice_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  provider text not null default 'retell' check (provider in ('retell')),
  retell_llm_id text,
  retell_agent_id text,
  voice_id text,
  status text not null default 'draft' check (status in ('draft', 'provisioning', 'ready', 'error')),
  prompt_version integer not null default 1,
  prompt_snapshot text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  follow_up_id uuid references public.follow_ups(id) on delete set null,
  voice_agent_id uuid references public.voice_agents(id) on delete set null,
  provider text not null default 'retell' check (provider in ('retell')),
  retell_call_id text unique,
  from_number text,
  to_number text,
  status text not null default 'queued' check (status in ('queued', 'calling', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'canceled')),
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  transcript text,
  recording_url text,
  summary text,
  sentiment text,
  disconnection_reason text,
  success boolean,
  cost_cents integer,
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dnc_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  phone_e164 text not null,
  channel text not null default 'voice' check (channel in ('voice')),
  source text not null default 'manual' check (source in ('manual', 'pdpc_api')),
  status text not null default 'unknown' check (status in ('unknown', 'pending', 'clear', 'blocked', 'error')),
  checked_at timestamptz,
  valid_until timestamptz,
  error_message text,
  raw_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.leads
  add column if not exists phone_e164 text,
  add column if not exists voice_consent_status text not null default 'unknown' check (voice_consent_status in ('unknown', 'consented', 'not_consented')),
  add column if not exists dnc_status text not null default 'unknown' check (dnc_status in ('unknown', 'pending', 'clear', 'blocked', 'error')),
  add column if not exists dnc_checked_at timestamptz,
  add column if not exists callable_block_reason text;

alter table public.follow_ups
  drop constraint if exists follow_ups_status_check;

alter table public.follow_ups
  add constraint follow_ups_status_check
  check (status in ('suggested', 'scheduled', 'calling', 'completed', 'dismissed', 'missed'));

alter table public.follow_ups
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists blocked_reason text;

create index if not exists workspace_telephony_workspace_idx on public.workspace_telephony(workspace_id);
create index if not exists voice_agents_workspace_idx on public.voice_agents(workspace_id);
create index if not exists calls_workspace_status_idx on public.calls(workspace_id, status, created_at desc);
create index if not exists calls_follow_up_idx on public.calls(follow_up_id);
create index if not exists dnc_checks_workspace_phone_idx on public.dnc_checks(workspace_id, phone_e164, created_at desc);
create index if not exists leads_workspace_callable_idx on public.leads(workspace_id, dnc_status, voice_consent_status);
create index if not exists follow_ups_workspace_due_agent_idx on public.follow_ups(workspace_id, owner_type, status, due_at);

drop trigger if exists set_workspace_telephony_updated_at on public.workspace_telephony;
create trigger set_workspace_telephony_updated_at
before update on public.workspace_telephony
for each row execute function public.set_updated_at();

drop trigger if exists set_voice_agents_updated_at on public.voice_agents;
create trigger set_voice_agents_updated_at
before update on public.voice_agents
for each row execute function public.set_updated_at();

drop trigger if exists set_calls_updated_at on public.calls;
create trigger set_calls_updated_at
before update on public.calls
for each row execute function public.set_updated_at();

drop trigger if exists set_dnc_checks_updated_at on public.dnc_checks;
create trigger set_dnc_checks_updated_at
before update on public.dnc_checks
for each row execute function public.set_updated_at();

alter table public.workspace_telephony enable row level security;
alter table public.voice_agents enable row level security;
alter table public.calls enable row level security;
alter table public.dnc_checks enable row level security;

drop policy if exists "Users manage telephony for their workspace" on public.workspace_telephony;
create policy "Users manage telephony for their workspace"
on public.workspace_telephony
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = workspace_telephony.workspace_id
    and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = workspace_telephony.workspace_id
    and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage voice agents for their workspace" on public.voice_agents;
create policy "Users manage voice agents for their workspace"
on public.voice_agents
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = voice_agents.workspace_id
    and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = voice_agents.workspace_id
    and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage calls for their workspace" on public.calls;
create policy "Users manage calls for their workspace"
on public.calls
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = calls.workspace_id
    and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = calls.workspace_id
    and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage dnc checks for their workspace" on public.dnc_checks;
create policy "Users manage dnc checks for their workspace"
on public.dnc_checks
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = dnc_checks.workspace_id
    and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = dnc_checks.workspace_id
    and workspaces.owner_id = auth.uid()
  )
);

revoke all on table public.workspace_telephony from anon;
revoke all on table public.voice_agents from anon;
revoke all on table public.calls from anon;
revoke all on table public.dnc_checks from anon;

grant select, insert, update, delete on table public.workspace_telephony to authenticated;
grant select, insert, update, delete on table public.voice_agents to authenticated;
grant select, insert, update, delete on table public.calls to authenticated;
grant select, insert, update, delete on table public.dnc_checks to authenticated;
