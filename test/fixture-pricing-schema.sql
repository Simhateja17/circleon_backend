-- Minimal, isolated PostgreSQL fixture. Never run against an application database.
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create table auth.users(id uuid primary key);
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create table workspaces(id uuid primary key default gen_random_uuid(),owner_id uuid references auth.users(id),name text,plan text);
create table workspace_billing(workspace_id uuid primary key references workspaces(id),plan text,subscription_status text default 'inactive',created_at timestamptz default now());
create table leads(id uuid primary key default gen_random_uuid(),workspace_id uuid references workspaces(id),source text,email text,email_status text,lifecycle_status text);
create table campaigns(id uuid primary key default gen_random_uuid(),workspace_id uuid references workspaces(id),name text,status text,channel text);
create table email_sequences(id uuid primary key default gen_random_uuid(),campaign_id uuid references campaigns(id),step_number integer);
create table calls(id uuid primary key default gen_random_uuid(),workspace_id uuid references workspaces(id),status text,raw_payload jsonb default '{}');
alter table workspaces enable row level security;
alter table workspace_billing enable row level security;
