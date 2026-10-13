const express = require('express');
const Stripe = require('stripe');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { getBilling, isActiveSubscription } = require('../lib/billing');
const { createServiceClient } = require('../lib/supabase');

const router = express.Router();
const monthly = require('../lib/monthlyBilling');
const { byId, invoiceSubscription } = require('../lib/pricing');
const PLAN_IDS = new Set(Object.keys(byId));

function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover' });
}


function appUrl(path) {
  const base = process.env.FRONTEND_URL;
  if (!base) throw new Error('FRONTEND_URL is required for Stripe redirects.');
  return `${base.replace(/\/$/, '')}${path}`;
}

async function upsertBilling(service, workspaceId, patch) {
  const { error } = await service.from('workspace_billing').upsert({ workspace_id: workspaceId, ...patch }, { onConflict: 'workspace_id' });
  if (error) throw error;
}

function buildCheckoutSessionPatch(session) {
  const patch = {
    stripe_checkout_session_id: session.id,
    ...(session.metadata?.pricing_version === 'monthly_v3' ? {checkout_lock_until:null} : {}),
  };

  if (session.customer) patch.stripe_customer_id = String(session.customer);
  if (session.subscription) patch.stripe_subscription_id = String(session.subscription);
  if (session.metadata?.plan) patch.plan = session.metadata.plan;

  // Checkout completion is proof that Checkout finished, not the authoritative
  // subscription state. Deliberately do not write subscription_status here:
  // Stripe can deliver this event after customer.subscription.created, and a
  // pending write would otherwise downgrade an already-active subscription.
  return patch;
}

async function workspaceIdForSubscription(service, subscription) {
  const metadataId = subscription.metadata?.workspace_id;
  if (metadataId) return metadataId;
  const { data, error } = await service
    .from('workspace_billing')
    .select('workspace_id')
    .or(`stripe_subscription_id.eq.${subscription.id},stripe_customer_id.eq.${subscription.customer}`)
    .maybeSingle();
  if (error) throw error;
  return data?.workspace_id || null;
}

async function syncSubscription(service, subscription) {
  const workspaceId = await workspaceIdForSubscription(service, subscription);
  if (!workspaceId) return;
  const item = subscription.items?.data?.find(item => item.price.recurring?.usage_type !== 'metered') || subscription.items?.data?.[0];
  const periodEnd = item?.current_period_end || subscription.current_period_end;
  const periodStart = item?.current_period_start || subscription.current_period_start;
  const plan = subscription.metadata?.plan;
  const existing = await monthly.result(service.from('workspace_billing').select('*').eq('workspace_id', workspaceId).maybeSingle());
  const patch = {
    stripe_customer_id: String(subscription.customer), stripe_subscription_id: subscription.id,
    ...(plan ? { plan } : {}), subscription_status: subscription.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
  };
  if (byId[plan]) {
    Object.assign(patch, {
      current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
      trial_start: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
      trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
      founding: subscription.metadata?.founding === 'true',
      ...(subscription.metadata?.setup_in_checkout==='true'?{setup_charged:true}:{}),
    });
    if (subscription.status === 'active') patch.payment_failed = false;
    if (existing?.pending_plan === plan) patch.pending_plan = null;
    // A ready flag can only be set by internal admin, never by subscription metadata.
    if (byId[plan].family === 'allinone' && subscription.status === 'trialing' && !existing?.voice_ready && subscription.cancel_at !== subscription.trial_end) {
      await stripeClient().subscriptions.update(subscription.id, { cancel_at: subscription.trial_end });
    }
  }
  await upsertBilling(service, workspaceId, patch);
  if (plan) await monthly.result(service.from('workspaces').update({ plan }).eq('id', workspaceId));
  if (!byId[plan]) return;
  if (subscription.status === 'canceled') {
    await monthly.result(service.from('founding_reservations').update({ state: 'released' }).eq('workspace_id', workspaceId).eq('state', 'reserved'));
  }
  if (subscription.trial_start && subscription.metadata.trial_domain) {
    await monthly.result(service.from('company_trials').update({ consumed: true }).eq('workspace_id', workspaceId).eq('domain', subscription.metadata.trial_domain));
  }
  if (subscription.status === 'trialing' && subscription.metadata.trial_domain) {
    await monthly.result(service.from('founding_reservations').update({ expires_at: new Date(subscription.trial_end * 1000 + 48 * 3600000).toISOString() }).eq('workspace_id', workspaceId).eq('state', 'reserved'));
  }
  if (patch.founding && ['active','trialing'].includes(subscription.status) && !(byId[plan].family==='allinone' && subscription.status==='trialing' && !existing?.voice_ready)) {
    const until = await monthly.configureFounderSchedule(stripeClient(), subscription, { ...existing, ...patch, workspace_id: workspaceId }, byId[plan], existing?.pending_plan !== plan ? byId[existing?.pending_plan] : null);
    if (until && !existing?.founder_until) await upsertBilling(service, workspaceId, { founder_until: until });
  }

}

