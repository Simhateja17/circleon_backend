-- Real-schema membership checks; creates no lasting users or operational rows.
begin;
do $$ declare owner_id uuid:=gen_random_uuid(); teammate_id uuid:=gen_random_uuid(); stranger_id uuid:=gen_random_uuid(); wid uuid:=gen_random_uuid(); other_wid uuid:=gen_random_uuid(); cid uuid;
begin
 insert into auth.users(id,email) values(owner_id,'pricing-'||owner_id||'@example.invalid'),(teammate_id,'pricing-'||teammate_id||'@example.invalid'),(stranger_id,'pricing-'||stranger_id||'@example.invalid');
 insert into workspaces(id,owner_id,name) values(wid,owner_id,'Pricing RLS test'),(other_wid,stranger_id,'Other RLS test');
 insert into workspace_billing(workspace_id,plan,subscription_status,current_period_start) values(wid,'followup_growth','active',now()),(other_wid,'followup_growth','active',now());
 insert into workspace_members(workspace_id,email,user_id,status) values(wid,'pricing-'||teammate_id||'@example.invalid',teammate_id,'active');
 insert into campaigns(workspace_id,name) values(wid,'Member campaign') returning id into cid;
 perform set_config('request.jwt.claim.sub',teammate_id::text,true);
 perform set_config('pricing.test.workspace',wid::text,true);
 perform set_config('pricing.test.other_workspace',other_wid::text,true);
 perform set_config('pricing.test.campaign',cid::text,true);
end $$;
set local role authenticated;
do $$ declare wid uuid:=current_setting('pricing.test.workspace')::uuid; other_wid uuid:=current_setting('pricing.test.other_workspace')::uuid; denied boolean:=false;
begin
 if not exists(select 1 from workspaces where id=wid) then raise exception 'Member cannot read own workspace'; end if;
 if exists(select 1 from workspaces where id=other_wid) then raise exception 'Cross-workspace visibility'; end if;
 if not exists(select 1 from workspace_billing where workspace_id=wid) then raise exception 'Member cannot read billing'; end if;
 insert into email_sequences(campaign_id,step_number,name) values(current_setting('pricing.test.campaign')::uuid,1,'Member-created first email');
 begin perform claim_pricing_checkout(wid,'evil.example.invalid',false); exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'Member can bypass billing RPC authorization'; end if;
 if exists(select 1 from pricing_settings) then raise exception 'Member can read private settings'; end if;
end $$;
reset role;
select 'PASS: member workspace/billing access, sequence writes, cross-workspace isolation and private billing RPC' as result;
rollback;
