-- Stripe Billing is the authority for paid access. Apply this migration before
-- enabling the Stripe routes in a deployed environment.

create table if not exists public.workspace_billing (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_checkout_session_id text unique,
  plan text check (plan in ('atelier', 'maison')),
  subscription_status text not null default 'inactive',
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

drop trigger if exists set_workspace_billing_updated_at on public.workspace_billing;
create trigger set_workspace_billing_updated_at
before update on public.workspace_billing
for each row execute function public.set_updated_at();

alter table public.workspace_billing enable row level security;
alter table public.stripe_webhook_events enable row level security;

drop policy if exists "Users read their own workspace billing" on public.workspace_billing;
create policy "Users read their own workspace billing"
on public.workspace_billing for select to authenticated
using (exists (
  select 1 from public.workspaces
  where workspaces.id = workspace_billing.workspace_id
    and workspaces.owner_id = auth.uid()
));

grant select on public.workspace_billing to authenticated;
