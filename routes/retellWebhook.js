const express = require('express');
const { createServiceClient } = require('../lib/supabase');
const { verifyRetellSignature } = require('../lib/calling');
const { extractOutcome, upsertCallOutcome } = require('../lib/outcomes');

const router = express.Router();

function getEventName(payload) {
  return payload.event || payload.event_type || payload.type || payload.call_status || '';
}

function getCall(payload) {
  return payload.call || payload.data || payload;
}

function mapRetellStatus(eventName, call) {
  const status = call.call_status || call.status || eventName;
  if (['registered', 'ongoing', 'in_progress'].includes(status)) return 'in_progress';
  if (['ended', 'call_ended', 'analyzed', 'call_analyzed', 'completed'].includes(status)) return 'completed';
  if (['error', 'failed'].includes(status)) return 'failed';
  if (['not_connected', 'no_answer'].includes(status)) return 'no_answer';
  return 'calling';
}

async function createSuggestedFollowUp(supabase, callRow, callPayload) {
  if (!callRow?.lead_id || !callRow?.workspace_id) return;

  const summary = callPayload.call_analysis?.call_summary
    || callPayload.call_summary
    || callPayload.summary
    || callRow.summary;
  const nextStep = callPayload.call_analysis?.custom_analysis_data?.next_action
    || callPayload.call_analysis?.custom_analysis_data?.follow_up
    || callPayload.next_action;

  if (!summary && !nextStep) return;

  const { data: existing } = await supabase
    .from('follow_ups')
    .select('id')
    .eq('workspace_id', callRow.workspace_id)
    .eq('lead_id', callRow.lead_id)
    .eq('status', 'suggested')
    .limit(1);

  if (existing?.length) return;

  await supabase.from('follow_ups').insert({
    workspace_id: callRow.workspace_id,
    lead_id: callRow.lead_id,
    call_id: callRow.id,
    title: nextStep || 'Review call and decide next follow-up',
    context_note: summary || 'Retell call completed. Review transcript before approving.',
    owner_type: 'agent',
    action_type: 'call',
    status: 'suggested',
    priority: 'normal',
  });
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

  const patch = {
    retell_call_id: retellCallId || null,
    status: mapRetellStatus(eventName, call),
    raw_payload: payload,
  };

  if (call.start_timestamp || call.start_time) {
    patch.started_at = new Date(call.start_timestamp || call.start_time).toISOString();
  }
  if (call.end_timestamp || call.end_time) {
    patch.ended_at = new Date(call.end_timestamp || call.end_time).toISOString();
  }
  if (call.duration_ms) patch.duration_seconds = Math.round(Number(call.duration_ms) / 1000);
  if (call.duration_seconds) patch.duration_seconds = Number(call.duration_seconds);
  if (call.transcript) patch.transcript = call.transcript;
  if (call.recording_url) patch.recording_url = call.recording_url;
  if (call.call_analysis?.call_summary || call.summary) patch.summary = call.call_analysis?.call_summary || call.summary;
  if (call.call_analysis?.user_sentiment || call.sentiment) patch.sentiment = call.call_analysis?.user_sentiment || call.sentiment;
  if (call.disconnection_reason) patch.disconnection_reason = call.disconnection_reason;
  if (call.call_cost?.combined_cost) patch.cost_cents = Math.round(Number(call.call_cost.combined_cost) * 100);
  if (patch.status === 'completed') patch.success = true;
  if (['failed', 'no_answer', 'busy', 'canceled'].includes(patch.status)) patch.success = false;

  let query = supabase.from('calls').update(patch);
  query = callId ? query.eq('id', callId) : query.eq('retell_call_id', retellCallId);
  const { data: updatedCalls, error } = await query.select('*');

  if (error) return res.status(500).json({ error: error.message });
  const updatedCall = updatedCalls?.[0];

  if (updatedCall?.follow_up_id && ['completed', 'failed', 'no_answer', 'busy', 'canceled'].includes(patch.status)) {
    await supabase
      .from('follow_ups')
      .update({
        status: patch.status === 'completed' ? 'completed' : 'missed',
        completed_at: patch.status === 'completed' ? new Date().toISOString() : null,
        blocked_reason: patch.status === 'completed' ? null : patch.disconnection_reason || patch.status,
      })
      .eq('id', updatedCall.follow_up_id);
  }

  if (updatedCall && (['completed', 'call_analyzed', 'analyzed'].includes(eventName) || patch.summary)) {
    const outcome = extractOutcome(call, patch.status);
    await upsertCallOutcome(supabase, updatedCall, outcome, call);
    await createSuggestedFollowUp(supabase, updatedCall, call);
  }

  return res.json({ received: true });
});

module.exports = router;
