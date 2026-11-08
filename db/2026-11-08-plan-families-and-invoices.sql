-- Three plans, one price each, reusing the All-in-one Starter / Growth / Pro
-- prices: Email (S$399), Email + Invoice (S$649) and All-in-one (S$999, the
-- only one with voice). The earlier Follow Up, Voice Agent and tiered
-- All-in-one plans are no longer sold, but existing subscriptions keep working.
begin;

alter table public.workspace_billing drop constraint if exists workspace_billing_plan_check;
alter table public.workspaces drop constraint if exists workspaces_plan_check;
alter table public.workspace_billing add constraint workspace_billing_plan_check check (plan in ('email','email_invoice','all_in_one','followup_starter','followup_growth','followup_pro','voice_starter','voice_growth','voice_pro','allinone_starter','allinone_growth','allinone_pro','atelier','maison','sovereign'));
alter table public.workspaces add constraint workspaces_plan_check check (plan in ('email','email_invoice','all_in_one','followup_starter','followup_growth','followup_pro','voice_starter','voice_growth','voice_pro','allinone_starter','allinone_growth','allinone_pro','atelier','maison','sovereign'));

insert into public.pricing_plans values ('email','email','Email',39900,34900,65000,500,2000,0,1,1,0,'aio_starter') on conflict (id) do nothing;
insert into public.pricing_plans values ('email_invoice','email_invoice','Email + Invoice',64900,54900,65000,800,3200,0,3,3,0,'aio_growth') on conflict (id) do nothing;
insert into public.pricing_plans values ('all_in_one','allinone','All-in-one',99900,91900,65000,1500,6000,600,5,10,3,'aio_pro') on conflict (id) do nothing;

-- Invoices a workspace sends to its own customers after a sale.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  number text not null,
  client_name text not null,
  client_email text not null,
  currency text not null default 'SGD' check (currency ~ '^[A-Z]{3}$'),
  line_items jsonb not null default '[]'::jsonb,
  amount_cents bigint not null check (amount_cents >= 0),
  issue_date date not null default current_date,
  due_date date not null,
  notes text,
  payment_link text,
  status text not null default 'draft' check (status in ('draft','sent','paid','void')),
  reminders_enabled boolean not null default true,
  checkins_enabled boolean not null default true,
  sent_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, number),
  check (due_date >= issue_date)
);
create index if not exists invoices_workspace_status_idx on public.invoices (workspace_id, status, due_date);

-- One row per email sent about an invoice. The unique key makes the follow-up
-- worker idempotent: a reminder or check-in step is sent at most once.
create table if not exists public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('invoice','reminder','checkin','paid','void')),
  step text not null default '',
  subject text,
  message_id text,
  created_at timestamptz not null default now(),
  unique (invoice_id, kind, step)
);
create index if not exists invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at);

-- Per-workspace schedule. Offsets are days relative to the due date for
-- reminders, and days after payment for post-sale check-ins.
create table if not exists public.invoice_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  reminder_offsets integer[] not null default '{-3,0,3,7,14}',
  checkin_offsets integer[] not null default '{0,7,30}',
  reminders_enabled boolean not null default true,
  checkins_enabled boolean not null default true,
  review_link text,
  updated_at timestamptz not null default now(),
  check (cardinality(reminder_offsets) <= 10 and cardinality(checkin_offsets) <= 10)
);

drop trigger if exists set_invoices_updated_at on public.invoices;
create trigger set_invoices_updated_at before update on public.invoices for each row execute function public.set_updated_at();

alter table public.invoices enable row level security;
alter table public.invoice_events enable row level security;
alter table public.invoice_settings enable row level security;
revoke all on public.invoices, public.invoice_events, public.invoice_settings from anon;

drop policy if exists "Members manage invoices" on public.invoices;
create policy "Members manage invoices" on public.invoices for all to authenticated
  using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));
drop policy if exists "Members read invoice events" on public.invoice_events;
create policy "Members read invoice events" on public.invoice_events for select to authenticated
  using (is_workspace_member(workspace_id));
drop policy if exists "Members manage invoice settings" on public.invoice_settings;
create policy "Members manage invoice settings" on public.invoice_settings for all to authenticated
  using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

commit;
