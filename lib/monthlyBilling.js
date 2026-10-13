const Stripe = require('stripe');
const { createServiceClient } = require('./supabase');
const { plans, byId, companyDomain, WEBMAIL, limits, voiceOverageCents } = require('./pricing');
function service() { const db = createServiceClient(); if (!db) throw new Error('Billing requires the service database connection.'); return db; }
function stripeClient() { if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.'); return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover' }); }
async function result(query) { const { data, error } = await query; if (error) throw error; return data; }
async function settings(db = service()) { return result(db.from('pricing_settings').select('*').eq('id', true).single()); }
async function publicCatalog(db = service()) {
  const config = await settings(db);
  const reservations = await result(db.from('founding_reservations').select('state,expires_at').in('state', ['confirmed', 'reserved']));
  const used = reservations.length;
  const left = Math.max(0, 20 - used);
  return { plans, offer: { active: config.founding_offer_active && left > 0, spotsLeft: left }, demoUrl: config.demo_url, gstRegistered: config.gst_registered, legalReady: config.legal_ready, trust: { pdpa: config.pdpa_verified, dnc: config.dnc_verified } };
}
async function findPrice(stripe, lookupKey, expectedCents) {
  const response = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = response.data[0];
  if (!price || price.currency !== 'sgd' || (expectedCents !== undefined && price.unit_amount !== expectedCents)) throw new Error(`Stripe price needs configuration: ${lookupKey}`);
  return price;
}
function periodStart(b) { return b.subscription_status === 'trialing' ? b.trial_start : b.current_period_start; }
async function usage(db, billing) {
  const plan = limits(billing);
  if (!plan) return null;
  const row = periodStart(billing) ? await result(db.from('billing_usage').select('*').eq('workspace_id', billing.workspace_id).eq('period_start', periodStart(billing)).maybeSingle()) : null;
  const used = { leads: row?.leads || 0, emails: row?.emails || 0, minutes: Math.ceil((row?.voice_seconds || 0) / 60) };
  return { used, limits: { leads: plan.leads, emails: plan.emails + (plan.trial ? 0 : Math.max(0, used.leads - plan.leads) * 4), minutes: plan.minutes, seats: plan.seats, campaigns: plan.campaigns, concurrency: plan.concurrency }, overage: { leadsCents: Math.max(0, used.leads - plan.leads) * 100, voiceCents: voiceOverageCents(row?.voice_seconds, plan.minutes) }, periodStart: periodStart(billing), periodEnd: plan.trial ? billing.trial_end : billing.current_period_end };
}
async function consumeUsage(db, workspaceId, kind, quantity, eventKey) {
  return result(db.rpc('consume_plan_usage', { wid: workspaceId, usage_kind: kind, quantity, usage_key: eventKey }));
}
async function voiceAccess(db, workspaceId) {
  const billing = await result(db.from('workspace_billing').select('*').eq('workspace_id', workspaceId).maybeSingle());
  const plan = limits(billing);
  if (!plan) return null;
  if (!['active'].includes(billing.subscription_status) || billing.payment_failed || !billing.voice_ready || !plan.minutes) return { ok: false, reason: 'Voice requires a paid, ready voice subscription.', concurrency: 0 };
  const current = await usage(db, billing);
  const allowed = plan.minutes + Math.floor(billing.voice_overage_cap_cents / 60);
  return { ok: current.used.minutes < allowed, reason: current.used.minutes < allowed ? null : 'Voice allowance reached.', concurrency: plan.concurrency, balanceCents: Math.max(0, allowed - current.used.minutes) * 60 };
}
async function notify(db, workspaceId, key, subject, body) {
  await result(db.from('billing_notifications').upsert({ workspace_id: workspaceId, notification_key: key, subject, body }, { onConflict: 'workspace_id,notification_key', ignoreDuplicates: true }));
}
function sixMonthsAfter(timestamp) {
  const date = new Date(timestamp * 1000), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 6);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last)); return Math.floor(date.getTime() / 1000);
}
async function configureFounderSchedule(stripe, subscription, billing, selectedPlan = byId[billing.plan], nextPlan = null) {
  if (!billing.founding || !selectedPlan) return;
  const until = billing.founder_until ? Math.floor(new Date(billing.founder_until).getTime() / 1000) : sixMonthsAfter(subscription.trial_end || subscription.start_date);
  if (until <= Date.now() / 1000) return;
  const schedule = subscription.schedule ? await stripe.subscriptionSchedules.retrieve(typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id) : await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
  const fingerprint = [selectedPlan.id,nextPlan?.id||'',until,subscription.trial_end||''].join(':');
  if(schedule.metadata?.circleon_fingerprint===fingerprint)return new Date(until*1000).toISOString();
  const start = schedule.current_phase?.start_date || subscription.items.data[0].current_period_start;
  const foundingPrice = await findPrice(stripe, selectedPlan.lookup + '_founding', selectedPlan.founding * 100);
  const finalPlan = nextPlan || selectedPlan;
  const listPrice = await findPrice(stripe, finalPlan.lookup + '_list', finalPlan.list * 100);
  const recurring = subscription.items.data.filter(item => item.price.recurring?.usage_type === 'metered').map(item => ({ price: item.price.id }));
  const phase = { start_date: start, end_date: until, items: [{ price: foundingPrice.id, quantity: 1 }, ...recurring], metadata: { ...subscription.metadata, plan: selectedPlan.id }, proration_behavior: 'none' };
  if (subscription.status === 'trialing') phase.trial_end = subscription.trial_end;
  const phases = [phase];
  if (nextPlan) {
    const renewal = subscription.items.data[0].current_period_end;
    phase.end_date = Math.min(renewal, until);
    if (renewal < until) { const nextPrice = await findPrice(stripe, nextPlan.lookup + '_founding', nextPlan.founding * 100); phases.push({ start_date: renewal, end_date: until, items: [{ price: nextPrice.id, quantity: 1 }, ...recurring], metadata: { ...subscription.metadata, plan: nextPlan.id }, proration_behavior: 'none' }); }
  }
  phases.push({ start_date: until, duration: { interval: 'month', interval_count: 1 }, items: [{ price: listPrice.id, quantity: 1 }, ...recurring], metadata: { ...subscription.metadata, plan: finalPlan.id }, proration_behavior: 'none' });
  await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'release', phases, metadata: {circleon_fingerprint:fingerprint} });
  return new Date(until * 1000).toISOString();
}
async function startMonthlyCheckout({ db, stripe, workspace, user, planId, appUrl, startPaid = false }) {
  const plan = byId[planId]; if (!plan) throw Object.assign(new Error('Select a current plan.'), { status: 400 });
  const config = await settings(db); if (!config.legal_ready) throw Object.assign(new Error('Checkout opens after our Terms and Privacy Policy are approved. Please request a demo.'), { status: 409 });
  let billing = await result(db.from('workspace_billing').select('*').eq('workspace_id', workspace.id).maybeSingle());
  if (billing?.stripe_subscription_id && !['canceled','incomplete_expired'].includes(billing.subscription_status)) throw Object.assign(new Error('Manage your existing subscription from Billing.'), { status: 409 });
  if (billing?.stripe_checkout_session_id) {
    const previous = await stripe.checkout.sessions.retrieve(billing.stripe_checkout_session_id);
    if (previous.status === 'open') {
      if (previous.metadata.plan === planId) return { url: previous.url };
      await stripe.checkout.sessions.expire(previous.id);
      await result(db.from('workspace_billing').update({checkout_lock_until:null}).eq('workspace_id',workspace.id));
    }
  }
  let trial = plan.family !== 'voice';
  if (!trial && (!billing?.voice_approved || !billing.voice_ready)) throw Object.assign(new Error('Book a demo first. Voice checkout requires approval and completed setup.'), { status: 403 });
  const domain = companyDomain(user.email);
  if (trial && WEBMAIL.has(domain) && !billing?.trial_approved) throw Object.assign(new Error('Trials require a company email. Request manual approval for a personal email address.'), { status: 403 });
  // Validate the complete catalogue before reserving a trial or founding spot.
  const list = await findPrice(stripe, plan.lookup + '_list', plan.list * 100);
  const founding = await findPrice(stripe, plan.lookup + '_founding', plan.founding * 100);
  const setupKey = 'setup_' + { followup: 'fu', voice: 'va', allinone: 'aio' }[plan.family];
  const setup = await findPrice(stripe, setupKey, plan.setup * 100);
  const overages = [];
  if (plan.leads) overages.push({ price: (await findPrice(stripe, 'overage_leads', 100)).id });
  if (plan.minutes) overages.push({ price: (await findPrice(stripe, 'overage_voice_minutes', 60)).id });
  // Personal-email exceptions are scoped to this approved workspace, not all Gmail users.
  const trialDomain = WEBMAIL.has(domain) ? billing?.company_trial_key : domain;
  if (trial && !trialDomain) throw Object.assign(new Error('Manual trial approval must identify your company.'),{status:403});
  const previousTrial = await result(db.from('company_trials').select('*').eq('domain',trialDomain).maybeSingle());
  if (trial && previousTrial?.consumed) {
    if (!startPaid) throw Object.assign(new Error('Your company has already used its trial. Confirm a paid subscription to continue.'),{status:409});
    trial = false;
  }
  if(!trial && plan.family==='allinone' && !billing?.voice_ready)throw Object.assign(new Error('All-in-one paid checkout requires completed voice setup.'),{status:409});
  const claim = await result(db.rpc('claim_pricing_checkout', { wid: workspace.id, domain_name: trialDomain, wants_trial: trial }));
  const founder = claim.founding;
  try {
  let customerId = billing?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, name: workspace.name, metadata: { workspace_id: workspace.id } }, { idempotencyKey: `customer:${workspace.id}` });
    customerId = customer.id;
    await result(db.from('workspace_billing').upsert({ workspace_id: workspace.id, stripe_customer_id: customerId }, { onConflict: 'workspace_id' }));
  }
  const metadata = { workspace_id: workspace.id, plan: plan.id, founding: String(founder), trial_domain: trial ? trialDomain : '', setup_key: founder ? '' : setupKey, pricing_version: 'monthly_v3', setup_in_checkout: String(!trial && !founder) };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription', customer: customerId, payment_method_collection: 'always',
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    line_items: [{ price: founder ? founding.id : list.id, quantity: 1 }, ...(!trial && !founder ? [{ price: setup.id, quantity: 1 }] : [])],
    success_url: appUrl('/plan-select?checkout=success'), cancel_url: appUrl('/plan-select?checkout=cancelled'),
    automatic_tax: { enabled: config.gst_registered }, billing_address_collection: config.gst_registered ? 'required' : 'auto',
    customer_update: { address: 'auto' }, consent_collection: { terms_of_service: 'required' },
    custom_text: { submit: { message: trial ? `7-day trial. Then S$${founder ? plan.founding : plan.list}/month excl. GST${founder ? ' for six paid months, then S$' + plan.list + '/month excl. GST. Setup waived.' : ', plus S$' + plan.setup + ' setup excl. GST on conversion.'} Connect your own verified mailbox. Cancel before conversion to pay nothing.` : 'Phone numbers and carrier charges are paid separately. No free voice trial.' } },
    metadata, subscription_data: { metadata, ...(trial ? { trial_period_days: 7 } : {}) },
  }, { idempotencyKey: `checkout:${workspace.id}:${plan.id}:${founder}:${Math.floor(Date.now() / 1800000)}` });
  // Never write pending over an active subscription webhook.
  await result(db.from('workspace_billing').upsert({ workspace_id: workspace.id, stripe_customer_id: customerId, stripe_checkout_session_id: session.id }, { onConflict: 'workspace_id' }));
  return { url: session.url };
  } catch (error) {
    await result(db.from('workspace_billing').update({checkout_lock_until:null}).eq('workspace_id',workspace.id));
    await result(db.from('founding_reservations').update({state:'released'}).eq('workspace_id',workspace.id).eq('state','reserved'));
    throw error;
  }
}
module.exports = { service, stripeClient, result, settings, publicCatalog, findPrice, usage, consumeUsage, voiceAccess, notify, sixMonthsAfter, configureFounderSchedule, startMonthlyCheckout };

