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

create index if not exists ai_jobs_workspace_idx on public.ai_jobs(workspace_id);
create index if not exists ai_jobs_workspace_type_idx on public.ai_jobs(workspace_id, job_type, created_at desc);
create index if not exists agent_config_versions_workspace_idx on public.agent_config_versions(workspace_id);
create index if not exists agent_config_versions_active_idx on public.agent_config_versions(workspace_id, is_active);

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
