-- Application-facing identities, reliable mailbox polling, and reply audit fields.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.email
  )
  on conflict (id) do update set
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    email = excluded.email,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute procedure public.handle_new_profile();

insert into public.profiles (id, full_name, email)
select
  id,
  nullif(trim(coalesce(raw_user_meta_data ->> 'full_name', '')), ''),
  email
from auth.users
on conflict (id) do update set
  full_name = coalesce(excluded.full_name, public.profiles.full_name),
  email = excluded.email,
  updated_at = now();

alter table public.profiles enable row level security;

drop policy if exists "Users manage their own profile" on public.profiles;
create policy "Users manage their own profile"
on public.profiles for all to authenticated
using (id = auth.uid())
with check (id = auth.uid());

grant select, insert, update on public.profiles to authenticated;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

alter table public.connected_accounts
  add column if not exists inbox_last_polled_at timestamptz;

alter table public.messages
  add column if not exists responded_at timestamptz,
  add column if not exists response_message_id uuid references public.messages(id) on delete set null;

alter table public.messages
  drop constraint if exists messages_approved_source_check;

alter table public.messages
  add constraint messages_approved_source_check
  check (approved_source in ('individual', 'batch', 'inbox'));

create index if not exists messages_workspace_sent_at_idx
on public.messages(workspace_id, sent_at desc)
where direction = 'outbound' and status = 'sent';
