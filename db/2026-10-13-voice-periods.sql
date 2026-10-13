begin;
alter table public.billing_usage alter column voice_seconds type numeric using voice_seconds::numeric;
alter table public.billing_usage_events alter column amount type numeric using amount::numeric;
create table public.billing_period_history (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 period_start timestamptz not null,period_end timestamptz not null,
 plan_id text not null references public.pricing_plans(id),is_trial boolean not null default false,
 primary key(workspace_id,period_start),check(period_end>period_start)
);
alter table public.billing_period_history enable row level security;
revoke all on public.billing_period_history from anon,authenticated;
grant all on public.billing_period_history to service_role;
insert into billing_period_history(workspace_id,period_start,period_end,plan_id,is_trial)
 select workspace_id,current_period_start,current_period_end,plan,subscription_status='trialing' from workspace_billing
 where plan in(select id from pricing_plans) and current_period_start is not null and current_period_end>current_period_start;
create function public.snapshot_billing_period() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from pricing_plans where id=new.plan) and new.current_period_start is not null and new.current_period_end>new.current_period_start then
 insert into billing_period_history values(new.workspace_id,new.current_period_start,new.current_period_end,new.plan,new.subscription_status='trialing')
 on conflict(workspace_id,period_start) do update set period_end=excluded.period_end,plan_id=excluded.plan_id,is_trial=excluded.is_trial;
 end if;return new;
end $$;
create trigger snapshot_billing_period after insert or update of current_period_start,current_period_end,plan,subscription_status on workspace_billing for each row execute function snapshot_billing_period();
alter table public.calls add column if not exists billing_period_start timestamptz;
create function public.snapshot_call_period() returns trigger language plpgsql security definer set search_path=public as $$
begin
 select current_period_start into new.billing_period_start from workspace_billing where workspace_id=new.workspace_id and plan in(select id from pricing_plans);
 return new;
end $$;
create trigger snapshot_call_period before insert on calls for each row execute function snapshot_call_period();
create function public.record_voice_period_usage(p_workspace_id uuid,p_call_id uuid,p_allocations jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare a jsonb;h billing_period_history;total numeric:=0;call_row calls;lo timestamptz;hi timestamptz;expected numeric;
begin
 perform 1 from workspace_billing where workspace_id=p_workspace_id for update;
 select * into call_row from calls where id=p_call_id and workspace_id=p_workspace_id;
 if not found or call_row.status<>'completed' or coalesce(call_row.duration_seconds,0)<=0 then raise exception 'Answered call required';end if;
 if exists(select 1 from billing_usage_events where workspace_id=p_workspace_id and event_key='call:'||p_call_id) then return jsonb_build_object('duplicate',true);end if;
 hi:=coalesce(call_row.ended_at,call_row.started_at+call_row.duration_seconds*interval '1 second');lo:=hi-call_row.duration_seconds*interval '1 second';
 if hi is null then raise exception 'Provider call timestamp required';end if;
 for a in select value from jsonb_array_elements(p_allocations) loop
 select * into h from billing_period_history where workspace_id=p_workspace_id and period_start=(a->>'period_start')::timestamptz;
 if not found or h.is_trial or not exists(select 1 from pricing_plans where id=h.plan_id and minutes>0) then raise exception 'Paid voice period required';end if;
 expected:=greatest(0,extract(epoch from least(hi,h.period_end)-greatest(lo,h.period_start)));
 if expected<=0 or abs(expected-(a->>'seconds')::numeric)>0.001 then raise exception 'Invalid call allocation';end if;
 insert into billing_usage(workspace_id,period_start,plan_id,is_trial,voice_seconds) values(p_workspace_id,h.period_start,h.plan_id,false,expected)
 on conflict(workspace_id,period_start) do update set voice_seconds=billing_usage.voice_seconds+excluded.voice_seconds;
 insert into billing_usage_events(workspace_id,event_key,kind,amount,period_start) values(p_workspace_id,'call:'||p_call_id||':'||h.period_start,'voice_seconds',expected,h.period_start);
 total:=total+expected;
 end loop;
 if abs(total-call_row.duration_seconds)>0.001 then raise exception 'Call history coverage incomplete';end if;
 insert into billing_usage_events(workspace_id,event_key,kind,amount,period_start) values(p_workspace_id,'call:'||p_call_id,'voice_seconds',0,coalesce(call_row.billing_period_start,(p_allocations->0->>'period_start')::timestamptz));
 return jsonb_build_object('recorded_seconds',total);
end $$;
revoke all on function public.record_voice_period_usage(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_voice_period_usage(uuid,uuid,jsonb) to service_role;
revoke all on function public.snapshot_billing_period(),public.snapshot_call_period() from public,anon,authenticated;
commit;
