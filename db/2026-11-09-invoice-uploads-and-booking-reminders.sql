-- Invoices can be uploaded (PDF or image) instead of built line by line, and can
-- carry a booking (a yacht charter, a class, an appointment) that gets its own
-- personalised reminders before the date.

alter table public.invoices
  add column if not exists file_path text,
  add column if not exists file_name text,
  add column if not exists file_mime text,
  add column if not exists booking_at timestamptz,
  add column if not exists booking_title text,
  add column if not exists booking_notes text;

-- Workspace defaults for when booking reminders go out. Each rule is either
-- {"days_before": 1, "time": "09:00"} (Singapore time) or {"hours_before": 3}.
alter table public.invoice_settings
  add column if not exists booking_reminders_enabled boolean not null default true,
  add column if not exists booking_rules jsonb not null default '[{"days_before":1,"time":"09:00"}]'::jsonb;

create table if not exists public.invoice_booking_reminders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  rule_key text not null,
  send_at timestamptz not null,
  subject text not null,
  body text not null,
  -- draft: written by AI, waiting for the owner. scheduled: approved.
  -- sending: claimed by the worker. sent / failed / cancelled: final.
  status text not null default 'draft' check (status in ('draft','scheduled','sending','sent','failed','cancelled')),
  sent_at timestamptz,
  message_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, rule_key)
);
create index if not exists invoice_booking_reminders_due_idx
  on public.invoice_booking_reminders (send_at) where status = 'scheduled';

drop trigger if exists set_invoice_booking_reminders_updated_at on public.invoice_booking_reminders;
create trigger set_invoice_booking_reminders_updated_at before update on public.invoice_booking_reminders
  for each row execute function public.set_updated_at();

alter table public.invoice_booking_reminders enable row level security;
revoke all on public.invoice_booking_reminders from anon;
drop policy if exists "Members manage booking reminders" on public.invoice_booking_reminders;
create policy "Members manage booking reminders" on public.invoice_booking_reminders for all to authenticated
  using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

-- Uploaded invoice files. Private: the backend reads them with the service key
-- to attach them, and hands the browser short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-files', 'invoice-files', false, 10485760, array['application/pdf','image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- Sent booking reminders also appear on the invoice's activity timeline.
alter table public.invoice_events drop constraint if exists invoice_events_kind_check;
alter table public.invoice_events add constraint invoice_events_kind_check
  check (kind in ('invoice','reminder','checkin','paid','void','booking'));
