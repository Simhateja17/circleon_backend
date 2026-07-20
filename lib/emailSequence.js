const { generateEmailSequence } = require('./gemini');

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
  return (data || []).filter(lead => lead.dnc_status !== 'blocked' && lead.lifecycle_status !== 'suppressed');
}

function orderedSteps(campaign) {
  const steps = [...(campaign.email_sequences || [])].sort((a, b) => a.step_number - b.step_number);
  return steps.length ? steps : [{ step_number: 1, name: 'Intro', delay_days: 0, ai_instruction: 'Write a concise first touch.' }];
}

function effectiveAgentConfig(agentConfig, campaign) {
  const brief = campaign.brief || {};
  const snapshot = brief.agent_config || {};
  return {
    ...agentConfig,
    ...snapshot,
    tone: brief.tone || snapshot.tone || agentConfig.tone,
    booking_link: brief.cta || snapshot.booking_link || agentConfig.booking_link,
    campaign_angle: brief.campaign_angle || '',
  };
}

function asPreviousEmail(message) {
  return { step_number: message.sequence_step, subject: message.subject, body: message.body };
}

async function getLeadMessages(supabase, workspaceId, campaignId, leadId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId)
    .eq('lead_id', leadId)
    .eq('direction', 'outbound')
    .order('sequence_step', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function generateLeadSequence({ supabase, workspaceId, campaign, agentConfig, lead, forceFromStep = null }) {
  const steps = orderedSteps(campaign);
  const existingMessages = await getLeadMessages(supabase, workspaceId, campaign.id, lead.id);
  const existingByStep = new Map(existingMessages.map(message => [message.sequence_step, message]));
  const companyData = lead.company_data || lead.raw_data?.apollo?.organization || {};
  const previousEmails = [];
  let generated = 0;
  let skipped = 0;
  let latestMessage = null;
  const stepsToGenerate = [];

  for (const step of steps) {
    const existing = existingByStep.get(step.step_number);
    const isEditable = !existing || ['draft', 'pending_approval', 'approved'].includes(existing.status);
    const shouldRegenerate = forceFromStep !== null && step.step_number >= forceFromStep && isEditable;
    if (existing && !shouldRegenerate) {
      previousEmails.push(asPreviousEmail(existing));
      skipped += 1;
      continue;
    }

    stepsToGenerate.push(step);
  }

  if (!stepsToGenerate.length) return { generated, skipped, latestMessage };

  const generatedEmails = await generateEmailSequence({
    steps: stepsToGenerate,
    lead,
    companyData,
    agentConfig,
    previousEmails,
  });

  for (const step of stepsToGenerate) {
    const existing = existingByStep.get(step.step_number);
    const email = generatedEmails.find(item => item.step_number === Number(step.step_number));
    if (!email) throw new Error(`No generated email was returned for sequence step ${step.step_number}`);

    const rawPayload = {
      ...(existing?.raw_payload || {}),
      generated_by: 'gemini',
      generated_at: new Date().toISOString(),
      generation_mode: 'sequence_batch',
      generated_step_count: generatedEmails.length,
    };

    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from('messages')
        .update({
          subject: email.subject,
          body: email.body,
          status: 'draft',
          approved_by: null,
          approved_at: null,
          approved_source: 'individual',
          manually_edited_at: null,
          manually_edited_by: null,
          raw_payload: rawPayload,
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('messages')
        .insert({
          workspace_id: workspaceId,
          campaign_id: campaign.id,
          lead_id: lead.id,
          sequence_step: step.step_number,
          direction: 'outbound',
          subject: email.subject,
          body: email.body,
          status: 'draft',
          raw_payload: rawPayload,
        })
        .select('*')
        .single();
      if (error) throw error;
      saved = data;
    }

    latestMessage = saved;
    previousEmails.push(asPreviousEmail(saved));
    generated += 1;
  }

  return { generated, skipped, latestMessage };
}

async function preGenerateSequence({ supabase, workspaceId, campaignId, leadIds = [], concurrency = 1, onProgress = null }) {
  const [campaign, savedAgentConfig] = await Promise.all([
    getCampaign(supabase, workspaceId, campaignId),
    getAgentConfig(supabase, workspaceId),
  ]);
  const agentConfig = effectiveAgentConfig(savedAgentConfig, campaign);
  const leads = await getCampaignLeads(supabase, workspaceId, leadIds);
  if (!leads.length) throw new Error('No leads with email are attached to this campaign');

  let generated = 0;
  let skipped = 0;
  let processed = 0;
  const errors = [];
  let nextLeadIndex = 0;

  async function generateNextLead() {
    while (nextLeadIndex < leads.length) {
      const lead = leads[nextLeadIndex];
      nextLeadIndex += 1;
      try {
        const result = await generateLeadSequence({ supabase, workspaceId, campaign, agentConfig, lead });
        generated += result.generated;
        skipped += result.skipped;
      } catch (error) {
        errors.push({ lead_id: lead.id, message: error.message || 'Generation failed' });
      }
      processed += 1;
      if (onProgress) {
        await onProgress({ total: leads.length, processed, generated, skipped, failed: errors.length, leadId: lead.id });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, leads.length)) }, generateNextLead));
  return { total: leads.length, generated, skipped, failed: errors.length, errors };
}

async function regenerateSequenceMessage({ supabase, workspaceId, campaignId, messageId }) {
  const [campaign, savedAgentConfig] = await Promise.all([
    getCampaign(supabase, workspaceId, campaignId),
    getAgentConfig(supabase, workspaceId),
  ]);
  const { data: message, error: messageError } = await supabase
    .from('messages')
    .select('*, leads(*)')
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId)
    .eq('id', messageId)
    .maybeSingle();
  if (messageError) throw messageError;
  if (!message || message.direction !== 'outbound' || !message.leads?.email) throw new Error('Campaign email not found');
  if (!['draft', 'approved'].includes(message.status)) throw new Error(`This email cannot be regenerated because it is ${message.status}`);

  const { error: removeError } = await supabase
    .from('messages')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId)
    .eq('lead_id', message.lead_id)
    .eq('direction', 'outbound')
    .gt('sequence_step', message.sequence_step)
    .in('status', ['draft', 'pending_approval', 'approved']);
  if (removeError) throw removeError;

  const agentConfig = effectiveAgentConfig(savedAgentConfig, campaign);
  const result = await generateLeadSequence({
    supabase,
    workspaceId,
    campaign,
    agentConfig,
    lead: message.leads,
    forceFromStep: message.sequence_step,
  });
  return result.latestMessage;
}

async function getPreviewMessages({ supabase, workspaceId, campaignId, limit = 100 }) {
  const { data, error } = await supabase
    .from('messages')
    .select('*, leads(full_name, company_name, title, email)')
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId)
    .eq('direction', 'outbound')
    .order('lead_id', { ascending: true })
    .order('sequence_step', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getPreviewMessages,
  preGenerateSequence,
  regenerateSequenceMessage,
};
