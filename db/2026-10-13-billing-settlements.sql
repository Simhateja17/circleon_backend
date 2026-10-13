-- Persist final usage invoice progress across process crashes and retries.
create table if not exists public.billing_settlements (
 subscription_id text primary key,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 invoice_id text not null unique,
 status text not null default 'draft' check(status in ('draft','finalized')),
 created_at timestamptz not null default now(),
 finalized_at timestamptz
);
alter table public.billing_settlements enable row level security;
revoke all on public.billing_settlements from anon,authenticated;
grant all on public.billing_settlements to service_role;
