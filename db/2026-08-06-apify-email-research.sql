-- Evidence-backed public research for email writing.
-- Apollo remains canonical for lead identity and contact fields. Apify writes
-- only research records and the compact personalization profile .

alter table public.leads
  add column if not exists research_status text not null default 'not_started',
  add column if not exists research_profile_version integer not null default 0,
  add column if not exists research_last_success_at timestamptz,
  add column if not exists research_last_error text,
  add column if not exists research_expires_at timestamptz;

alter table public.leads drop constraint if exists leads_research_status_check;
alter table public.leads add constraint leads_research_status_check check (
  research_status in ('not_started', 'queued', 'running', 'completed', 'partial', 'fallback', 'failed', 'timed_out')
);

alter table public.messages
  add column if not exists generation_meta jsonb not null default '{}'::jsonb;

create table if not exists public.research_source_cache (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_type text not null check (source_type in ('company_profile', 'company_posts', 'person_posts', 'website')),
  source_url text not null,
  version integer not null default 1 check (version > 0),
  status text not null default 'succeeded' check (status in ('succeeded', 'failed')),
  actor_refs jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  observed_at timestamptz,
  last_success_at timestamptz,
  expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_type, source_url)
);

create table if not exists public.lead_research_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'partial', 'fallback', 'failed', 'timed_out')),
  requested_sources text[] not null default '{}',
  input jsonb not null default '{}'::jsonb,
  actor_refs jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_profile jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  source_fields_used text[] not null default '{}',
  personalization_score smallint not null default 0 check (personalization_score between 0 and 3),
  error_message text,
  requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  timeout_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_research_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  run_id uuid references public.lead_research_runs(id) on delete set null,
  version integer not null check (version > 0),
  status text not null check (status in ('completed', 'partial', 'fallback', 'failed', 'timed_out')),
  profile jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  source_fields_used text[] not null default '{}',
  personalization_score smallint not null default 0 check (personalization_score between 0 and 3),
  observed_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lead_id, version)
);

create index if not exists research_source_cache_workspace_lookup_idx
on public.research_source_cache(workspace_id, source_type, source_url, expires_at);
create index if not exists lead_research_runs_lead_created_idx
on public.lead_research_runs(lead_id, created_at desc);
create index if not exists lead_research_runs_campaign_status_idx
on public.lead_research_runs(campaign_id, status, created_at desc);
create index if not exists lead_research_profiles_lead_created_idx
on public.lead_research_profiles(lead_id, created_at desc);
create index if not exists leads_research_status_idx
on public.leads(workspace_id, research_status, research_expires_at);

drop trigger if exists set_research_source_cache_updated_at on public.research_source_cache;
create trigger set_research_source_cache_updated_at
before update on public.research_source_cache
for each row execute function public.set_updated_at();

drop trigger if exists set_lead_research_runs_updated_at on public.lead_research_runs;
create trigger set_lead_research_runs_updated_at
before update on public.lead_research_runs
for each row execute function public.set_updated_at();

alter table public.research_source_cache enable row level security;
alter table public.lead_research_runs enable row level security;
alter table public.lead_research_profiles enable row level security;

drop policy if exists "Users view workspace research cache" on public.research_source_cache;
create policy "Users view workspace research cache"
on public.research_source_cache for select to authenticated
using (exists (
  select 1 from public.workspaces
  where workspaces.id = research_source_cache.workspace_id
    and workspaces.owner_id = auth.uid()
));

drop policy if exists "Users view workspace research runs" on public.lead_research_runs;
create policy "Users view workspace research runs"
on public.lead_research_runs for select to authenticated
using (exists (
  select 1 from public.workspaces
  where workspaces.id = lead_research_runs.workspace_id
    and workspaces.owner_id = auth.uid()
));

drop policy if exists "Users view workspace research profiles" on public.lead_research_profiles;
create policy "Users view workspace research profiles"
on public.lead_research_profiles for select to authenticated
using (exists (
  select 1 from public.workspaces
  where workspaces.id = lead_research_profiles.workspace_id
    and workspaces.owner_id = auth.uid()
));

revoke all on public.research_source_cache, public.lead_research_runs, public.lead_research_profiles from anon;
grant select on public.research_source_cache, public.lead_research_runs, public.lead_research_profiles to authenticated;
