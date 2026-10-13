// Launching a voice campaign.
//
// The customer's Singapore number takes about a week to clear Twilio's
// regulatory review. Rather than blocking launch on it, a campaign whose script
// is ready launches into a queued state and starts dialling by itself the
// moment the number is verified. The wait is the regulator's, not ours, and the
// customer should not have to come back and press a button again.

const { voiceEligibility, summariseCallability } = require('./dnc');
const { syncVoiceAgent, monthlyWorkspace, loadWorkspaceAgent } = require('./voiceAgentProvisioning');
const { setupBlockers } = require('./voiceCampaign');

/**
 * Create one work item per selected lead. Leads that cannot be called are
 * recorded as blocked with a reason rather than silently dropped, so the
 * campaign view can account for every lead the user selected.
 */
async function buildCallTargets(supabase, { campaign, workspaceId }) {
  const { data: rows, error } = await supabase
    .from('campaign_leads')
    .select('lead_id, leads(*)')
    .eq('campaign_id', campaign.id)
    .eq('workspace_id', workspaceId);

  if (error) throw error;
  if (!rows?.length) return { created: 0, blocked: 0 };

  const now = new Date().toISOString();
  const targets = rows
    .filter(row => row.leads)
    .map(row => {
      const eligibility = voiceEligibility(row.leads);
      return {
        workspace_id: workspaceId,
        campaign_id: campaign.id,
        lead_id: row.lead_id,
        state: eligibility.callable ? 'pending' : 'blocked',
        block_reason: eligibility.reason,
        next_attempt_at: now,
      };
    });

  // Re-launching a paused campaign must not reset progress on leads already
  // worked, so existing rows are left alone.
  const { error: insertError } = await supabase
    .from('voice_call_targets')
    .upsert(targets, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true });

  if (insertError) throw insertError;

  return {
    created: targets.filter(target => target.state === 'pending').length,
    blocked: targets.filter(target => target.state === 'blocked').length,
  };
}

/**
 * Anything that stops a campaign dialling forever, as opposed to stopping it
 * today. A number still in verification is a wait, not a blocker.
 */
function launchBlockers({ campaign, script, agent, telephony }) {
  return setupBlockers({ campaign, script, agent, telephony })
    .filter(blocker => !blocker.waiting && blocker.key !== 'agent');
}

async function launchVoiceCampaign(req, res, { workspace, campaign }) {
  const supabase = req.supabase;

  const [
    { data: script, error: scriptError },
    { data: telephony, error: telephonyError },
    { data: agentConfig, error: agentConfigError },
    { data: agent, error: agentError },
  ] = await Promise.all([
    supabase.from('voice_scripts').select('*').eq('campaign_id', campaign.id).maybeSingle(),
    supabase.from('workspace_telephony').select('*').eq('workspace_id', workspace.id).maybeSingle(),
    supabase.from('agent_configs').select('*').eq('workspace_id', workspace.id).maybeSingle(),
    monthlyWorkspace(supabase,workspace.id).then(async monthly=>({data:monthly?await loadWorkspaceAgent(supabase,workspace.id):(await supabase.from('voice_agents').select('*').eq('campaign_id',campaign.id).maybeSingle()).data})),
  ]);

  if (scriptError) throw scriptError;
  if (telephonyError) throw telephonyError;
  if (agentConfigError) throw agentConfigError;
  if (agentError) throw agentError;

  const blockers = launchBlockers({ campaign, script, agent, telephony });
  if (blockers.length) {
    return res.status(400).json({
      error: blockers[0].reason,
      blockers,
    });
  }

  const { data: leadRows, error: leadError } = await supabase
    .from('campaign_leads')
    .select('leads(*)')
    .eq('campaign_id', campaign.id)
    .eq('workspace_id', workspace.id);

  if (leadError) throw leadError;

  const coverage = summariseCallability((leadRows || []).map(row => row.leads).filter(Boolean));
  if (!coverage.callableNow) {
    return res.status(400).json({
      error: 'No leads in this campaign can be called yet',
      coverage,
    });
  }

  // Push the current script to Retell. A campaign can be edited and relaunched,
  // so this updates the existing agent rather than creating another one.
  await syncVoiceAgent(supabase, {
    campaign,
    script,
    workspace,
    agentConfig,
    telephony,
    voiceId: script?.voice_id || agent?.voice_id,
  });

  const targets = await buildCallTargets(supabase, { campaign, workspaceId: workspace.id });

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from('campaigns')
    .update({
      status: 'active',
      launched_at: campaign.launched_at || now,
    })
    .eq('id', campaign.id)
    .select('*')
    .single();

  if (updateError) throw updateError;

  const numberReady = ['attached', 'verified'].includes(telephony?.phone_number_status);

  return res.json({
    campaign: updated,
    queued: targets.created,
    blocked: targets.blocked,
    coverage,
    // The campaign is live either way. This tells the UI whether to say
    // "calling now" or "starts as soon as your number clears".
    waitingOnNumber: !numberReady,
  });
}

module.exports = {
  buildCallTargets,
  launchBlockers,
  launchVoiceCampaign,
};
