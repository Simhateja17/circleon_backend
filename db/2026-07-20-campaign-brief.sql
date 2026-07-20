-- Freeze the onboarding context and campaign-specific writing choices at creation time.
-- This keeps an in-flight campaign stable when the workspace agent configuration changes later.
alter table public.campaigns
  add column if not exists brief jsonb not null default '{}'::jsonb;
