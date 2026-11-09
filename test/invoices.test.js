const test = require('node:test');
const assert = require('node:assert/strict');
const { nextFollowUp, invoiceStatus, composeEmail, lineItemsTotal, runInvoiceFollowUps } = require('../lib/invoices');
const { hasFeature, planFeatures } = require('../lib/entitlements');
const { plans } = require('../lib/pricing');

// Noon Singapore time on the given date.
const at = date => new Date(`${date}T04:00:00Z`);
const sent = { id: 'i1', workspace_id: 'w', status: 'sent', due_date: '2026-11-20', sent_at: '2026-11-01T04:00:00Z', reminders_enabled: true, checkins_enabled: true, amount_cents: 150000, currency: 'SGD', number: 'INV-1', client_name: 'Ana Tan', client_email: 'ana@client.sg', line_items: [] };

test('plan families unlock the right features', () => {
  assert.deepEqual(planFeatures('email'), ['leads', 'email']);
  assert.ok(hasFeature('email_invoice', 'invoices') && !hasFeature('email_invoice', 'voice'));
  assert.ok(['leads', 'email', 'invoices', 'voice'].every(f => hasFeature('all_in_one', f)));
  assert.deepEqual(planFeatures('followup_growth'), ['leads', 'email']);
  assert.ok(hasFeature('allinone_starter', 'invoices'));
  assert.ok(!hasFeature('voice_pro', 'invoices'));
  assert.ok(hasFeature('maison', 'voice') && !hasFeature('maison', 'invoices'));
  assert.deepEqual(planFeatures(null), []);
  assert.deepEqual(plans.filter(p => !p.retired).map(p => p.id), ['email', 'email_invoice', 'all_in_one']);
});

test('overdue is derived from the due date in Singapore time', () => {
  assert.equal(invoiceStatus(sent, at('2026-11-20')), 'sent');
  assert.equal(invoiceStatus(sent, at('2026-11-21')), 'overdue');
  assert.equal(invoiceStatus({ ...sent, status: 'paid' }, at('2026-12-30')), 'paid');
});

test('reminders follow the due date and are sent once each', () => {
  assert.equal(nextFollowUp(sent, null, [], at('2026-11-16')), null);
  assert.deepEqual(nextFollowUp(sent, null, [], at('2026-11-17')), { kind: 'reminder', offset: -3, step: 'd-3' });
  const events = [{ kind: 'reminder', step: 'd-3', created_at: '2026-11-17T04:00:00Z' }];
  assert.equal(nextFollowUp(sent, null, events, at('2026-11-18')), null);
  assert.equal(nextFollowUp(sent, null, events, at('2026-11-20')).step, 'd0');
});

test('a late start sends only the latest missed reminder', () => {
  assert.equal(nextFollowUp(sent, null, [], at('2026-11-29')).step, 'd7');
  assert.equal(nextFollowUp(sent, null, [{ kind: 'reminder', step: 'd7', created_at: '2026-11-27T00:00:00Z' }], at('2026-11-29')), null);
});

test('no reminder within a day of the invoice email, or dated before it', () => {
  const fresh = { ...sent, sent_at: '2026-11-19T02:00:00Z' };
  const events = [{ kind: 'invoice', step: '', created_at: '2026-11-19T02:00:00Z' }];
  assert.equal(nextFollowUp(fresh, null, events, at('2026-11-19')), null);
  assert.equal(nextFollowUp(fresh, null, events, at('2026-11-20')).step, 'd0');
});

test('reminders can be turned off per invoice or per workspace', () => {
  assert.equal(nextFollowUp({ ...sent, reminders_enabled: false }, null, [], at('2026-11-25')), null);
  assert.equal(nextFollowUp(sent, { reminders_enabled: false }, [], at('2026-11-25')), null);
});

test('paid invoices get the check-in sequence instead of reminders', () => {
  const paid = { ...sent, status: 'paid', paid_at: '2026-11-22T03:00:00Z' };
  assert.equal(nextFollowUp(paid, null, [], at('2026-11-22')).step, 'd0');
  assert.equal(nextFollowUp(paid, null, [{ kind: 'checkin', step: 'd0', created_at: '2026-11-22T03:00:00Z' }], at('2026-11-25')), null);
  assert.equal(nextFollowUp(paid, null, [{ kind: 'checkin', step: 'd0', created_at: '2026-11-22T03:00:00Z' }], at('2026-11-29')).step, 'd7');
  assert.equal(nextFollowUp({ ...paid, status: 'void' }, null, [], at('2026-11-29')), null);
});

test('emails read naturally for each stage', () => {
  assert.match(composeEmail('reminder', sent, { offset: -3 }).body, /is due in 3 days/);
  assert.match(composeEmail('reminder', sent, { offset: 7 }).subject, /^Overdue/);
  assert.match(composeEmail('checkin', sent, { offset: 30, reviewLink: 'https://g.page/r/x' }).body, /g\.page/);
  assert.match(composeEmail('invoice', sent, { businessName: 'Acme' }).body, /^Hi Ana,/);
  assert.equal(lineItemsTotal([{ quantity: 2, unit_cents: 1250 }, { quantity: 0.5, unit_cents: 1001 }]), 3001);
});

test('the worker skips workspaces whose plan lacks invoicing', async () => {
  const tables = {
    invoices: [sent],
    workspace_billing: [{ workspace_id: 'w', plan: 'email', subscription_status: 'active' }],
  };
  const db = { from(table) { const q = { select: () => q, or: () => q, limit: async () => ({ data: tables[table], error: null }), eq: () => q, maybeSingle: async () => ({ data: tables[table][0], error: null }) }; return q; } };
  assert.deepEqual(await runInvoiceFollowUps(db, { now: at('2026-11-25') }), { sent: 0 });
});

test('emails carry a CircleOn-styled HTML version with the same facts', () => {
  const invoice = { ...sent, issue_date: '2026-11-01', notes: '<script>x</script>', line_items: [{ description: 'Design & build', quantity: 2, unit_cents: 75000 }] };
  const { subject, body, html } = composeEmail('invoice', invoice, { businessName: 'Acme' });
  assert.match(subject, /S\$1,500\.00 due 20 Nov 2026$/);
  assert.match(body, /Due: 20 Nov 2026/);
  assert.match(html, /S\$1,500\.00/);
  assert.match(html, /Awaiting payment/);
  assert.match(html, /Design &amp; build/);
  assert.match(html, /Sent with/);
  assert.ok(!html.includes('<script>x'));
  assert.match(composeEmail('reminder', sent, { offset: 7 }).html, /Overdue by 7 days/);
  const review = composeEmail('checkin', sent, { offset: 30, reviewLink: 'javascript:alert(1)' }).html;
  assert.ok(!review.includes('javascript:'));
});
