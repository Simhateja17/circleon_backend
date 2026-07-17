create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null default 'smtp' check (provider in ('smtp')),
  smtp_host text not null,
  smtp_port integer not null,
  smtp_username text not null,
  smtp_password_encrypted text not null,
  from_name text not null,
  from_email text not null,
  reply_to_email text,
  imap_host text not null,
  imap_port integer not null,
  imap_username text not null,
  imap_password_encrypted text not null,
  status text not null default 'connected' check (status in ('connected', 'error', 'disconnected')),
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  channel text not null default 'email' check (channel in ('email')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  lead_source text not null default 'manual' check (lead_source in ('apollo', 'csv', 'manual')),
  import_run_id uuid references public.lead_import_runs(id) on delete set null,
  sending_hours_start time not null default '09:00',
  sending_hours_end time not null default '18:00',
  active_days integer[] not null default array[1,2,3,4,5],
  daily_send_cap integer not null default 100,
  cadence_per_hour integer not null default 25,
  created_by uuid references auth.users(id) on delete set null,
  launched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_sequences (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  step_number integer not null check (step_number > 0),
  name text not null,
  delay_days integer not null default 0 check (delay_days >= 0),
  subject_template text,
  body_template text,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, step_number)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  sequence_step integer,
  direction text not null check (direction in ('outbound', 'inbound')),
  subject text,
  body text,
  draft_body text,
  message_id_header text,
  in_reply_to_header text,
  status text not null default 'draft' check (
    status in ('draft', 'pending_approval', 'approved', 'sent', 'failed', 'auto_sent', 'received', 'rejected')
  ),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  open_count integer not null default 0,
  intent_classification text check (
    intent_classification in ('positive', 'pricing', 'not_interested', 'dnc_request', 'auto_reply')
  ),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.leads
  add column if not exists company_data jsonb not null default '{}'::jsonb,
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;

create index if not exists connected_accounts_workspace_status_idx
on public.connected_accounts(workspace_id, status);

create index if not exists campaigns_workspace_status_idx
on public.campaigns(workspace_id, status);

create index if not exists email_sequences_campaign_step_idx
on public.email_sequences(campaign_id, step_number);

create index if not exists messages_workspace_lead_created_idx
on public.messages(workspace_id, lead_id, created_at desc);

create index if not exists messages_workspace_campaign_status_idx
on public.messages(workspace_id, campaign_id, status);

create index if not exists messages_message_id_header_idx
on public.messages(message_id_header)
where message_id_header is not null;

create index if not exists leads_workspace_campaign_idx
on public.leads(workspace_id, campaign_id)
where campaign_id is not null;

alter table if exists public.dnc_checks
  drop constraint if exists dnc_checks_channel_check;

alter table if exists public.dnc_checks
  add constraint dnc_checks_channel_check
  check (channel in ('voice', 'email'));

drop trigger if exists set_connected_accounts_updated_at on public.connected_accounts;
create trigger set_connected_accounts_updated_at
before update on public.connected_accounts
for each row execute function public.set_updated_at();

drop trigger if exists set_campaigns_updated_at on public.campaigns;
create trigger set_campaigns_updated_at
before update on public.campaigns
for each row execute function public.set_updated_at();

drop trigger if exists set_email_sequences_updated_at on public.email_sequences;
create trigger set_email_sequences_updated_at
before update on public.email_sequences
for each row execute function public.set_updated_at();

drop trigger if exists set_messages_updated_at on public.messages;
create trigger set_messages_updated_at
before update on public.messages
for each row execute function public.set_updated_at();

alter table public.connected_accounts enable row level security;
alter table public.campaigns enable row level security;
alter table public.email_sequences enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Users manage connected accounts for their workspace" on public.connected_accounts;
create policy "Users manage connected accounts for their workspace"
on public.connected_accounts
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = connected_accounts.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = connected_accounts.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage campaigns for their workspace" on public.campaigns;
create policy "Users manage campaigns for their workspace"
on public.campaigns
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = campaigns.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = campaigns.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage email sequences for their workspace" on public.email_sequences;
create policy "Users manage email sequences for their workspace"
on public.email_sequences
for all
to authenticated
using (
  exists (
    select 1
    from public.campaigns
    join public.workspaces on workspaces.id = campaigns.workspace_id
    where campaigns.id = email_sequences.campaign_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.campaigns
    join public.workspaces on workspaces.id = campaigns.workspace_id
    where campaigns.id = email_sequences.campaign_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage messages for their workspace" on public.messages;
create policy "Users manage messages for their workspace"
on public.messages
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = messages.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = messages.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

grant select, insert, update, delete on public.connected_accounts to authenticated;
grant select, insert, update, delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.email_sequences to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
