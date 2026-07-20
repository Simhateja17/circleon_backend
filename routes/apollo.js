const express = require('express');
const requireAuth = require('../middleware/auth');
const { createServiceClient } = require('../lib/supabase');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { createQueueJobId, getLeadImportQueue } = require('../lib/redis');
const { findExistingLead, normalizeLead, upsertLeadWithContext, usableEmail } = require('./leads');
const {
  APOLLO_BLOCK_REASON,
  APOLLO_INDUSTRIES,
  apolloPersonId,
  buildPersonalizationProfile,
  buildDefaultFilters,
  enrichOrganizationForPerson,
  extractWebhookUpdates,
  normalizeApolloLead,
  normalizeFilters,
  pollWebhookResult,
  requestBulkEnrichment,
  searchPeople,
} = require('../lib/apollo');

const router = express.Router();

function debug(event, details = {}) {
  if (process.env.APOLLO_DEBUG === 'false') return;
  console.log(`[apollo:${event}]`, JSON.stringify(details));
}

function estimateImportSeconds(target) {
  return 20 + (Math.ceil(Math.max(1, Number(target || 1)) / 10) * 45);
}

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
  debug('enrichment_requests_recorded', {
    importRunId,
    rows: rows.length,
    requestIds: [...new Set(rows.map(row => row.apollo_request_id).filter(Boolean))].map(id => id.slice(-8)),
  });
}

async function findLeadForApolloUpdate(supabase, item) {
  if (item.requestId) {
    let requestQuery = supabase
      .from('apollo_enrichment_requests')
      .select('lead_id')
      .eq('apollo_request_id', item.requestId);
    if (item.personId) requestQuery = requestQuery.eq('apollo_person_id', item.personId);
    const { data: requests, error: requestError } = await requestQuery.limit(1);
    if (requestError) throw requestError;
    if (requests?.[0]?.lead_id) {
      const { data, error } = await supabase.from('leads').select('*').eq('id', requests[0].lead_id).maybeSingle();
      if (error) throw error;
      if (data) return data;
    }
  }

  // Apollo person IDs are not tenant-specific. If the webhook omits our request
  // ID, only accept an unambiguous pending request rather than searching the
  // shared leads table and risking a cross-workspace update.
  if (item.personId) {
    const { data: requests, error: requestError } = await supabase
      .from('apollo_enrichment_requests')
      .select('lead_id')
      .eq('apollo_person_id', item.personId)
      .eq('status', 'pending')
      .limit(2);
    if (requestError) throw requestError;
    if (requests?.length === 1) {
      const { data, error } = await supabase.from('leads').select('*').eq('id', requests[0].lead_id).maybeSingle();
      if (error) throw error;
      return data || null;
    }
  }

  return null;
}

async function requestNextEnrichmentBatch(supabase, run) {
  const target = Number(run.raw_meta?.requested_limit || run.total_rows || 0);
  const cap = Number(run.raw_meta?.candidate_cap || Math.min(target * 3, 300));
  const [{ data: candidates, error: candidateError }, { data: requests, error: requestError }] = await Promise.all([
    supabase.from('leads').select('id, external_id, raw_data').eq('import_run_id', run.id).eq('lifecycle_status', 'enriching').limit(cap),
    supabase.from('apollo_enrichment_requests').select('lead_id').eq('import_run_id', run.id),
  ]);
  if (candidateError) throw candidateError;
  if (requestError) throw requestError;
  const requestedLeadIds = new Set((requests || []).map(row => row.lead_id));
  const next = (candidates || []).filter(lead => !requestedLeadIds.has(lead.id)).slice(0, 10);
  const people = next.map(lead => lead.raw_data?.apollo?.searchPerson).filter(Boolean);
  if (!people.length) return { requested: 0, requestIds: [] };
  const leadByPersonId = new Map(next.map(lead => [lead.external_id, lead.id]));
  const batches = await requestBulkEnrichment(people, run.id);
  await recordEnrichmentRequests(supabase, run.workspace_id, run.id, batches, leadByPersonId);
  return { requested: people.length, requestIds: batches.map(batch => batch.request_id).filter(Boolean) };
}

