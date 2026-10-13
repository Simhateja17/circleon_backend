// The voice campaign dialer.
//
// Replaces the old workspace-wide follow-up dialer, which could run exactly one
// call per workspace and had no idea which campaign a call belonged to.
//
// Shape of a pass:
//   active voice campaigns -> grouped by workspace -> each workspace gets a
//   concurrency budget -> campaigns take turns spending it, round-robin, so no
//   campaign starves another.
//
// Caps are per campaign, under a workspace concurrency ceiling that always wins.

const { createServiceClient } = require('./supabase');
const { normalizePhone } = require('./calling');
const { createPhoneCall: createRetellPhoneCall, retellLanguage } = require('./retellVoice');
const { monthlyWorkspace, loadWorkspaceAgent, callContext } = require('./voiceAgentProvisioning');
const { voiceEligibility } = require('./dnc');
const { nextAttemptAt, fromZonedWallClock, zonedParts } = require('./voiceScheduling');
const { creditCheck } = require('./callCredits');
const { ACTIVE_CALL_STATUSES, voiceCampaignState } = require('./voiceCampaign');

let running = false;

const CAMPAIGN_SELECT = `
  *,
  workspaces(id, name),
  voice_scripts(*),
  voice_agents(*)
`;

async function countActiveCalls(supabase, workspaceId) {
  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ACTIVE_CALL_STATUSES);

  if (error) throw error;
  return count || 0;
}

async function countCallsToday(supabase, campaignId, timezone, now = new Date()) {
  // Day boundary in the campaign's own timezone, so a cap of 50 means 50 calls
  // in the customer's working day rather than in UTC.
  const zone = timezone || 'Asia/Singapore';
  const today = zonedParts(now, zone);
  const since = fromZonedWallClock({ ...today, minutes: 0 }, zone);

  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .gte('created_at', since.toISOString());

  if (error) throw error;
  return count || 0;
}

async function countPendingTargets(supabase, campaignId, now) {
  const { count, error } = await supabase
    .from('voice_call_targets')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('state', 'pending')
    .lte('next_attempt_at', now.toISOString());

  if (error) throw error;
  return count || 0;
}

/**
 * Take the next due lead for a campaign and mark it in flight, so two passes of
 * the queue can never dial the same lead twice.
 */
