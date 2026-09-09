require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection } = require('../lib/redis');
const leadRoutes = require('../routes/leads');
const apolloRoutes = require('../routes/apollo');
const { extractDocumentLeads } = require('../lib/gemini');

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
  if (job.name === 'documents') {
    const { data: workspace, error: workspaceError } = await service.from('workspaces').select('*').eq('id', job.data.workspaceId).maybeSingle();
    if (workspaceError) throw workspaceError;
    if (!workspace) throw new Error('Document import workspace not found');
    const context = { workspace, user: { id: job.data.userId, email: job.data.userEmail } };
    await service.from('document_imports').update({ status: 'processing' }).eq('id', job.data.importId);
    const { data: files, error } = await service.from('document_import_files').select('*').eq('import_id', job.data.importId);
    if (error) throw error;
    let candidates = 0;
    for (const file of files || []) {
      try {
        await service.from('document_import_files').update({ status: 'processing' }).eq('id', file.id);
        const { data: blob, error: downloadError } = await service.storage.from('lead-documents').download(file.storage_path);
        if (downloadError) throw downloadError;
        const result = await extractDocumentLeads({ filename: file.filename, mimeType: file.mime_type, contentBase64: Buffer.from(await blob.arrayBuffer()).toString('base64') });
        const rows = (Array.isArray(result.leads) ? result.leads : []).filter(item => item && (item.email || item.phone || item.external_id || (item.full_name && item.company_name)));
        for (const row of rows) {
          const normalized = leadRoutes.normalizeLead(row);
          const existing = await leadRoutes.findExistingLead(service, context.workspace.id, normalized);
          const conflicts = existing ? ['full_name','company_name','title','email','phone','location','company_domain'].filter(key => row[key] && existing[key] && String(row[key]).trim().toLowerCase() !== String(existing[key]).trim().toLowerCase()).map(key => ({ field:key, existing:existing[key], extracted:row[key] })) : [];
          const evidence = [...(row.safe_facts || []), ...(row.sensitive_facts || [])].map(item => ({ ...item, source:file.filename, source_type:'uploaded_document' }));
          await service.from('document_lead_candidates').insert({ import_id:job.data.importId,file_id:file.id,workspace_id:context.workspace.id,extracted_data:{...row,personalization_profile:{source:'uploaded_document',email_context:evidence}},conflicts });
        }
        candidates += rows.length;
        await service.from('document_import_files').update({ status:'completed',summary:result.document_summary || null }).eq('id',file.id);
      } catch (fileError) {
        await service.from('document_import_files').update({ status:'failed',error_message:fileError.message }).eq('id',file.id);
      }
    }
    await service.from('document_imports').update({ status:'review',candidate_count:candidates }).eq('id',job.data.importId);
    return { candidates };
  }
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
      campaignId: job.data.campaignId || null,
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
  worker.on('ready', () => console.info(JSON.stringify({ event: 'lead_import_worker_ready' })));
  worker.on('active', job => console.info(JSON.stringify({
    event: 'lead_import_job_started',
    jobId: job.id,
    source: job.name,
    runId: job.data.runId,
    workspaceId: job.data.workspaceId,
  })));
  worker.on('completed', (job, result) => console.info(JSON.stringify({
    event: 'lead_import_job_completed',
    jobId: job.id,
    source: job.name,
    runId: job.data.runId,
    durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
    result: result || null,
  })));
  worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'lead_import_job_failed', jobId: job?.id, error: error.message })));
  return worker;
}

if (require.main === module) createWorker();

module.exports = { createWorker, processImportJob };
