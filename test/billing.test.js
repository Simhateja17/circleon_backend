const test = require('node:test');
const assert = require('node:assert/strict');

const { isActiveSubscription } = require('../lib/billing');

test('only active and trialing Stripe subscriptions grant paid access', () => {
  assert.equal(isActiveSubscription(null), false);
  assert.equal(isActiveSubscription({ subscription_status: 'pending' }), false);
  assert.equal(isActiveSubscription({ subscription_status: 'past_due' }), false);
  assert.equal(isActiveSubscription({ subscription_status: 'canceled' }), false);
  assert.equal(isActiveSubscription({ subscription_status: 'active' }), true);
  assert.equal(isActiveSubscription({ subscription_status: 'trialing' }), true);
});
