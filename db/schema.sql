-- CircleOnproduct MVP schema.
-- Apply this in Supabase SQL editor before using the authenticated workspace APIs.

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Workspace',
  plan text check (plan in ('atelier', 'maison', 'sovereign')),
  onboarding_step integer not null default 0,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id)
);

create table if not exists public.agent_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_name text not null default 'Aria',
  company_name text not null,
  industry text,
  city text,
  business_model text,
  target_titles text[] not null default '{}',
  target_regions text,
  company_size text,
  min_mrr_k_sgd integer not null default 0,
  product text,
  pricing_model text,
  value_proposition text,
  objections text,
  monthly_capacity integer not null default 20,
  booking_link text,
  tone text,
  raw_answers jsonb not null default '{}'::jsonb,
  system_prompt text not null,
  status text not null default 'draft' check (status in ('draft', 'ready', 'launched', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_workspaces_updated_at on public.workspaces;
create trigger set_workspaces_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

drop trigger if exists set_agent_configs_updated_at on public.agent_configs;
create trigger set_agent_configs_updated_at
before update on public.agent_configs
for each row execute function public.set_updated_at();

alter table public.workspaces enable row level security;
alter table public.agent_configs enable row level security;

drop policy if exists "Users manage their own workspace" on public.workspaces;
create policy "Users manage their own workspace"
on public.workspaces
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Users manage agent configs for their workspace" on public.agent_configs;
create policy "Users manage agent configs for their workspace"
on public.agent_configs
for all
to authenticated
using (
  exists (
    select 1
    from public.workspaces
    where workspaces.id = agent_configs.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.workspaces
    where workspaces.id = agent_configs.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.agent_configs to authenticated;

create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  job_type text not null default 'agent_launch' check (job_type in ('agent_launch')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  current_step text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_config_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_config_id uuid not null references public.agent_configs(id) on delete cascade,
  ai_job_id uuid references public.ai_jobs(id) on delete set null,
  version_number integer not null,
  playbook jsonb not null default '{}'::jsonb,
  retell_system_prompt text not null,
  gemini_model text not null,
  retell_llm_id text,
  retell_agent_id text,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, version_number)
);

drop trigger if exists set_ai_jobs_updated_at on public.ai_jobs;
create trigger set_ai_jobs_updated_at
before update on public.ai_jobs
for each row execute function public.set_updated_at();

drop trigger if exists set_agent_config_versions_updated_at on public.agent_config_versions;
create trigger set_agent_config_versions_updated_at
before update on public.agent_config_versions
for each row execute function public.set_updated_at();

alter table public.ai_jobs enable row level security;
alter table public.agent_config_versions enable row level security;

drop policy if exists "Users manage ai jobs for their workspace" on public.ai_jobs;
create policy "Users manage ai jobs for their workspace"
on public.ai_jobs
for all
to authenticated
using (
  exists (
    select 1
    from public.workspaces
    where workspaces.id = ai_jobs.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.workspaces
    where workspaces.id = ai_jobs.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage agent config versions for their workspace" on public.agent_config_versions;
create policy "Users manage agent config versions for their workspace"
on public.agent_config_versions
for all
to authenticated
using (
  exists (
    select 1
    from public.workspaces
    where workspaces.id = agent_config_versions.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.workspaces
    where workspaces.id = agent_config_versions.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

grant select, insert, update, delete on public.ai_jobs to authenticated;
grant select, insert, update, delete on public.agent_config_versions to authenticated;
