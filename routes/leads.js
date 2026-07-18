const express = require('express');
const requireAuth = require('../middleware/auth');
const { normalizePhone } = require('../lib/calling');
const { createServiceClient } = require('../lib/supabase');
const { mapCsvColumns } = require('../lib/gemini');
const { applyMapping, parseCsv } = require('../lib/csvLeads');
const { createQueueJobId, getLeadImportQueue } = require('../lib/redis');

const router = express.Router();

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizeDomain(value) {
  return clean(value)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

function usableEmail(value) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const local = email.split('@')[0];
  return !['info', 'support', 'hello', 'contact', 'admin', 'sales'].includes(local);
}

function calculateFitScore(lead, agentConfig = {}) {
  const reasons = [];
  let score = 0;
  const title = clean(lead.title).toLowerCase();
  const companyIndustry = clean(lead.company_industry || lead.company_data?.industry).toLowerCase();
  const targetTitles = Array.isArray(agentConfig.target_titles) ? agentConfig.target_titles : [];

  if (targetTitles.some(target => title.includes(clean(target).toLowerCase()) || clean(target).toLowerCase().includes(title))) {
    score += 25;
    reasons.push({ points: 25, reason: 'Buyer role matches' });
  }
  if (agentConfig.industry && companyIndustry.includes(clean(agentConfig.industry).toLowerCase())) {
    score += 25;
    reasons.push({ points: 25, reason: 'Industry and use case match' });
  }
  const companyData = lead.company_data || {};
  if (companyData.latest_funding_round_date || Number(companyData.total_funding || 0) > 0 || (companyData.raw?.job_postings || []).length) {
    score += 20;
    reasons.push({ points: 20, reason: 'Current growth or buying signal' });
  }
  if (agentConfig.company_size && (lead.company_size || companyData.estimated_num_employees)) {
    score += 15;
    reasons.push({ points: 15, reason: 'Company size data available for qualification' });
  }
  if (title) {
    score += 10;
    reasons.push({ points: 10, reason: 'Reachable named decision-maker' });
  }
  if (lead.company_name && (lead.company_domain || companyData.domain || companyData.short_description)) {
    score += 5;
    reasons.push({ points: 5, reason: 'Strong personalization data' });
  }

  return { score: Math.min(score, 100), reasons };
}

function normalizeLead(input = {}) {
  const email = normalizeEmail(input.email);
  const source = clean(input.source);
  const userProvidedEmail = Boolean(email && source !== 'apollo');
  return {
    external_id: clean(input.external_id),
    first_name: clean(input.first_name),
    last_name: clean(input.last_name),
    full_name: clean(input.full_name || input.name || `${clean(input.first_name)} ${clean(input.last_name)}`) || (email ? email.split('@')[0] : ''),
    company_name: clean(input.company_name || input.company),
    title: clean(input.title),
    phone: clean(input.phone),
    phone_e164: normalizePhone(input.phone_e164 || input.phone),
    email,
    email_status: clean(input.email_status) || (userProvidedEmail ? 'user_provided' : (email ? 'unverified' : 'unknown')),
    email_source: clean(input.email_source) || (email ? (source || 'manual') : null),
    email_updated_at: email ? (clean(input.email_updated_at) || new Date().toISOString()) : null,
    linkedin_url: clean(input.linkedin_url),
    company_domain: normalizeDomain(input.company_domain || input.website || input.company_website),
    company_industry: clean(input.company_industry || input.industry),
    company_size: clean(input.company_size),
    location: clean(input.location),
    status: clean(input.status) || 'new',
    priority: clean(input.priority) || 'normal',
    voice_consent_status: clean(input.voice_consent_status) || 'unknown',
    dnc_status: clean(input.dnc_status) || 'unknown',
    dnc_checked_at: clean(input.dnc_checked_at) || null,
    callable_block_reason: clean(input.callable_block_reason),
    last_contacted_at: clean(input.last_contacted_at) || null,
    notes_summary: clean(input.notes_summary || input.note || input.history),
    company_data: input.company_data || {},
    raw_data: input.raw_data || input,
    lifecycle_status: clean(input.lifecycle_status) || (usableEmail(email) ? 'ready' : 'candidate'),
    enrichment_status: clean(input.enrichment_status) || 'not_started',
    enrichment_attempts: Number(input.enrichment_attempts || 0),
    last_enriched_at: clean(input.last_enriched_at) || null,
    rejection_reason: clean(input.rejection_reason) || null,
    suppression_reason: clean(input.suppression_reason) || null,
    fit_score: Number(input.fit_score || 0),
    fit_reasons: Array.isArray(input.fit_reasons) ? input.fit_reasons : [],
  };
}

