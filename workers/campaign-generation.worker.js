require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection } = require('../lib/redis');
const { preGenerateSequence } = require('../lib/emailSequence');
const { getAiModelName, getAiProvider } = require('../lib/gemini');

async function processCampaignGenerationJob(job) {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for campaign generation');
  const { workspaceId, campaignId, leadIds } = job.data;
  const startedAt = Date.now();
  await job.updateProgress({ status: 'generating', total: leadIds.length, processed: 0, generated: 0, skipped: 0, failed: 0 });
  console.info(JSON.stringify({
    event: 'campaign_generation_processing',
    jobId: job.id,
    campaignId,
    workspaceId,
    leads: leadIds.length,
    concurrency: Number(process.env.CAMPAIGN_GENERATION_CONCURRENCY || 1),
    aiProvider: getAiProvider(),
    aiModel: getAiModelName(),
  }));

  const result = await preGenerateSequence({
    supabase: service,
    workspaceId,
    campaignId,
    leadIds,
    concurrency: Number(process.env.CAMPAIGN_GENERATION_CONCURRENCY || 1),
    onProgress: async progress => {
      const payload = { status: 'generating', ...progress };
      await job.updateProgress(payload);
      console.info(JSON.stringify({
        event: 'campaign_generation_progress',
        jobId: job.id,
        campaignId,
        workspaceId,
        leadId: progress.leadId,
        ...payload,
      }));
    },
  });

  const finalProgress = { status: result.failed ? 'partial' : 'completed', ...result };
  await job.updateProgress(finalProgress);
  console.info(JSON.stringify({
    event: 'campaign_generation_completed', jobId: job.id, campaignId, workspaceId,
    durationMs: Date.now() - startedAt, ...finalProgress,
  }));
  return finalProgress;
}

function createWorker() {
  const worker = new Worker('campaign-generation', processCampaignGenerationJob, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.CAMPAIGN_GENERATION_WORKER_CONCURRENCY || 1),
  });
  worker.on('ready', () => console.info(JSON.stringify({
    event: 'campaign_generation_worker_ready',
    aiProvider: getAiProvider(),
    aiModel: getAiModelName(),
  })));
  worker.on('active', job => console.info(JSON.stringify({ event: 'campaign_generation_started', jobId: job.id, campaignId: job.data.campaignId, workspaceId: job.data.workspaceId })));
  worker.on('failed', (job, error) => console.error(JSON.stringify({
    event: 'campaign_generation_failed',
    jobId: job?.id,
    campaignId: job?.data?.campaignId,
    workspaceId: job?.data?.workspaceId,
    attempts: job?.attemptsMade,
    error: error.message,
  })));
  return worker;
}

if (require.main === module) createWorker();

module.exports = { createWorker, processCampaignGenerationJob };
