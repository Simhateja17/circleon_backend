-- Credit-safe lead acquisition, provenance, suppression, campaign selection,
-- and independently verified SMTP/IMAP mailbox connections.

alter table public.connected_accounts
  add column if not exists smtp_verified_at timestamptz,
  add column if not exists imap_verified_at timestamptz;

alter table public.leads
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists linkedin_url text,
  add column if not exists company_domain text,
  add column if not exists company_industry text,
  add column if not exists company_size text,
  add column if not exists email_status text not null default 'unknown',
  add column if not exists email_source text,
  add column if not exists email_updated_at timestamptz,
  add column if not exists phone_status text not null default 'unknown',
  add column if not exists phone_source text,
  add column if not exists phone_updated_at timestamptz,
  add column if not exists lifecycle_status text not null default 'candidate',
  add column if not exists fit_score integer not null default 0,
  add column if not exists fit_reasons jsonb not null default '[]'::jsonb,
  add column if not exists enrichment_status text not null default 'not_started',
  add column if not exists last_enriched_at timestamptz,
  add column if not exists enrichment_attempts integer not null default 0,
  add column if not exists rejection_reason text,
  add column if not exists suppression_reason text;

alter table public.leads drop constraint if exists leads_lifecycle_status_check;
alter table public.leads add constraint leads_lifecycle_status_check check (
  lifecycle_status in (
    'candidate', 'enriching', 'ready', 'selected_for_campaign',
    'contacted', 'rejected_no_email', 'suppressed'
  )
);

alter table public.leads drop constraint if exists leads_email_status_check;
alter table public.leads add constraint leads_email_status_check check (
  email_status in ('unknown', 'user_provided', 'verified', 'likely', 'unverified', 'invalid', 'not_found')
);

alter table public.leads drop constraint if exists leads_enrichment_status_check;
alter table public.leads add constraint leads_enrichment_status_check check (
  enrichment_status in ('not_started', 'pending', 'completed', 'failed', 'cooldown')
);

update public.leads
set lifecycle_status = case
  when dnc_status = 'blocked' or status = 'do_not_call' then 'suppressed'
  when coalesce(email, '') <> '' then 'ready'
  else 'candidate'
end,
email_status = case when coalesce(email, '') <> '' then 'user_provided' else 'unknown' end,
email_source = case when coalesce(email, '') <> '' then source else null end,
email_updated_at = case when coalesce(email, '') <> '' then updated_at else null end
where lifecycle_status = 'candidate';

create unique index if not exists leads_workspace_external_id_unique
on public.leads(workspace_id, external_id)
where external_id is not null and external_id <> '';

create index if not exists leads_workspace_lifecycle_score_idx
on public.leads(workspace_id, lifecycle_status, fit_score desc);

create index if not exists leads_workspace_linkedin_idx
on public.leads(workspace_id, linkedin_url)
where linkedin_url is not null and linkedin_url <> '';

create index if not exists leads_workspace_domain_idx
on public.leads(workspace_id, company_domain)
where company_domain is not null and company_domain <> '';

create table if not exists public.lead_enrichment_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  provider text not null,
  field_name text not null,
  previous_value text,
  discovered_value text,
  selected_as_canonical boolean not null default false,
  confidence text,
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lead_enrichment_history_lead_created_idx
on public.lead_enrichment_history(lead_id, created_at desc);

create table if not exists public.lead_suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  import_run_id uuid references public.lead_import_runs(id) on delete set null,
  external_id text,
  email text,
  phone text,
  linkedin_url text,
  company_domain text,
  full_name text,
  company_name text,
  reason text not null default 'user_csv',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    external_id is not null or email is not null or phone is not null or
    linkedin_url is not null or company_domain is not null or
    (full_name is not null and company_name is not null)
  )
);

create index if not exists lead_suppressions_workspace_email_idx
on public.lead_suppressions(workspace_id, email) where email is not null;
create index if not exists lead_suppressions_workspace_domain_idx
on public.lead_suppressions(workspace_id, company_domain) where company_domain is not null;
create index if not exists lead_suppressions_workspace_external_idx
on public.lead_suppressions(workspace_id, external_id) where external_id is not null;

create table if not exists public.campaign_leads (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  selected_by uuid references auth.users(id) on delete set null,
  selected_at timestamptz not null default now(),
  primary key (campaign_id, lead_id)
);

create index if not exists campaign_leads_workspace_campaign_idx
on public.campaign_leads(workspace_id, campaign_id);

alter table public.lead_import_runs drop constraint if exists lead_import_runs_status_check;
alter table public.lead_import_runs add constraint lead_import_runs_status_check check (
  status in ('pending', 'searching', 'enriching', 'pending_enrichment', 'completed', 'partial', 'failed')
);

alter table public.lead_enrichment_history enable row level security;
alter table public.lead_suppressions enable row level security;
alter table public.campaign_leads enable row level security;

drop policy if exists "Users manage lead enrichment history for their workspace" on public.lead_enrichment_history;
create policy "Users manage lead enrichment history for their workspace"
on public.lead_enrichment_history for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = lead_enrichment_history.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = lead_enrichment_history.workspace_id and workspaces.owner_id = auth.uid()));

drop policy if exists "Users manage lead suppressions for their workspace" on public.lead_suppressions;
create policy "Users manage lead suppressions for their workspace"
on public.lead_suppressions for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = lead_suppressions.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = lead_suppressions.workspace_id and workspaces.owner_id = auth.uid()));

drop policy if exists "Users manage campaign leads for their workspace" on public.campaign_leads;
create policy "Users manage campaign leads for their workspace"
on public.campaign_leads for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = campaign_leads.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = campaign_leads.workspace_id and workspaces.owner_id = auth.uid()));

revoke all on public.lead_enrichment_history, public.lead_suppressions, public.campaign_leads from anon;
grant select, insert, update, delete on public.lead_enrichment_history, public.lead_suppressions, public.campaign_leads to authenticated;
