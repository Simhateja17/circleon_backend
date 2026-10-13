begin;
-- Requires 2026-09-16-voice-campaigns.sql and monthly pricing migrations.
-- Legacy campaign agents remain untouched; a separate scope owns monthly agents.
alter table public.voice_agents
 add column if not exists shared_scope boolean not null default false,
 add column if not exists inbound_prompt text,
 add column if not exists inbound_opening_line text,
 add column if not exists inbound_language text not null default 'en-US',
 add column if not exists inbound_approved_at timestamptz,
 add column if not exists inbound_approved_by uuid references auth.users(id);
alter table public.voice_scripts add column if not exists voice_id text;
-- A nonpartial unique index has the same null behavior and is inferable by
-- PostgREST upsert(onConflict:'campaign_id') for legacy campaign rows.
drop index if exists public.voice_agents_campaign_unique;
create unique index voice_agents_campaign_unique on public.voice_agents(campaign_id);
grant execute on function public.charge_call_credits(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.add_call_credits(uuid,integer,text,text) to service_role;
create unique index if not exists voice_agents_monthly_workspace_unique on public.voice_agents(workspace_id) where shared_scope;
alter table public.voice_agents add constraint voice_agents_shared_not_campaign check (not shared_scope or campaign_id is null);
create or replace function public.protect_shared_voice_agent() returns trigger language plpgsql set search_path=public as $$
begin
 if coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' and current_user not in ('postgres','service_role') and (case when TG_OP='DELETE' then OLD.shared_scope else NEW.shared_scope or (TG_OP='UPDATE' and OLD.shared_scope) end) then
  raise exception 'Monthly workspace agent is managed by the service';
 end if;
 if TG_OP='DELETE' then return OLD; end if; return NEW;
end $$;
create trigger protect_shared_voice_agent before insert or update or delete on public.voice_agents for each row execute function public.protect_shared_voice_agent();
-- Database serialization prevents duplicate external creates across server processes.
-- An error/provisioning row is intentionally not reclaimed automatically: a lost
-- provider response must be reconciled before another resource can be created.
create or replace function public.claim_workspace_voice_agent(p_workspace_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.voice_agents; created boolean:=false;
begin
 perform 1 from public.workspace_billing where workspace_id=p_workspace_id and plan in ('voice_starter','voice_growth','voice_pro','allinone_starter','allinone_growth','allinone_pro') for update;
 if not found then raise exception 'Monthly plan required'; end if;
 select * into a from public.voice_agents where workspace_id=p_workspace_id and shared_scope;
 if not found then
  insert into public.voice_agents(workspace_id,shared_scope,status,prompt_version) values(p_workspace_id,true,'provisioning',1) returning * into a; created:=true;
 end if;
 return jsonb_build_object('claimed',created,'agent',to_jsonb(a));
end $$;
revoke all on function public.claim_workspace_voice_agent(uuid) from public,anon,authenticated;
grant execute on function public.claim_workspace_voice_agent(uuid) to service_role;
commit;