async function claimNextTarget(supabase, campaignId, now) {
  const { data: candidates, error } = await supabase
    .from('voice_call_targets')
    .select('*, leads(*)')
    .eq('campaign_id', campaignId)
    .eq('state', 'pending')
    .lte('next_attempt_at', now.toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(5);

  if (error) throw error;

  for (const candidate of candidates || []) {
    const { data: claimed, error: claimError } = await supabase
      .from('voice_call_targets')
      .update({ state: 'in_flight' })
      .eq('id', candidate.id)
      .eq('state', 'pending')
      .select('*')
      .maybeSingle();

    if (claimError) throw claimError;
    if (claimed) return { ...claimed, leads: candidate.leads };
  }

  return null;
}

async function releaseTarget(supabase, target, patch) {
  await supabase.from('voice_call_targets').update(patch).eq('id', target.id);
}

function dynamicVariables({ campaign, script, lead, workspace }) {
  return {
    company_name: workspace?.name || 'our company',
    lead_name: lead.full_name || lead.first_name || 'there',
    lead_first_name: lead.first_name || '',
    lead_company: lead.company_name || '',
    lead_title: lead.title || '',
    campaign_name: campaign.name || '',
    objective: script?.objective || '',
    offer: script?.offer || '',
  };
}

async function placeCall(supabase, { campaign, script, agent, telephony, target, workspace }) {
  const lead = target.leads;
  const eligibility = voiceEligibility(lead);

  if (!eligibility.callable) {
    await Promise.all([
      releaseTarget(supabase, target, { state: 'blocked', block_reason: eligibility.reason }),
      supabase.from('leads').update({ callable_block_reason: eligibility.reason }).eq('id', lead.id),
    ]);
    return false;
  }

  const attemptNumber = (target.attempts || 0) + 1;
  const toNumber = normalizePhone(lead.phone_e164 || lead.phone);
  const fromNumber = telephony.retell_phone_number || telephony.from_number;

  const { data: call, error: callError } = await supabase
    .from('calls')
    .insert({
      workspace_id: campaign.workspace_id,
      campaign_id: campaign.id,
      lead_id: lead.id,
      voice_agent_id: agent.id,
      from_number: fromNumber,
      to_number: toNumber,
      attempt_number: attemptNumber,
      status: 'queued',
    })
    .select('*')
    .single();

  if (callError) throw callError;

  try {
    const retellCall = await createRetellPhoneCall({
      fromNumber,
      toNumber,
      agentId: agent.retell_agent_id,
      metadata: {
        workspace_id: campaign.workspace_id,
        campaign_id: campaign.id,
        lead_id: lead.id,
        call_id: call.id,
        target_id: target.id,
        attempt_number: attemptNumber,
      },
      variables: { ...dynamicVariables({ campaign, script, lead, workspace }),
        ...(agent.shared_scope ? callContext({campaign,script,workspace,agentConfig:campaign.monthlyAgentConfig,telephony}) : {}) },
      ...(agent.shared_scope ? {agentOverride:{agent:{language:retellLanguage(script.language),...(script.voice_id?{voice_id:script.voice_id}:{})}}} : {}),
    });

    await Promise.all([
      supabase
        .from('calls')
        .update({
          retell_call_id: retellCall.call_id || retellCall.id || retellCall.retell_call_id || null,
          status: 'calling',
          raw_payload: retellCall,
        })
        .eq('id', call.id),
      releaseTarget(supabase, target, {
        attempts: attemptNumber,
        last_call_id: call.id,
        block_reason: null,
      }),
    ]);

    return true;
  } catch (error) {
    const message = error.message || 'Call could not be placed';

    // Put the lead back in the queue rather than losing it, but respect the
    // attempt budget so a permanently broken number cannot loop.
    const exhausted = attemptNumber >= (campaign.max_call_attempts || 3);

    await Promise.all([
      supabase.from('calls').update({ status: 'failed', error_message: message }).eq('id', call.id),
      releaseTarget(supabase, target, {
        state: exhausted ? 'exhausted' : 'pending',
        attempts: attemptNumber,
        block_reason: message,
        next_attempt_at: nextAttemptAt(
          {
            timezone: campaign.timezone,
            active_days: campaign.active_days,
            sending_hours_start: campaign.sending_hours_start,
            sending_hours_end: campaign.sending_hours_end,
          },
          attemptNumber + 1,
          { gapHours: campaign.retry_gap_hours || 24 },
        ).toISOString(),
      }),
      supabase
        .from('workspace_telephony')
        .update({ last_error: message })
        .eq('workspace_id', campaign.workspace_id),
    ]);

    return false;
  }
}

async function processWorkspace(supabase, workspaceId, campaigns, now) {
  const { data: telephony, error: telephonyError } = await supabase
    .from('workspace_telephony')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (telephonyError) throw telephonyError;
  if (!telephony) return;

  const monthly=await monthlyWorkspace(supabase,workspaceId);
  const sharedAgent=monthly ? await loadWorkspaceAgent(supabase,workspaceId) : null;
  if(monthly && (!sharedAgent || sharedAgent.status!=='ready')) return;
  let monthlyAgentConfig=null;
  if(monthly){const {data,error}=await supabase.from('agent_configs').select('*').eq('workspace_id',workspaceId).maybeSingle();if(error)throw error;monthlyAgentConfig=data;}
  const credits = await creditCheck(supabase, workspaceId);
  if (!credits.ok) return;

  const activeCalls = await countActiveCalls(supabase, workspaceId);
  const maxConcurrent = credits.concurrency ? Math.min(credits.concurrency, telephony.max_concurrent_calls || credits.concurrency) : (telephony.max_concurrent_calls || 1);
  let budget = maxConcurrent - activeCalls;
  if (budget <= 0) return;

  // Round-robin: each pass gives every eligible campaign one turn, so a large
  // campaign cannot monopolise the workspace's concurrency.
  let placedThisPass = true;
  while (budget > 0 && placedThisPass) {
    placedThisPass = false;

    for (const campaign of campaigns) {
      if (budget <= 0) break;

      const script = campaign.voice_scripts?.[0] || campaign.voice_scripts || null;
      const agent = monthly ? sharedAgent : (campaign.voice_agents?.[0] || campaign.voice_agents || null);
      campaign.monthlyAgentConfig=monthlyAgentConfig;

      const [callsToday, pendingTargets] = await Promise.all([
        countCallsToday(supabase, campaign.id, campaign.timezone, now),
        countPendingTargets(supabase, campaign.id, now),
      ]);

      const state = voiceCampaignState({
        campaign,
        script,
        agent,
        telephony: {...telephony,max_concurrent_calls:maxConcurrent},
        callsToday,
        activeCalls: maxConcurrent - budget,
        creditBalanceCents: credits.balanceCents,
        pendingTargets,
      }, now);

      if (!state.dialing) continue;

      const target = await claimNextTarget(supabase, campaign.id, now);
      if (!target) continue;

      const placed = await placeCall(supabase, {
        campaign,
        script,
        agent,
        telephony,
        target,
        workspace: campaign.workspaces,
      });

      if (placed) {
        budget -= 1;
        placedThisPass = true;
      } else {
        // A blocked lead costs no concurrency, so keep working this campaign.
        placedThisPass = true;
      }
    }
  }
}

async function runVoiceQueueOnce() {
  if (running) return;
  running = true;

  const supabase = createServiceClient();
  if (!supabase) {
    running = false;
    return;
  }

  try {
    const now = new Date();

    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select(CAMPAIGN_SELECT)
      .eq('channel', 'voice')
      .eq('status', 'active');

    if (error) throw error;

    const byWorkspace = new Map();
    for (const campaign of campaigns || []) {
      if (!byWorkspace.has(campaign.workspace_id)) byWorkspace.set(campaign.workspace_id, []);
      byWorkspace.get(campaign.workspace_id).push(campaign);
    }

    for (const [workspaceId, workspaceCampaigns] of byWorkspace) {
      try {
        await processWorkspace(supabase, workspaceId, workspaceCampaigns, now);
      } catch (workspaceError) {
        console.error('[voice-queue] workspace failed', workspaceId, workspaceError);
      }
    }
  } catch (error) {
    console.error('[voice-queue] failed', error);
  } finally {
    running = false;
  }
}

function startVoiceQueue() {
  if (process.env.VOICE_QUEUE_ENABLED !== 'true') {
    console.log('Voice campaign queue disabled. Set VOICE_QUEUE_ENABLED=true to place campaign calls.');
    return;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('Voice campaign queue disabled. SUPABASE_SERVICE_ROLE_KEY is required.');
    return;
  }

  setInterval(runVoiceQueueOnce, Number(process.env.VOICE_QUEUE_INTERVAL_MS || 30000));
  runVoiceQueueOnce();
}

module.exports = {
  runVoiceQueueOnce,
  startVoiceQueue,
};
