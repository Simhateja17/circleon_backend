const express = require('express');
const requireAuth = require('../middleware/auth');
const { normalizePhone } = require('../lib/calling');

const router = express.Router();

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeLead(input = {}) {
  return {
    external_id: clean(input.external_id),
    full_name: clean(input.full_name || input.name),
    company_name: clean(input.company_name || input.company),
    title: clean(input.title),
    phone: clean(input.phone),
    phone_e164: normalizePhone(input.phone_e164 || input.phone),
    email: clean(input.email).toLowerCase(),
    location: clean(input.location),
    status: clean(input.status) || 'new',
    priority: clean(input.priority) || 'normal',
    voice_consent_status: clean(input.voice_consent_status) || 'unknown',
    dnc_status: clean(input.dnc_status) || 'unknown',
    dnc_checked_at: clean(input.dnc_checked_at) || null,
    callable_block_reason: clean(input.callable_block_reason),
    last_contacted_at: clean(input.last_contacted_at) || null,
    notes_summary: clean(input.notes_summary || input.note || input.history),
    raw_data: input.raw_data || input,
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

  return null;
}

async function upsertLeadWithContext(supabase, user, workspace, input, importRunId = null, source = 'manual') {
  const lead = normalizeLead(input);

  if (!lead.full_name || (source !== 'apollo' && !lead.phone && !lead.email)) {
    return { skipped: true, reason: source === 'apollo' ? 'Apollo lead requires a name' : 'Lead requires name and phone or email' };
  }

  const existing = await findExistingLead(supabase, workspace.id, lead);
  const payload = {
    ...lead,
    workspace_id: workspace.id,
    import_run_id: importRunId,
    source,
  };

  let savedLead;
  if (existing) {
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

router.post('/import-csv', async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);

    const { data: run, error: runError } = await req.supabase
      .from('lead_import_runs')
      .insert({
        workspace_id: workspace.id,
        source: 'csv',
        status: 'pending',
        total_rows: rows.length,
        raw_meta: { columns: Object.keys(rows[0] || {}) },
      })
      .select('*')
      .single();

    if (runError) throw runError;

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const result = await upsertLeadWithContext(req.supabase, req.user, workspace, row, run.id, 'csv');
      if (result.skipped) skipped += 1;
      else if (result.updated) updated += 1;
      else created += 1;
    }

    const { data: completedRun, error: updateError } = await req.supabase
      .from('lead_import_runs')
      .update({
        status: 'completed',
        created_count: created,
        updated_count: updated,
        skipped_count: skipped,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return res.json({ importRun: completedRun });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to import CSV leads' });
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
