-- Apollo candidates without a verified work email are audit-only outcomes,
-- never durable Barsha leads.

create table if not exists public.apollo_enrichment_audits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  import_run_id uuid references public.lead_import_runs(id) on delete set null,
  apollo_person_id text,
  apollo_request_id text,
  outcome text not null check (outcome in ('not_admitted_no_verified_work_email', 'not_admitted_target_reached')),
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists apollo_enrichment_audits_run_idx
on public.apollo_enrichment_audits(import_run_id, created_at desc);

alter table public.apollo_enrichment_audits enable row level security;

drop policy if exists "Users manage Apollo enrichment audits for their workspace" on public.apollo_enrichment_audits;
create policy "Users manage Apollo enrichment audits for their workspace"
on public.apollo_enrichment_audits for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = apollo_enrichment_audits.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = apollo_enrichment_audits.workspace_id and workspaces.owner_id = auth.uid()));

revoke all on public.apollo_enrichment_audits from anon;
grant select, insert, update, delete on public.apollo_enrichment_audits to authenticated;
