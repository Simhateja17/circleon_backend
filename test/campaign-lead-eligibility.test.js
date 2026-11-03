const test = require('node:test');
const assert = require('node:assert/strict');
const { leadBlockReason } = require('../routes/campaigns');

const phoneOnly = { phone_e164: '+6583638482', lifecycle_status: 'candidate', dnc_status: 'unknown', source: 'manual' };

test('a voice campaign accepts a lead with a phone and no email', () => {
  assert.equal(leadBlockReason(phoneOnly, 'voice'), null);
});

test('a voice campaign accepts an Apollo lead whose phone can be looked up', () => {
  assert.equal(leadBlockReason({ email: 'a@b.co', lifecycle_status: 'ready', source: 'apollo', external_id: 'x' }, 'voice'), null);
});

test('a voice campaign rejects a lead with no way to get a phone', () => {
  assert.equal(leadBlockReason({ email: 'a@b.co', lifecycle_status: 'ready', source: 'manual' }, 'voice'), 'Lead does not have a phone number');
});

test('suppressed leads stay blocked on voice', () => {
  assert.match(leadBlockReason({ ...phoneOnly, dnc_status: 'blocked' }, 'voice'), /suppressed/);
  assert.match(leadBlockReason({ ...phoneOnly, lifecycle_status: 'suppressed' }, 'voice'), /suppressed/);
});

test('email campaigns still need a ready lead with an email', () => {
  assert.equal(leadBlockReason(phoneOnly), 'Lead does not have a verified work email');
  assert.equal(leadBlockReason(phoneOnly, 'email'), 'Lead does not have a verified work email');
  assert.equal(leadBlockReason({ email: 'a@b.co', lifecycle_status: 'ready' }, 'email'), null);
  assert.equal(leadBlockReason({ email: 'a@b.co', lifecycle_status: 'candidate' }, 'email'), 'Lead is not ready for a campaign yet');
});