function normalizeFollowUp(input = {}) {
  const dueAt = clean(input.due_at || input.follow_up_due_at || input.next_follow_up_at);
  return {
    title: clean(input.title || input.follow_up_title || input.next_action) || 'Follow up with lead',
    context_note: clean(input.context_note || input.follow_up_note || input.note),
    owner_type: clean(input.owner_type) || 'agent',
    action_type: clean(input.action_type) || 'call',
    status: clean(input.status) || 'scheduled',
    priority: clean(input.priority) || 'normal',
    due_at: dueAt || null,
  };
}

async function getOrCreateWorkspace(supabase, user) {
  const { data: existing, error: selectError } = await supabase
    .from('workspaces')
    .select('*')
    .eq('owner_id', user.id)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing) return existing;

  const { data, error } = await supabase
    .from('workspaces')
    .insert({
      owner_id: user.id,
      name: user.email?.split('@')[0] || 'My Workspace',
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function findExistingLead(supabase, workspaceId, lead) {
  if (lead.external_id) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('external_id', lead.external_id)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  if (lead.phone) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('phone', lead.phone)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  if (lead.email) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('email', lead.email)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  if (lead.linkedin_url) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('linkedin_url', lead.linkedin_url)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  return null;
}

async function upsertLeadWithContext(supabase, user, workspace, input, importRunId = null, source = 'manual') {
  const lead = normalizeLead({ ...input, source });

  const hasIdentity = Boolean(lead.full_name || lead.email || lead.linkedin_url);
  const hasCsvLocator = Boolean(lead.email || lead.linkedin_url || (lead.full_name && lead.company_name));
  if (!hasIdentity || (source === 'csv' && !hasCsvLocator) || (source === 'manual' && !lead.phone && !lead.email)) {
    return { skipped: true, reason: source === 'csv' ? 'CSV lead requires name and company, email, or LinkedIn URL' : 'Lead requires identifying contact data' };
  }

  const existing = await findExistingLead(supabase, workspace.id, lead);
  const scored = calculateFitScore(lead, input.agent_config || {});
  const payload = {
    ...lead,
    fit_score: lead.fit_score || scored.score,
    fit_reasons: lead.fit_reasons.length ? lead.fit_reasons : scored.reasons,
    workspace_id: workspace.id,
    import_run_id: importRunId,
    source,
  };

  let savedLead;
  if (existing) {
    if (existing.email && existing.email_source !== 'apollo') {
      payload.email = existing.email;
      payload.email_status = existing.email_status;
      payload.email_source = existing.email_source;
      payload.email_updated_at = existing.email_updated_at;
      payload.lifecycle_status = existing.lifecycle_status;
    }
    const { data, error } = await supabase
      .from('leads')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;
    savedLead = data;
  } else {
    const { data, error } = await supabase
      .from('leads')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;
    savedLead = data;
  }

  const noteText = clean(input.note || input.history || input.notes_summary);
  if (noteText) {
    const { error } = await supabase.from('lead_notes').insert({
      workspace_id: workspace.id,
      lead_id: savedLead.id,
      source: source === 'csv' ? 'import' : 'manual',
      note: noteText,
      created_by: user.id,
    });

    if (error) throw error;
  }

  const followUp = normalizeFollowUp(input.follow_up || input);
  if (followUp.due_at || clean(input.next_action || input.follow_up_title)) {
    const { error } = await supabase.from('follow_ups').insert({
      ...followUp,
      workspace_id: workspace.id,
      lead_id: savedLead.id,
      created_by: user.id,
    });

    if (error) throw error;
  }

  return { skipped: false, updated: Boolean(existing), lead: savedLead };
}

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: leads, error: leadsError } = await req.supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id)
      .order('updated_at', { ascending: false });

    if (leadsError) throw leadsError;

    const { data: followUps, error: followUpError } = await req.supabase
      .from('follow_ups')
      .select('*, leads(full_name, company_name, phone, email)')
      .eq('workspace_id', workspace.id)
      .in('status', ['suggested', 'scheduled', 'missed'])
      .order('due_at', { ascending: true, nullsFirst: false });

    if (followUpError) throw followUpError;

    const sortedFollowUps = [...(followUps || [])].sort((a, b) => {
      const priorityDiff = (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.due_at || '9999-12-31').getTime() - new Date(b.due_at || '9999-12-31').getTime();
    });

    return res.json({ leads: leads || [], followUps: sortedFollowUps });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load leads' });
  }
});

