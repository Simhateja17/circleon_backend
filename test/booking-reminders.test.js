const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../lib/bookingReminders');
const { composeEmail } = require('../lib/invoices');

const invoice = {
  id: 'i1', workspace_id: 'w', status: 'sent', number: 'INV-1', client_name: 'Ana Tan', client_email: 'ana@client.sg',
  currency: 'SGD', amount_cents: 120000, due_date: '2026-11-20', line_items: [],
  booking_at: '2026-11-15T09:00:00+08:00', booking_title: 'Sunset yacht charter', booking_notes: 'Bring your IC. Meet at Marina Pier 3.',
};

test('rules turn into Singapore send times', () => {
  assert.equal(b.sendAtFor(invoice.booking_at, { days_before: 1, time: '09:00' }).toISOString(), '2026-11-14T01:00:00.000Z');
  assert.equal(b.sendAtFor(invoice.booking_at, { hours_before: 3 }).toISOString(), '2026-11-14T22:00:00.000Z');
  assert.equal(b.sendAtFor(invoice.booking_at, { days_before: 0, time: '07:00' }).toISOString(), '2026-11-14T23:00:00.000Z');
  assert.deepEqual(b.normalizeRules([{ days_before: 1, time: '09:00' }, { days_before: 1, time: '09:00' }, { hours_before: 0 }, { hours_before: 3 }]), [{ days_before: 1, time: '09:00' }, { hours_before: 3 }]);
});

test('the booking is described from the moment the reminder arrives', () => {
  assert.equal(b.relativeWhen(invoice.booking_at, new Date('2026-11-14T01:00:00Z')), 'tomorrow at 9:00 AM');
  assert.equal(b.relativeWhen(invoice.booking_at, new Date('2026-11-14T22:00:00Z')), 'today at 9:00 AM');
  assert.match(b.relativeWhen(invoice.booking_at, new Date('2026-11-12T01:00:00Z')), /^this Sunday at 9:00 AM$/);
});

test('AI drafts are used per rule, past times are skipped, and failures fall back to a template', async () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const rules = [{ days_before: 7, time: '09:00' }, { days_before: 1, time: '09:00' }, { hours_before: 3 }];
  const generate = async ({ prompt }) => {
    const input = JSON.parse(prompt);
    assert.equal(input.customer_first_name, 'Ana');
    assert.equal(input.owner_notes, invoice.booking_notes);
    return { reminders: input.reminders.map(r => ({ rule_key: r.rule_key, subject: `See you ${r.booking_is}`, body: `Hi Ana,\n\nYour charter is ${r.booking_is}. Bring your IC.\n\nSee you soon,\nBlue Sea` })) };
  };
  const drafts = await b.draftReminders(invoice, rules, { businessName: 'Blue Sea', now, generate });
  assert.deepEqual(drafts.map(d => d.rule_key), ['d1@09:00', 'h3']);
  assert.equal(drafts[0].subject, 'See you tomorrow at 9:00 AM');

  const fallback = await b.draftReminders(invoice, rules, { businessName: 'Blue Sea', now, generate: async () => { throw new Error('down'); } });
  assert.match(fallback[0].body, /^Hi Ana,/);
  assert.match(fallback[0].body, /Sunset yacht charter is tomorrow at 9:00 AM/);
  assert.match(fallback[0].body, /Marina Pier 3/);

  await assert.rejects(b.draftReminders({ ...invoice, booking_at: null }, rules, { now, generate }), /booking date/);
  await assert.rejects(b.draftReminders(invoice, rules, { now: new Date('2026-11-15T00:30:00Z'), generate }), /already passed/);
});

test('booking reminder emails put the booking card between message and sign-off', () => {
  const email = b.composeBookingEmail({ subject: 'See you tomorrow', body: 'Hi Ana,\n\nYour charter is tomorrow.\n\nSee you soon,\nBlue Sea' }, invoice, 'Blue Sea');
  const html = email.html;
  assert.ok(html.indexOf('Your charter is tomorrow') < html.indexOf('Sunset yacht charter'));
  assert.ok(html.indexOf('Sunset yacht charter') < html.indexOf('See you soon'));
  assert.match(html, /Sunday, 15 November 2026, 9:00 AM/);
});

test('invoice emails mention the attached file and the booking', () => {
  const { body, html } = composeEmail('invoice', { ...invoice, file_path: 'w/x.pdf' }, { businessName: 'Blue Sea' });
  assert.match(body, /Your invoice is attached/);
  assert.match(html, /Sunset yacht charter/);
});

test('the worker sends due approved reminders once and cancels ones for past bookings', async () => {
  const sent = [];
  const rows = {
    invoice_booking_reminders: [
      { id: 'r1', invoice_id: 'i1', workspace_id: 'w', rule_key: 'd1@09:00', status: 'scheduled', send_at: '2026-11-14T01:00:00Z', subject: 'See you tomorrow', body: 'Hi Ana,\n\nSee you.\n\nThanks,\nBlue Sea' },
    ],
  };
  const updates = [];
  const db = {
    from(table) {
      const q = {
        _table: table, _update: null,
        select() { return q; }, eq() { return q; }, lte() { return q; }, order() { return q; }, in() { return q; }, not() { return q; },
        limit: async () => ({ data: rows[table], error: null }),
        update(patch) { q._update = patch; updates.push([table, patch]); return q; },
        insert: async () => ({ error: null }),
        maybeSingle: async () => {
          if (q._update) return { data: { id: 'r1' } };
          if (table === 'workspace_billing') return { data: { plan: 'email_invoice', subscription_status: 'active' } };
          if (table === 'invoice_settings') return { data: null };
          if (table === 'connected_accounts') return { data: { from_email: 'hi@bluesea.sg', from_name: 'Blue Sea', smtp_host: 'x', smtp_port: 587, smtp_username: 'u', smtp_password_encrypted: null } };
          return { data: { name: 'Blue Sea' } };
        },
        then(resolve) { return Promise.resolve(table === 'invoices' ? { data: [invoice], error: null } : { data: null, error: null }).then(resolve); },
      };
      return q;
    },
  };
  const smtp = require('../lib/smtp');
  const original = { createTransport: smtp.createTransport, sendEmail: smtp.sendEmail };
  // The worker module captured these at require time, so patch through the module cache.
  const mod = require.cache[require.resolve('../lib/bookingReminders')];
  delete require.cache[require.resolve('../lib/bookingReminders')];
  smtp.createTransport = () => ({});
  smtp.sendEmail = async message => { sent.push(message); return { messageId: 'm1' }; };
  try {
    const fresh = require('../lib/bookingReminders');
    assert.deepEqual(await fresh.runBookingReminders(db, { now: new Date('2026-11-14T01:05:00Z') }), { sent: 1 });
    assert.equal(sent[0].to, 'ana@client.sg');
    assert.equal(sent[0].subject, 'See you tomorrow');
    assert.ok(updates.some(([t, p]) => t === 'invoice_booking_reminders' && p.status === 'sent'));

    updates.length = 0;
    assert.deepEqual(await fresh.runBookingReminders(db, { now: new Date('2026-11-15T02:00:00Z') }), { sent: 0 });
    assert.ok(updates.some(([, p]) => p.status === 'cancelled'));
  } finally {
    Object.assign(smtp, original);
    require.cache[require.resolve('../lib/bookingReminders')] = mod;
  }
});
