require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const {
  getCampaignGenerationQueue,
  getRedisConnection,
} = require('../lib/redis');
const { getApifyConfig } = require('../lib/apify');
const { reconcileResearchRun, researchCampaign, scheduleResearchReconciliation } = require('../lib/leadResearch');

async function enqueueGeneration({ workspaceId, campaignId, leadIds }) {
  const queue = getCampaignGenerationQueue();
  const jobId = createQueueJobId('campaign-generate', campaignId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) return { jobId, reused: true };
    await existing.remove();
  }
  await queue.add('generate-sequence', { workspaceId, campaignId, leadIds }, { jobId });
  return { jobId, reused: false };
}

async function processLeadResearchJob(job) {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for lead research workers');

  if (job.name === 'reconcile-research') {
    const result = await reconcileResearchRun({
      supabase: service,
      researchRunId: job.data.researchRunId,
      config: getApifyConfig(),
    });
    return { stage: 'reconciled', ...result };
  }
  if (job.name !== 'research-campaign') throw new Error(`Unsupported lead research job ${job.name}`);

  const { workspaceId, campaignId, leadIds } = job.data;
  const startedAt = Date.now();
  console.info(JSON.stringify({
    event: 'lead_research_processing',
    jobId: job.id,
    workspaceId,
    campaignId,
    leads: leadIds.length,
    apifyEnabled: getApifyConfig().enabled,
  }));
  await job.updateProgress({ stage: 'researching', status: 'researching', total: leadIds.length, processed: 0, researched: 0, fallback: 0, failed: 0, timed_out: 0 });
  const result = await researchCampaign({
    supabase: service,
    workspaceId,
    campaignId,
    leadIds,
    concurrency: Number(process.env.APIFY_RESEARCH_CONCURRENCY || 2),
    config: getApifyConfig(),
    onProgress: async progress => {
      await job.updateProgress({ stage: 'researching', status: 'researching', ...progress });
      console.info(JSON.stringify({
        event: 'lead_research_worker_progress',
        jobId: job.id,
        workspaceId,
        campaignId,
        ...progress,
      }));
    },
  });
  const reconciliationQueued = await scheduleResearchReconciliation(result.reconciliation_refs || []);
  const generation = await enqueueGeneration({ workspaceId, campaignId, leadIds });
  console.info(JSON.stringify({
    event: 'lead_research_generation_queued',
    jobId: job.id,
    workspaceId,
    campaignId,
    generationJobId: generation.jobId,
    reconciliationQueued,
  }));
  const final = {
    stage: 'research_complete',
    status: result.failed ? 'partial' : 'completed',
    ...result,
    reconciliation_queued: reconciliationQueued,
    generation_job_id: generation.jobId,
  };
  await job.updateProgress(final);
  console.info(JSON.stringify({
    event: 'lead_research_completed',
    jobId: job.id,
    workspaceId,
    campaignId,
    durationMs: Date.now() - startedAt,
    apifyEnabled: getApifyConfig().enabled,
    ...final,
  }));
  return final;
}

function createWorker() {
  const worker = new Worker('lead-research', processLeadResearchJob, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.APIFY_RESEARCH_WORKER_CONCURRENCY || 1),
  });
  worker.on('ready', () => console.info(JSON.stringify({
    event: 'lead_research_worker_ready',
    apifyEnabled: getApifyConfig().enabled,
  })));
  worker.on('active', job => console.info(JSON.stringify({
    event: 'lead_research_started',
    jobId: job.id,
    name: job.name,
    campaignId: job.data?.campaignId,
    leadId: job.data?.leadId,
  })));
  worker.on('failed', (job, error) => console.error(JSON.stringify({
    event: 'lead_research_failed',
    jobId: job?.id,
    name: job?.name,
    campaignId: job?.data?.campaignId,
    leadId: job?.data?.leadId,
    attempts: job?.attemptsMade,
    error: error.message,
  })));
  return worker;
}

if (require.main === module) createWorker();

module.exports = { createWorker, processLeadResearchJob, scheduleReconciliation: scheduleResearchReconciliation };