router.post('/', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const result = await upsertLeadWithContext(req.supabase, req.user, workspace, req.body.lead || req.body, null, 'manual');

    if (result.skipped) {
      return res.status(400).json({ error: result.reason });
    }

    return res.json({ lead: result.lead, updated: result.updated });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save lead' });
  }
});

router.patch('/:leadId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: existing, error: existingError } = await req.supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.leadId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const editable = ['full_name', 'company_name', 'title', 'email', 'phone', 'notes_summary', 'linkedin_url', 'location'];
    const requested = Object.fromEntries(editable.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field]]));
    const normalized = normalizeLead({ ...existing, ...requested, source: existing.source });
    if (!normalized.full_name) return res.status(400).json({ error: 'Lead name is required' });
    const emailChanged = requested.email !== undefined && normalizeEmail(requested.email) !== normalizeEmail(existing.email);
    const phoneChanged = requested.phone !== undefined && clean(requested.phone) !== clean(existing.phone);
    const { data: agentConfig, error: agentError } = await req.supabase
      .from('agent_configs').select('*').eq('workspace_id', workspace.id).maybeSingle();
    if (agentError) throw agentError;
    const fit = calculateFitScore(normalized, agentConfig || {});
    const preserveLifecycle = ['selected_for_campaign', 'contacted', 'suppressed'].includes(existing.lifecycle_status);
    const patch = {
      ...Object.fromEntries(editable.map(field => [field, normalized[field]])),
      phone_e164: normalized.phone_e164,
      fit_score: fit.score,
      fit_reasons: fit.reasons,
      lifecycle_status: preserveLifecycle ? existing.lifecycle_status : (usableEmail(normalized.email) ? 'ready' : 'candidate'),
    };
    if (emailChanged) {
      patch.email_source = 'user_edit';
      patch.email_status = normalized.email ? 'user_provided' : 'unknown';
      patch.email_updated_at = normalized.email ? new Date().toISOString() : null;
    }
    if (phoneChanged) {
      patch.phone_source = 'user_edit';
      patch.phone_updated_at = normalized.phone ? new Date().toISOString() : null;
    }

    const { data, error } = await req.supabase.from('leads').update(patch)
      .eq('workspace_id', workspace.id).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return res.json({ lead: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update lead' });
  }
});

router.delete('/:leadId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase.from('leads').delete()
      .eq('workspace_id', workspace.id).eq('id', req.params.leadId).select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Lead not found' });
    return res.json({ deleted: true, leadId: data.id });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to delete lead' });
  }
});