async function discardUnadmittedEnrichingLeads(supabase, run, reason) {
  const { data: leads, error: leadError } = await supabase
    .from('leads')
    .select('id, external_id, raw_data')
    .eq('workspace_id', run.workspace_id)
    .eq('import_run_id', run.id)
    .eq('lifecycle_status', 'enriching');
  if (leadError) throw leadError;
  if (!leads?.length) return 0;

  const { error: auditError } = await supabase.from('apollo_enrichment_audits').insert(leads.map(lead => ({
    workspace_id: run.workspace_id,
    import_run_id: run.id,
    apollo_person_id: lead.external_id || null,
    outcome: 'not_admitted_no_verified_work_email',
    raw_response: {
      reason,
      apollo_search_person: lead.raw_data?.apollo?.searchPerson || null,
    },
  })));
  if (auditError) throw auditError;

  const completedAt = new Date().toISOString();
  const { error: requestError } = await supabase
    .from('apollo_enrichment_requests')
    .update({ status: 'failed', error_message: reason, completed_at: completedAt })
    .eq('workspace_id', run.workspace_id)
    .eq('import_run_id', run.id)
    .eq('status', 'pending');
  if (requestError) throw requestError;

  const { error: deleteError } = await supabase
    .from('leads')
    .delete()
    .eq('workspace_id', run.workspace_id)
    .eq('import_run_id', run.id)
    .eq('lifecycle_status', 'enriching');
  if (deleteError) throw deleteError;
  return leads.length;
}