router.get('/catalog', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store'); return res.json(await monthly.publicCatalog()); }
  catch (error) { return res.status(503).json({ error: 'Pricing availability could not be loaded.' }); }
});

const demoBuckets = new Map();
router.post('/demo', async (req, res) => {
  const key = req.ip; const now = Date.now(); const previous = demoBuckets.get(key) || 0;
  if (now - previous < 60000) return res.status(429).json({ error: 'Please wait a minute before sending another request.' });
  const { name, email, company, message } = req.body || {};
  if (![name,email,company].every(v => typeof v === 'string' && v.trim() && v.length <= 250) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || String(message || '').length > 2000) return res.status(400).json({ error: 'Enter your name, company, and valid email.' });
  try {
    await monthly.result(monthly.service().from('demo_requests').insert({ name: name.trim(), email: email.trim().toLowerCase(), company: company.trim(), message: message || null }));
    demoBuckets.set(key, now); if (demoBuckets.size > 10000) demoBuckets.clear();
    return res.status(201).json({ received: true });
  } catch (error) { return res.status(500).json({ error: 'Could not save your demo request. Please try again.' }); }
});

router.post('/inbound/:id', express.urlencoded({extended:false}), (req,res,next)=>require('../lib/inboundBilling').handleInbound(req,res).catch(next));

router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const billing = await getBilling(req.supabase, workspace.id);
    return res.json({ billing, active: isActiveSubscription(billing), usage: billing ? await monthly.usage(req.supabase, billing) : null });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load billing status.' });
  }
});

router.post('/checkout', async (req, res) => {
  try {
    if (!PLAN_IDS.has(req.body?.plan)) return res.status(400).json({ error: 'Select a current monthly plan.' });
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    if (workspace.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner manages billing.' });
    const checkout = await monthly.startMonthlyCheckout({ db: monthly.service(), stripe: stripeClient(), workspace, user: req.user, planId: req.body.plan, appUrl, startPaid: req.body.start_paid === true });
    return res.json(checkout);
  } catch (error) { return res.status(error.status || 409).json({ error: error.message || 'Could not start checkout.' }); }
});

router.post('/portal', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    if (workspace.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner manages billing.' });
    const billing = await getBilling(req.supabase, workspace.id);
    if (!billing?.stripe_customer_id) return res.status(400).json({ error: 'No Stripe customer exists for this workspace yet.' });
    const configuration = byId[billing.plan] ? process.env.STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID : undefined;
    if (byId[billing.plan] && !configuration) return res.status(503).json({ error: 'Monthly billing portal configuration is required.' });
    if (configuration) require('../lib/billingConfiguration').assertMonthlyPortal(await stripeClient().billingPortal.configurations.retrieve(configuration));
    const session = await stripeClient().billingPortal.sessions.create({ customer: billing.stripe_customer_id, return_url: appUrl('/dashboard?page=billing'), ...(configuration ? { configuration } : {}) });
    return res.json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not open the Stripe Billing Portal.' });
  }
});

