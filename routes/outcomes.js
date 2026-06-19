const express = require('express');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { normalizeOutcomeType, upsertCallOutcome } = require('../lib/outcomes');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('call_outcomes')
      .select('*, calls(created_at, duration_seconds), leads(full_name, company_name, email, phone)')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ outcomes: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load call outcomes' });
  }
});

router.post('/calls/:callId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: call, error: callError } = await req.supabase
      .from('calls')
      .select('*')
      .eq('id', req.params.callId)
      .eq('workspace_id', workspace.id)
      .single();

    if (callError) throw callError;

    const outcome = await upsertCallOutcome(req.supabase, call, {
      outcome_type: normalizeOutcomeType(req.body.outcome_type),
      confidence: req.body.confidence || 'medium',
      summary: req.body.summary || null,
      next_action: req.body.next_action || null,
      meeting_requested: Boolean(req.body.meeting_requested),
    }, { source: 'manual', body: req.body });

    return res.json({ outcome });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save call outcome' });
  }
});

router.get('/meetings', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('meetings')
      .select('*, leads(full_name, company_name, email, phone), calls(outcome_type, summary)')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ meetings: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load meetings' });
  }
});

router.post('/meetings', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const payload = {
      workspace_id: workspace.id,
      lead_id: req.body.lead_id || null,
      call_id: req.body.call_id || null,
      call_outcome_id: req.body.call_outcome_id || null,
      provider: req.body.provider || 'manual',
      external_id: req.body.external_id || null,
      status: req.body.status || 'requested',
      title: req.body.title || 'Discovery call',
      invitee_name: req.body.invitee_name || null,
      invitee_email: req.body.invitee_email || null,
      invitee_phone: req.body.invitee_phone || null,
      booking_url: req.body.booking_url || null,
      meeting_url: req.body.meeting_url || null,
      starts_at: req.body.starts_at || null,
      ends_at: req.body.ends_at || null,
      timezone: req.body.timezone || 'Asia/Singapore',
      notes: req.body.notes || null,
      raw_data: req.body.raw_data || {},
    };

    const { data, error } = await req.supabase
      .from('meetings')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;

    if (data.lead_id) {
      await req.supabase.from('leads').update({ status: 'booked' }).eq('id', data.lead_id);
    }

    return res.json({ meeting: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create meeting' });
  }
});

module.exports = router;