async function applyApolloUpdates(supabase, updates) {
  let updated = 0;
  let skipped = 0;
  let notAdmitted = 0;
  const touchedRuns = new Set();

  for (const item of updates) {
    const lead = await findLeadForApolloUpdate(supabase, item);
    if (!lead) {
      skipped += 1;
      debug('update_skipped_no_lead_match', {
        hasPersonId: Boolean(item.personId),
        hasEmail: Boolean(item.email),
        hasPhone: Boolean(item.phone),
      });
      continue;
    }

    const canUseApolloEmail = !lead.email || lead.email_source === 'apollo';
    const canonicalEmail = canUseApolloEmail ? item.email : lead.email;
    const emailReady = usableEmail(canonicalEmail);
    const person = lead.raw_data?.apollo?.searchPerson || {};
    const enrichedAt = new Date().toISOString();

    if (!emailReady) {
      const { error: auditError } = await supabase.from('apollo_enrichment_audits').insert({
        workspace_id: lead.workspace_id,
        import_run_id: lead.import_run_id,
        apollo_person_id: lead.external_id || item.personId || null,
        apollo_request_id: item.requestId || null,
        outcome: 'not_admitted_no_verified_work_email',
        raw_response: item.raw || {},
      });
      if (auditError) throw auditError;

      const { error: requestError } = await supabase
        .from('apollo_enrichment_requests')
        .update({ status: 'failed', raw_response: item.raw, error_message: 'Apollo returned no verified work email', completed_at: enrichedAt })
        .eq('lead_id', lead.id);
      if (requestError) throw requestError;
      const { error: deleteError } = await supabase.from('leads').delete().eq('id', lead.id);
      if (deleteError) throw deleteError;
      if (lead.import_run_id) touchedRuns.add(lead.import_run_id);
      notAdmitted += 1;
      continue;
    }

    const companyData = await enrichOrganizationForPerson(person);
    const patch = {
      raw_data: mergeRawData(lead.raw_data, {
        enrichmentWebhook: item.raw,
        enrichment_status: 'completed',
      }),
      callable_block_reason: null,
      lifecycle_status: 'ready',
      enrichment_status: 'completed',
      last_enriched_at: enrichedAt,
      rejection_reason: null,
      company_data: companyData,
      personalization_profile: buildPersonalizationProfile(person, companyData, enrichedAt),
    };
    if (item.email && canUseApolloEmail) {
      patch.email = item.email;
      patch.email_status = 'verified';
      patch.email_source = 'apollo';
      patch.email_updated_at = new Date().toISOString();
    }
    if (item.phone) patch.phone = item.phone;
    if (item.phone_e164) patch.phone_e164 = item.phone_e164;

    const { error: updateError } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', lead.id);
    if (updateError) throw updateError;

    if (item.email) {
      await supabase.from('lead_enrichment_history').insert({
        workspace_id: lead.workspace_id,
        lead_id: lead.id,
        provider: 'apollo_waterfall',
        field_name: 'email',
        previous_value: lead.email || null,
        discovered_value: item.email,
        selected_as_canonical: canUseApolloEmail,
        confidence: 'verified',
        raw_response: item.raw || {},
      });
    }

    await supabase
      .from('apollo_enrichment_requests')
      .update({
        status: 'completed',
        raw_response: item.raw,
        error_message: null,
        completed_at: enrichedAt,
      })
      .eq('lead_id', lead.id);

    if (lead.import_run_id) touchedRuns.add(lead.import_run_id);
    updated += 1;
    debug('lead_contact_updated', {
      leadId: lead.id,
      hasEmail: Boolean(item.email),
      hasPhone: Boolean(item.phone),
      status: item.hasContactData ? 'completed' : 'failed',
    });
  }

  for (const runId of touchedRuns) {
    const { data: run } = await supabase
      .from('lead_import_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();

    if (run) {
      const [{ count: readyCount }, { count: pendingCount }] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('import_run_id', runId).eq('lifecycle_status', 'ready'),
        supabase.from('apollo_enrichment_requests').select('id', { count: 'exact', head: true }).eq('import_run_id', runId).eq('status', 'pending'),
      ]);
      const target = Number(run.raw_meta?.requested_limit || run.total_rows || 0);
      const ready = readyCount || 0;
      const pending = pendingCount || 0;
      const shouldTopUp = !pending && ready < target;
      const topUp = shouldTopUp ? await requestNextEnrichmentBatch(supabase, run) : { requested: 0, requestIds: [] };
      const hasMore = topUp.requested > 0;
      const discarded = !pending && ready >= target
        ? await discardUnadmittedEnrichingLeads(supabase, run, 'Target reached before verified work email was returned')
        : 0;
      await updateImportRun(supabase, runId, {
        status: (pending || hasMore) ? 'pending_enrichment' : (ready >= target ? 'completed' : 'partial'),
        completed_at: (pending || hasMore) ? null : new Date().toISOString(),
        raw_meta: {
          ...(run.raw_meta || {}),
          stage: (pending || hasMore) ? 'waiting_for_enrichment' : 'completed',
          stage_label: (pending || hasMore)
            ? (hasMore ? 'Requesting the next email batch' : 'Waiting for Apollo email results')
            : (ready >= target ? 'Ready leads reached' : 'Import finished with partial results'),
          eta_seconds: (pending || hasMore) ? 60 : 0,
          last_progress_at: new Date().toISOString(),
          enrichment_status: 'webhook_received',
          webhook_updated_count: ((run.raw_meta || {}).webhook_updated_count || 0) + updated,
          last_webhook_at: new Date().toISOString(),
          ready_count: ready,
          pending_count: pending,
          not_admitted_count: ((run.raw_meta || {}).not_admitted_count || 0) + discarded,
          latest_top_up_request_ids: topUp.requestIds,
        },
      });
    }
  }

  return { updated, skipped, notAdmitted };
}