async function handleWebhook(req, res) {
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }

  const service = createServiceClient();
  if (!service) return res.status(500).send('SUPABASE_SERVICE_ROLE_KEY is required for Stripe webhooks.');
  const { error: eventError } = await service.from('stripe_webhook_events').upsert(
    { event_id: event.id, event_type: event.type }, { onConflict: 'event_id', ignoreDuplicates: true }
  ).select('processed_at').maybeSingle();
  if (eventError) return res.status(500).send(eventError.message);
  try {
    const recorded = await monthly.result(service.from('stripe_webhook_events').select('processed_at').eq('event_id', event.id).single());
    if (recorded?.processed_at) return res.status(200).json({ received: true });
    const object = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const workspaceId = object.metadata?.workspace_id;
      if (workspaceId) {
        await upsertBilling(service, workspaceId, buildCheckoutSessionPatch(object));

        // Refresh from Stripe's current subscription object when available so
        // Checkout completion also works if the subscription webhook arrives
        // later or is temporarily delayed.
        if (object.subscription) {
          await syncSubscription(service, await stripeClient().subscriptions.retrieve(String(object.subscription)));
        }
      }
    } else if (event.type.startsWith('customer.subscription.')) {
      // Refresh current Stripe state so late events cannot restore canceled access.
      await syncSubscription(service, await stripeClient().subscriptions.retrieve(object.id));
    } else if (event.type === 'invoice.created') {
      await monthly.billClosedUsage(service, stripeClient(), object);
    } else if (event.type === 'checkout.session.expired') {
      const wid=object.metadata?.workspace_id;
      if(wid){const current=await monthly.result(service.from('workspace_billing').select('stripe_checkout_session_id').eq('workspace_id',wid).maybeSingle());if(current?.stripe_checkout_session_id===object.id)await monthly.result(service.from('founding_reservations').update({state:'released'}).eq('workspace_id',wid).eq('state','reserved'));}
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const subscriptionId = invoiceSubscription(object);
      if (subscriptionId) {
        const subscription = await stripeClient().subscriptions.retrieve(String(subscriptionId));
        await syncSubscription(service, subscription);
        const wid = await workspaceIdForSubscription(service, subscription);
        if (wid && byId[subscription.metadata?.plan]) {
          if (event.type === 'invoice.payment_failed' && (await stripeClient().invoices.retrieve(object.id)).status !== 'paid') {
            await upsertBilling(service, wid, { payment_failed: true });
            await monthly.notify(service, wid, `failed:${object.id}`, 'Payment failed', 'Activity is paused. Update your payment method in Billing.');
          } else if (event.type === 'invoice.paid' && object.amount_paid > 0) {
            await upsertBilling(service, wid, { payment_failed: false });
            await monthly.result(service.from('founding_reservations').update({ state: 'confirmed', expires_at: null }).eq('workspace_id', wid).eq('state', 'reserved'));
          }
        }
      }
    } else if (event.type === 'invoice_payment.paid') {
      const invoiceId = typeof object.invoice === 'string' ? object.invoice : object.invoice?.id;
      if (invoiceId) {
        const invoice = await stripeClient().invoices.retrieve(String(invoiceId));
        if (invoiceSubscription(invoice)) {
          await syncSubscription(service, await stripeClient().subscriptions.retrieve(String(invoiceSubscription(invoice))));
        }
      }
    }
    const { error: processedError } = await service.from('stripe_webhook_events').update({ processed_at: new Date().toISOString() }).eq('event_id', event.id);
    if (processedError) throw processedError;
    return res.json({ received: true });
  } catch (error) {
    return res.status(500).send(error.message || 'Webhook processing failed.');
  }
}

router.use('/provider-credits', require('./providerCredits'));
router.use(require('./monthlyBilling'));
module.exports = { router, handleWebhook, buildCheckoutSessionPatch, syncSubscription };