router.post('/import-csv', async (req, res) => {
  return res.status(410).json({
    error: 'Direct CSV import is retired. Preview the CSV mapping and confirm it through /csv/import.',
  });
});

router.post('/csv/preview', async (req, res) => {
  try {
    const parsed = parseCsv(req.body.csv_text || '');
    if (!parsed.headers.length) return res.status(400).json({ error: 'CSV file has no headers' });
    if (parsed.rows.length > 10000) return res.status(400).json({ error: 'CSV exceeds the 10,000-row limit' });
    const mappings = await mapCsvColumns({ headers: parsed.headers, sampleRows: parsed.rows.slice(0, 5) });
    const normalizedPreview = parsed.rows.slice(0, 5).map(row => applyMapping(row, mappings));
    return res.json({
      headers: parsed.headers,
      row_count: parsed.rows.length,
      mappings,
      preview: normalizedPreview,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to map CSV columns' });
  }
});

async function processCsvImport({ supabase, user, workspace, run, rows, mappings, mode }) {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set();
  const rejected = [];
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const input = applyMapping(rows[index], mappings);
      const normalized = normalizeLead({ ...input, source: 'csv' });
      const key = normalized.email || normalized.linkedin_url || normalized.external_id
        || `${normalized.full_name.toLowerCase()}|${normalized.company_name.toLowerCase()}`;
      if (!key || seen.has(key)) {
        skipped += 1;
        rejected.push({ row: index + 2, reason: 'Duplicate or missing identity' });
        continue;
      }
      seen.add(key);

      if (mode === 'suppress') {
        const suppression = {
          workspace_id: workspace.id,
          import_run_id: run.id,
          external_id: normalized.external_id || null,
          email: normalized.email || null,
          phone: normalized.phone || null,
          linkedin_url: normalized.linkedin_url || null,
          company_domain: normalized.company_domain || null,
          full_name: normalized.full_name || null,
          company_name: normalized.company_name || null,
          reason: 'user_csv',
          raw_data: input.raw_data || {},
        };
        const hasLocator = Object.entries(suppression).some(([field, value]) => ['external_id', 'email', 'phone', 'linkedin_url', 'company_domain'].includes(field) && value)
          || (suppression.full_name && suppression.company_name);
        if (!hasLocator) {
          skipped += 1;
          rejected.push({ row: index + 2, reason: 'Suppression row has no matchable identity' });
          continue;
        }
        const { error } = await supabase.from('lead_suppressions').insert(suppression);
        if (error) throw error;
        if (suppression.company_domain) {
          await supabase.from('leads').update({ lifecycle_status: 'suppressed', suppression_reason: 'Matched user CSV exclusion' })
            .eq('workspace_id', workspace.id).eq('company_domain', suppression.company_domain);
        } else {
          const existing = await findExistingLead(supabase, workspace.id, normalized);
          if (existing) {
            await supabase.from('leads').update({ lifecycle_status: 'suppressed', suppression_reason: 'Matched user CSV exclusion' }).eq('id', existing.id);
          }
        }
        created += 1;
        continue;
      }

      input.lifecycle_status = usableEmail(normalized.email) ? 'ready' : 'candidate';
      input.email_status = normalized.email ? 'user_provided' : 'unknown';
      input.email_source = normalized.email ? 'csv' : null;
      const result = await upsertLeadWithContext(supabase, user, workspace, input, run.id, 'csv');
      if (result.skipped) {
        skipped += 1;
        rejected.push({ row: index + 2, reason: result.reason });
      } else if (result.updated) updated += 1;
      else created += 1;
    }

    await supabase.from('lead_import_runs').update({
      status: 'completed',
      created_count: created,
      updated_count: updated,
      skipped_count: skipped,
      completed_at: new Date().toISOString(),
      raw_meta: { ...(run.raw_meta || {}), mode, rejected },
    }).eq('id', run.id);
  } catch (error) {
    await supabase.from('lead_import_runs').update({
      status: 'failed',
      error_message: error.message,
      completed_at: new Date().toISOString(),
      raw_meta: { ...(run.raw_meta || {}), mode, rejected },
    }).eq('id', run.id);
  }
}

