// Places one call through Retell. Shared by the campaign queue and one-off calls
// so both send the agent exactly the same details.

const { createPhoneCall, retellLanguage } = require('./retellVoice');
const { callContext } = require('./voiceAgentProvisioning');

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

async function dialLead({ call, campaign, script, agent, telephony, lead, workspace, targetId }) {
  return createPhoneCall({
    fromNumber: call.from_number,
    toNumber: call.to_number,
    agentId: agent.retell_agent_id,
    metadata: {
      workspace_id: campaign.workspace_id,
      campaign_id: campaign.id,
      lead_id: lead.id,
      call_id: call.id,
      ...(targetId ? { target_id: targetId } : {}),
      attempt_number: call.attempt_number,
    },
    variables: {
      ...dynamicVariables({ campaign, script, lead, workspace }),
      ...(agent.shared_scope ? callContext({ campaign, script, workspace, agentConfig: campaign.monthlyAgentConfig, telephony }) : {}),
    },
    ...(agent.shared_scope ? { agentOverride: { agent: { language: retellLanguage(script.language), ...(script.voice_id ? { voice_id: script.voice_id } : {}) } } } : {}),
  });
}

function retellCallId(retellCall) {
  return retellCall.call_id || retellCall.id || retellCall.retell_call_id || null;
}

module.exports = { dialLead, retellCallId };
