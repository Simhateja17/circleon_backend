require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection, getEmailSendQueue } = require('../lib/redis');
const { getAutopilotSettings, campaignFilters, isCampaignIncluded } = require('../lib/autopilot');
const { mailboxReady } = require('../lib/autopilotScheduler');
const { runApolloImport } = require('../routes/apollo');
const { preGenerateSequence } = require('../lib/emailSequence');
const { scheduleMessages } = require('../lib/campaignScheduling');
const { researchCampaign, scheduleResearchReconciliation } = require('../lib/leadResearch');

async function updateRun(service, runId, patch) {
  const { data, error } = await service.from('autopilot_runs').update(patch).eq('id', runId).select('*').single();
  if (error) throw error;
  return data;
}

async function processAutopilotJob(job) {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for autopilot workers');
  const { workspaceId, campaignId, autopilotRunId } = job.data;
  const [{ data: workspace, error: workspaceError }, { data: campaign, error: campaignError }, { data: run, error: runError }, { data: agentConfig, error: configError }] = await Promise.all([
    service.from('workspaces').select('*').eq('id', workspaceId).maybeSingle(),
    service.from('campaigns').select('*, email_sequences(*)').eq('workspace_id', workspaceId).eq('id', campaignId).maybeSingle(),
    service.from('autopilot_runs').select('*').eq('id', autopilotRunId).maybeSingle(),
    service.from('agent_configs').select('*').eq('workspace_id', workspaceId).maybeSingle(),
  ]);
  if (workspaceError || campaignError || runError || configError) throw workspaceError || campaignError || runError || configError;
  if (!workspace || !campaign || !run || !agentConfig) throw new Error('Autopilot context not found');
  if (['completed', 'partial', 'failed', 'paused', 'skipped'].includes(run.status)) return { skipped: true, reason: `Run is already ${run.status}` };

  const settings = await getAutopilotSettings(service, workspaceId);
  if (!settings.enabled || settings.paused_at || campaign.status !== 'active' || !isCampaignIncluded(settings, campaign)) {
    await updateRun(service, run.id, { status: 'paused', completed_at: new Date().toISOString(), error_message: 'Autopilot or campaign is paused' });
    return { skipped: true, reason: 'Autopilot or campaign is paused' };
  }
  if (!await mailboxReady(service, workspaceId)) {
    await updateRun(service, run.id, { status: 'failed', completed_at: new Date().toISOString(), error_message: 'Verified SMTP and IMAP mailbox is required' });
    return { skipped: true, reason: 'Mailbox is not ready' };
  }

  await updateRun(service, run.id, { status: 'running', started_at: new Date().toISOString(), error_message: null });
  await service.from('campaigns').update({ autopilot_enabled: true }).eq('id', campaignId);
  console.info(JSON.stringify({
    event: 'autopilot_processing',
    jobId: job.id,
    autopilotRunId,
    workspaceId,
    campaignId,
  }));
  const filters = campaignFilters(campaign, agentConfig);
  const { data: importRun, error: importError } = await service.from('lead_import_runs').insert({
    workspace_id: workspaceId,
    source: 'apollo',
    status: 'pending',
    total_rows: filters.limit,
    raw_meta: { filters, requested_limit: filters.limit, autopilot_run_id: run.id, campaign_id: campaignId, stage: 'queued', stage_label: 'Autopilot lead discovery queued' },
  }).select('*').single();
  if (importError) throw importError;

  await runApolloImport({ supabase: service, user: { id: workspace.owner_id, email: null }, workspace, agentConfig, filters, run: importRun });
  const { data: completedImport, error: completedImportError } = await service.from('lead_import_runs').select('*').eq('id', importRun.id).single();
  if (completedImportError) throw completedImportError;
  const { data: readyLeads, error: leadsError } = await service.from('leads').select('id')
    .eq('workspace_id', workspaceId).eq('import_run_id', importRun.id).eq('lifecycle_status', 'ready');
  if (leadsError) throw leadsError;
  const leadIds = (readyLeads || []).map(lead => lead.id);
  console.info(JSON.stringify({
    event: 'autopilot_lead_discovery_completed',
    jobId: job.id,
    autopilotRunId,
    workspaceId,
    campaignId,
    discovered: Number(completedImport.created_count || 0),
    readyLeads: leadIds.length,
    importRunId: importRun.id,
    importStatus: completedImport.status,
  }));
  if (leadIds.length) {
    const { error: ownershipError } = await service.from('lead_campaign_ownership').upsert(leadIds.map(leadId => ({ workspace_id: workspaceId, lead_id: leadId, campaign_id: campaignId, source: 'autopilot' })), {
      onConflict: 'workspace_id,lead_id', ignoreDuplicates: true,
    });
    if (ownershipError) throw ownershipError;
    const { data: ownedLeads, error: ownedLeadsError } = await service.from('lead_campaign_ownership').select('lead_id')
      .eq('workspace_id', workspaceId).eq('campaign_id', campaignId).in('lead_id', leadIds);
    if (ownedLeadsError) throw ownedLeadsError;
    const ownedLeadIds = (ownedLeads || []).map(lead => lead.lead_id);
    const { error: assignmentError } = await service.from('campaign_leads').upsert(ownedLeadIds.map(leadId => ({ campaign_id: campaignId, lead_id: leadId, workspace_id: workspaceId, selected_by: workspace.owner_id })), {
      onConflict: 'campaign_id,lead_id', ignoreDuplicates: true,
    });
    if (assignmentError) throw assignmentError;
    const { error: leadUpdateError } = await service.from('leads').update({ campaign_id: campaignId, lifecycle_status: 'selected_for_campaign' }).eq('workspace_id', workspaceId).in('id', ownedLeadIds);
    if (leadUpdateError) throw leadUpdateError;
    leadIds.splice(0, leadIds.length, ...ownedLeadIds);
  }

  let research = { total: 0, researched: 0, skipped: 0, fallback: 0, failed: 0, timed_out: 0, errors: [] };
  if (leadIds.length) {
    research = await researchCampaign({
      supabase: service,
      workspaceId,
      campaignId,
      leadIds,
      concurrency: Number(process.env.APIFY_RESEARCH_CONCURRENCY || 2),
    });
  }
  const reconciliationQueued = await scheduleResearchReconciliation(research.reconciliation_refs || []);
  research = { ...research, reconciliation_queued: reconciliationQueued };
  console.info(JSON.stringify({
    event: 'autopilot_research_completed',
    jobId: job.id,
    autopilotRunId,
    workspaceId,
    campaignId,
    ...research,
  }));
  let generation = { generated: 0, failed: 0, skipped: 0 };
  if (leadIds.length) generation = await preGenerateSequence({ supabase: service, workspaceId, campaignId, leadIds, concurrency: Number(process.env.AUTOPILOT_GENERATION_CONCURRENCY || 1) });
  console.info(JSON.stringify({
    event: 'autopilot_generation_completed',
    jobId: job.id,
    autopilotRunId,
    workspaceId,
    campaignId,
    ...generation,
  }));
  const { data: firstMessages, error: messageError } = await service.from('messages').select('id, lead_id, sequence_step')
    .eq('workspace_id', workspaceId).eq('campaign_id', campaignId).eq('direction', 'outbound').eq('sequence_step', 1).eq('status', 'draft').is('scheduled_at', null).in('lead_id', leadIds);
  if (messageError) throw messageError;
  const jobs = await scheduleMessages({ supabase: service, queue: getEmailSendQueue(), workspaceId, campaign, messages: firstMessages || [], reason: 'Autopilot daily run' });
  console.info(JSON.stringify({
    event: 'autopilot_email_scheduling_completed',
    jobId: job.id,
    autopilotRunId,
    workspaceId,
    campaignId,
    draftStepOneMessages: firstMessages?.length || 0,
    scheduled: jobs.length,
  }));
  const pending = completedImport.status === 'pending_enrichment';
  await updateRun(service, run.id, {
    status: pending || generation.failed || research.failed ? 'partial' : 'completed',
    discovered_leads: Number(completedImport.created_count || 0),
    assigned_leads: leadIds.length,
    generated_messages: Number(generation.generated || 0),
    scheduled_messages: jobs.length,
    skipped_duplicates: Number(completedImport.skipped_count || 0),
    completed_at: new Date().toISOString(),
    details: { ...(run.details || {}), import_run_id: importRun.id, pending_enrichment: pending, filters, research },
  });
  console.info(JSON.stringify({
    event: 'autopilot_completed',
    jobId: job.id,
    autopilotRunId,
    workspaceId,
    campaignId,
    assignedLeads: leadIds.length,
    generated: generation.generated || 0,
    scheduled: jobs.length,
    partial: pending || Boolean(generation.failed) || Boolean(research.failed),
  }));
  return {
    importRunId: importRun.id,
    assignedLeads: leadIds.length,
    researched: research.researched || 0,
    researchFallback: research.fallback || 0,
    generated: generation.generated || 0,
    scheduled: jobs.length,
    partial: pending || Boolean(generation.failed) || Boolean(research.failed),
  };
}

function createWorker() {
  return new Worker('autopilot', async job => {
    if (job.name !== 'autopilot-campaign') throw new Error(`Unsupported autopilot job ${job.name}`);
    return processAutopilotJob(job);
  }, { connection: getRedisConnection(), concurrency: Number(process.env.AUTOPILOT_WORKER_CONCURRENCY || 1) });
}

if (require.main === module) createWorker();

module.exports = { createWorker, processAutopilotJob };
