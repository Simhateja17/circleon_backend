alter table public.leads
  add column if not exists external_id text;

create index if not exists leads_workspace_external_id_idx
on public.leads(workspace_id, external_id)
where external_id is not null;

create table if not exists public.apollo_enrichment_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  import_run_id uuid references public.lead_import_runs(id) on delete set null,
  lead_id uuid references public.leads(id) on delete cascade,
  apollo_person_id text not null,
  apollo_request_id text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  raw_request jsonb not null default '{}'::jsonb,
  raw_response jsonb not null default '{}'::jsonb,
  error_message text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, apollo_person_id)
);

create index if not exists apollo_enrichment_requests_import_run_idx
on public.apollo_enrichment_requests(import_run_id);

create index if not exists apollo_enrichment_requests_request_idx
on public.apollo_enrichment_requests(apollo_request_id)
where apollo_request_id is not null;

drop trigger if exists set_apollo_enrichment_requests_updated_at on public.apollo_enrichment_requests;
create trigger set_apollo_enrichment_requests_updated_at
before update on public.apollo_enrichment_requests
for each row execute function public.set_updated_at();

alter table public.apollo_enrichment_requests enable row level security;

drop policy if exists "Users manage Apollo enrichment requests for their workspace" on public.apollo_enrichment_requests;
create policy "Users manage Apollo enrichment requests for their workspace"
on public.apollo_enrichment_requests
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = apollo_enrichment_requests.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = apollo_enrichment_requests.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

revoke all on table public.apollo_enrichment_requests from anon;
grant select, insert, update, delete on table public.apollo_enrichment_requests to authenticated;