async function pollAndApplyApolloRequests(supabase, requestIds) {
  let updated = 0;
  let skipped = 0;
  let pending = 0;

  for (const requestId of requestIds.filter(Boolean)) {
    try {
      const payload = await pollWebhookResult(requestId);
      const updates = extractWebhookUpdates(payload || {});
      if (!updates.length) {
        pending += 1;
        debug('poll_result_pending_or_empty', {
          requestIdSuffix: requestId.slice(-8),
        });
        continue;
      }
      debug('poll_result_updates_extracted', {
        requestIdSuffix: requestId.slice(-8),
        updates: updates.length,
        withEmail: updates.filter(update => Boolean(update.email)).length,
      });
      const result = await applyApolloUpdates(supabase, updates);
      updated += result.updated;
      skipped += result.skipped;
    } catch (error) {
      pending += 1;
      debug('poll_result_failed', {
        requestIdSuffix: requestId.slice(-8),
        error: error.message,
      });
    }
  }

  return { updated, skipped, pending };
}

router.post('/webhook', async (req, res) => {
  try {
    const service = createServiceClient();
    if (!service) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is required for Apollo webhooks' });
    }

    const updates = extractWebhookUpdates(req.body || {});
    const result = await applyApolloUpdates(service, updates);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to process Apollo webhook' });
  }
});

router.use(requireAuth);

router.get('/filters', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const agentConfig = await getAgentConfig(req.supabase, workspace.id);
    return res.json({
      filters: buildDefaultFilters(agentConfig || {}),
      industryOptions: APOLLO_INDUSTRIES,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load Apollo filters' });
  }
});

router.post('/sync-pending', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('apollo_enrichment_requests')
      .select('apollo_request_id')
      .eq('workspace_id', workspace.id)
      .eq('status', 'pending')
      .not('apollo_request_id', 'is', null)
      .limit(50);

    if (error) throw error;

    const requestIds = [...new Set((data || []).map(row => row.apollo_request_id).filter(Boolean))];
    debug('sync_pending_start', {
      workspaceId: workspace.id,
      requestCount: requestIds.length,
      requestIds: requestIds.map(id => id.slice(-8)),
    });
    const sync = await pollAndApplyApolloRequests(req.supabase, requestIds);
    debug('sync_pending_complete', sync);
    return res.json({ sync, requestIds });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to sync Apollo enrichment' });
  }
});

function normalizedCandidateKeys(lead = {}) {
  return {
    externalId: String(lead.external_id || '').trim(),
    email: String(lead.email || '').trim().toLowerCase(),
    phone: String(lead.phone || '').replace(/\D/g, ''),
    linkedin: String(lead.linkedin_url || '').trim().toLowerCase(),
    domain: String(lead.company_domain || lead.company_data?.domain || '').trim().toLowerCase(),
    nameCompany: `${String(lead.full_name || '').trim().toLowerCase()}|${String(lead.company_name || '').trim().toLowerCase()}`,
  };
}

function isSuppressed(lead, suppressions) {
  const keys = normalizedCandidateKeys(lead);
  return suppressions.some(row => {
    const suppressed = normalizedCandidateKeys(row);
    return Boolean(
      (keys.externalId && keys.externalId === suppressed.externalId)
      || (keys.email && keys.email === suppressed.email)
      || (keys.phone && keys.phone === suppressed.phone)
      || (keys.linkedin && keys.linkedin === suppressed.linkedin)
      || (keys.domain && keys.domain === suppressed.domain)
      || (keys.nameCompany !== '|' && keys.nameCompany === suppressed.nameCompany)
    );
  });
}

