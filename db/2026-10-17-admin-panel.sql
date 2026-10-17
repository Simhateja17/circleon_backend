begin;
-- Suspension lives on billing so every existing isActiveSubscription gate
-- (routes and workers) stops a suspended workspace without new call sites.
alter table public.workspace_billing
 add column if not exists suspended_at timestamptz,
 add column if not exists suspended_reason text;

create table if not exists public.admin_audit_log (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references auth.users(id),
 action text not null,
 target_type text not null,
 target_id text,
 before jsonb,
 after jsonb,
 ip text,
 created_at timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx on public.admin_audit_log(created_at desc);
create index if not exists admin_audit_log_target_idx on public.admin_audit_log(target_type,target_id,created_at desc);

create table if not exists public.support_tickets (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 created_by uuid not null references auth.users(id),
 subject text not null check(char_length(subject) between 3 and 200),
 status text not null default 'open' check(status in ('open','answered','closed')),
 last_message_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists support_tickets_workspace_idx on public.support_tickets(workspace_id,last_message_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets(status,last_message_at desc);

create table if not exists public.support_messages (
 id uuid primary key default gen_random_uuid(),
 ticket_id uuid not null references public.support_tickets(id) on delete cascade,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 sender text not null check(sender in ('user','admin')),
 body text not null check(char_length(body) between 1 and 10000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx on public.support_messages(ticket_id,created_at);

-- Only the backend service role touches these; customers reach support through the API.
alter table public.admin_audit_log enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
revoke all on public.admin_audit_log, public.support_tickets, public.support_messages from anon,authenticated;
grant select,insert on public.admin_audit_log to service_role;
grant select,insert,update on public.support_tickets, public.support_messages to service_role;

create or replace function public.admin_metrics() returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object(
  'workspaces', (select count(*) from workspaces),
  'signups_7d', (select count(*) from workspaces where created_at>=now()-interval '7 days'),
  'signups_30d', (select count(*) from workspaces where created_at>=now()-interval '30 days'),
  'paying', (select count(*) from workspace_billing where subscription_status='active' and suspended_at is null),
  'trialing', (select count(*) from workspace_billing where subscription_status='trialing' and suspended_at is null),
  'suspended', (select count(*) from workspace_billing where suspended_at is not null),
  'payment_failed', (select count(*) from workspace_billing where payment_failed),
  'mrr_cents', (select coalesce(sum(case when b.founding then p.founding_cents else p.list_cents end),0)
    from workspace_billing b join pricing_plans p on p.id=b.plan
    where b.subscription_status='active' and not b.payment_failed and b.suspended_at is null),
  'active_campaigns', (select count(*) from campaigns where status='active'),
  'emails_sent_30d', (select count(*) from messages where status in ('sent','auto_sent') and created_at>=now()-interval '30 days'),
  'voice_minutes_30d', (select coalesce(round(sum(amount)/60.0),0) from billing_usage_events where kind='voice_seconds' and created_at>=now()-interval '30 days'),
  'open_tickets', (select count(*) from support_tickets where status='open')
 );
$$;
revoke all on function public.admin_metrics() from public,anon,authenticated;
grant execute on function public.admin_metrics() to service_role;
commit;
