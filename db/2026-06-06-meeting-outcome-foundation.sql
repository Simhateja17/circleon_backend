create table if not exists public.call_outcomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  call_id uuid references public.calls(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  follow_up_id uuid references public.follow_ups(id) on delete set null,
  outcome_type text not null check (outcome_type in (
    'booked',
    'booking_link_sent',
    'interested',
    'follow_up_needed',
    'no_answer',
    'not_interested',
    'do_not_call',
    'unknown'
  )),
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  summary text,
  next_action text,
  meeting_requested boolean not null default false,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_id)
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  call_id uuid references public.calls(id) on delete set null,
  call_outcome_id uuid references public.call_outcomes(id) on delete set null,
  provider text not null default 'manual' check (provider in ('manual', 'calendly', 'google_calendar', 'outlook')),
  external_id text,
  status text not null default 'requested' check (status in ('requested', 'scheduled', 'completed', 'canceled', 'no_show')),
  title text not null default 'Discovery call',
  invitee_name text,
  invitee_email text,
  invitee_phone text,
  booking_url text,
  meeting_url text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text not null default 'Asia/Singapore',
  notes text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calls
  add column if not exists outcome_type text check (outcome_type in (
    'booked',
    'booking_link_sent',
    'interested',
    'follow_up_needed',
    'no_answer',
    'not_interested',
    'do_not_call',
    'unknown'
  )),
  add column if not exists outcome_confidence text check (outcome_confidence in ('low', 'medium', 'high')),
  add column if not exists outcome_summary text,
  add column if not exists next_action text,
  add column if not exists meeting_id uuid references public.meetings(id) on delete set null;

create index if not exists call_outcomes_workspace_type_idx
on public.call_outcomes(workspace_id, outcome_type, created_at desc);

create index if not exists call_outcomes_lead_idx
on public.call_outcomes(lead_id, created_at desc);

create index if not exists meetings_workspace_status_idx
on public.meetings(workspace_id, status, starts_at);

create index if not exists meetings_lead_idx
on public.meetings(lead_id, starts_at desc);

create unique index if not exists meetings_provider_external_uidx
on public.meetings(workspace_id, provider, external_id)
where external_id is not null;

drop trigger if exists set_call_outcomes_updated_at on public.call_outcomes;
create trigger set_call_outcomes_updated_at
before update on public.call_outcomes
for each row execute function public.set_updated_at();

drop trigger if exists set_meetings_updated_at on public.meetings;
create trigger set_meetings_updated_at
before update on public.meetings
for each row execute function public.set_updated_at();

alter table public.call_outcomes enable row level security;
alter table public.meetings enable row level security;

drop policy if exists "Users manage call outcomes for their workspace" on public.call_outcomes;
create policy "Users manage call outcomes for their workspace"
on public.call_outcomes
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = call_outcomes.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = call_outcomes.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage meetings for their workspace" on public.meetings;
create policy "Users manage meetings for their workspace"
on public.meetings
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = meetings.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = meetings.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

revoke all on table public.call_outcomes from anon;
revoke all on table public.meetings from anon;

grant select, insert, update, delete on table public.call_outcomes to authenticated;
grant select, insert, update, delete on table public.meetings to authenticated;
