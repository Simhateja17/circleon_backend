alter table public.workspaces
add column if not exists onboarding_step integer not null default 0;
