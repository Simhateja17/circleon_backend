const { generateEmailStep, generateIcebreaker } = require('./gemini');

async function getAgentConfig(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Agent configuration is required before generating emails');
  return data;
}

async function getCampaign(supabase, workspaceId, campaignId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, email_sequences(*)')
    .eq('workspace_id', workspaceId)
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Campaign not found');
  return data;
}

async function getCampaignLeads(supabase, workspaceId, leadIds = []) {
  if (!leadIds.length) return [];
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('id', leadIds)
    .not('email', 'is', null)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

function firstStep(campaign) {
  const steps = [...(campaign.email_sequences || [])].sort((a, b) => a.step_number - b.step_number);
  return steps[0] || { step_number: 1, name: 'Intro', delay_days: 0 };
}

async function preGenerateStep1({ supabase, workspaceId, campaignId, leadIds = [] }) {
  const [campaign, agentConfig] = await Promise.all([
    getCampaign(supabase, workspaceId, campaignId),
    getAgentConfig(supabase, workspaceId),
  ]);

  const leads = await getCampaignLeads(supabase, workspaceId, leadIds);
  if (!leads.length) {
    throw new Error('No leads with email are attached to this campaign');
  }

  const step = firstStep(campaign);
  let generated = 0;
  let skipped = 0;
  const errors = [];

  for (const lead of leads) {
    const { data: existing, error: existingError } = await supabase
      .from('messages')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('campaign_id', campaignId)
      .eq('lead_id', lead.id)
      .eq('direction', 'outbound')
      .eq('sequence_step', 1)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) {
      skipped += 1;
      continue;
    }

    try {
      const companyData = lead.company_data || lead.raw_data?.apollo?.organization || {};
      const icebreaker = await generateIcebreaker({ lead, companyData, agentConfig });
      const email = await generateEmailStep({
        step,
        lead,
        companyData,
        agentConfig,
        icebreaker,
      });

      const { error } = await supabase
        .from('messages')
        .insert({
          workspace_id: workspaceId,
          campaign_id: campaignId,
          lead_id: lead.id,
          sequence_step: 1,
          direction: 'outbound',
          subject: email.subject,
          body: email.body,
          status: 'draft',
          raw_payload: {
            icebreaker,
            generated_by: 'gemini',
          },
        });

      if (error) throw error;
      generated += 1;
    } catch (error) {
      errors.push({
        lead_id: lead.id,
        message: error.message || 'Generation failed',
      });
    }
  }

  return {
    total: leads.length,
    generated,
    skipped,
    failed: errors.length,
    errors,
  };
}

async function getPreviewMessages({ supabase, workspaceId, campaignId, limit = 5 }) {
  const { data, error } = await supabase
    .from('messages')
    .select('*, leads(full_name, company_name, title, email)')
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId)
    .eq('direction', 'outbound')
    .eq('sequence_step', 1)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

module.exports = {
  getPreviewMessages,
  preGenerateStep1,
};
