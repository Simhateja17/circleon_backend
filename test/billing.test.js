const test = require('node:test');
const assert = require('node:assert/strict');

const { isActiveSubscription } = require('../lib/billing');
const { buildCheckoutSessionPatch } = require('../routes/billing');

test('only active and trialing Stripe subscriptions grant paid access', () => {
  assert.equal(isActiveSubscription(null), false);
  assert.equal(isActiveSubscription({ subscription_status: 'pending' }), false);
  assert.equal(isActiveSubscription({ subscription_status: 'past_due' }), false);
  assert.equal(isActiveSubscription({ subscription_status: 'canceled' }), false);
  assert.equal(isActiveSubscription({ subscription_status: 'active' }), true);
  assert.equal(isActiveSubscription({ subscription_status: 'trialing' }), true);
});

test('checkout completion cannot downgrade a subscription made active by an earlier webhook', () => {
  const session = {
    id: 'cs_test_ordered_late',
    customer: 'cus_test_customer',
    subscription: 'sub_test_subscription',
    metadata: { workspace_id: 'workspace-1', plan: 'atelier' },
  };

  const checkoutPatch = buildCheckoutSessionPatch(session);
  const existingBilling = { subscription_status: 'active' };
  const afterCheckout = { ...existingBilling, ...checkoutPatch };

  assert.equal(afterCheckout.subscription_status, 'active');
  assert.equal(checkoutPatch.subscription_status, undefined);
});
