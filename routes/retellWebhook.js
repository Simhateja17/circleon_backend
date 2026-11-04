const express = require('express');
const { createServiceClient } = require('../lib/supabase');
const { verifyRetellSignature } = require('../lib/calling');
const { applyRetellCallUpdate } = require('../lib/retellCallSync');

const router = express.Router();

function getEventName(payload) {
  return payload.event || payload.event_type || payload.type || payload.call_status || '';
}

function getCall(payload) {
  return payload.call || payload.data || payload;
}

router.post('/', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const signature = req.headers['x-retell-signature'] || req.headers['retell-signature'];

  if (!verifyRetellSignature(rawBody, signature)) {
    return res.status(403).json({ error: 'Invalid Retell signature' });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is required for Retell webhooks' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (_error) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const eventName = getEventName(payload);
  const call = getCall(payload);
  const retellCallId = call.call_id || call.retell_call_id || payload.call_id;
  const metadata = call.metadata || payload.metadata || {};
  const callId = metadata.call_id;

  if (!retellCallId && !callId) {
    return res.status(202).json({ ignored: true, reason: 'No call identifier' });
  }

  try {
    await applyRetellCallUpdate(supabase, { eventName, call, payload, callId, retellCallId });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ received: true });
});

module.exports = router;
