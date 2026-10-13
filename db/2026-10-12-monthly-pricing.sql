-- CircleOn monthly pricing. Legacy subscriptions are deliberately retained.
begin;
alter table public.campaigns drop constraint if exists campaigns_channel_check;
alter table public.campaigns add constraint campaigns_channel_check check(channel in ('email','voice'));
alter table public.workspace_billing drop constraint if exists workspace_billing_plan_check;
alter table public.workspaces drop constraint if exists workspaces_plan_check;
alter table public.workspace_billing add constraint workspace_billing_plan_check check (plan in ('followup_starter','followup_growth','followup_pro','voice_starter','voice_growth','voice_pro','allinone_starter','allinone_growth','allinone_pro','atelier','maison','sovereign'));
alter table public.workspaces add constraint workspaces_plan_check check (plan in ('followup_starter','followup_growth','followup_pro','voice_starter','voice_growth','voice_pro','allinone_starter','allinone_growth','allinone_pro','atelier','maison','sovereign'));
alter table public.workspace_billing
 add column if not exists checkout_lock_until timestamptz,
 add column if not exists company_trial_key text,
 add column if not exists current_period_start timestamptz,
 add column if not exists trial_start timestamptz,
 add column if not exists trial_end timestamptz,
 add column if not exists founder_until timestamptz,
 add column if not exists founding boolean not null default false,
 add column if not exists setup_charged boolean not null default false,
 add column if not exists payment_failed boolean not null default false,
 add column if not exists voice_ready boolean not null default false,
 add column if not exists voice_approved boolean not null default false,
 add column if not exists trial_approved boolean not null default false,
 add column if not exists trial_extended boolean not null default false,
 add column if not exists extension_consent_at timestamptz,
 add column if not exists lead_overage_cap_cents integer not null default 0 check (lead_overage_cap_cents >= 0),
 add column if not exists voice_overage_cap_cents integer not null default 0 check (voice_overage_cap_cents >= 0),
 add column if not exists pending_plan text,
 add column if not exists fallback_number text;
