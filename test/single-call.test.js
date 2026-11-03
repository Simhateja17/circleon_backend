const test = require('node:test');
const assert = require('node:assert/strict');
const { leadSearchFilter, runDueScheduledCalls, singleCallProblem, startSingleCall } = require('../lib/singleCall');
const { handleVoiceCallCompletion } = require('../lib/voiceCallCompletion');
const { nextOpenAt } = require('../lib/voiceScheduling');

const hours = { timezone: 'Asia/Singapore', active_days: [1, 2, 3, 4, 5], sending_hours_start: '09:00', sending_hours_end: '18:00' };
const wedMorning = new Date('2026-09-16T02:00:00Z'); // Wed 10:00 SGT
const wedNight = new Date('2026-09-16T14:00:00Z'); // Wed 22:00 SGT
const friNight = new Date('2026-09-18T14:00:00Z'); // Fri 22:00 SGT

const lead = { id: 'lead-1', full_name: 'A Lead', phone_e164: '+6591234567', phone_type: 'business', workspace_id: 'w1' };
const setup = {
  campaign: { id: 'camp-1', workspace_id: 'w1', name: 'Script', ...hours },
  script: { status: 'approved', opening_line: 'Hello', language: 'en-US' },
  agent: { id: 'agent-1', status: 'ready', retell_agent_id: 'retell-1' },
  telephony: { phone_number_status: 'attached', from_number: '+6560000000', max_concurrent_calls: 2 },
  workspace: { id: 'w1', name: 'Hey' },
};
const okCredit = async () => ({ ok: true, reason: null });

