-- Public marketing lead preview requests. These records stay separate from
-- authenticated workspace leads until a visitor signs up and explicitly claims
-- the sample.

create table if not exists public.free_lead_preview_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  company_name text not null,
  product text not null,
  target_titles text[] not null default '{}',
  target_industry text not null,
  target_region text not null,
  target_company_size text not null,
  status text not null default 'queued' check (status in (
    'queued', 'searching', 'enriching', 'sending', 'sent', 'partial', 'failed'
  )),
  requested_count smallint not null default 3 check (requested_count between 1 and 3),
  candidate_count integer not null default 0,
  ready_count integer not null default 0,
  search_pages integer not null default 0,
  result_summary jsonb not null default '{}'::jsonb,
  provider_meta jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.free_lead_preview_candidates (
  id uuid primary key default gen_random_uuid(),
  preview_request_id uuid not null references public.free_lead_preview_requests(id) on delete cascade,
  external_id text not null,
  search_rank integer not null,
  apollo_request_id text,
  status text not null default 'enriching' check (status in ('enriching', 'ready', 'rejected')),
  full_name text,
  first_name text,
  last_name text,
  company_name text,
  title text,
  location text,
  email text,
  email_status text not null default 'unknown' check (email_status in ('unknown', 'verified', 'not_found', 'invalid')),
  linkedin_url text,
  company_domain text,
  company_data jsonb not null default '{}'::jsonb,
  personalization_profile jsonb not null default '{}'::jsonb,
  fit_score integer not null default 0,
  fit_reasons jsonb not null default '[]'::jsonb,
  research_quality smallint not null default 0 check (research_quality between 0 and 5),
  selected_rank smallint,
  search_data jsonb not null default '{}'::jsonb,
  enrichment_data jsonb not null default '{}'::jsonb,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (preview_request_id, external_id)
);

create index if not exists free_lead_preview_requests_email_created_idx
on public.free_lead_preview_requests(lower(email), created_at desc);

create index if not exists free_lead_preview_requests_status_created_idx
on public.free_lead_preview_requests(status, created_at desc);

-- The application-level cooldown is user-friendly; this constraint closes the
-- race where two identical submissions arrive at the same time.
create unique index if not exists free_lead_preview_requests_active_email_uidx
on public.free_lead_preview_requests(lower(email))
where status in ('queued', 'searching', 'enriching', 'sending');

create index if not exists free_lead_preview_candidates_request_status_idx
on public.free_lead_preview_candidates(preview_request_id, status, fit_score desc, search_rank);

create index if not exists free_lead_preview_candidates_apollo_request_idx
on public.free_lead_preview_candidates(apollo_request_id)
where apollo_request_id is not null;

drop trigger if exists set_free_lead_preview_requests_updated_at on public.free_lead_preview_requests;
create trigger set_free_lead_preview_requests_updated_at
before update on public.free_lead_preview_requests
for each row execute function public.set_updated_at();

drop trigger if exists set_free_lead_preview_candidates_updated_at on public.free_lead_preview_candidates;
create trigger set_free_lead_preview_candidates_updated_at
before update on public.free_lead_preview_candidates
for each row execute function public.set_updated_at();

alter table public.free_lead_preview_requests enable row level security;
alter table public.free_lead_preview_candidates enable row level security;

-- Public visitors never query these tables directly. The backend uses the
-- service role after validating and rate-limiting the marketing form.
revoke all on public.free_lead_preview_requests, public.free_lead_preview_candidates from anon, authenticated;
