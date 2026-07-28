alter table public.email_sequences
  add column if not exists attachments jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-attachments',
  'campaign-attachments',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Workspace members can view campaign attachments" on storage.objects;
create policy "Workspace members can view campaign attachments"
on storage.objects for select to authenticated
using (
  bucket_id = 'campaign-attachments'
  and exists (
    select 1 from public.campaigns
    join public.workspaces on workspaces.id = campaigns.workspace_id
    where campaigns.id::text = (storage.foldername(storage.objects.name))[1]
      and workspaces.owner_id = auth.uid()
  )
);

drop policy if exists "Workspace members can manage campaign attachments" on storage.objects;
create policy "Workspace members can manage campaign attachments"
on storage.objects for all to authenticated
using (
  bucket_id = 'campaign-attachments'
  and exists (
    select 1 from public.campaigns
    join public.workspaces on workspaces.id = campaigns.workspace_id
    where campaigns.id::text = (storage.foldername(storage.objects.name))[1]
      and workspaces.owner_id = auth.uid()
  )
)
with check (
  bucket_id = 'campaign-attachments'
  and exists (
    select 1 from public.campaigns
    join public.workspaces on workspaces.id = campaigns.workspace_id
    where campaigns.id::text = (storage.foldername(storage.objects.name))[1]
      and workspaces.owner_id = auth.uid()
  )
);
