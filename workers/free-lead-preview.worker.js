require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection } = require('../lib/redis');
const { markFreeLeadPreviewFailed, processFreeLeadPreviewJob } = require('../lib/freeLeadPreview');

async function processJob(job) {
  console.info(JSON.stringify({
    event: 'free_lead_preview_processing',
    jobId: job.id,
    name: job.name,
    requestId: job.data?.requestId || null,
  }));
  try {
    const result = await processFreeLeadPreviewJob(job);
    console.info(JSON.stringify({
      event: 'free_lead_preview_completed',
      jobId: job.id,
      name: job.name,
      requestId: job.data?.requestId || null,
      ...result,
    }));
    return result;
  } catch (error) {
    const maxAttempts = Number(job.opts?.attempts || 1);
    const finalAttempt = Number(job.attemptsMade || 0) + 1 >= maxAttempts;
    if (finalAttempt) {
      const service = createServiceClient();
      try {
        await markFreeLeadPreviewFailed(service, job.data?.requestId, error);
      } catch (markError) {
        console.error(JSON.stringify({
          event: 'free_lead_preview_failure_record_failed',
          requestId: job.data?.requestId || null,
          error: markError.message,
        }));
      }
    }
    throw error;
  }
}

function createWorker() {
  const worker = new Worker('free-lead-preview', processJob, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.FREE_LEAD_PREVIEW_WORKER_CONCURRENCY || 1),
  });
  worker.on('ready', () => console.info(JSON.stringify({ event: 'free_lead_preview_worker_ready' })));
  worker.on('failed', (job, error) => console.error(JSON.stringify({
    event: 'free_lead_preview_failed',
    jobId: job?.id,
    name: job?.name,
    requestId: job?.data?.requestId || null,
    attempts: job?.attemptsMade,
    error: error.message,
  })));
  return worker;
}

if (require.main === module) createWorker();

module.exports = { createWorker, processJob };
