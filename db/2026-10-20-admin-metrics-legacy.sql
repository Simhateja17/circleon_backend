-- Workspaces on pre-launch plans (atelier, maison) are not in pricing_plans.
-- Counting them as paying put "Paying 7" next to "MRR S$0"; report them apart.
begin;
create or replace function public.admin_metrics() returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object(
  'workspaces', (select count(*) from workspaces),
  'signups_7d', (select count(*) from workspaces where created_at>=now()-interval '7 days'),
  'signups_30d', (select count(*) from workspaces where created_at>=now()-interval '30 days'),
  'paying', (select count(*) from workspace_billing b join pricing_plans p on p.id=b.plan where b.subscription_status='active' and b.suspended_at is null),
  'legacy', (select count(*) from workspace_billing b where b.plan is not null and not exists (select 1 from pricing_plans p where p.id=b.plan)),
  'trialing', (select count(*) from workspace_billing where subscription_status='trialing' and suspended_at is null),
  'suspended', (select count(*) from workspace_billing where suspended_at is not null),
  'payment_failed', (select count(*) from workspace_billing where payment_failed),
  'mrr_cents', (select coalesce(sum(case when b.founding then p.founding_cents else p.list_cents end),0)
    from workspace_billing b join pricing_plans p on p.id=b.plan
    where b.subscription_status='active' and not b.payment_failed and b.suspended_at is null),
  'active_campaigns', (select count(*) from campaigns where status='active'),
  'emails_sent_30d', (select count(*) from messages where status in ('sent','auto_sent') and created_at>=now()-interval '30 days'),
  'voice_minutes_30d', (select coalesce(round(sum(amount)/60.0),0) from billing_usage_events where kind='voice_seconds' and created_at>=now()-interval '30 days'),
  'open_tickets', (select count(*) from support_tickets where status='open')
 );
$$;
revoke all on function public.admin_metrics() from public,anon,authenticated;
grant execute on function public.admin_metrics() to service_role;
commit;