// The database ledger is authoritative. Invoice only closed monthly periods,
// including usage carried across a mid-period upgrade. This avoids charging
// irreversible live meter events before an upgrade changes the allowance.
async function billClosedUsage(db, stripe, eventInvoice, finalSubscription = null) {
  if (!finalSubscription && eventInvoice.billing_reason !== 'subscription_cycle') return;
  const { invoiceSubscription } = require('./pricing');
  const subscriptionId=finalSubscription?.id || invoiceSubscription(eventInvoice); if(!subscriptionId)return;
  const sub=finalSubscription || await stripe.subscriptions.retrieve(subscriptionId);
  if(!byId[sub.metadata?.plan])return;
  const invoice=await stripe.invoices.retrieve(eventInvoice.id);
  if(invoice.status!=='draft')return;
  const billing=await result(db.from('workspace_billing').select('*').eq('workspace_id',sub.metadata.workspace_id).single());
  if(!finalSubscription && sub.metadata.setup_key && !billing.setup_charged && sub.status!=='trialing'){
    const setup=await findPrice(stripe,sub.metadata.setup_key,byId[sub.metadata.plan].setup*100);
    await stripe.invoiceItems.create({customer:String(sub.customer),invoice:invoice.id,pricing:{price:setup.id},quantity:1},{idempotencyKey:`setup:${sub.id}`});
    await result(db.from('workspace_billing').update({setup_charged:true}).eq('workspace_id',billing.workspace_id));
  }
  const base=sub.items.data.find(i=>i.price.recurring?.usage_type!=='metered');
  const boundary=finalSubscription ? Math.floor(Date.now()/1000)+1 : base.current_period_start;
  const charges=await result(db.rpc('claim_usage_invoice',{p_workspace_id:billing.workspace_id,p_boundary:new Date(boundary*1000).toISOString(),p_invoice_id:invoice.id}));
  for(const charge of charges){
    await stripe.invoiceItems.create({customer:String(sub.customer),invoice:invoice.id,currency:'sgd',amount:charge.amount,metadata:{circleon_usage_charge:charge.id},description:`CircleOn ${charge.kind} overage adjustment for period starting ${charge.period_start} (excl. GST)`},{idempotencyKey:`usage-charge:${charge.id}`});
    await result(db.rpc('commit_usage_invoice_charge',{p_charge_id:charge.id}));
  }
}
module.exports.billClosedUsage=billClosedUsage;