router.post('/csv/import', async (req, res) => {
  let run = null;
  try {
    const mode = req.body.mode === 'suppress' ? 'suppress' : 'import';
    const mappings = Array.isArray(req.body.mappings) ? req.body.mappings : [];
    const parsed = parseCsv(req.body.csv_text || '');
    if (!parsed.rows.length || !mappings.length) return res.status(400).json({ error: 'Confirmed CSV mapping is required' });
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase.from('lead_import_runs').insert({
      workspace_id: workspace.id,
      source: 'csv',
      status: 'pending',
      total_rows: parsed.rows.length,
      raw_meta: { mode, columns: parsed.headers, mappings },
    }).select('*').single();
    if (error) throw error;
    run = data;
    const queue = getLeadImportQueue();
    await queue.add('csv', {
      runId: run.id,
      workspaceId: workspace.id,
      userId: req.user.id,
      userEmail: req.user.email || null,
      rows: parsed.rows,
      mappings,
      mode,
    }, { jobId: createQueueJobId('csv', run.id) });
    return res.status(202).json({ importRun: run });
  } catch (error) {
    if (run?.id) {
      try {
        await req.supabase.from('lead_import_runs').update({
          status: 'failed',
          error_message: error.message || 'Failed to queue CSV import',
          completed_at: new Date().toISOString(),
        }).eq('id', run.id);
      } catch (_) {
        // Preserve the original queue error returned to the caller.
      }
    }
    return res.status(500).json({ error: error.message || 'Failed to start CSV import' });
  }
});

router.get('/imports/:runId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase.from('lead_import_runs').select('*')
      .eq('workspace_id', workspace.id).eq('id', req.params.runId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Import run not found' });
    return res.json({ importRun: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load CSV import progress' });
  }
});

router.get('/imports/:runId/errors.csv', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase.from('lead_import_runs').select('id, raw_meta')
      .eq('workspace_id', workspace.id).eq('id', req.params.runId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Import run not found' });
    const rejected = Array.isArray(data.raw_meta?.rejected) ? data.raw_meta.rejected : [];
    const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const body = ['row,reason', ...rejected.map(item => `${csvCell(item.row)},${csvCell(item.reason)}`)].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="barsha-import-${data.id}-errors.csv"`);
    return res.send(body);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to download CSV import errors' });
  }
});

router.post('/:leadId/follow-ups', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const followUp = normalizeFollowUp(req.body);
    const { data, error } = await req.supabase
      .from('follow_ups')
      .insert({
        ...followUp,
        workspace_id: workspace.id,
        lead_id: req.params.leadId,
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ followUp: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create follow-up' });
  }
});

router.patch('/follow-ups/:followUpId', async (req, res) => {
  try {
    const patch = {};
    for (const key of ['status', 'priority', 'due_at', 'owner_type', 'action_type', 'title', 'context_note', 'blocked_reason']) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (patch.status === 'completed') patch.completed_at = new Date().toISOString();
    if (patch.status === 'scheduled') {
      patch.approved_at = new Date().toISOString();
      patch.approved_by = req.user.id;
    }

    const { data, error } = await req.supabase
      .from('follow_ups')
      .update(patch)
      .eq('id', req.params.followUpId)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ followUp: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update follow-up' });
  }
});

module.exports = router;
module.exports.normalizeLead = normalizeLead;
module.exports.findExistingLead = findExistingLead;
module.exports.upsertLeadWithContext = upsertLeadWithContext;
module.exports.calculateFitScore = calculateFitScore;
module.exports.normalizeDomain = normalizeDomain;
module.exports.usableEmail = usableEmail;
module.exports.processCsvImport = processCsvImport;
