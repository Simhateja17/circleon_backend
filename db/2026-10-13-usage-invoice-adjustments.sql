begin;
alter table public.billing_usage add column if not exists billed_leads_cents integer not null default 0, add column if not exists billed_voice_cents integer not null default 0;
-- Existing settled rows already collected their then-current allowance overage.
update public.billing_usage u set billed_leads_cents=greatest(0,u.leads-p.leads)*100,billed_voice_cents=greatest(0,ceil(u.voice_seconds/60.0)-p.minutes)::integer*60 from public.pricing_plans p where p.id=u.plan_id and u.billed_invoice_id is not null and not u.is_trial;
create table public.usage_invoice_charges (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),period_start timestamptz not null,
 kind text not null check(kind in ('leads','voice')),invoice_id text not null,amount integer not null check(amount>0),target_amount integer not null,
 status text not null default 'pending' check(status in ('pending','committed')),created_at timestamptz not null default now(),
 unique(workspace_id,period_start,kind,target_amount)
);
alter table public.usage_invoice_charges enable row level security;
revoke all on public.usage_invoice_charges from anon,authenticated;
grant all on public.usage_invoice_charges to service_role;
create or replace function public.claim_usage_invoice(p_workspace_id uuid,p_boundary timestamptz,p_invoice_id text) returns setof public.usage_invoice_charges language plpgsql security definer set search_path=public as $$
declare u billing_usage;p pricing_plans;v_kind text;total integer;held integer;
begin
 perform 1 from workspace_billing where workspace_id=p_workspace_id for update;
 for u in select * from billing_usage where workspace_id=p_workspace_id and period_start<p_boundary and not is_trial for update loop
  select * into p from pricing_plans where id=u.plan_id;
  if p.id is null then continue;end if;
  foreach v_kind in array array['leads','voice'] loop
   total:=case when v_kind='leads' then greatest(0,u.leads-p.leads)*100 else greatest(0,ceil(u.voice_seconds/60.0)-p.minutes)::integer*60 end;
   select coalesce(sum(amount),0) into held from usage_invoice_charges c where c.workspace_id=u.workspace_id and c.period_start=u.period_start and c.kind=v_kind and c.status='pending';
   held:=held+case when v_kind='leads' then u.billed_leads_cents else u.billed_voice_cents end;
   if total>held then insert into usage_invoice_charges(workspace_id,period_start,kind,invoice_id,amount,target_amount) values(u.workspace_id,u.period_start,v_kind,p_invoice_id,total-held,total);end if;
  end loop;
 end loop;
 return query select * from usage_invoice_charges c where c.invoice_id=p_invoice_id and c.workspace_id=p_workspace_id and c.status='pending';
end $$;
create or replace function public.commit_usage_invoice_charge(p_charge_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare c usage_invoice_charges;
begin
 perform 1 from workspace_billing where workspace_id=(select workspace_id from usage_invoice_charges where id=p_charge_id) for update;
 select * into c from usage_invoice_charges where id=p_charge_id for update;
 if c.id is null or c.status='committed' then return;end if;
 update billing_usage set billed_leads_cents=billed_leads_cents+case when c.kind='leads' then c.amount else 0 end,billed_voice_cents=billed_voice_cents+case when c.kind='voice' then c.amount else 0 end,billed_invoice_id=c.invoice_id where workspace_id=c.workspace_id and period_start=c.period_start;
 update usage_invoice_charges set status='committed' where id=c.id;
end $$;
revoke all on function public.claim_usage_invoice(uuid,timestamptz,text),public.commit_usage_invoice_charge(uuid) from public,anon,authenticated;
grant execute on function public.claim_usage_invoice(uuid,timestamptz,text),public.commit_usage_invoice_charge(uuid) to service_role;
alter table public.billing_settlements drop constraint billing_settlements_pkey;
alter table public.billing_settlements add column revision integer not null default 1;
alter table public.billing_settlements add primary key(subscription_id,revision);
commit;
