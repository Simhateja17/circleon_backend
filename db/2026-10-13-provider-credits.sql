begin;
create table if not exists public.provider_credit_snapshots (
 id uuid primary key default gen_random_uuid(),
 provider text not null check(provider='apollo'),
 source text not null check(source in ('api','manual')),
 balances jsonb not null check(jsonb_typeof(balances)='array'),
 cycle jsonb,
 verified_at timestamptz not null,
 source_note text not null,
 recorded_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
create index if not exists provider_credit_snapshots_verified_idx on public.provider_credit_snapshots(verified_at desc);
alter table public.provider_credit_snapshots enable row level security;
revoke all on public.provider_credit_snapshots from anon,authenticated;
grant select,insert on public.provider_credit_snapshots to service_role;
-- CircleOn usage counts are deliberately separate from provider credit charges.
create or replace function public.provider_credit_client_usage() returns table (
 workspace_id uuid,workspace_name text,plan text,period_start timestamptz,
 billing_period_leads bigint,calendar_month_admitted_leads bigint,calendar_month_enrichment_outcomes bigint
) language sql stable security definer set search_path=public as $$
 select w.id,w.name,b.plan,case when b.subscription_status='trialing' then b.trial_start else b.current_period_start end,
 coalesce((select u.leads from billing_usage u where u.workspace_id=w.id and u.period_start=case when b.subscription_status='trialing' then b.trial_start else b.current_period_start end),0)::bigint,
 (select count(*) from leads l where l.workspace_id=w.id and l.email_source='apollo' and l.lifecycle_status='ready' and l.created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'),
 (select count(*) from apollo_enrichment_audits a where a.workspace_id=w.id and a.created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')
 from workspaces w left join workspace_billing b on b.workspace_id=w.id order by w.name;
$$;
revoke all on function public.provider_credit_client_usage() from public,anon,authenticated;
grant execute on function public.provider_credit_client_usage() to service_role;
commit;