async function runApolloImport({ supabase, user, workspace, agentConfig, filters, run }) {
  const target = filters.limit;
  const candidateCap = Math.min(target * 3, 300);
  const pageCap = 10;
  const candidatePeople = [];
  const leadByPersonId = new Map();
  let searched = 0;
  let skipped = 0;
  let page = 1;
  const startedAt = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  let progressMeta = {
    ...(run.raw_meta || {}),
    stage: 'starting',
    stage_label: 'Starting Apollo import',
    started_at: startedAt,
    estimated_total_seconds: estimateImportSeconds(target),
    eta_seconds: estimateImportSeconds(target),
    target_ready_count: target,
    candidate_cap: candidateCap,
    page_cap: pageCap,
    timeout_at: timeoutAt,
  };

  async function reportProgress(status, metaPatch = {}, rowPatch = {}) {
    progressMeta = { ...progressMeta, ...metaPatch, last_progress_at: new Date().toISOString() };
    const updated = await updateImportRun(supabase, run.id, {
      status,
      raw_meta: progressMeta,
      progress: progressMeta,
      ...rowPatch,
    });
    debug('import_progress', {
      runId: run.id,
      stage: progressMeta.stage,
      page: progressMeta.current_page || null,
      searched: progressMeta.searched_count || 0,
      candidates: progressMeta.candidate_count || 0,
      requested: progressMeta.enrichment_requested_count || 0,
      ready: progressMeta.ready_count || 0,
      pending: progressMeta.pending_count || 0,
      etaSeconds: progressMeta.eta_seconds ?? null,
    });
    return updated;
  }

  try {
    await reportProgress('searching', {
      stage: 'searching',
      stage_label: 'Searching Apollo for matching people',
      current_page: page,
    }, { started_at: startedAt, timeout_at: timeoutAt, completed_at: null });

    const { data: suppressions, error: suppressionError } = await supabase
      .from('lead_suppressions')
      .select('*')
      .eq('workspace_id', workspace.id)
      .limit(10000);
    if (suppressionError) throw suppressionError;

    while (page <= pageCap && candidatePeople.length < candidateCap) {
      if (Date.now() >= new Date(timeoutAt).getTime()) {
        throw new Error('Apollo did not finish in time. Start a fresh import.');
      }
      debug('search_page_started', { runId: run.id, page, candidateCount: candidatePeople.length, candidateCap });
      const search = await searchPeople(filters, page, 100);
      searched += search.people.length;
      if (!search.people.length) {
        debug('search_exhausted', { runId: run.id, page, searched });
        break;
      }

      for (const person of search.people) {
        if (candidatePeople.length >= candidateCap) break;
        const leadInput = normalizeApolloLead(person, { searchFilters: filters, searchPage: page });
        const normalized = normalizeLead({ ...leadInput, source: 'apollo' });
        const existing = await findExistingLead(supabase, workspace.id, normalized);
        if (existing || isSuppressed(normalized, suppressions || [])) {
          skipped += 1;
          continue;
        }

        leadInput.lifecycle_status = 'enriching';
        leadInput.enrichment_status = 'pending';
        leadInput.enrichment_attempts = 1;
        leadInput.agent_config = agentConfig || {};
        const result = await upsertLeadWithContext(supabase, user, workspace, leadInput, run.id, 'apollo');
        if (result.skipped) {
          skipped += 1;
          continue;
        }
        const personId = apolloPersonId(person);
        if (personId) leadByPersonId.set(personId, result.lead.id);
        candidatePeople.push(person);
      }

      const searchProgress = Math.min(1, page / pageCap);
      await reportProgress('searching', {
        stage: 'searching',
        stage_label: `Searched Apollo page ${page}`,
        current_page: page,
        searched_pages: page,
        searched_count: searched,
        candidate_count: candidatePeople.length,
        skipped_count: skipped,
        eta_seconds: Math.max(30, Math.round(estimateImportSeconds(target) * (1 - searchProgress * 0.2))),
      }, {
        total_rows: candidatePeople.length,
        created_count: candidatePeople.length,
        skipped_count: skipped,
      });
      page += 1;
    }

    const totalBatches = Math.ceil(candidatePeople.length / 10);
    await reportProgress('enriching', {
      stage: 'enriching',
      stage_label: 'Enriching work emails in credit-safe batches',
      searched_pages: page - 1,
      total_enrichment_batches: totalBatches,
      current_enrichment_batch: 0,
      enrichment_requested_count: 0,
      eta_seconds: Math.max(20, totalBatches * 45),
    });
    const requestIds = [];
    for (let offset = 0; offset < candidatePeople.length; offset += 10) {
      if (Date.now() >= new Date(timeoutAt).getTime()) {
        throw new Error('Apollo did not finish in time. Start a fresh import.');
      }
      const batchPeople = candidatePeople.slice(offset, offset + 10);
      const batchNumber = Math.floor(offset / 10) + 1;
      await reportProgress('enriching', {
        stage: 'enriching',
        stage_label: `Requesting email batch ${batchNumber} of ${totalBatches}`,
        current_enrichment_batch: batchNumber,
        enrichment_requested_count: offset,
        eta_seconds: Math.max(15, (totalBatches - batchNumber + 1) * 45),
      });
      const batches = await requestBulkEnrichment(batchPeople, run.id);
      await recordEnrichmentRequests(supabase, workspace.id, run.id, batches, leadByPersonId);
      const batchRequestIds = batches.map(batch => batch.request_id).filter(Boolean);
      requestIds.push(...batchRequestIds);
      await pollAndApplyApolloRequests(supabase, batchRequestIds);

      const [{ count: readyCount }, { count: pendingCount }] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('import_run_id', run.id).eq('lifecycle_status', 'ready'),
        supabase.from('apollo_enrichment_requests').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('import_run_id', run.id).eq('status', 'pending'),
      ]);
      await reportProgress((pendingCount || 0) > 0 ? 'pending_enrichment' : 'enriching', {
        stage: (pendingCount || 0) > 0 ? 'waiting_for_enrichment' : 'enriching',
        stage_label: (pendingCount || 0) > 0 ? 'Waiting for Apollo email results' : `Completed email batch ${batchNumber}`,
        current_enrichment_batch: batchNumber,
        enrichment_requested_count: Math.min(candidatePeople.length, offset + batchPeople.length),
        ready_count: readyCount || 0,
        pending_count: pendingCount || 0,
        eta_seconds: (pendingCount || 0) > 0 ? 60 : Math.max(10, (totalBatches - batchNumber) * 45),
      });
      if ((readyCount || 0) >= target || (pendingCount || 0) > 0) break;
    }

    const [{ count: readyCount }, { count: pendingCount }] = await Promise.all([
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('import_run_id', run.id).eq('lifecycle_status', 'ready'),
      supabase.from('apollo_enrichment_requests').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('import_run_id', run.id).eq('status', 'pending'),
    ]);
    const ready = readyCount || 0;
    const pending = pendingCount || 0;
    const finalStatus = pending ? 'pending_enrichment' : (ready >= target ? 'completed' : 'partial');

    await reportProgress(finalStatus, {
      stage: pending ? 'waiting_for_enrichment' : 'completed',
      stage_label: pending ? 'Waiting for Apollo email results' : (ready >= target ? 'Ready leads reached' : 'Import finished with partial results'),
      eta_seconds: pending ? 60 : 0,
      filters,
      requested_limit: target,
      ready_count: ready,
      pending_count: pending,
      searched_count: searched,
      searched_pages: page - 1,
      candidate_count: candidatePeople.length,
      apollo_request_ids: requestIds,
      stop_reason: ready >= target ? 'target_reached' : (candidatePeople.length >= candidateCap ? 'candidate_cap' : 'search_exhausted'),
    }, {
      total_rows: candidatePeople.length,
      created_count: candidatePeople.length,
      skipped_count: skipped,
      completed_at: pending ? null : new Date().toISOString(),
    });
  } catch (error) {
    const timedOut = error.message === 'Apollo did not finish in time. Start a fresh import.';
    if (timedOut) {
      await discardUnadmittedEnrichingLeads(supabase, run, error.message).catch(() => undefined);
    }
    await updateImportRun(supabase, run.id, {
      status: 'failed',
      error_message: error.message || 'Apollo import failed',
      completed_at: new Date().toISOString(),
      raw_meta: {
        ...progressMeta,
        stage: 'failed',
        stage_label: 'Apollo import failed',
        timeout_at: timeoutAt,
        eta_seconds: 0,
        last_progress_at: new Date().toISOString(),
        apollo_error: error.payload || null,
      },
    }).catch(() => undefined);
    debug('background_import_failed', { importRunId: run.id, message: error.message });
  }
}

