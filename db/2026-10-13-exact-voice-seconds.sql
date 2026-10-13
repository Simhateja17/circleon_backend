begin;
alter table public.billing_usage alter column voice_seconds type numeric;
alter table public.billing_usage_events alter column amount type numeric;
alter table public.calls alter column duration_seconds type numeric;
drop function public.consume_plan_usage(uuid,text,integer,text);
create or replace function public.consume_plan_usage(wid uuid, usage_kind text, quantity numeric, usage_key text)
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
revoke all on function public.consume_plan_usage(uuid,text,numeric,text) from public,anon,authenticated;
grant execute on function public.consume_plan_usage(uuid,text,numeric,text) to service_role;
commit;
