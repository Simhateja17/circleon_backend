-- Voice campaigns: campaign-scoped outbound calling for Singapore.
--
-- Replaces the workspace-wide follow-up dialer with first-class voice campaigns.
-- Each voice campaign owns one Retell agent, one script, its own lead list,
-- its own caps and its own schedule.

-- ---------------------------------------------------------------------------
-- 1. Campaigns can be voice
-- ---------------------------------------------------------------------------

alter table public.campaigns drop constraint if exists campaigns_channel_check;
alter table public.campaigns add constraint campaigns_channel_check
  check (channel in ('email', 'voice'));

alter table public.campaigns
  add column if not exists max_call_attempts integer not null default 3
    check (max_call_attempts between 1 and 10),
  add column if not exists retry_gap_hours integer not null default 24
    check (retry_gap_hours >= 1);

comment on column public.campaigns.daily_send_cap is
  'Per-day cap for this campaign. Emails for channel=email, calls for channel=voice.';
comment on column public.campaigns.sending_hours_start is
  'Start of the daily contact window, interpreted in campaigns.timezone.';

-- ---------------------------------------------------------------------------
-- 2. Voice agents move from workspace-scoped to campaign-scoped
-- ---------------------------------------------------------------------------

alter table public.voice_agents
  add column if not exists campaign_id uuid references public.campaigns(id) on delete cascade,
  add column if not exists language text not null default 'en-US';

-- The old model allowed exactly one agent per workspace. Campaigns now own agents.
alter table public.voice_agents drop constraint if exists voice_agents_workspace_id_key;

create unique index if not exists voice_agents_campaign_unique
  on public.voice_agents(campaign_id) where campaign_id is not null;

-- ---------------------------------------------------------------------------
-- 3. The script a voice campaign runs
-- ---------------------------------------------------------------------------

create table if not exists public.voice_scripts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null unique references public.campaigns(id) on delete cascade,

  language text not null default 'en-US',

  -- Always authored by the user, never generated unread.
  opening_line text,

  -- Structured review surface. The composed prompt is derived from these.
  objective text,
  offer text,
  qualifying_questions jsonb not null default '[]'::jsonb,
  objection_handling text,
  success_criteria text,

  -- Escape hatch for power users, and the composed output we send to Retell.
  custom_prompt text,
  composed_prompt text,

  status text not null default 'draft' check (status in ('draft', 'approved')),

  -- Non-English scripts cannot launch until the customer says they have read it.
  attested_by uuid references auth.users(id) on delete set null,
  attested_at timestamptz,

  generation_status text not null default 'not_started'
    check (generation_status in ('not_started', 'pending', 'completed', 'failed')),
  generation_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voice_scripts_workspace_idx
  on public.voice_scripts(workspace_id);

-- ---------------------------------------------------------------------------
-- 4. Calls belong to campaigns, and carry an attempt number
-- ---------------------------------------------------------------------------

alter table public.calls
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null,
  add column if not exists attempt_number integer not null default 1,
  add column if not exists credit_charged_cents integer;

create index if not exists calls_campaign_created_idx
  on public.calls(campaign_id, created_at desc) where campaign_id is not null;

create index if not exists calls_workspace_active_idx
  on public.calls(workspace_id, status)
  where status in ('queued', 'calling', 'ringing', 'in_progress');

-- ---------------------------------------------------------------------------
-- 5. The dialer's work queue: one row per lead per voice campaign
-- ---------------------------------------------------------------------------

create table if not exists public.voice_call_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  state text not null default 'pending' check (state in (
    'pending',     -- waiting for its turn
    'in_flight',   -- a call is live right now
    'completed',   -- reached a decisive outcome
    'exhausted',   -- ran out of attempts
    'blocked'      -- cannot be called; see block_reason
  )),

  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_call_id uuid references public.calls(id) on delete set null,
  last_outcome text,
  block_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (campaign_id, lead_id)
);

create index if not exists voice_call_targets_due_idx
  on public.voice_call_targets(campaign_id, state, next_attempt_at)
  where state = 'pending';

create index if not exists voice_call_targets_workspace_idx
  on public.voice_call_targets(workspace_id, state);

-- ---------------------------------------------------------------------------
-- 6. Phone number classification, for the Singapore B2B exemption
-- ---------------------------------------------------------------------------
--
-- DNC obligations attach to the number being a personal one. Business lines are
-- outside the DNC provisions, so we only spend a PDPC credit on numbers that
-- need it. Apollo hands us the type; we must stop discarding it.

alter table public.leads
  add column if not exists phone_type text not null default 'unknown'
    check (phone_type in ('business', 'personal', 'unknown')),
  add column if not exists phone_type_source text,
  add column if not exists phone_type_overridden_by uuid references auth.users(id) on delete set null,
  add column if not exists phone_type_overridden_at timestamptz;

comment on column public.leads.phone_type is
  'business = organisation line, exempt from DNC under the B2B provisions. personal = requires a PDPC check.';

