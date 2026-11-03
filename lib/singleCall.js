// One-off calls from the Calls page: one lead, one approved script, one attempt.
//
// They obey the same rules as a campaign call. The script's campaign supplies the
// agent and calling hours, but the call never touches that campaign's queue.

const { normalizePhone } = require('./calling');
const { voiceEligibility } = require('./dnc');
const { creditCheck } = require('./callCredits');
const { ACTIVE_CALL_STATUSES, setupBlockers } = require('./voiceCampaign');
const { callingWindowState, nextOpenAt } = require('./voiceScheduling');
const { monthlyWorkspace, loadWorkspaceAgent } = require('./voiceAgentProvisioning');
const { dialLead, retellCallId } = require('./voiceDial');

const OPEN_STATUSES = ['scheduled', ...ACTIVE_CALL_STATUSES];
// Longer than any real call. Past this the provider's result was lost, and the
// lead must not stay locked.
const STALE_AFTER_MS = 90 * 60 * 1000;

class SingleCallError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function first(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

/** The first reason this call cannot go ahead, whatever the time of day. */
function singleCallProblem({ lead, setup, credits }) {
  const eligibility = voiceEligibility(lead);
  if (!eligibility.callable) return eligibility.reason;

  const blocker = setupBlockers(setup)[0];
  if (blocker) return blocker.reason;

  if (credits && !credits.ok) return credits.reason || 'Calling is not available for this workspace';
  return null;
}

/** Strip the characters that carry meaning in a PostgREST filter. */
function leadSearchFilter(query) {
  const term = String(query || '').replace(/[,()*%:"\\.]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 80);
  const hasPhone = 'or(phone_e164.not.is.null,phone.not.is.null)';
  if (!term) return `and(${hasPhone})`;
  // People type numbers with spaces and dashes, but they are stored without.
  const looksLikePhone = /^[+\d\s-]+$/.test(term);
  const phoneTerm = looksLikePhone ? term.replace(/[\s-]/g, '') : term;
  const matches = [
    `full_name.ilike.*${term}*`,
    `company_name.ilike.*${term}*`,
    `phone_e164.ilike.*${phoneTerm}*`,
    `phone.ilike.*${phoneTerm}*`,
  ].join(',');
  return `and(${hasPhone},or(${matches}))`;
}

async function loadCallSetup(supabase, workspaceId, campaignId) {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*, workspaces(id, name), voice_scripts(*), voice_agents(*)')
    .eq('workspace_id', workspaceId)
    .eq('id', campaignId)
    .eq('channel', 'voice')
    .maybeSingle();

  if (error) throw error;
  if (!campaign) return null;

  const { data: telephony, error: telephonyError } = await supabase
    .from('workspace_telephony')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (telephonyError) throw telephonyError;

  const monthly = await monthlyWorkspace(supabase, workspaceId);
  const agent = monthly ? await loadWorkspaceAgent(supabase, workspaceId) : first(campaign.voice_agents);

  if (monthly) {
    const { data: agentConfig, error: configError } = await supabase
      .from('agent_configs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (configError) throw configError;
    campaign.monthlyAgentConfig = agentConfig;
  }

  return { campaign, script: first(campaign.voice_scripts), agent, telephony, workspace: campaign.workspaces };
}

async function countActiveCalls(supabase, workspaceId) {
  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ACTIVE_CALL_STATUSES);
  if (error) throw error;
  return count || 0;
}

function concurrencyLimit(credits, telephony) {
  return credits?.concurrency
    ? Math.min(credits.concurrency, telephony?.max_concurrent_calls || credits.concurrency)
    : (telephony?.max_concurrent_calls || 1);
}

/** Any call to this lead, from a campaign or not, that has not finished. */
async function findOpenCall(supabase, leadId, now = new Date()) {
  const { data, error } = await supabase
    .from('calls')
    .select('id, status, scheduled_for, created_at')
    .eq('lead_id', leadId)
    .in('status', OPEN_STATUSES)
    .gte('created_at', new Date(now.getTime() - STALE_AFTER_MS).toISOString())
    .limit(1);
  if (error) throw error;

  const recent = data?.[0];
  if (recent) return recent;

  // A scheduled call can be older than the stale limit and still be valid.
  const { data: scheduled, error: scheduledError } = await supabase
    .from('calls')
    .select('id, status, scheduled_for, created_at')
    .eq('lead_id', leadId)
    .eq('status', 'scheduled')
    .limit(1);
  if (scheduledError) throw scheduledError;
  return scheduled?.[0] || null;
}

/** Close one-off calls whose result never arrived. */
async function closeStaleCalls(supabase, { leadId, now = new Date() } = {}) {
  let query = supabase
    .from('calls')
    .update({ status: 'failed', success: false, error_message: 'No result was received for this call' })
    .eq('source', 'manual')
    .in('status', ACTIVE_CALL_STATUSES)
    .lt('created_at', new Date(now.getTime() - STALE_AFTER_MS).toISOString());
  if (leadId) query = query.eq('lead_id', leadId);
  const { error } = await query;
  if (error) throw error;
}

async function dialCallRow(supabase, call, { setup, lead }, dial = dialLead) {
  try {
    const retellCall = await dial({ call, ...setup, lead });
    const { data, error } = await supabase
      .from('calls')
      .update({ retell_call_id: retellCallId(retellCall), status: 'calling', raw_payload: retellCall })
      .eq('id', call.id)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    const message = error.message || 'Call could not be placed';
    await supabase.from('calls').update({ status: 'failed', success: false, error_message: message }).eq('id', call.id);
    await supabase.from('workspace_telephony').update({ last_error: message }).eq('workspace_id', call.workspace_id);
    throw new SingleCallError(502, message, { call_id: call.id });
  }
}

function newCallRow({ workspaceId, lead, setup, userId, now }) {
  return {
    workspace_id: workspaceId,
    campaign_id: setup.campaign.id,
    lead_id: lead.id,
    voice_agent_id: setup.agent.id,
    from_number: setup.telephony.retell_phone_number || setup.telephony.from_number,
    to_number: normalizePhone(lead.phone_e164 || lead.phone),
    attempt_number: 1,
    source: 'manual',
    confirmed_by: userId,
    confirmed_at: now.toISOString(),
  };
}

async function insertCall(supabase, row) {
  const { data, error } = await supabase.from('calls').insert(row).select('*').single();
  if (error?.code === '23505') throw new SingleCallError(409, 'A call to this lead is already in progress or scheduled');
  if (error) throw error;
  return data;
}

async function startSingleCall(supabase, { workspaceId, userId, leadId, campaignId, schedule = false, schedulingAvailable, now = new Date() }, deps = {}) {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', leadId)
    .maybeSingle();
  if (leadError) throw leadError;
  if (!lead) throw new SingleCallError(404, 'Lead not found');

  const setup = await (deps.loadSetup || loadCallSetup)(supabase, workspaceId, campaignId);
  if (!setup) throw new SingleCallError(404, 'Script not found');

  const credits = await (deps.credit || creditCheck)(supabase, workspaceId);
  const problem = singleCallProblem({ lead, setup, credits });
  if (problem) throw new SingleCallError(400, problem);

  await closeStaleCalls(supabase, { leadId: lead.id, now });
  const open = await findOpenCall(supabase, lead.id, now);
  if (open) throw new SingleCallError(409, 'A call to this lead is already in progress or scheduled', { call_id: open.id });

  const row = newCallRow({ workspaceId, lead, setup, userId, now });

  const window = callingWindowState(setup.campaign, now);
  if (!window.open) {
    const nextOpen = nextOpenAt(setup.campaign, now);
    if (!schedule) {
      throw new SingleCallError(409, 'This is outside calling hours', { code: 'outside_hours', next_open_at: nextOpen?.toISOString() || null });
    }
    if (!schedulingAvailable) throw new SingleCallError(409, 'Calls cannot be scheduled right now. Try again during calling hours.');
    if (!nextOpen) throw new SingleCallError(409, 'This script has no upcoming calling hours');
    return insertCall(supabase, { ...row, status: 'scheduled', scheduled_for: nextOpen.toISOString() });
  }

  const active = await (deps.countActive || countActiveCalls)(supabase, workspaceId);
  if (active >= concurrencyLimit(credits, setup.telephony)) {
    throw new SingleCallError(409, 'Your agent is already on the most calls your plan allows at once. Try again when one ends.');
  }

  const call = await insertCall(supabase, { ...row, status: 'queued' });
  return dialCallRow(supabase, call, { setup, lead }, deps.dial);
}

async function cancelCall(supabase, id, reason) {
  await supabase
    .from('calls')
    .update({ status: 'canceled', success: false, error_message: reason })
    .eq('id', id)
    .eq('status', 'scheduled');
}

/**
 * Dial the scheduled calls that are due. Every check runs again, because a lead
 * can opt out or a script can change between booking and calling.
 */
async function runDueScheduledCalls(supabase, now = new Date(), deps = {}) {
  const { data: due, error } = await supabase
    .from('calls')
    .select('*, leads(*)')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now.toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(20);
  if (error) throw error;

  for (const call of due || []) {
    try {
      if (!call.leads || !call.campaign_id) {
        await cancelCall(supabase, call.id, 'The lead or script no longer exists');
        continue;
      }

      const setup = await (deps.loadSetup || loadCallSetup)(supabase, call.workspace_id, call.campaign_id);
      if (!setup) {
        await cancelCall(supabase, call.id, 'The script no longer exists');
        continue;
      }

      const credits = await (deps.credit || creditCheck)(supabase, call.workspace_id);
      const problem = singleCallProblem({ lead: call.leads, setup, credits });
      if (problem) {
        await cancelCall(supabase, call.id, problem);
        continue;
      }

      if (!callingWindowState(setup.campaign, now).open) {
        const nextOpen = nextOpenAt(setup.campaign, now);
        if (nextOpen) await supabase.from('calls').update({ scheduled_for: nextOpen.toISOString() }).eq('id', call.id).eq('status', 'scheduled');
        else await cancelCall(supabase, call.id, 'This script has no upcoming calling hours');
        continue;
      }

      // Busy for now, whether with this lead or the plan's limit. Try next pass.
      const active = await (deps.countActive || countActiveCalls)(supabase, call.workspace_id);
      if (active >= concurrencyLimit(credits, setup.telephony)) continue;
      const { data: inProgress, error: inProgressError } = await supabase
        .from('calls')
        .select('id')
        .eq('lead_id', call.lead_id)
        .in('status', ACTIVE_CALL_STATUSES)
        .gte('created_at', new Date(now.getTime() - STALE_AFTER_MS).toISOString())
        .limit(1);
      if (inProgressError) throw inProgressError;
      if (inProgress?.length) continue;

      // Claiming first means two servers can never dial the same row.
      const { data: claimed, error: claimError } = await supabase
        .from('calls')
        .update({ status: 'queued' })
        .eq('id', call.id)
        .eq('status', 'scheduled')
        .select('*')
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) continue;

      await dialCallRow(supabase, claimed, { setup, lead: call.leads }, deps.dial);
    } catch (callError) {
      console.error('[single-call] scheduled call failed', call.id, callError.message);
    }
  }
}

module.exports = {
  SingleCallError,
  cancelCall,
  closeStaleCalls,
  findOpenCall,
  leadSearchFilter,
  runDueScheduledCalls,
  singleCallProblem,
  startSingleCall,
};
