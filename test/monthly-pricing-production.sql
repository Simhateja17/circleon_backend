-- Runs against the real application schema. All test rows roll back.
begin;
do $$ declare w uuid; i integer; n integer; p jsonb; trial_w uuid; paid_w uuid; failed boolean; c uuid; baseline integer;
begin
 select count(*) into baseline from founding_reservations where state in ('reserved','confirmed');
 for i in 1..22 loop
  insert into auth.users(id,email) values(gen_random_uuid(),'pricing-'||gen_random_uuid()||'@example.invalid') returning id into w;
  insert into workspaces(id,owner_id,name) values(w,w,'Founding test '||i) returning id into w;
  p:=claim_pricing_checkout(w,'pricing-test-founder-'||i||'.example.invalid',true);
 end loop;
 select count(*) into n from founding_reservations where state in ('reserved','confirmed');
 if n<>20 then raise exception 'Expected exactly 20 reserved spots, got %',n; end if;
 insert into auth.users(id,email) values(gen_random_uuid(),'pricing-'||gen_random_uuid()||'@example.invalid') returning id into w;
 insert into workspaces(id,owner_id,name) values(w,w,'Trial test') returning id into trial_w;
 insert into workspace_billing(workspace_id,plan,subscription_status,trial_start,trial_end,current_period_start,lead_overage_cap_cents) values(trial_w,'allinone_pro','trialing',now()-interval '1 day',now()+interval '6 days',now()-interval '1 day',100000);
 insert into leads(workspace_id,source,full_name,email,email_status,lifecycle_status) values
 (trial_w,'apollo','Verified lead','verified@example.invalid','verified','ready'),
 (trial_w,'apollo','Duplicate verified lead','VERIFIED@example.invalid','verified','ready'),
 (trial_w,'apollo','Unverified lead','unknown@example.invalid','unverified','ready'),
 (trial_w,'csv','Uploaded lead','uploaded@example.invalid','verified','ready');
 select leads into n from billing_usage where workspace_id=trial_w;
 if n<>1 then raise exception 'Only unique verified provider leads should consume allowance, got %',n; end if;
 perform consume_plan_usage(trial_w,'leads',49,'trial-leads');
 perform consume_plan_usage(trial_w,'leads',49,'trial-leads');
 failed:=false;begin perform consume_plan_usage(trial_w,'leads',1,'too-many');exception when others then if position('Lead allowance reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Trial lead limit failed';end if;
 perform consume_plan_usage(trial_w,'emails',200,'trial-emails');
 failed:=false;begin perform consume_plan_usage(trial_w,'emails',1,'too-many-emails');exception when others then if position('Email allowance reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Trial email limit failed';end if;
 failed:=false;begin perform consume_plan_usage(trial_w,'voice_seconds',1,'trial-voice');exception when others then if position('Voice is unavailable' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Trial voice was allowed';end if;
 insert into auth.users(id,email) values(gen_random_uuid(),'pricing-'||gen_random_uuid()||'@example.invalid') returning id into w;
 insert into workspaces(id,owner_id,name) values(w,w,'Paid test') returning id into paid_w;
 insert into workspace_billing(workspace_id,plan,subscription_status,current_period_start,voice_ready,lead_overage_cap_cents) values(paid_w,'allinone_starter','active',now(),true,200);
 perform consume_plan_usage(paid_w,'leads',502,'paid-leads');
 perform consume_plan_usage(paid_w,'emails',2008,'paid-emails');
 failed:=false;begin perform consume_plan_usage(paid_w,'leads',1,'over-cap');exception when others then if position('Lead allowance reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Lead spend cap failed';end if;
 failed:=false;begin perform consume_plan_usage(paid_w,'emails',1,'over-email');exception when others then if position('Email allowance reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Email bundle limit failed';end if;
 failed:=false;begin insert into workspace_members(workspace_id,email) values(paid_w,'teammate@example.com');exception when others then if position('User seat limit reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Owner seat was not counted';end if;
 insert into campaigns(workspace_id,name,status,channel) values(paid_w,'Email campaign','active','email') returning id into c;
 failed:=false;begin insert into campaigns(workspace_id,name,status,channel) values(paid_w,'Voice campaign','active','voice');exception when others then if position('Active campaign limit reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Combined campaign cap failed';end if;
 failed:=false;begin insert into email_sequences(campaign_id,step_number,name) values(c,5,'Fifth email');exception when others then if position('Monthly plans allow' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Fifth email was allowed';end if;
 insert into calls(workspace_id,status) values(paid_w,'queued');
 failed:=false;begin insert into calls(workspace_id,status) values(paid_w,'queued');exception when others then if position('Concurrent call limit reached' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Concurrent call cap failed';end if;
 update workspace_billing set payment_failed=true where workspace_id=paid_w;
 update calls set status='completed' where workspace_id=paid_w;
 failed:=false;begin insert into calls(workspace_id,status) values(paid_w,'queued');exception when others then if position('Paid voice is not ready' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Failed payment permitted a new call';end if;
 perform consume_plan_usage(paid_w,'voice_seconds',30,'finishing-call');
 select workspace_id into w from company_trials where domain='pricing-test-founder-1.example.invalid';
 update company_trials set consumed=true where workspace_id=w;
 update workspace_billing set checkout_lock_until=null where workspace_id=w;
 failed:=false;begin perform claim_pricing_checkout(w,(select domain from company_trials where workspace_id=w),true);exception when others then if position('This company has already used' in sqlerrm)=0 then raise; end if; failed:=true;end;
 if not failed then raise exception 'Repeat company trial allowed';end if;
 raise notice 'PASS: founding capacity, trial quotas, idempotency, paid caps, included email bundles, seat limits, shared campaigns, four-step sequences, failed-payment gating, company deduplication';
end $$;
select 'PASS: live-schema pricing invariants; test changes rolled back' as result;
rollback;
