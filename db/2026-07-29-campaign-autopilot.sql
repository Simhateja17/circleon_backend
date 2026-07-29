-- Campaign autopilot: workspace controls, campaign discovery criteria, durable run
-- history, and one-campaign-per-lead ownership.

create table if not exists public.workspace_autopilot_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  enabled boolean not null default false,
  include_all_launched_campaigns boolean not null default false,
  campaign_ids uuid[] not null default '{}',
  timezone text not null default 'Asia/Singapore',
  daily_run_time time not null default '08:00',
  workspace_daily_send_cap integer not null default 250 check (workspace_daily_send_cap between 1 and 2000),
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaigns
  add column if not exists autopilot_enabled boolean not null default false,
  add column if not exists daily_lead_target integer not null default 20 check (daily_lead_target between 1 and 300),
  add column if not exists autopilot_filters jsonb not null default '{}'::jsonb,
  add column if not exists attention_required boolean not null default false,
  add column if not exists attention_reason text,
  add column if not exists autopilot_confirmed_at timestamptz;

alter table public.messages
  add column if not exists scheduled_at timestamptz,
  add column if not exists schedule_reason text;

create table if not exists public.autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  local_run_date date not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'partial', 'completed', 'failed', 'paused', 'skipped')),
  requested_leads integer not null default 0,
  discovered_leads integer not null default 0,
  assigned_leads integer not null default 0,
  generated_messages integer not null default 0,
  scheduled_messages integer not null default 0,
  skipped_duplicates integer not null default 0,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, campaign_id, local_run_date)
);

-- A lead belongs to one campaign at a time. Existing duplicate assignments must
-- be resolved before this migration is applied in a database that contains them.
create unique index if not exists campaign_leads_workspace_lead_unique
on public.campaign_leads(workspace_id, lead_id);

create index if not exists campaigns_workspace_autopilot_idx
on public.campaigns(workspace_id, status, autopilot_enabled)
where autopilot_enabled = true;
create index if not exists autopilot_runs_workspace_created_idx
on public.autopilot_runs(workspace_id, created_at desc);
create index if not exists messages_campaign_scheduled_idx
on public.messages(campaign_id, scheduled_at)
where scheduled_at is not null;

drop trigger if exists set_workspace_autopilot_settings_updated_at on public.workspace_autopilot_settings;
create trigger set_workspace_autopilot_settings_updated_at
before update on public.workspace_autopilot_settings
for each row execute function public.set_updated_at();

drop trigger if exists set_autopilot_runs_updated_at on public.autopilot_runs;
create trigger set_autopilot_runs_updated_at
before update on public.autopilot_runs
for each row execute function public.set_updated_at();

alter table public.workspace_autopilot_settings enable row level security;
alter table public.autopilot_runs enable row level security;

drop policy if exists "Users manage workspace autopilot settings" on public.workspace_autopilot_settings;
create policy "Users manage workspace autopilot settings"
on public.workspace_autopilot_settings for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = workspace_autopilot_settings.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = workspace_autopilot_settings.workspace_id and workspaces.owner_id = auth.uid()));

drop policy if exists "Users view workspace autopilot runs" on public.autopilot_runs;
create policy "Users view workspace autopilot runs"
on public.autopilot_runs for select to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = autopilot_runs.workspace_id and workspaces.owner_id = auth.uid()));

revoke all on public.workspace_autopilot_settings, public.autopilot_runs from anon;
grant select, insert, update, delete on public.workspace_autopilot_settings, public.autopilot_runs to authenticated;