create index if not exists leads_workspace_phone_type_idx
  on public.leads(workspace_id, phone_type) where phone_e164 is not null;

-- ---------------------------------------------------------------------------
-- 7. Suppression that actually holds across channels
-- ---------------------------------------------------------------------------
--
-- lifecycle_status was previously set by a one-time backfill, so a lead marked
-- do_not_call after that migration ran kept receiving email. This keeps it true.

create or replace function public.sync_lead_suppression()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'do_not_call' or new.dnc_status = 'blocked' then
    new.lifecycle_status := 'suppressed';
    if new.suppression_reason is null then
      new.suppression_reason := case
        when new.status = 'do_not_call' then 'lead_requested_do_not_call'
        else 'dnc_blocked'
      end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_lead_suppression_trigger on public.leads;
create trigger sync_lead_suppression_trigger
  before insert or update of status, dnc_status on public.leads
  for each row execute function public.sync_lead_suppression();

-- Backfill anything the original migration missed.
update public.leads
set lifecycle_status = 'suppressed'
where (status = 'do_not_call' or dnc_status = 'blocked')
  and lifecycle_status <> 'suppressed';

-- ---------------------------------------------------------------------------
-- 8. Telephony: customer-owned Twilio numbers, per-workspace PDPC credentials
-- ---------------------------------------------------------------------------

alter table public.workspace_telephony drop constraint if exists workspace_telephony_phone_number_status_check;
alter table public.workspace_telephony add constraint workspace_telephony_phone_number_status_check
  check (phone_number_status in ('missing', 'pending_verification', 'attached', 'verified', 'error'));

alter table public.workspace_telephony
  -- Customer brings their own Twilio account; the number is registered to their UEN.
  add column if not exists twilio_account_sid text,
  add column if not exists twilio_auth_token_encrypted text,
  add column if not exists number_imported_at timestamptz,

  -- Each customer registers their own UEN with PDPC, so credentials are per workspace.
  add column if not exists pdpc_account_id text,
  add column if not exists pdpc_api_key_encrypted text,
  add column if not exists pdpc_api_url text,

  -- Concurrency ships at 1 and is raised per workspace once real call costs are known.
  add column if not exists max_concurrent_calls integer not null default 1
    check (max_concurrent_calls between 1 and 20),

  add column if not exists recording_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- 9. Prepaid call credits
-- ---------------------------------------------------------------------------
--
-- Voice is the first feature with genuinely variable unit cost. Prepaid fails
-- safely: running out pauses the campaign rather than generating a disputed bill.

create table if not exists public.workspace_call_credits (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  balance_cents integer not null default 0,
  lifetime_purchased_cents integer not null default 0,
  lifetime_spent_cents integer not null default 0,
  low_balance_notified_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.call_credit_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  call_id uuid references public.calls(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  delta_cents integer not null,
  balance_after_cents integer not null,
  reason text not null check (reason in ('purchase', 'call_charge', 'refund', 'trial_grant', 'adjustment')),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists call_credit_entries_workspace_idx
  on public.call_credit_entries(workspace_id, created_at desc);

create unique index if not exists call_credit_entries_call_charge_unique
  on public.call_credit_entries(call_id) where reason = 'call_charge';

-- ---------------------------------------------------------------------------
-- 10. Housekeeping
-- ---------------------------------------------------------------------------

drop trigger if exists set_voice_scripts_updated_at on public.voice_scripts;
create trigger set_voice_scripts_updated_at
  before update on public.voice_scripts
  for each row execute function public.set_updated_at();

drop trigger if exists set_voice_call_targets_updated_at on public.voice_call_targets;
create trigger set_voice_call_targets_updated_at
  before update on public.voice_call_targets
  for each row execute function public.set_updated_at();

drop trigger if exists set_workspace_call_credits_updated_at on public.workspace_call_credits;
create trigger set_workspace_call_credits_updated_at
  before update on public.workspace_call_credits
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 11. Row level security
-- ---------------------------------------------------------------------------

alter table public.voice_scripts enable row level security;
alter table public.voice_call_targets enable row level security;
alter table public.workspace_call_credits enable row level security;
alter table public.call_credit_entries enable row level security;

drop policy if exists "Users manage voice scripts for their workspace" on public.voice_scripts;
create policy "Users manage voice scripts for their workspace"
on public.voice_scripts for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = voice_scripts.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = voice_scripts.workspace_id and workspaces.owner_id = auth.uid()));

drop policy if exists "Users read voice call targets for their workspace" on public.voice_call_targets;
create policy "Users read voice call targets for their workspace"
on public.voice_call_targets for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = voice_call_targets.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = voice_call_targets.workspace_id and workspaces.owner_id = auth.uid()));

drop policy if exists "Users read call credits for their workspace" on public.workspace_call_credits;
create policy "Users read call credits for their workspace"
on public.workspace_call_credits for select to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = workspace_call_credits.workspace_id and workspaces.owner_id = auth.uid()));

