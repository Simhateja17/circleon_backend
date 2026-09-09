create table if not exists public.document_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','processing','review','completed','failed')),
  file_count integer not null default 0,
  candidate_count integer not null default 0,
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.document_import_files (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.document_imports(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  size_bytes integer not null,
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  summary text,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.document_lead_candidates (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.document_imports(id) on delete cascade,
  file_id uuid not null references public.document_import_files(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'review' check (status in ('review','approved','rejected','imported')),
  extracted_data jsonb not null default '{}'::jsonb,
  reviewed_data jsonb not null default '{}'::jsonb,
  conflicts jsonb not null default '[]'::jsonb,
  lead_id uuid references public.leads(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists document_imports_workspace_created_idx on public.document_imports(workspace_id, created_at desc);
create index if not exists document_candidates_import_idx on public.document_lead_candidates(import_id, status);

alter table public.document_imports enable row level security;
alter table public.document_import_files enable row level security;
alter table public.document_lead_candidates enable row level security;

create policy "Users manage document imports for their workspace" on public.document_imports for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id=document_imports.workspace_id and workspaces.owner_id=auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id=document_imports.workspace_id and workspaces.owner_id=auth.uid()));
create policy "Users manage document import files for their workspace" on public.document_import_files for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id=document_import_files.workspace_id and workspaces.owner_id=auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id=document_import_files.workspace_id and workspaces.owner_id=auth.uid()));
create policy "Users manage document candidates for their workspace" on public.document_lead_candidates for all to authenticated
using (exists (select 1 from public.workspaces where workspaces.id=document_lead_candidates.workspace_id and workspaces.owner_id=auth.uid()))
with check (exists (select 1 from public.workspaces where workspaces.id=document_lead_candidates.workspace_id and workspaces.owner_id=auth.uid()));

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values
('lead-documents','lead-documents',false,10485760,array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

grant select,insert,update,delete on public.document_imports,public.document_import_files,public.document_lead_candidates to authenticated;