router.post('/import', async (req, res) => {
  let pendingRun = null;
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const agentConfig = await getAgentConfig(req.supabase, workspace.id);
    const filters = normalizeFilters(req.body.filters || req.body, agentConfig || {});
    debug('import_start', {
      workspaceId: workspace.id,
      titles: filters.titles,
      region: filters.region,
      industry: filters.industry,
      companySize: filters.companySize,
      limit: filters.limit,
    });

    const { data, error: runError } = await req.supabase
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
          stage: 'queued',
          stage_label: 'Waiting for the lead-import worker',
          estimated_total_seconds: estimateImportSeconds(filters.limit),
          eta_seconds: estimateImportSeconds(filters.limit),
          queued_at: new Date().toISOString(),
          last_progress_at: new Date().toISOString(),
        },
      })
      .select('*')
      .single();

    if (runError) throw runError;
    pendingRun = data;
    const queue = getLeadImportQueue();
    await queue.add('apollo', {
      runId: pendingRun.id,
      workspaceId: workspace.id,
      userId: req.user.id,
      userEmail: req.user.email || null,
      filters,
    }, { jobId: createQueueJobId('apollo', pendingRun.id) });

    return res.status(202).json({ importRun: pendingRun });
  } catch (error) {
    if (pendingRun?.id) {
      try {
        await req.supabase.from('lead_import_runs').update({
          status: 'failed',
          error_message: error.message || 'Failed to queue Apollo import',
          completed_at: new Date().toISOString(),
        }).eq('id', pendingRun.id);
      } catch (_) {
        // Preserve the original queue error returned to the caller.
      }
    }
    debug('import_failed', {
      importRunId: pendingRun?.id || null,
      statusCode: error.statusCode || null,
      message: error.message,
      payload: error.payload || null,
    });
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return res.status(status).json({ error: error.message || 'Failed to import Apollo leads' });
  }
});