/** A small stand-in for the database that records writes. Reads come from `reads`. */
function fakeDb(reads = {}) {
  const writes = [];
  const queried = [];
  return {
    writes,
    queried,
    from(table) {
      queried.push(table);
      const op = { table, filters: {}, patch: null, insert: null };
      const result = () => {
        if (op.insert) return { data: { id: 'new-call', ...op.insert }, error: null };
        if (op.patch) return { data: { id: op.filters.id || 'x', ...op.patch }, error: null };
        const value = reads[table];
        return { data: value === undefined ? null : value, error: null };
      };
      const chain = {
        select() { return chain; },
        eq(column, value) { op.filters[column] = value; return chain; },
        in() { return chain; }, gte() { return chain; }, lt() { return chain; }, lte() { return chain; },
        order() { return chain; }, limit() { return chain; },
        update(patch) { op.patch = patch; writes.push(op); return chain; },
        insert(row) { op.insert = row; writes.push(op); return chain; },
        maybeSingle: async () => result(),
        single: async () => result(),
        then(resolve, reject) {
          const value = result();
          if (reads[table] === undefined && !op.patch && !op.insert) value.data = [];
          return Promise.resolve(value).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

test('calling opens now during hours, otherwise at the next start of hours', () => {
  assert.equal(nextOpenAt(hours, wedMorning), wedMorning);
  assert.equal(nextOpenAt(hours, wedNight).toISOString(), '2026-09-17T01:00:00.000Z'); // Thu 09:00 SGT
  assert.equal(nextOpenAt(hours, friNight).toISOString(), '2026-09-21T01:00:00.000Z'); // Mon 09:00 SGT
  assert.equal(nextOpenAt(hours, new Date('2026-09-16T00:00:00Z')).toISOString(), '2026-09-16T01:00:00.000Z'); // same day
});

test('a one-off call obeys the same rules as a campaign call', () => {
  assert.equal(singleCallProblem({ lead, setup, credits: { ok: true } }), null);
  assert.match(singleCallProblem({ lead: { ...lead, status: 'do_not_call' }, setup, credits: { ok: true } }), /asked not to be called/);
  assert.match(singleCallProblem({ lead: { ...lead, phone_type: 'personal', dnc_status: 'unknown' }, setup, credits: { ok: true } }), /Do Not Call check/);
  assert.match(singleCallProblem({ lead, setup: { ...setup, script: { ...setup.script, status: 'draft' } }, credits: { ok: true } }), /approve the call script/);
  assert.match(singleCallProblem({ lead, setup: { ...setup, telephony: {} }, credits: { ok: true } }), /Singapore number/);
  assert.equal(singleCallProblem({ lead, setup, credits: { ok: false, reason: 'Plan minutes used up' } }), 'Plan minutes used up');
});

test('lead search keeps user text out of the filter syntax', () => {
  assert.equal(leadSearchFilter(''), 'and(or(phone_e164.not.is.null,phone.not.is.null))');
  const filter = leadSearchFilter('a),workspace_id.neq.1,(b*');
  assert.ok(!filter.includes('a)'));
  assert.ok(filter.includes('full_name.ilike.*a workspace_id neq 1 b*'));
  assert.ok(leadSearchFilter('+65 8363-8482').includes('phone_e164.ilike.*+6583638482*'));
});

const startArgs = { workspaceId: 'w1', userId: 'u1', leadId: 'lead-1', campaignId: 'camp-1', schedulingAvailable: true };

test('during calling hours the call dials straight away and records who confirmed it', async () => {
  const db = fakeDb({ leads: lead, calls: [] });
  const dialled = [];
  const call = await startSingleCall(db, { ...startArgs, now: wedMorning }, {
    loadSetup: async () => setup, credit: okCredit, countActive: async () => 0,
    dial: async args => { dialled.push(args); return { call_id: 'retell-call' }; },
  });
  assert.equal(dialled.length, 1);
  assert.equal(dialled[0].lead.id, 'lead-1');
  assert.equal(call.status, 'calling');
  const inserted = db.writes.find(write => write.insert).insert;
  assert.equal(inserted.source, 'manual');
  assert.equal(inserted.confirmed_by, 'u1');
  assert.equal(inserted.to_number, '+6591234567');
});

test('outside hours nothing dials until the user chooses to schedule', async () => {
  const dial = async () => assert.fail('must not dial outside hours');
  const deps = { loadSetup: async () => setup, credit: okCredit, dial };

  await assert.rejects(
    startSingleCall(fakeDb({ leads: lead, calls: [] }), { ...startArgs, now: wedNight }, deps),
    error => error.extra.code === 'outside_hours' && error.extra.next_open_at === '2026-09-17T01:00:00.000Z',
  );

  const db = fakeDb({ leads: lead, calls: [] });
  const call = await startSingleCall(db, { ...startArgs, schedule: true, now: wedNight }, deps);
  assert.equal(call.status, 'scheduled');
  assert.equal(call.scheduled_for, '2026-09-17T01:00:00.000Z');
});

test('a blocked lead never reaches the dialler', async () => {
  const db = fakeDb({ leads: { ...lead, status: 'do_not_call' }, calls: [] });
  await assert.rejects(
    startSingleCall(db, { ...startArgs, now: wedMorning }, { loadSetup: async () => setup, credit: okCredit, dial: async () => assert.fail('must not dial') }),
    /asked not to be called/,
  );
  assert.equal(db.writes.length, 0);
});

test('a lead with an open call cannot be called again', async () => {
  const db = fakeDb({ leads: lead, calls: [{ id: 'open-call', status: 'in_progress' }] });
  await assert.rejects(
    startSingleCall(db, { ...startArgs, now: wedMorning }, { loadSetup: async () => setup, credit: okCredit, dial: async () => assert.fail('must not dial') }),
    error => error.status === 409 && error.extra.call_id === 'open-call',
  );
});

test('at the plan limit the call waits rather than dialling', async () => {
  await assert.rejects(
    startSingleCall(fakeDb({ leads: lead, calls: [] }), { ...startArgs, now: wedMorning }, {
      loadSetup: async () => setup, credit: okCredit, countActive: async () => 2, dial: async () => assert.fail('must not dial'),
    }),
    error => error.status === 409,
  );
});

test('a failed dial is recorded and reported', async () => {
  const db = fakeDb({ leads: lead, calls: [] });
  await assert.rejects(
    startSingleCall(db, { ...startArgs, now: wedMorning }, {
      loadSetup: async () => setup, credit: okCredit, countActive: async () => 0,
      dial: async () => { throw new Error('Number refused'); },
    }),
    error => error.status === 502 && error.message === 'Number refused',
  );
  assert.ok(db.writes.some(write => write.table === 'calls' && write.patch?.status === 'failed'));
});

function scheduled(overrides = {}) {
  return { id: 'sched-1', workspace_id: 'w1', campaign_id: 'camp-1', lead_id: 'lead-1', status: 'scheduled', leads: lead, from_number: '+656', to_number: '+659', ...overrides };
}

test('a due scheduled call is claimed, then dialled', async () => {
  const dialled = [];
  // The due list and the "is this lead busy" check share a table in this fake,
  // so the busy check is answered by the same rows only when they are active.
  const db = fakeDb({ calls: [scheduled()] });
  const original = db.from.bind(db);
  let reads = 0;
  db.from = table => {
    const chain = original(table);
    if (table !== 'calls') return chain;
    reads += 1;
    if (reads === 2) chain.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  };
  await runDueScheduledCalls(db, wedMorning, {
    loadSetup: async () => setup, credit: okCredit, countActive: async () => 0,
    dial: async args => { dialled.push(args); return { call_id: 'r' }; },
  });
  assert.equal(dialled.length, 1);
  const statuses = db.writes.filter(write => write.table === 'calls').map(write => write.patch.status);
  assert.deepEqual(statuses, ['queued', 'calling']);
});

test('a scheduled call is canceled if the lead has since opted out', async () => {
  const db = fakeDb({ calls: [scheduled({ leads: { ...lead, status: 'do_not_call' } })] });
  await runDueScheduledCalls(db, wedMorning, { loadSetup: async () => setup, credit: okCredit, dial: async () => assert.fail('must not dial') });
  assert.equal(db.writes[0].patch.status, 'canceled');
  assert.match(db.writes[0].patch.error_message, /asked not to be called/);
});

test('a scheduled call moves to the next opening if hours have changed', async () => {
  const db = fakeDb({ calls: [scheduled()] });
  await runDueScheduledCalls(db, wedNight, { loadSetup: async () => setup, credit: okCredit, dial: async () => assert.fail('must not dial') });
  assert.equal(db.writes[0].patch.scheduled_for, '2026-09-17T01:00:00.000Z');
});

test('a one-off call does not move the queue of the campaign whose script it used', async () => {
  const reads = { campaigns: setup.campaign, leads: null, agent_configs: null, workspace_billing: null };
  const manual = fakeDb(reads);
  await handleVoiceCallCompletion(manual, { call: { id: 'c', workspace_id: 'w1', campaign_id: 'camp-1', lead_id: 'lead-1', source: 'manual' }, outcome: { outcome_type: 'interested' }, payload: {} });
  assert.ok(!manual.queried.includes('voice_call_targets'));

  const campaign = fakeDb(reads);
  await handleVoiceCallCompletion(campaign, { call: { id: 'c', workspace_id: 'w1', campaign_id: 'camp-1', lead_id: 'lead-1', source: 'campaign' }, outcome: { outcome_type: 'interested' }, payload: {} });
  assert.ok(campaign.queried.includes('voice_call_targets'));
});
