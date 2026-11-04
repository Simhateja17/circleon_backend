// Applies what Retell reports about a call: status, transcript, charge, outcome
// and the next step for the lead. Used by the webhook, and by the check that asks
// Retell directly when a webhook never arrives.

const { extractOutcome, upsertCallOutcome } = require('./outcomes');
const { handleVoiceCallCompletion } = require('./voiceCallCompletion');
const { getCall, retellHasFinished } = require('./retellVoice');

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

async function applyRetellCallUpdate(supabase, { eventName, call, payload, callId, retellCallId }) {
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
  if (call.duration_ms) patch.duration_seconds = Number(call.duration_ms) / 1000;
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

  if (error) throw error;
  const updatedCall = updatedCalls?.[0];

  // Billing must acknowledge completion durably even before analysis arrives.
  // Return a retryable failure if metering fails; follow-up side effects run later.
  if (updatedCall?.status === 'completed') {
    try { await require('../lib/callCredits').chargeForCall(supabase, updatedCall); }
    catch (_billingError) { throw Object.assign(new Error('Call usage could not be recorded.'), { billing: true }); }
  }

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

    if (updatedCall.campaign_id) {
      // A voice campaign call: charge the credit, schedule or stop the retry,
      // honour a do-not-call request, and send the email the agent promised.
      try {
        await handleVoiceCallCompletion(supabase, { call: updatedCall, outcome, payload: call });
      } catch (completionError) {
        // The call itself is already recorded. Losing the follow-up work should
        // not make Retell retry the whole webhook.
        console.error('[retell-webhook] voice completion failed', updatedCall.id, completionError);
      }
    } else {
      await require('../lib/callCredits').chargeForCall(supabase,updatedCall);
      await createSuggestedFollowUp(supabase, updatedCall, call);
    }
  }

  return updatedCall || null;
}

const OPEN_STATUSES = ['queued', 'calling', 'ringing', 'in_progress'];
const FINISHED_STATUSES = ['completed', 'no_answer', 'busy'];
// Webhooks normally arrive within seconds, so only step in after this long.
const CHECK_AFTER_MS = 2 * 60 * 1000;
// Retell needs a moment after a call ends to write the summary.
const ANALYSIS_GRACE_MS = 3 * 60 * 1000;
const LOOK_BACK_MS = 24 * 60 * 60 * 1000;
const GIVE_UP_AFTER_MS = 2 * 60 * 60 * 1000;

/** Calls Retell should have told us about by now. */
async function loadUnsettledCalls(supabase, now) {
  const { data, error } = await supabase
    .from('calls')
    .select('id, status, retell_call_id, created_at')
    .not('retell_call_id', 'is', null)
    .or(`status.in.(${OPEN_STATUSES.join(',')}),and(status.in.(${FINISHED_STATUSES.join(',')}),outcome_type.is.null)`)
    .gte('created_at', new Date(now.getTime() - LOOK_BACK_MS).toISOString())
    .lt('updated_at', new Date(now.getTime() - CHECK_AFTER_MS).toISOString())
    .order('updated_at', { ascending: true })
    .limit(20);
  if (error) throw error;
  return data || [];
}

/** Ask Retell about calls whose webhook never came, so none stays stuck on Calling. */
async function syncUnsettledCalls(supabase, now = new Date(), fetchCall = getCall) {
  for (const row of await loadUnsettledCalls(supabase, now)) {
    try {
      let call;
      try {
        call = await fetchCall(row.retell_call_id);
      } catch (error) {
        const tooOld = now.getTime() - new Date(row.created_at).getTime() > GIVE_UP_AFTER_MS;
        if (error.status !== 404 || !tooOld) throw error;
        call = { call_id: row.retell_call_id, call_status: 'error', disconnection_reason: 'call_not_found' };
      }

      if (!retellHasFinished(call)) {
        if (call.call_status === 'ongoing' && row.status !== 'in_progress') {
          await supabase.from('calls').update({ status: 'in_progress' }).eq('id', row.id);
        }
        continue;
      }

      const endedAt = call.end_timestamp ? Number(call.end_timestamp) : 0;
      const analysed = Boolean(call.call_analysis);
      if (!analysed && endedAt && now.getTime() - endedAt < ANALYSIS_GRACE_MS) continue;

      await applyRetellCallUpdate(supabase, {
        eventName: 'call_analyzed',
        call,
        payload: { event: 'call_analyzed', call, source: 'status_check' },
        callId: row.id,
        retellCallId: row.retell_call_id,
      });
    } catch (error) {
      console.error('[retell-sync] could not check call', row.id, error.message);
    }
  }
}

module.exports = { applyRetellCallUpdate, syncUnsettledCalls };
