// Readiness and runtime state for a voice campaign.
//
// Used by the dialer to decide whether to place a call, and by the campaign API
// to explain what the campaign is doing. Both read from the same function on
// purpose: "why is nothing happening" is the most common question on any
// dialer, and the answer the UI shows must be the answer the queue acted on.

const { callingWindowState } = require('./voiceScheduling');
const { minimumBalanceCents } = require('./callCredits');

const ACTIVE_CALL_STATUSES = ['queued', 'calling', 'ringing', 'in_progress'];
const ATTACHED_NUMBER_STATUSES = ['attached', 'verified'];

/** Languages the customer must explicitly attest to before launching. */
function requiresAttestation(language) {
  return !String(language || 'en-US').toLowerCase().startsWith('en');
}

/**
 * Things that must be fixed before this campaign can ever dial. These are
 * setup problems, not timing.
 */
function setupBlockers({ campaign, script, agent, telephony }) {
  const blockers = [];

  if (!ATTACHED_NUMBER_STATUSES.includes(telephony?.phone_number_status)) {
    blockers.push({
      key: 'number',
      label: 'Singapore number',
      reason: telephony?.phone_number_status === 'pending_verification'
        ? 'Waiting on Twilio to verify your Singapore number'
        : 'Connect a Singapore number to start calling',
      waiting: telephony?.phone_number_status === 'pending_verification',
    });
  }

  if (!script?.opening_line) {
    blockers.push({ key: 'opening_line', label: 'Opening line', reason: 'Write the opening line before launching' });
  }

  if (script?.status !== 'approved') {
    blockers.push({ key: 'script', label: 'Script', reason: 'Review and approve the call script' });
  }

  if (requiresAttestation(script?.language) && !script?.attested_at) {
    blockers.push({
      key: 'attestation',
      label: 'Script approval',
      reason: 'Confirm you have read and approved this non-English script',
    });
  }

  if (agent?.status !== 'ready' || !agent?.retell_agent_id) {
    blockers.push({
      key: 'agent',
      label: 'Voice agent',
      reason: agent?.last_error || 'Voice agent is still being prepared',
      waiting: agent?.status === 'provisioning',
    });
  }

  return blockers;
}

/**
 * Why the campaign is not dialling at this exact moment, given it is set up
 * correctly. These resolve on their own.
 */
function timingState({ campaign, telephony, callsToday, activeCalls, creditBalanceCents, pendingTargets, nextAttemptAt }, now = new Date()) {
  const window = callingWindowState({
    timezone: campaign?.timezone,
    active_days: campaign?.active_days,
    sending_hours_start: campaign?.sending_hours_start,
    sending_hours_end: campaign?.sending_hours_end,
  }, now);

  if (campaign?.status === 'paused') {
    return { dialing: false, state: 'paused', reason: 'Campaign is paused' };
  }
  if (campaign?.status !== 'active') {
    return { dialing: false, state: 'not_launched', reason: 'Campaign has not been launched' };
  }
  if (creditBalanceCents !== undefined && creditBalanceCents < minimumBalanceCents()) {
    return { dialing: false, state: 'out_of_credits', reason: 'Out of call credits' };
  }
  if (!window.open) {
    return { dialing: false, state: 'outside_hours', reason: window.reason };
  }
  if (callsToday !== undefined && callsToday >= (campaign?.daily_send_cap || 0)) {
    return { dialing: false, state: 'daily_cap', reason: 'Daily call cap reached' };
  }
  if (activeCalls !== undefined && activeCalls >= (telephony?.max_concurrent_calls || 1)) {
    return { dialing: false, state: 'at_concurrency', reason: 'Already at the concurrent call limit' };
  }
  if (pendingTargets === 0) {
    return {
      dialing: false,
      state: nextAttemptAt ? 'awaiting_retry' : 'finished',
      reason: nextAttemptAt ? 'Waiting for the next scheduled retry' : 'Every lead has been worked',
    };
  }

  return { dialing: true, state: 'dialing', reason: null };
}

/** The full picture, as the campaign view shows it. */
function voiceCampaignState(input, now = new Date()) {
  const blockers = setupBlockers(input);
  if (blockers.length) {
    const waiting = blockers.every(blocker => blocker.waiting);
    return {
      ready: false,
      dialing: false,
      state: waiting ? 'waiting_on_setup' : 'needs_setup',
      reason: blockers[0].reason,
      blockers,
    };
  }

  const timing = timingState(input, now);
  return { ready: true, blockers: [], ...timing };
}

module.exports = {
  ACTIVE_CALL_STATUSES,
  ATTACHED_NUMBER_STATUSES,
  requiresAttestation,
  setupBlockers,
  timingState,
  voiceCampaignState,
};
