-- Dashboard workflow contract: curated enrichment, editable sequence intent,
-- explicit approval provenance, and import terminal timestamps.

alter table public.leads
  add column if not exists personalization_profile jsonb not null default '{}'::jsonb,
  add column if not exists personalization_profile_version integer not null default 1;

alter table public.email_sequences
  add column if not exists ai_instruction text not null default '';

update public.email_sequences
set ai_instruction = case step_number
  when 1 then 'Write a concise first touch. Use one factual, relevant company insight and invite a short conversation.'
  when 2 then 'Write a brief follow-up that adds one useful angle without repeating the first email.'
  else 'Write a polite final follow-up with a low-pressure close.'
end
where ai_instruction = '';

alter table public.messages
  add column if not exists manually_edited_at timestamptz,
  add column if not exists manually_edited_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_source text not null default 'individual'
    check (approved_source in ('individual', 'batch'));

alter table public.lead_import_runs
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists timeout_at timestamptz,
  add column if not exists progress jsonb not null default '{}'::jsonb;

create index if not exists leads_workspace_personalization_profile_idx
on public.leads(workspace_id)
where personalization_profile <> '{}'::jsonb;
