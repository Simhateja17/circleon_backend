-- Two bookings can race for the same time. Only one can hold a start time in a
-- workspace; the other is told the time has gone.
create unique index if not exists meetings_one_booking_per_start
  on public.meetings (workspace_id, starts_at)
  where starts_at is not null and status in ('requested', 'scheduled');

-- The public address of each workspace's in-house booking page.
alter table public.workspaces
  add column if not exists booking_token text not null default encode(extensions.gen_random_bytes(16), 'hex');
create unique index if not exists workspaces_booking_token_key on public.workspaces (booking_token);

-- Emails and agents read the link from here, so point them at the booking page.
update public.agent_configs c
set booking_link = 'https://circleon.ai/book/' || w.booking_token
from public.workspaces w
where w.id = c.workspace_id;
