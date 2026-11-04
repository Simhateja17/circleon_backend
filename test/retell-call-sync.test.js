const test = require('node:test');
const assert = require('node:assert/strict');
const { syncUnsettledCalls } = require('../lib/retellCallSync');

const now = new Date('2026-11-04T04:00:00Z');
const stuck = { id: 'c1', status: 'calling', retell_call_id: 'r1', created_at: '2026-11-04T01:00:00Z' };
const callRow = { ...stuck, workspace_id: 'w1', lead_id: null, campaign_id: null, follow_up_id: null };

function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    rpc: async () => ({ data: null, error: null }),
    from(table) {
      const op = { table, filters: {}, patch: null };
      const chain = {
        select() { return chain; }, not() { return chain; }, or() { return chain; }, gte() { return chain; },
        lt() { return chain; }, order() { return chain; }, limit() { return chain; }, in() { return chain; },
        eq(column, value) { op.filters[column] = value; return chain; },
        update(patch) { op.patch = patch; updates.push(op); return chain; },
        upsert() { return chain; }, insert() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: {}, error: null }),
        then(resolve, reject) {
          let data = [];
          if (table === 'calls' && !op.patch) data = rows;
          if (table === 'calls' && op.patch) data = [{ ...callRow, ...op.patch }];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const callUpdates = db => db.updates.filter(update => update.table === 'calls' && update.filters.id === 'c1');

test('a call that ended without a webhook gets its result from Retell', async () => {
  const db = fakeDb([stuck]);
  await syncUnsettledCalls(db, now, async () => ({
    call_id: 'r1', call_status: 'ended', end_timestamp: now.getTime() - 3600000, duration_ms: 42000,
    transcript: 'Agent: Hello', call_analysis: { call_summary: 'Spoke briefly' },
  }));
  const patch = callUpdates(db)[0].patch;
  assert.equal(patch.status, 'completed');
  assert.equal(patch.duration_seconds, 42);
  assert.equal(patch.summary, 'Spoke briefly');
  assert.equal(patch.transcript, 'Agent: Hello');
});

test('an unanswered call is recorded as no answer', async () => {
  const db = fakeDb([stuck]);
  await syncUnsettledCalls(db, now, async () => ({ call_id: 'r1', call_status: 'not_connected', disconnection_reason: 'dial_no_answer', end_timestamp: now.getTime() - 3600000 }));
  assert.equal(callUpdates(db)[0].patch.status, 'no_answer');
});

test('a live call is left alone apart from showing it connected', async () => {
  const db = fakeDb([stuck]);
  await syncUnsettledCalls(db, now, async () => ({ call_id: 'r1', call_status: 'ongoing' }));
  assert.deepEqual(callUpdates(db).map(update => update.patch), [{ status: 'in_progress' }]);

  const dialling = fakeDb([stuck]);
  await syncUnsettledCalls(dialling, now, async () => ({ call_id: 'r1', call_status: 'registered' }));
  assert.equal(callUpdates(dialling).length, 0);
});

test('a just-ended call waits for its summary', async () => {
  const db = fakeDb([stuck]);
  await syncUnsettledCalls(db, now, async () => ({ call_id: 'r1', call_status: 'ended', end_timestamp: now.getTime() - 30000 }));
  assert.equal(callUpdates(db).length, 0);
});

test('a brief Retell outage changes nothing', async () => {
  const db = fakeDb([stuck]);
  await syncUnsettledCalls(db, now, async () => { throw Object.assign(new Error('down'), { status: 500 }); });
  assert.equal(callUpdates(db).length, 0);
});

test('a call Retell has no record of eventually fails, but not straight away', async () => {
  const missing = async () => { throw Object.assign(new Error('not found'), { status: 404 }); };

  const old = fakeDb([stuck]);
  await syncUnsettledCalls(old, now, missing);
  assert.equal(callUpdates(old)[0].patch.status, 'failed');

  const recent = fakeDb([{ ...stuck, created_at: '2026-11-04T03:50:00Z' }]);
  await syncUnsettledCalls(recent, now, missing);
  assert.equal(callUpdates(recent).length, 0);
});
