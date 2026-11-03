const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supabaseLib = require('../lib/supabase');

const TOKEN = 'a'.repeat(32);
let state;

function fakeClient() {
  return {
    from(table) {
      const query = {
        select: () => query, eq: () => query, in: () => query, gte: () => query, lt: () => query, ilike: () => query, limit: () => query,
        maybeSingle: async () => ({ data: state.workspace, error: null }),
        insert: async row => { state.inserted.push(row); return { error: state.insertError || null }; },
        then: resolve => resolve({ data: table === 'leads' ? state.leads : state.meetings, error: null }),
      };
      return query;
    },
  };
}

async function request(method, path, body) {
  supabaseLib.createServiceClient = fakeClient;
  delete require.cache[require.resolve('../routes/booking')];
  const app = express();
  app.use('/', require('../routes/booking'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test.beforeEach(() => {
  state = { workspace: { id: 'w', name: 'Hey' }, meetings: [], leads: [], inserted: [], insertError: null };
});

test('rejects a malformed or unknown token', async () => {
  assert.equal((await request('GET', '/not-a-token')).status, 404);
  state.workspace = null;
  assert.equal((await request('GET', `/${TOKEN}`)).status, 404);
});

test('lists open times and does not expose the workspace id', async () => {
  const { status, body } = await request('GET', `/${TOKEN}`);
  assert.equal(status, 200);
  assert.equal(body.company, 'Hey');
  assert.ok(body.slots.length > 3);
  assert.equal(JSON.stringify(body).includes('"w"'), false);
});

test('books an open time onto the in-house calendar and links a known lead', async () => {
  const { body: { slots } } = await request('GET', `/${TOKEN}`);
  state.leads = [{ id: 'lead-1', phone_e164: '+6500000000' }];
  const { status } = await request('POST', `/${TOKEN}`, { start: slots[0].start, name: 'Ann', email: 'ANN@Example.com' });
  assert.equal(status, 201);
  assert.equal(state.inserted[0].provider, 'manual');
  assert.equal(state.inserted[0].lead_id, 'lead-1');
  assert.equal(state.inserted[0].invitee_email, 'ann@example.com');
  assert.equal(state.inserted[0].starts_at, slots[0].start);
});

test('refuses a time that was never offered', async () => {
  const { status } = await request('POST', `/${TOKEN}`, { start: '2020-01-01T00:00:00Z', name: 'Ann', email: 'a@b.co' });
  assert.equal(status, 409);
  assert.equal(state.inserted.length, 0);
});

test('reports a lost race as taken', async () => {
  const { body: { slots } } = await request('GET', `/${TOKEN}`);
  state.insertError = { code: '23505' };
  const { status, body } = await request('POST', `/${TOKEN}`, { start: slots[0].start, name: 'Ann', email: 'a@b.co' });
  assert.equal(status, 409);
  assert.match(body.error, /taken/);
});

test('requires a name and a valid email', async () => {
  assert.equal((await request('POST', `/${TOKEN}`, { start: 'x', name: '', email: 'nope' })).status, 400);
});
