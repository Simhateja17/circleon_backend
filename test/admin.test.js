const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ADMIN = 'founder-id';
process.env.CIRCLEON_ADMIN_USER_IDS = ADMIN;

// A fake service client that records every call and resolves with canned rows.
const calls = [];
let rows = {};
function builder(table) {
  const ops = [];
  const proxy = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') {
        calls.push({ table, ops });
        const data = typeof rows[table] === 'function' ? rows[table](ops) : rows[table] ?? null;
        return resolve => resolve({ data, error: null, count: Array.isArray(data) ? data.length : 0 });
      }
      return (...args) => { ops.push([prop, ...args]); return proxy; };
    },
  });
  return proxy;
}
const fakeDb = { from: builder, rpc: name => builder(`rpc:${name}`), auth: { admin: { getUserById: async id => ({ data: { user: { email: `${id}@x.test` } } }) } } };

function stub(file, exports) {
  const id = require.resolve(path.join(__dirname, '..', file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const realSupabase = require('../lib/supabase');
stub('lib/supabase.js', Object.assign(realSupabase, { createServiceClient: () => fakeDb }));
stub('middleware/auth.js', (req, res, next) => {
  if (!req.headers['x-user']) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: req.headers['x-user'], email: 'f@x.test' };
  req.accessToken = req.headers['x-token'];
  next();
});

const { mfaState, rateLimit } = require('../lib/admin');
const app = express();
app.use(express.json());
app.use('/api/admin', require('../routes/admin'));

function jwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}
const now = Math.floor(Date.now() / 1000);
const fresh = jwt({ aal: 'aal2', amr: [{ method: 'otp', timestamp: now - 100 }, { method: 'totp', timestamp: now - 60 }] });
const stale = jwt({ aal: 'aal2', amr: [{ method: 'totp', timestamp: now - 13 * 3600 }] });
const aal1 = jwt({ aal: 'aal1', amr: [{ method: 'otp', timestamp: now }] });

let server, base;
test.before(async () => { server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function call(method, url, { user, token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}), ...(token ? { 'x-token': token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ROUTES = [
  ['GET', '/api/admin/overview'], ['GET', '/api/admin/organizations'], ['GET', '/api/admin/organizations/w1'],
  ['POST', '/api/admin/organizations/w1/suspend'], ['POST', '/api/admin/organizations/w1/unsuspend'],
  ['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings'], ['GET', '/api/admin/billing'], ['PATCH', '/api/admin/billing/w1'],
  ['GET', '/api/admin/demos'], ['GET', '/api/admin/provider-credits'], ['POST', '/api/admin/provider-credits/refresh'],
  ['GET', '/api/admin/support'], ['GET', '/api/admin/support/t1'], ['POST', '/api/admin/support/t1/reply'],
  ['POST', '/api/admin/support/t1/status'], ['GET', '/api/admin/audit'],
];

test('mfa state requires aal2 with a totp proof inside 12 hours', () => {
  assert.deepEqual([mfaState(fresh).aal2, mfaState(fresh).fresh], [true, true]);
  assert.deepEqual([mfaState(stale).aal2, mfaState(stale).fresh], [true, false]);
  assert.equal(mfaState(aal1).aal2, false);
  assert.equal(mfaState(jwt({ aal: 'aal2', amr: [] })).aal2, false);
  assert.equal(mfaState('garbage').aal2, false);
  assert.equal(mfaState(undefined).fresh, false);
});

test('every admin route rejects anonymous, non-founder, unverified and expired sessions', async () => {
  for (const [method, url] of ROUTES) {
    assert.equal((await call(method, url)).status, 401, `${url} anonymous`);
    assert.equal((await call(method, url, { user: 'customer', token: fresh })).status, 403, `${url} non-founder`);
    const unverified = await call(method, url, { user: ADMIN, token: aal1 });
    assert.equal(unverified.body.code, 'mfa_required', `${url} aal1`);
    const expired = await call(method, url, { user: ADMIN, token: stale });
    assert.equal(expired.body.code, 'mfa_expired', `${url} stale`);
  }
});

test('/me and mfa endpoints stay founder-only', async () => {
  for (const url of ['/api/admin/me', '/api/admin/mfa/enroll', '/api/admin/mfa/verify']) {
    assert.equal((await call(url === '/api/admin/me' ? 'GET' : 'POST', url, { user: 'customer', token: fresh })).status, 403);
  }
});

test('suspend needs a reason and the exact organization name, and audits before writing', async () => {
  calls.length = 0;
  rows = { workspaces: { id: 'w1', name: 'Acme Pte Ltd' }, workspace_billing: null };
  assert.match((await call('POST', '/api/admin/organizations/w1/suspend', { user: ADMIN, token: fresh, body: { reason: 'Spam', confirm: 'Acme Pte Ltd' } })).body.error, /reason/);
  assert.match((await call('POST', '/api/admin/organizations/w1/suspend', { user: ADMIN, token: fresh, body: { reason: 'Spam complaints', confirm: 'acme' } })).body.error, /exactly/);
  assert.equal(calls.some(c => c.table === 'admin_audit_log'), false);
  const ok = await call('POST', '/api/admin/organizations/w1/suspend', { user: ADMIN, token: fresh, body: { reason: 'Spam complaints', confirm: 'Acme Pte Ltd' } });
  assert.equal(ok.status, 200);
  const auditAt = calls.findIndex(c => c.table === 'admin_audit_log');
  const writeAt = calls.findIndex(c => c.table === 'workspace_billing' && c.ops.some(([op]) => op === 'upsert'));
  assert.ok(auditAt >= 0 && writeAt > auditAt, 'audit row precedes the change');
  const row = calls[auditAt].ops.find(([op]) => op === 'insert')[1];
  assert.equal(row.actor_id, ADMIN);
  assert.equal(row.action, 'organization.suspend');
  assert.equal(row.after.suspended_reason, 'Spam complaints');
});

test('settings writes are audited with before and after values', async () => {
  calls.length = 0;
  rows = { pricing_settings: { legal_ready: false } };
  assert.equal((await call('PATCH', '/api/admin/settings', { user: ADMIN, token: fresh, body: { legal_ready: true } })).status, 200);
  const row = calls.find(c => c.table === 'admin_audit_log').ops.find(([op]) => op === 'insert')[1];
  assert.deepEqual([row.before, row.after], [{ legal_ready: false }, { legal_ready: true }]);
});

test('voice readiness changes that touch Stripe require typed confirmation', async () => {
  calls.length = 0;
  rows = { workspaces: { id: 'w1', name: 'Acme' }, workspace_billing: { subscription_status: 'trialing', plan: 'allinone_starter', fallback_number: '+6591234567' } };
  const res = await call('PATCH', '/api/admin/billing/w1', { user: ADMIN, token: fresh, body: { voice_ready: true } });
  assert.match(res.body.error, /exactly/);
  assert.equal(calls.some(c => c.table === 'admin_audit_log'), false);
});

test('rate limiter blocks after the window maximum', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 2 });
  const statuses = [];
  const res = { status: code => ({ json: () => statuses.push(code) }) };
  for (let i = 0; i < 3; i++) limit({ user: { id: 'u' } }, res, () => statuses.push(200));
  assert.deepEqual(statuses, [200, 200, 429]);
});
