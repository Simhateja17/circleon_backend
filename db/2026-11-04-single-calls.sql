-- One-off calls placed from the Calls page, including ones booked for later.
alter table public.calls
  add column if not exists source text not null default 'campaign',
  add column if not exists scheduled_for timestamptz,
  add column if not exists confirmed_by uuid,
  add column if not exists confirmed_at timestamptz;

alter table public.calls drop constraint if exists calls_source_check;
alter table public.calls add constraint calls_source_check
  check (source in ('campaign', 'manual'));

alter table public.calls drop constraint if exists calls_status_check;
alter table public.calls add constraint calls_status_check
  check (status in ('scheduled', 'queued', 'calling', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'canceled'));

-- A double click or a second tab must not ring the same person twice.
create unique index if not exists calls_one_open_manual_call_per_lead
  on public.calls (lead_id)
  where source = 'manual' and status in ('scheduled', 'queued', 'calling', 'ringing', 'in_progress');

create index if not exists calls_due_scheduled
  on public.calls (scheduled_for)
  where status = 'scheduled';