router.post('/retry/:leadId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: lead, error } = await req.supabase.from('leads').select('*')
      .eq('workspace_id', workspace.id).eq('id', req.params.leadId).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.lifecycle_status !== 'rejected_no_email') return res.status(400).json({ error: 'Only no-email leads can be retried' });
    const cooldownEnds = new Date(new Date(lead.last_enriched_at || 0).getTime() + 30 * 24 * 60 * 60 * 1000);
    if (cooldownEnds > new Date()) {
      return res.status(409).json({ error: `Enrichment can be retried after ${cooldownEnds.toISOString()}` });
    }
    const person = lead.raw_data?.apollo?.searchPerson;
    if (!person || !lead.import_run_id) return res.status(400).json({ error: 'Apollo source data is unavailable for retry' });
    await req.supabase.from('leads').update({
      lifecycle_status: 'enriching',
      enrichment_status: 'pending',
      enrichment_attempts: Number(lead.enrichment_attempts || 0) + 1,
      rejection_reason: null,
    }).eq('id', lead.id);
    const batches = await requestBulkEnrichment([person], lead.import_run_id);
    await recordEnrichmentRequests(req.supabase, workspace.id, lead.import_run_id, batches, new Map([[lead.external_id, lead.id]]));
    return res.status(202).json({ lead_id: lead.id, request_ids: batches.map(batch => batch.request_id).filter(Boolean) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to retry Apollo enrichment' });
  }
});

router.get('/imports/latest', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('lead_import_runs')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('source', 'apollo')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({ importRun: data || null });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load latest Apollo import' });
  }
});

router.get('/imports/:runId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('lead_import_runs')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.runId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Import run not found' });
    return res.json({ importRun: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load import progress' });
  }
});

module.exports = router;
module.exports.runApolloImport = runApolloImport;
