create table if not exists public.lead_import_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null check (source in ('manual', 'csv', 'apollo')),
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  total_rows integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  error_message text,
  raw_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  import_run_id uuid references public.lead_import_runs(id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'csv', 'apollo')),
  external_id text,
  full_name text not null,
  company_name text,
  title text,
  phone text,
  email text,
  location text,
  status text not null default 'new' check (status in ('new', 'contacted', 'interested', 'not_interested', 'follow_up', 'booked', 'do_not_call')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  last_contacted_at timestamptz,
  notes_summary text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  source text not null default 'manual' check (source in ('manual', 'call', 'import')),
  note text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  call_id uuid,
  title text not null,
  context_note text,
  owner_type text not null default 'agent' check (owner_type in ('agent', 'human')),
  action_type text not null default 'call' check (action_type in ('call', 'send_info', 'book_meeting', 'manual_task')),
  status text not null default 'scheduled' check (status in ('suggested', 'scheduled', 'completed', 'dismissed', 'missed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_workspace_status_idx on public.leads(workspace_id, status);
create index if not exists leads_workspace_source_idx on public.leads(workspace_id, source);
create index if not exists leads_workspace_phone_idx on public.leads(workspace_id, phone) where phone is not null;
create index if not exists leads_workspace_email_idx on public.leads(workspace_id, email) where email is not null;
create index if not exists follow_ups_workspace_queue_idx on public.follow_ups(workspace_id, status, priority, due_at);
create index if not exists lead_notes_lead_created_idx on public.lead_notes(lead_id, created_at desc);

create trigger set_leads_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

create trigger set_follow_ups_updated_at
before update on public.follow_ups
for each row execute function public.set_updated_at();

alter table public.lead_import_runs enable row level security;
alter table public.leads enable row level security;
alter table public.lead_notes enable row level security;
alter table public.follow_ups enable row level security;

drop policy if exists "Users manage lead import runs for their workspace" on public.lead_import_runs;
create policy "Users manage lead import runs for their workspace"
on public.lead_import_runs
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = lead_import_runs.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = lead_import_runs.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage leads for their workspace" on public.leads;
create policy "Users manage leads for their workspace"
on public.leads
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = leads.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = leads.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage lead notes for their workspace" on public.lead_notes;
create policy "Users manage lead notes for their workspace"
on public.lead_notes
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = lead_notes.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = lead_notes.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Users manage follow ups for their workspace" on public.follow_ups;
create policy "Users manage follow ups for their workspace"
on public.follow_ups
for all
to authenticated
using (
  exists (
    select 1 from public.workspaces
    where workspaces.id = follow_ups.workspace_id
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.workspaces
    where workspaces.id = follow_ups.workspace_id
      and workspaces.owner_id = auth.uid()
  )
);

grant select, insert, update, delete on public.lead_import_runs to authenticated;
grant select, insert, update, delete on public.leads to authenticated;
grant select, insert, update, delete on public.lead_notes to authenticated;
grant select, insert, update, delete on public.follow_ups to authenticated;