// Canceled subscriptions do not necessarily produce a renewal invoice. Wait
// until connected calls finish, then collect their last ledger period once.
async function billFinalUsage(db, stripe, billing) {
  let job = await result(db.from('billing_settlements').select('*').eq('subscription_id',billing.stripe_subscription_id).order('revision',{ascending:false}).limit(1).maybeSingle());
  const priorRevision=job?.revision||0;
  if(job?.status==='finalized')job=null;
  const sub = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
  if (sub.status !== 'canceled') return;
  if (!job) {
    const running = await result(db.from('calls').select('id').eq('workspace_id',billing.workspace_id).in('status',['queued','calling','ringing','in_progress']).limit(1));
    if (running.length) return;
    // Completion updates the call before its ledger RPC; never settle in that gap.
    const finished = await result(db.from('calls').select('id,duration_seconds,status').eq('workspace_id',billing.workspace_id).eq('status','completed'));
    const events = await result(db.from('billing_usage_events').select('event_key').eq('workspace_id',billing.workspace_id).eq('kind','voice_seconds'));
    const metered = new Set(events.map(e => e.event_key));
    if (finished.some(call => Number(call.duration_seconds)>0 && !metered.has('call:'+call.id))) return;
    const rows = await result(db.from('billing_usage').select('*').eq('workspace_id',billing.workspace_id));
    if (!rows.some(r => !r.is_trial && byId[r.plan_id] && (Math.max(0,r.leads-byId[r.plan_id].leads)*100 > (r.billed_leads_cents||0) || voiceOverageCents(r.voice_seconds,byId[r.plan_id].minutes) > (r.billed_voice_cents||0)))) return;
    const tax = await settings(db);
    const invoice = await stripe.invoices.create({automatic_tax:{enabled:tax.gst_registered},customer:String(sub.customer),collection_method:'charge_automatically',auto_advance:false,pending_invoice_items_behavior:'exclude',metadata:{circleon_final_subscription:sub.id}},{idempotencyKey:`final-usage:${sub.id}:${priorRevision+1}`});
    job = {subscription_id:sub.id,workspace_id:billing.workspace_id,invoice_id:invoice.id,status:'draft',revision:priorRevision+1};
    await result(db.from('billing_settlements').upsert(job,{onConflict:'subscription_id,revision',ignoreDuplicates:true}));
    job = await result(db.from('billing_settlements').select('*').eq('subscription_id',sub.id).eq('revision',priorRevision+1).single());
  }
  const invoice = await stripe.invoices.retrieve(job.invoice_id);
  if (invoice.status === 'draft') {
    await billClosedUsage(db,stripe,invoice,sub);
    await stripe.invoices.finalizeInvoice(invoice.id,{auto_advance:true});
  }
  await result(db.from('billing_settlements').update({status:'finalized',finalized_at:new Date().toISOString()}).eq('subscription_id',sub.id).eq('revision',job.revision));
}
module.exports.billFinalUsage=billFinalUsage;
