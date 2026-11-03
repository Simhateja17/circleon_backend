const test = require('node:test');
const assert = require('node:assert/strict');
const { isCampaignFinished, isPermanentRecipientRejection, pendingSteps, requeuePendingSteps, sendableStatuses } = require('../lib/campaignFollowUps');
const { scheduleMessages } = require('../lib/campaignScheduling');

const manual = { allowedStatuses: sendableStatuses({ autopilot_enabled: false }) };
const step = (lead_id, sequence_step, status, extra = {}) => ({ id: `${lead_id}-${sequence_step}`, lead_id, sequence_step, status, direction: 'outbound', ...extra });
const reply = lead_id => ({ id: `${lead_id}-in`, lead_id, sequence_step: null, status: 'received', direction: 'inbound' });

test('the next unsent approved step is pending', () => {
  const pending = pendingSteps([step('a', 2, 'approved'), step('a', 1, 'sent'), step('a', 3, 'approved')], manual);
  assert.deepEqual(pending.map(item => item.message.id), ['a-2']);
  assert.equal(pending[0].previous.id, 'a-1');
});

test('a reply, opt-out or refused step stops the lead', () => {
  assert.equal(pendingSteps([step('a', 1, 'sent'), step('a', 2, 'approved'), reply('a')], manual).length, 0);
  assert.equal(pendingSteps([step('a', 1, 'sent'), step('a', 2, 'approved', { leads: { dnc_status: 'blocked' } })], manual).length, 0);
  assert.equal(pendingSteps([step('a', 1, 'failed'), step('a', 2, 'approved')], manual).length, 0);
});

test('unapproved drafts only send on autopilot', () => {
  const messages = [step('a', 1, 'sent'), step('a', 2, 'draft'), step('a', 3, 'approved')];
  assert.equal(pendingSteps(messages, manual).length, 0);
  assert.equal(pendingSteps(messages, { allowedStatuses: sendableStatuses({ autopilot_enabled: true }) }).length, 1);
});

test('a direct inbox reply does not count as a sequence step', () => {
  assert.equal(pendingSteps([step('a', 1, 'sent'), step('a', null, 'approved')], manual).length, 0);
});

test('a campaign finishes only when something sent and nothing is left', () => {
  assert.equal(isCampaignFinished([step('a', 1, 'approved')], manual), false);
  assert.equal(isCampaignFinished([], manual), false);
  assert.equal(isCampaignFinished([step('a', 1, 'draft')], manual), false);
  assert.equal(isCampaignFinished([step('a', 1, 'sent'), step('b', 1, 'sent'), step('b', 2, 'approved')], manual), false);
  assert.equal(isCampaignFinished([step('a', 1, 'sent'), step('b', 1, 'sent'), step('b', 2, 'approved'), reply('b')], manual), true);
});

test('only a refused address counts as permanent', () => {
  assert.equal(isPermanentRecipientRejection({ code: 'EENVELOPE', rejected: ['x@y.z'], response: '550-5.1.1 no such user' }), true);
  assert.equal(isPermanentRecipientRejection({ code: 'EENVELOPE', rejected: ['x@y.z'], response: '550 5.4.5 Daily user sending limit exceeded' }), false);
  assert.equal(isPermanentRecipientRejection({ code: 'EAUTH', responseCode: 535, response: '535 bad credentials' }), false);
  assert.equal(isPermanentRecipientRejection({ code: 'EENVELOPE', rejected: [], response: '550 5.1.1' }), false);
});

// Answers every query chain with one fixed result.
function fakeDb(results = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      const query = {
        select: () => query, eq: () => query, in: () => query, not: () => query, gte: () => query, order: () => query, range: () => query,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        update: patch => { updates.push(patch); return query; },
        then: (resolve) => resolve({ data: results[table] || [], error: null }),
      };
      return query;
    },
  };
}
const fakeQueue = () => {
  const queue = { jobs: [], removed: [], getJob: async id => ({ remove: async () => queue.removed.push(id) }), addBulk: async jobs => queue.jobs.push(...jobs) };
  return queue;
};
const campaign = { id: 'c', workspace_id: 'w', timezone: 'UTC', active_days: [0, 1, 2, 3, 4, 5, 6], sending_hours_start: '00:00', sending_hours_end: '23:59', daily_send_cap: 50, cadence_per_hour: 25, autopilot_enabled: false };

test('a follow-up due in three days is delayed three days, not sent straight away', async () => {
  const queue = fakeQueue();
  const due = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  await scheduleMessages({ supabase: fakeDb(), queue, workspaceId: 'w', campaign, messages: [{ id: 'm', lead_id: 'a', sequence_step: 2 }], now: due });
  const days = queue.jobs[0].opts.delay / (24 * 60 * 60 * 1000);
  assert.ok(days > 2.99 && days <= 3, `delay was ${days} days`);
});

test('resume re-queues overdue steps and leaves the rest alone', async () => {
  const now = new Date('2026-11-10T02:00:00Z');
  const past = '2026-11-08T02:00:00Z';
  const future = '2026-11-12T02:00:00Z';
  const db = fakeDb({
    messages: [
      step('overdue', 1, 'approved', { scheduled_at: past }),
      step('waiting', 1, 'approved', { scheduled_at: future }),
      step('new', 1, 'approved', { scheduled_at: null }),
      step('chain', 1, 'sent', { scheduled_at: past, sent_at: past }),
      step('chain', 2, 'approved', { scheduled_at: null }),
      step('early', 1, 'sent', { scheduled_at: past, sent_at: '2026-11-09T02:00:00Z' }),
      step('early', 2, 'approved', { scheduled_at: null }),
    ],
    email_sequences: [{ step_number: 1, delay_days: 0 }, { step_number: 2, delay_days: 1 }],
  });
  const queue = fakeQueue();
  const count = await requeuePendingSteps({ db, queue, campaign, now });
  assert.equal(count, 3);
  assert.deepEqual(queue.jobs.map(job => job.data.messageId).sort(), ['chain-2', 'early-2', 'overdue-1']);
  assert.equal(queue.removed.length, 3);
});

test('a booked meeting stops the lead', () => {
  const booked = { leads: { meetings: [{ status: 'scheduled' }] } };
  assert.equal(pendingSteps([step('a', 1, 'sent', booked), step('a', 2, 'approved', booked)], manual).length, 0);
  const canceled = { leads: { meetings: [{ status: 'canceled' }] } };
  assert.equal(pendingSteps([step('a', 1, 'sent', canceled), step('a', 2, 'approved', canceled)], manual).length, 1);
});
