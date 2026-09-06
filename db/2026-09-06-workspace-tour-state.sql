-- Guided product tour progress, one record per workspace.
--
-- This lives as a jsonb blob rather than columns because only the client reads
-- its contents: the backend validates the shape and stamps updatedAt, but never
-- reasons about individual step ids. Adding a field to the tour therefore costs
-- no migration.
--
-- The default is an empty object rather than a populated record so that every
-- existing workspace normalises to `not_started` on first read and gets the
-- tour exactly once, the same as a brand-new one.

alter table public.workspaces
  add column if not exists tour_state jsonb not null default '{}'::jsonb;

comment on column public.workspaces.tour_state is
  'Guided tour progress: { status, lastStepId, lastStepIndex, seenStepIds, updatedAt }. Client-owned shape.';
