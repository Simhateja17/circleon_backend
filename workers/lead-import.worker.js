require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection } = require('../lib/redis');
const leadRoutes = require('../routes/leads');
const apolloRoutes = require('../routes/apollo');

async function loadContext(service, data) {
  const [{ data: workspace, error: workspaceError }, { data: run, error: runError }] = await Promise.all([
    service.from('workspaces').select('*').eq('id', data.workspaceId).maybeSingle(),
    service.from('lead_import_runs').select('*').eq('id', data.runId).maybeSingle(),
  ]);
  if (workspaceError) throw workspaceError;
  if (runError) throw runError;
  if (!workspace || !run) throw new Error('Lead import context not found');
  return { workspace, run, user: { id: data.userId, email: data.userEmail } };
}

async function processImportJob(job) {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for lead import workers');
  const context = await loadContext(service, job.data);
  if (['completed', 'partial', 'failed'].includes(context.run.status)) {
    return { skipped: true, reason: `Import run is already ${context.run.status}` };
  }

  if (job.name === 'csv') {
    return leadRoutes.processCsvImport({
      supabase: service,
      ...context,
      rows: job.data.rows,
      mappings: job.data.mappings,
      mode: job.data.mode,
    });
  }

  if (job.name === 'apollo') {
    const { data: agentConfig, error } = await service.from('agent_configs').select('*').eq('workspace_id', context.workspace.id).maybeSingle();
    if (error) throw error;
    return apolloRoutes.runApolloImport({
      supabase: service,
      ...context,
      agentConfig,
      filters: job.data.filters,
    });
  }

  throw new Error(`Unsupported lead import job: ${job.name}`);
}

function createWorker() {
  const worker = new Worker('lead-import', processImportJob, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.LEAD_IMPORT_WORKER_CONCURRENCY || 2),
  });
  worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'lead_import_job_failed', jobId: job?.id, error: error.message })));
  return worker;
}

if (require.main === module) createWorker();

module.exports = { createWorker, processImportJob };
