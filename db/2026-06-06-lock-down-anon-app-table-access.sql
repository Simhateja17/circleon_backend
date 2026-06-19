revoke all on table public.workspaces from anon;
revoke all on table public.agent_configs from anon;
revoke all on table public.lead_import_runs from anon;
revoke all on table public.leads from anon;
revoke all on table public.lead_notes from anon;
revoke all on table public.follow_ups from anon;

grant select, insert, update, delete on table public.workspaces to authenticated;
grant select, insert, update, delete on table public.agent_configs to authenticated;
grant select, insert, update, delete on table public.lead_import_runs to authenticated;
grant select, insert, update, delete on table public.leads to authenticated;
grant select, insert, update, delete on table public.lead_notes to authenticated;
grant select, insert, update, delete on table public.follow_ups to authenticated;
