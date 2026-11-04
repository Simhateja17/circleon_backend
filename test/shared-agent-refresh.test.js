const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshSharedAgents, SHARED_PROMPT, SHARED_OPENING } = require('../lib/voiceAgentProvisioning');
const { bookingTools, retellWebhookUrl } = require('../lib/retellVoice');

const ENV = ['RETELL_FUNCTION_BASE_URL', 'RETELL_FUNCTION_SECRET', 'RETELL_WEBHOOK_URL'];

function withEnv(values, run) {
  return async () => {
    const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
    ENV.forEach(key => delete process.env[key]);
    Object.assign(process.env, values);
    try { await run(); } finally {
      ENV.forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
    }
  };
}

function fakeDb(agents) {
  const updates = [];
  return {
    updates,
    from() {
      const op = { patch: null };
      const chain = {
        select() { return chain; }, eq() { return chain; },
        update(patch) { op.patch = patch; updates.push(patch); return chain; },
        then(resolve, reject) { return Promise.resolve({ data: op.patch ? null : agents, error: null }).then(resolve, reject); },
      };
      return chain;
    },
  };
}

const agent = { id: 'a1', retell_llm_id: 'llm1', retell_agent_id: 'agent1' };
const configured = { RETELL_FUNCTION_BASE_URL: 'https://api.example.com', RETELL_FUNCTION_SECRET: 's3cret' };

test('the webhook defaults to our own address, unless overridden', withEnv(configured, () => {
  assert.equal(retellWebhookUrl(), 'https://api.example.com/api/retell/webhook');
  process.env.RETELL_WEBHOOK_URL = 'https://other.example.com/hook';
  assert.equal(retellWebhookUrl(), 'https://other.example.com/hook');
}));

test('a shared agent gets the booking tools and webhook it was missing', withEnv(configured, async () => {
  const calls = [];
  const result = await refreshSharedAgents(fakeDb([agent]), {
    updateLlm: async (id, body) => calls.push(['llm', id, body]),
    updateAgent: async (id, body) => calls.push(['agent', id, body]),
  });
  assert.deepEqual(result, { refreshed: 1, failed: 0 });
  // Per-call prompts arrive as variables, so these templates must stay in place.
  assert.deepEqual(calls[0], ['llm', 'llm1', { prompt: SHARED_PROMPT, beginMessage: SHARED_OPENING }]);
  assert.deepEqual(calls[1], ['agent', 'agent1', { webhookUrl: 'https://api.example.com/api/retell/webhook' }]);
  assert.deepEqual(bookingTools().map(tool => tool.name), ['check_availability', 'book_meeting']);
}));

test('missing settings never wipe an agent', withEnv({}, async () => {
  const fail = async () => assert.fail('must not touch Retell');
  const db = fakeDb([agent]);
  assert.deepEqual(await refreshSharedAgents(db, { updateLlm: fail, updateAgent: fail }), { refreshed: 0, failed: 0 });
  assert.equal(db.updates.length, 0);
}));

test('one failed agent does not stop the rest and stays ready', withEnv(configured, async () => {
  const db = fakeDb([agent, { ...agent, id: 'a2', retell_llm_id: 'llm2' }]);
  const result = await refreshSharedAgents(db, {
    updateLlm: async id => { if (id === 'llm1') throw new Error('Retell down'); },
    updateAgent: async () => {},
  });
  assert.deepEqual(result, { refreshed: 1, failed: 1 });
  assert.match(db.updates[0].last_error, /Retell down/);
  assert.ok(db.updates.every(update => update.status === undefined));
}));
