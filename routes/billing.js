const express = require('express');
const Stripe = require('stripe');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { getBilling, isActiveSubscription } = require('../lib/billing');
const { createServiceClient } = require('../lib/supabase');

const router = express.Router();
const PLAN_IDS = new Set(['atelier', 'maison']);

function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover' });
}

function priceForPlan(plan) {
  const prices = {
    atelier: process.env.STRIPE_PRICE_ATELIER_ANNUAL,
    maison: process.env.STRIPE_PRICE_MAISON_ANNUAL,
  };
  if (!prices[plan]) throw new Error(`Stripe price is not configured for ${plan}.`);
  return prices[plan];
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
  const periodEnd = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
  await upsertBilling(service, workspaceId, {
    stripe_customer_id: String(subscription.customer),
    stripe_subscription_id: subscription.id,
    plan: subscription.metadata?.plan || null,
    subscription_status: subscription.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
  });
}

router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const billing = await getBilling(req.supabase, workspace.id);
    return res.json({ billing, active: isActiveSubscription(billing) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load billing status.' });
  }
});

router.post('/checkout', async (req, res) => {
  try {
    const plan = req.body?.plan;
    if (!PLAN_IDS.has(plan)) return res.status(400).json({ error: 'Select Atelier or Maison to continue to checkout.' });
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const existing = await getBilling(req.supabase, workspace.id);
    if (isActiveSubscription(existing)) return res.status(409).json({ error: 'This workspace already has an active subscription.' });

    const stripe = stripeClient();
    let customerId = existing?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email || undefined,
        name: workspace.name,
        metadata: { workspace_id: workspace.id, owner_id: req.user.id },
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceForPlan(plan), quantity: 1 }],
      success_url: appUrl('/plan-select?checkout=success&session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: appUrl('/plan-select?checkout=cancelled'),
      allow_promotion_codes: false,
      metadata: { workspace_id: workspace.id, plan },
      subscription_data: { metadata: { workspace_id: workspace.id, plan } },
    });

    const service = createServiceClient();
    if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for Stripe billing.');
    await upsertBilling(service, workspace.id, { stripe_customer_id: customerId, stripe_checkout_session_id: session.id, plan, subscription_status: 'pending' });
    const { error: planError } = await service.from('workspaces').update({ plan }).eq('id', workspace.id);
    if (planError) throw planError;
    return res.json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not start Stripe Checkout.' });
  }
});

router.post('/portal', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const billing = await getBilling(req.supabase, workspace.id);
    if (!billing?.stripe_customer_id) return res.status(400).json({ error: 'No Stripe customer exists for this workspace yet.' });
    const session = await stripeClient().billingPortal.sessions.create({ customer: billing.stripe_customer_id, return_url: appUrl('/dashboard?page=billing') });
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
  const { data: recorded, error: eventError } = await service.from('stripe_webhook_events').upsert(
    { event_id: event.id, event_type: event.type }, { onConflict: 'event_id', ignoreDuplicates: true }
  ).select('processed_at').maybeSingle();
  if (eventError) return res.status(500).send(eventError.message);
  if (!recorded || recorded.processed_at) return res.status(200).json({ received: true });

  try {
    const object = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const workspaceId = object.metadata?.workspace_id;
      if (workspaceId) await upsertBilling(service, workspaceId, {
        stripe_customer_id: String(object.customer), stripe_subscription_id: String(object.subscription),
        stripe_checkout_session_id: object.id, plan: object.metadata?.plan || null, subscription_status: 'pending',
      });
    } else if (event.type.startsWith('customer.subscription.')) {
      await syncSubscription(service, object);
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const subscriptionId = object.subscription;
      if (subscriptionId) await syncSubscription(service, await stripeClient().subscriptions.retrieve(String(subscriptionId)));
    }
    const { error: processedError } = await service.from('stripe_webhook_events').update({ processed_at: new Date().toISOString() }).eq('event_id', event.id);
    if (processedError) throw processedError;
    return res.json({ received: true });
  } catch (error) {
    return res.status(500).send(error.message || 'Webhook processing failed.');
  }
}

module.exports = { router, handleWebhook };