create table if not exists public.pricing_plans (
 id text primary key, family text not null, name text not null,
 list_cents integer not null, founding_cents integer not null, setup_cents integer not null,
 leads integer not null, emails integer not null, minutes integer not null,
 seats integer not null, campaigns integer, concurrency integer not null, lookup_key text not null
);
insert into public.pricing_plans values ('followup_starter','followup','Follow Up Starter',28900,24900,20000,500,2000,0,1,1,0,'fu_starter') on conflict (id) do nothing;
insert into public.pricing_plans values ('followup_growth','followup','Follow Up Growth',42900,38900,20000,800,3200,0,3,3,0,'fu_growth') on conflict (id) do nothing;
insert into public.pricing_plans values ('followup_pro','followup','Follow Up Pro',69900,65900,20000,1500,6000,0,5,10,0,'fu_pro') on conflict (id) do nothing;
insert into public.pricing_plans values ('voice_starter','voice','Voice Agent Starter',24900,18900,50000,0,0,100,1,null,1,'va_starter') on conflict (id) do nothing;
insert into public.pricing_plans values ('voice_growth','voice','Voice Agent Growth',39900,30900,50000,0,0,300,3,null,2,'va_growth') on conflict (id) do nothing;
insert into public.pricing_plans values ('voice_pro','voice','Voice Agent Pro',59900,46900,50000,0,0,600,5,null,3,'va_pro') on conflict (id) do nothing;
insert into public.pricing_plans values ('allinone_starter','allinone','All-in-one Starter',39900,34900,65000,500,2000,100,1,1,1,'aio_starter') on conflict (id) do nothing;
insert into public.pricing_plans values ('allinone_growth','allinone','All-in-one Growth',64900,54900,65000,800,3200,300,3,3,2,'aio_growth') on conflict (id) do nothing;
insert into public.pricing_plans values ('allinone_pro','allinone','All-in-one Pro',99900,91900,65000,1500,6000,600,5,10,3,'aio_pro') on conflict (id) do nothing;
create table if not exists public.pricing_settings (
 id boolean primary key default true check (id), founding_offer_active boolean not null default true,
 gst_registered boolean not null default false, demo_url text, legal_ready boolean not null default false,
 pdpa_verified boolean not null default false, dnc_verified boolean not null default false
);
insert into public.pricing_settings (id) values (true) on conflict do nothing;
create table if not exists public.company_trials (
 domain text primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
 consumed boolean not null default false, reserved_until timestamptz not null, created_at timestamptz not null default now()
);
create table if not exists public.founding_reservations (
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 state text not null check (state in ('reserved','confirmed','released')),
 expires_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.billing_usage (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 period_start timestamptz not null, plan_id text, is_trial boolean not null default false, billed_invoice_id text, leads integer not null default 0,
 emails integer not null default 0, voice_seconds integer not null default 0,
 primary key (workspace_id, period_start)
);
create table if not exists public.billing_usage_events (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 event_key text not null, kind text not null check(kind in ('leads','emails','voice_seconds')),
 amount integer not null check(amount >= 0), period_start timestamptz not null,
 created_at timestamptz not null default now(), primary key(workspace_id,event_key)
);
create table if not exists public.workspace_members (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 email text not null, user_id uuid references auth.users(id), status text not null default 'pending' check(status in ('pending','active','revoked')),
 created_at timestamptz not null default now(), unique(workspace_id,email)
);
create unique index if not exists one_active_workspace_per_member on public.workspace_members(user_id) where status='active';
create table if not exists public.billing_notifications (
 workspace_id uuid not null references public.workspaces(id) on delete cascade, notification_key text not null,
 subject text not null, body text not null, sent_at timestamptz, created_at timestamptz not null default now(),
 primary key(workspace_id,notification_key)
);
create table if not exists public.demo_requests (
 id uuid primary key default gen_random_uuid(), name text not null, email text not null,
 company text not null, message text, created_at timestamptz not null default now()
);
-- All checkout claims serialize through the singleton settings row.
create or replace function public.claim_pricing_checkout(wid uuid, domain_name text, wants_trial boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare settings pricing_settings; old company_trials; b workspace_billing; r founding_reservations; spots integer;
begin
 select * into settings from pricing_settings where id=true for update;
 insert into workspace_billing(workspace_id) values(wid) on conflict do nothing;
 select * into b from workspace_billing where workspace_id=wid for update;
 if b.checkout_lock_until>now() then raise exception 'Checkout is already opening. Please wait or resume your existing checkout'; end if;
 update workspace_billing set checkout_lock_until=now()+interval '31 minutes' where workspace_id=wid;
 if b.subscription_status in ('active','trialing','past_due','unpaid','incomplete','paused') then raise exception 'Manage your existing subscription from Billing'; end if;
 if wants_trial then
  select * into old from company_trials where domain=domain_name;
  if old.consumed or (old.reserved_until>now() and old.workspace_id<>wid) then raise exception 'This company has already used or reserved its trial'; end if;
  insert into company_trials(domain,workspace_id,reserved_until) values(domain_name,wid,now()+interval '31 minutes')
   on conflict(domain) do update set workspace_id=excluded.workspace_id,reserved_until=excluded.reserved_until;
 end if;
 select * into r from founding_reservations where workspace_id=wid;
 if r.state='confirmed' then return jsonb_build_object('founding',false); end if;
 select count(*) into spots from founding_reservations where state in ('confirmed','reserved');
 if settings.founding_offer_active and (spots<20 or r.state='reserved') then
  insert into founding_reservations(workspace_id,state,expires_at) values(wid,'reserved',now()+interval '31 minutes')
   on conflict(workspace_id) do update set state='reserved',expires_at=excluded.expires_at;
  return jsonb_build_object('founding',true);
 end if;
 return jsonb_build_object('founding',false);
end $$;
-- A ledger entry and its allowance check share one billing-row lock.
create or replace function public.consume_plan_usage(wid uuid, usage_kind text, quantity integer, usage_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b workspace_billing; p pricing_plans; u billing_usage; start_at timestamptz;
 max_leads integer; max_emails integer; max_seconds integer; trial boolean;
begin
 if quantity<0 or usage_kind not in ('leads','emails','voice_seconds') then raise exception 'Invalid usage'; end if;
 select * into b from workspace_billing where workspace_id=wid for update;
 select * into p from pricing_plans where id=b.plan;
 if p.id is null then return jsonb_build_object('legacy',true); end if;
 if usage_kind<>'voice_seconds' and (b.subscription_status not in ('active','trialing') or b.payment_failed or
    (b.subscription_status='trialing' and b.trial_end<=now())) then raise exception 'Subscription is not active'; end if;
 if exists(select 1 from billing_usage_events where workspace_id=wid and event_key=usage_key) then return jsonb_build_object('duplicate',true); end if;
 trial:=b.subscription_status='trialing';
 if usage_kind='voice_seconds' and (trial or p.minutes=0) then raise exception 'Voice is unavailable on this subscription'; end if;
 if usage_kind in ('leads','emails') and p.family='voice' then raise exception 'Email outreach is not included'; end if;
 start_at:=case when trial then b.trial_start else b.current_period_start end;
 if start_at is null then raise exception 'Billing period is not synchronized'; end if;
 insert into billing_usage(workspace_id,period_start,plan_id,is_trial) values(wid,start_at,b.plan,trial) on conflict do nothing;
 select * into u from billing_usage where workspace_id=wid and period_start=start_at for update;
 max_leads:=case when trial then 50 else p.leads+floor(b.lead_overage_cap_cents/100.0)::integer end;
 max_emails:=case when trial then 200 else p.emails+greatest(0,u.leads-p.leads)*4 end;
 max_seconds:=case when trial then 0 else (p.minutes+floor(b.voice_overage_cap_cents/60.0)::integer)*60 end;
 if usage_kind='leads' and u.leads+quantity>max_leads then raise exception 'Lead allowance reached'; end if;
 if usage_kind='emails' and u.emails+quantity>max_emails then raise exception 'Email allowance reached'; end if;
 -- Connected calls are allowed to finish; this records actual duration.
 update billing_usage set leads=leads+case when usage_kind='leads' then quantity else 0 end,
 emails=emails+case when usage_kind='emails' then quantity else 0 end,
 voice_seconds=voice_seconds+case when usage_kind='voice_seconds' then quantity else 0 end
 where workspace_id=wid and period_start=start_at;
 insert into billing_usage_events(workspace_id,event_key,kind,amount,period_start) values(wid,usage_key,usage_kind,quantity,start_at);
 return jsonb_build_object('accepted',true);
end $$;
create or replace function public.release_email_usage(wid uuid, usage_key text) returns void
language plpgsql security definer set search_path=public as $$
declare e billing_usage_events;
begin
 perform 1 from workspace_billing where workspace_id=wid for update;
 delete from billing_usage_events where workspace_id=wid and event_key=usage_key and kind='emails' returning * into e;
 if found then update billing_usage set emails=greatest(0,emails-e.amount) where workspace_id=wid and period_start=e.period_start; end if;
end $$;
create or replace function public.count_pricing_lead() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.source in ('apollo','apollo_fallback') and new.email is not null and new.email_status='verified' and new.lifecycle_status='ready'
 and (TG_OP='INSERT' or old.lifecycle_status is distinct from 'ready') then
  perform consume_plan_usage(new.workspace_id,'leads',1,'lead-email:'||lower(trim(new.email)));
 end if;
 return new;
end $$;
drop trigger if exists count_pricing_lead on public.leads;
create trigger count_pricing_lead before insert or update on public.leads for each row execute function count_pricing_lead();
create or replace function public.enforce_pricing_campaign() returns trigger language plpgsql security definer set search_path=public as $$
declare p pricing_plans; n integer;
begin
 if new.status='active' and (TG_OP='INSERT' or old.status is distinct from 'active') then
  perform 1 from workspace_billing where workspace_id=new.workspace_id for update;
  select p1.* into p from pricing_plans p1 join workspace_billing b on b.plan=p1.id where b.workspace_id=new.workspace_id;
  if p.campaigns is not null then
   select count(*) into n from campaigns where workspace_id=new.workspace_id and status='active' and id<>new.id;
   if n>=p.campaigns then raise exception 'Active campaign limit reached'; end if;
  end if;
 end if;
 return new;
end $$;
drop trigger if exists enforce_pricing_campaign on public.campaigns;
create trigger enforce_pricing_campaign before insert or update on public.campaigns for each row execute function enforce_pricing_campaign();
create or replace function public.enforce_pricing_seat() returns trigger language plpgsql security definer set search_path=public as $$
declare p pricing_plans; n integer;
begin
 if new.status in ('pending','active') then
  perform 1 from workspace_billing where workspace_id=new.workspace_id for update;
  select p1.* into p from pricing_plans p1 join workspace_billing b on b.plan=p1.id where b.workspace_id=new.workspace_id;
  if p.id is null then raise exception 'Team invitations require a monthly plan'; end if;
  select count(*)+1 into n from workspace_members where workspace_id=new.workspace_id and status in ('pending','active') and id<>new.id;
  if n>=p.seats then raise exception 'User seat limit reached'; end if;
 end if;
 return new;
end $$;
drop trigger if exists enforce_pricing_seat on public.workspace_members;
create trigger enforce_pricing_seat before insert or update on public.workspace_members for each row execute function enforce_pricing_seat();
-- Requests can read their own billing data; all mutation stays in the backend.
alter table public.pricing_plans enable row level security;
alter table public.pricing_settings enable row level security;
alter table public.company_trials enable row level security;
alter table public.founding_reservations enable row level security;
alter table public.billing_usage enable row level security;
alter table public.billing_usage_events enable row level security;
alter table public.workspace_members enable row level security;
alter table public.billing_notifications enable row level security;
alter table public.demo_requests enable row level security;
create policy "Owner reads billing_usage" on public.billing_usage for select to authenticated using (exists(select 1 from public.workspaces where id=billing_usage.workspace_id and owner_id=auth.uid()));
grant select on public.billing_usage to authenticated;
create policy "Owner reads workspace_members" on public.workspace_members for select to authenticated using (exists(select 1 from public.workspaces where id=workspace_members.workspace_id and owner_id=auth.uid()));
grant select on public.workspace_members to authenticated;
create policy "Owner reads billing_notifications" on public.billing_notifications for select to authenticated using (exists(select 1 from public.workspaces where id=billing_notifications.workspace_id and owner_id=auth.uid()));
grant select on public.billing_notifications to authenticated;
revoke all on function public.claim_pricing_checkout(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_pricing_checkout(uuid,text,boolean) to service_role;
revoke all on function public.consume_plan_usage(uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.consume_plan_usage(uuid,text,integer,text) to service_role;
revoke all on function public.release_email_usage(uuid,text) from public,anon,authenticated;
grant execute on function public.release_email_usage(uuid,text) to service_role;
create table if not exists public.billing_plan_changes (
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 plan text not null references public.pricing_plans(id), keep_member_ids uuid[] not null default '{}', keep_campaign_ids uuid[] not null default '{}'
);
alter table public.billing_plan_changes enable row level security;
create or replace function public.apply_pricing_downgrade() returns trigger language plpgsql security definer set search_path=public as $$
declare c billing_plan_changes;
begin
 if new.plan is distinct from old.plan then
  if new.current_period_start is not distinct from old.current_period_start then
   update billing_usage set plan_id=new.plan where workspace_id=new.workspace_id and period_start=new.current_period_start;
  end if;
  select * into c from billing_plan_changes where workspace_id=new.workspace_id and plan=new.plan;
  if found then
   update workspace_members set status='revoked',user_id=null where workspace_id=new.workspace_id and not(id=any(c.keep_member_ids));
   if (select campaigns is not null from pricing_plans where id=new.plan) then
    update campaigns set status='paused' where workspace_id=new.workspace_id and status='active' and not(id=any(c.keep_campaign_ids));
   end if;
   delete from billing_plan_changes where workspace_id=new.workspace_id;
  end if;
 end if;
 return new;
end $$;
create trigger apply_pricing_downgrade after update on public.workspace_billing for each row execute function apply_pricing_downgrade();
-- Membership is explicit and never inferred from an email domain.
create or replace function public.is_workspace_member(wid uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from workspace_members where workspace_id=wid and user_id=auth.uid() and status='active');
$$;
revoke all on function public.is_workspace_member(uuid) from public,anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
create policy "Members read workspace" on public.workspaces for select to authenticated using(is_workspace_member(id));
create policy "Members read billing" on public.workspace_billing for select to authenticated using(is_workspace_member(workspace_id));
create policy "Members read usage" on public.billing_usage for select to authenticated using(is_workspace_member(workspace_id));
create policy "Members read memberships" on public.workspace_members for select to authenticated using(user_id=auth.uid() or is_workspace_member(workspace_id));
-- Add member access only to operational tables already granting authenticated
-- writes. Never broaden owner-only billing, settings, or membership mutations.
do $$ declare t text; begin
 foreach t in array array['leads','campaigns','campaign_leads','messages','email_sequences','agent_configs','connected_accounts','lead_import_runs','calls','call_outcomes','meetings','lead_suppressions','voice_scripts','voice_agents','voice_call_targets','workspace_telephony','workspace_autopilot_settings'] loop
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='workspace_id') then
   execute format('create policy "Team operational access" on public.%I for all to authenticated using(is_workspace_member(workspace_id)) with check(is_workspace_member(workspace_id))',t);
  end if;
 end loop;
end $$;
create policy "Team manages campaign sequences" on public.email_sequences for all to authenticated
using (exists(select 1 from public.campaigns c where c.id=email_sequences.campaign_id and is_workspace_member(c.workspace_id)))
with check (exists(select 1 from public.campaigns c where c.id=email_sequences.campaign_id and is_workspace_member(c.workspace_id)));
create or replace function public.enforce_pricing_sequence() returns trigger language plpgsql security definer set search_path=public as $$
declare pid text;
begin
 select b.plan into pid from campaigns c join workspace_billing b on b.workspace_id=c.workspace_id where c.id=new.campaign_id;
 if exists(select 1 from pricing_plans where id=pid) and new.step_number>4 then raise exception 'Monthly plans allow an initial email and three follow-ups'; end if;
 return new;
end $$;
create trigger enforce_pricing_sequence before insert or update on public.email_sequences for each row execute function enforce_pricing_sequence();
create or replace function public.enforce_monthly_call() returns trigger language plpgsql security definer set search_path=public as $$
declare b workspace_billing; p pricing_plans; u billing_usage; n integer;
begin
 if new.status in ('queued','calling','ringing','in_progress') and (TG_OP='INSERT' or old.status not in ('queued','calling','ringing','in_progress')) then
  select * into b from workspace_billing where workspace_id=new.workspace_id for update;
  select * into p from pricing_plans where id=b.plan;
  if p.id is null then return new; end if;
  if b.subscription_status<>'active' or b.payment_failed or not b.voice_ready or p.minutes=0 then raise exception 'Paid voice is not ready';end if;
  select * into u from billing_usage where workspace_id=new.workspace_id and period_start=b.current_period_start;
  if coalesce(u.voice_seconds,0)>=(p.minutes+floor(b.voice_overage_cap_cents/60.0)::integer)*60 then raise exception 'Voice allowance reached';end if;
  select count(*) into n from calls where workspace_id=new.workspace_id and status in ('queued','calling','ringing','in_progress') and id<>new.id;
  if n>=p.concurrency then raise exception 'Concurrent call limit reached';end if;
 end if;
 return new;
end $$;
do $$ begin if to_regclass('public.calls') is not null then
 create trigger enforce_monthly_call before insert or update on public.calls for each row execute function enforce_monthly_call();
 create unique index monthly_twilio_call_unique on public.calls(workspace_id,(raw_payload->>'twilio_call_sid')) where raw_payload->>'twilio_call_sid' is not null;
end if;end $$;
commit;
