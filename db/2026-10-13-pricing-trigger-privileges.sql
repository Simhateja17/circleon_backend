-- Trigger functions are invoked by triggers, not public RPC clients.
revoke all on function public.count_pricing_lead() from public,anon,authenticated;
revoke all on function public.enforce_pricing_campaign() from public,anon,authenticated;
revoke all on function public.enforce_pricing_seat() from public,anon,authenticated;
revoke all on function public.apply_pricing_downgrade() from public,anon,authenticated;
revoke all on function public.enforce_pricing_sequence() from public,anon,authenticated;
revoke all on function public.enforce_monthly_call() from public,anon,authenticated;
