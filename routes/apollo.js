const express = require('express');
const requireAuth = require('../middleware/auth');
const { createServiceClient } = require('../lib/supabase');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { normalizeLead, upsertLeadWithContext } = require('./leads');
const {
  APOLLO_BLOCK_REASON,
  apolloPersonId,
  buildDefaultFilters,
  extractWebhookUpdates,
  getWebhookUrl,
  normalizeApolloLead,
  normalizeFilters,
  requestBulkEnrichment,
  searchPeople,
} = require('../lib/apollo');

const router = express.Router();

function mergeRawData(existing = {}, patch = {}) {
  return {
    ...(existing || {}),
    apollo: {
      ...((existing || {}).apollo || {}),
      ...(patch.apollo || patch),
    },
  };
}

async function getAgentConfig(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateImportRun(supabase, runId, patch) {
  const { data, error } = await supabase
    .from('lead_import_runs')
    .update(patch)
    .eq('id', runId)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function recordEnrichmentRequests(supabase, workspaceId, importRunId, batches, leadByPersonId) {
  const rows = [];
  for (const batch of batches) {
    for (const personId of batch.people || []) {
      const leadId = leadByPersonId.get(personId);
      if (!leadId) continue;
      rows.push({
        workspace_id: workspaceId,
        import_run_id: importRunId,
        lead_id: leadId,
        apollo_person_id: personId,
        apollo_request_id: batch.request_id || null,
        status: 'pending',
        raw_request: batch.payload || {},
      });
    }
  }

  if (!rows.length) return;
  const { error } = await supabase.from('apollo_enrichment_requests').upsert(rows, {
    onConflict: 'workspace_id,apollo_person_id',
  });
  if (error) throw error;
}

router.post('/webhook', async (req, res) => {
  try {
    const service = createServiceClient();
    if (!service) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is required for Apollo webhooks' });
    }

    const updates = extractWebhookUpdates(req.body || {});
    let updated = 0;
    let skipped = 0;
    const touchedRuns = new Set();

    for (const item of updates) {
      let query = service
        .from('leads')
        .select('*')
        .eq('source', 'apollo')
        .limit(1);

      if (item.personId) {
        query = query.eq('external_id', item.personId);
      } else if (item.email) {
        query = query.eq('email', item.email);
      } else if (item.phone) {
        query = query.eq('phone', item.phone);
      } else {
        skipped += 1;
        continue;
      }

      const { data: matches, error: matchError } = await query;
      if (matchError) throw matchError;
      const lead = matches?.[0];
      if (!lead) {
        skipped += 1;
        continue;
      }

      const patch = {
        raw_data: mergeRawData(lead.raw_data, {
          enrichmentWebhook: item.raw,
          enrichment_status: 'completed',
        }),
        callable_block_reason: lead.callable_block_reason || APOLLO_BLOCK_REASON,
      };
      if (item.email) patch.email = item.email;
      if (item.phone) patch.phone = item.phone;
      if (item.phone_e164) patch.phone_e164 = item.phone_e164;

      const { error: updateError } = await service
        .from('leads')
        .update(patch)
        .eq('id', lead.id);
      if (updateError) throw updateError;

      await service
        .from('apollo_enrichment_requests')
        .update({
          status: 'completed',
          raw_response: item.raw,
          completed_at: new Date().toISOString(),
        })
        .eq('lead_id', lead.id);

      if (lead.import_run_id) touchedRuns.add(lead.import_run_id);
      updated += 1;
    }

    for (const runId of touchedRuns) {
      const { data: run } = await service
        .from('lead_import_runs')
        .select('*')
        .eq('id', runId)
        .maybeSingle();

      if (run) {
        await updateImportRun(service, runId, {
          raw_meta: {
            ...(run.raw_meta || {}),
            enrichment_status: 'webhook_received',
            webhook_updated_count: ((run.raw_meta || {}).webhook_updated_count || 0) + updated,
            last_webhook_at: new Date().toISOString(),
          },
        });
      }
    }

    return res.json({ updated, skipped });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to process Apollo webhook' });
  }
});

router.use(requireAuth);

router.get('/filters', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const agentConfig = await getAgentConfig(req.supabase, workspace.id);
    return res.json({ filters: buildDefaultFilters(agentConfig || {}) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load Apollo filters' });
  }
});

router.post('/import', async (req, res) => {
  let run = null;
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const agentConfig = await getAgentConfig(req.supabase, workspace.id);
    const filters = normalizeFilters(req.body.filters || req.body, agentConfig || {});

    if (!getWebhookUrl()) {
      return res.status(400).json({ error: 'APOLLO_WEBHOOK_URL or APP_PUBLIC_URL is required for Apollo phone enrichment' });
    }

    const { data: pendingRun, error: runError } = await req.supabase
      .from('lead_import_runs')
      .insert({
        workspace_id: workspace.id,
        source: 'apollo',
        status: 'pending',
        total_rows: filters.limit,
        raw_meta: {
          filters,
          requested_limit: filters.limit,
          enrichment_status: 'not_started',
        },
      })
      .select('*')
      .single();

    if (runError) throw runError;
    run = pendingRun;

    const search = await searchPeople(filters);
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const leadByPersonId = new Map();

    for (const person of search.people) {
      const leadInput = normalizeApolloLead(person, { searchFilters: filters });
      const result = await upsertLeadWithContext(req.supabase, req.user, workspace, leadInput, run.id, 'apollo');
      if (result.skipped) {
        skipped += 1;
      } else {
        const personId = apolloPersonId(person) || normalizeLead(leadInput).external_id;
        if (personId) leadByPersonId.set(personId, result.lead.id);
        if (result.updated) updated += 1;
        else created += 1;
      }
    }

    const batches = search.people.length ? await requestBulkEnrichment(search.people, run.id) : [];
    await recordEnrichmentRequests(req.supabase, workspace.id, run.id, batches, leadByPersonId);

    const completedRun = await updateImportRun(req.supabase, run.id, {
      status: 'completed',
      total_rows: search.people.length,
      created_count: created,
      updated_count: updated,
      skipped_count: skipped,
      completed_at: new Date().toISOString(),
      raw_meta: {
        ...(run.raw_meta || {}),
        filters,
        requested_limit: filters.limit,
        search_count: search.people.length,
        apollo_request_ids: batches.map(batch => batch.request_id).filter(Boolean),
        enrichment_status: batches.length ? 'pending_webhook' : 'no_candidates',
      },
    });

    return res.json({ importRun: completedRun });
  } catch (error) {
    if (run?.id) {
      await updateImportRun(req.supabase, run.id, {
        status: 'failed',
        error_message: error.message || 'Apollo import failed',
        completed_at: new Date().toISOString(),
        raw_meta: {
          ...(run.raw_meta || {}),
          apollo_error: error.payload || null,
        },
      }).catch(() => undefined);
    }

    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return res.status(status).json({ error: error.message || 'Failed to import Apollo leads' });
  }
});

module.exports = router;
