const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'b'.repeat(32);
const PN = 'PN' + 'c'.repeat(32);
const credentials = { accountSid: SID, authToken: TOKEN };

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null, auth: options.headers?.Authorization });
    const match = routes.find(([pattern, method]) => pattern.test(url) && (method || 'GET') === (options.method || 'GET'));
    const [, , status = 200, payload = {}] = match || [null, null, 404, { code: 20404, message: 'not found' }];
    return { ok: status < 300, status, json: async () => payload };
  };
  return calls;
}

const twilio = () => { delete require.cache[require.resolve('../lib/twilioByok')]; return require('../lib/twilioByok'); };

test('account validation rejects malformed, trial and unauthorised accounts', async () => {
  const saved = global.fetch;
  try {
    const { validateAccount } = twilio();
    await assert.rejects(validateAccount({ accountSid: 'bad', authToken: TOKEN }), /Account SID/);
    mockFetch([[/Accounts\/AC\w+\.json$/, 'GET', 200, { status: 'active', type: 'Trial' }]]);
    await assert.rejects(validateAccount(credentials), /trial/);
    mockFetch([[/Accounts\/AC\w+\.json$/, 'GET', 401, {}]]);
    await assert.rejects(validateAccount(credentials), /rejected/);
    const calls = mockFetch([[/Accounts\/AC\w+\.json$/, 'GET', 200, { status: 'active', type: 'Full', friendly_name: 'Acme' }]]);
    assert.equal((await validateAccount(credentials)).friendlyName, 'Acme');
    assert.equal(calls[0].auth, 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'));
  } finally { global.fetch = saved; }
});

test('only Singapore voice numbers owned by the account are eligible', async () => {
  const saved = global.fetch;
  try {
    const { listEligibleNumbers, fetchOwnedNumber } = twilio();
    mockFetch([[/IncomingPhoneNumbers\.json/, 'GET', 200, { incoming_phone_numbers: [
      { sid: PN, phone_number: '+6561234567', capabilities: { voice: true } },
      { sid: 'PN2', phone_number: '+14155550100', capabilities: { voice: true } },
      { sid: 'PN3', phone_number: '+6590000000', capabilities: { voice: false } },
    ] }]]);
    assert.deepEqual((await listEligibleNumbers(credentials)).map(n => n.sid), [PN]);

    mockFetch([[/IncomingPhoneNumbers\/PN\w+\.json$/, 'GET', 200, { sid: PN, account_sid: 'AC' + 'd'.repeat(32), phone_number: '+6561234567' }]]);
    await assert.rejects(fetchOwnedNumber(credentials, PN), /not on the connected/);
    mockFetch([]);
    await assert.rejects(fetchOwnedNumber(credentials, PN), /not on the connected/);
    await assert.rejects(fetchOwnedNumber(credentials, '../evil'), /Choose a number/);
  } finally { global.fetch = saved; }
});

test('termination trunk uses credential auth on the Singapore edge and is reused', async () => {
  const saved = global.fetch;
  try {
    const { ensureTerminationTrunk, routeInboundToWebhook } = twilio();
    const calls = mockFetch([
      [/\/v1\/Trunks$/, 'POST', 201, { sid: 'TK1' }],
      [/CredentialLists\.json$/, 'POST', 201, { sid: 'CL1' }],
      [/CredentialLists\/CL1\/Credentials\.json$/, 'POST', 201, {}],
      [/\/v1\/Trunks\/TK1\/CredentialLists$/, 'POST', 201, {}],
      [/\/v1\/Trunks\/TK1$/, 'GET', 200, { sid: 'TK1' }],
      [/IncomingPhoneNumbers\/PN\w+\.json$/, 'POST', 200, {}],
    ]);
    const trunk = await ensureTerminationTrunk(credentials, { workspaceId: '12345678-aaaa' });
    assert.match(trunk.terminationUri, /^circleon-12345678-\w+\.pstn\.singapore\.twilio\.com$/);
    const password = calls.find(c => /Credentials\.json$/.test(c.url)).body.Password;
    assert.ok(password.length >= 12 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password));
    // The number is never put on the trunk: that would bypass the inbound webhook.
    assert.ok(!calls.some(c => /Trunks\/\w+\/PhoneNumbers/.test(c.url)));

    const before = calls.length;
    assert.equal(await ensureTerminationTrunk(credentials, { workspaceId: 'x', existing: trunk }), trunk);
    assert.equal(calls.length, before + 1);

    await routeInboundToWebhook(credentials, PN, 'https://api.test/api/billing/inbound/w1');
    assert.deepEqual(calls.at(-1).body, { VoiceUrl: 'https://api.test/api/billing/inbound/w1', VoiceMethod: 'POST', VoiceApplicationSid: '' });
  } finally { global.fetch = saved; }
});

test('inbound webhooks verify against the workspace Twilio token, not other accounts', async () => {
  process.env.ENCRYPTION_KEY = 'test-key';
  const { encrypt } = require('../lib/crypto');
  const m = require('../lib/monthlyBilling');
  const saved = { service: m.service, url: process.env.API_PUBLIC_URL, tokens: process.env.BILLING_TWILIO_ACCOUNT_TOKENS };
  const telephony = { twilio_account_sid: SID, twilio_auth_token_encrypted: encrypt(TOKEN), twilio_connected_at: 'now' };
  m.service = () => ({ from(table) { const q = { select: () => q, eq: () => q, maybeSingle: () => q, single: () => q, then: (r, j) => Promise.resolve({ data: table === 'workspace_telephony' ? telephony : null, error: table === 'workspace_billing' ? { message: 'stop' } : null }).then(r, j) }; return q; } });
  process.env.API_PUBLIC_URL = 'https://api.circleon.test';
  process.env.BILLING_TWILIO_ACCOUNT_TOKENS = JSON.stringify({ ['AC' + 'e'.repeat(32)]: 'other' });
  delete require.cache[require.resolve('../lib/inboundBilling')];
  const { handleInbound } = require('../lib/inboundBilling');
  const url = '/api/billing/inbound/w1';
  const sign = (body, token) => crypto.createHmac('sha1', token).update(process.env.API_PUBLIC_URL + url + Object.keys(body).sort().map(k => k + body[k]).join('')).digest('base64');
  const run = (body, token) => handleInbound({ params: { id: 'w1' }, originalUrl: url, body, headers: { 'x-twilio-signature': sign(body, token) } }, { sendStatus: code => code });
  try {
    // Signed by the workspace's account: passes verification, then stops at billing (503).
    assert.equal(await run({ AccountSid: SID, CallSid: 'CA1' }, TOKEN), 503);
    // A different account, even one in the deployment map, is refused for this workspace.
    assert.equal(await run({ AccountSid: 'AC' + 'e'.repeat(32), CallSid: 'CA1' }, 'other'), 403);
    assert.equal(await run({ AccountSid: SID, CallSid: 'CA1' }, 'wrong'), 403);
  } finally {
    m.service = saved.service;
    for (const [k, v] of [['API_PUBLIC_URL', saved.url], ['BILLING_TWILIO_ACCOUNT_TOKENS', saved.tokens]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete require.cache[require.resolve('../lib/inboundBilling')];
  }
});