drop policy if exists "Users read call credit entries for their workspace" on public.call_credit_entries;
create policy "Users read call credit entries for their workspace"
on public.call_credit_entries for select to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = call_credit_entries.workspace_id and workspaces.owner_id = auth.uid()));

revoke all on table public.voice_scripts from anon;
revoke all on table public.voice_call_targets from anon;
revoke all on table public.workspace_call_credits from anon;
revoke all on table public.call_credit_entries from anon;

grant select, insert, update, delete on table public.voice_scripts to authenticated;
grant select, insert, update, delete on table public.voice_call_targets to authenticated;
grant select on table public.workspace_call_credits to authenticated;
grant select on table public.call_credit_entries to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Credit movement, done atomically in the database
-- ---------------------------------------------------------------------------
--
-- Charging happens from a webhook that Retell may deliver more than once, so
-- the charge is idempotent on call_id via call_credit_entries_call_charge_unique.

create or replace function public.charge_call_credits(
  p_workspace_id uuid,
  p_call_id uuid,
  p_campaign_id uuid,
  p_amount_cents integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    select balance_cents into v_balance from public.workspace_call_credits where workspace_id = p_workspace_id;
    return coalesce(v_balance, 0);
  end if;

  -- Already charged for this call; return the balance unchanged.
  if exists (select 1 from public.call_credit_entries where call_id = p_call_id and reason = 'call_charge') then
    select balance_cents into v_balance from public.workspace_call_credits where workspace_id = p_workspace_id;
    return coalesce(v_balance, 0);
  end if;

  insert into public.workspace_call_credits (workspace_id, balance_cents)
  values (p_workspace_id, 0)
  on conflict (workspace_id) do nothing;

  update public.workspace_call_credits
  set balance_cents = balance_cents - p_amount_cents,
      lifetime_spent_cents = lifetime_spent_cents + p_amount_cents
  where workspace_id = p_workspace_id
  returning balance_cents into v_balance;

  insert into public.call_credit_entries
    (workspace_id, call_id, campaign_id, delta_cents, balance_after_cents, reason)
  values
    (p_workspace_id, p_call_id, p_campaign_id, -p_amount_cents, v_balance, 'call_charge');

  return v_balance;
end;
$$;

create or replace function public.add_call_credits(
  p_workspace_id uuid,
  p_amount_cents integer,
  p_reason text,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Credit amount must be positive';
  end if;
  if p_reason not in ('purchase', 'refund', 'trial_grant', 'adjustment') then
    raise exception 'Unsupported credit reason: %', p_reason;
  end if;

  insert into public.workspace_call_credits (workspace_id, balance_cents)
  values (p_workspace_id, 0)
  on conflict (workspace_id) do nothing;

  update public.workspace_call_credits
  set balance_cents = balance_cents + p_amount_cents,
      lifetime_purchased_cents = lifetime_purchased_cents
        + case when p_reason = 'purchase' then p_amount_cents else 0 end,
      low_balance_notified_at = null
  where workspace_id = p_workspace_id
  returning balance_cents into v_balance;

  insert into public.call_credit_entries
    (workspace_id, delta_cents, balance_after_cents, reason, note)
  values
    (p_workspace_id, p_amount_cents, v_balance, p_reason, p_note);

  return v_balance;
end;
$$;

revoke all on function public.charge_call_credits(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.add_call_credits(uuid, integer, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 13. Calendar connection, so the agent can offer real times
-- ---------------------------------------------------------------------------
--
-- Without this the agent can only promise to send a booking link, which ends
-- the conversation by asking the prospect to go and do an email's worth of
-- work. Reading real availability is what makes it an appointment setter.

create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  provider text not null default 'google_calendar' check (provider in ('google_calendar')),
  account_email text,
  calendar_id text not null default 'primary',
  refresh_token_encrypted text not null,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  slot_minutes integer not null default 30 check (slot_minutes between 15 and 120),
  booking_hours_start time not null default '09:00',
  booking_hours_end time not null default '18:00',
  booking_days integer[] not null default array[1,2,3,4,5],
  timezone text not null default 'Asia/Singapore',
  status text not null default 'connected' check (status in ('connected', 'error', 'disconnected')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.meetings
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;

drop trigger if exists set_calendar_connections_updated_at on public.calendar_connections;
create trigger set_calendar_connections_updated_at
  before update on public.calendar_connections
  for each row execute function public.set_updated_at();

alter table public.calendar_connections enable row level security;

drop policy if exists "Users manage calendar connections for their workspace" on public.calendar_connections;
create policy "Users manage calendar connections for their workspace"
on public.calendar_connections for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id = calendar_connections.workspace_id and workspaces.owner_id = auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id = calendar_connections.workspace_id and workspaces.owner_id = auth.uid()));

revoke all on table public.calendar_connections from anon;
grant select, insert, update, delete on table public.calendar_connections to authenticated;
