const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { voiceEligibility, requiresDncCheck } = require('../lib/dnc');
const { creditCheck } = require('../lib/callCredits');
const { setupBlockers } = require('../lib/voiceCampaign');
const { callingWindowState, nextOpenAt } = require('../lib/voiceScheduling');
const { monthlyWorkspace, loadWorkspaceAgent } = require('../lib/voiceAgentProvisioning');
const { SingleCallError, leadSearchFilter, startSingleCall } = require('../lib/singleCall');

const router = express.Router();
router.use(requireAuth);

const LEAD_COLUMNS = 'id, full_name, first_name, company_name, title, phone, phone_e164, phone_type, status, lifecycle_status, suppression_reason, dnc_status, dnc_checked_at, voice_consent_status';

const uuid = z.string().uuid();
const startSchema = z.object({
  lead_id: uuid,
  campaign_id: uuid,
  confirmed: z.literal(true),
  schedule: z.boolean().optional(),
  call_now: z.boolean().optional(),
});

function first(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function schedulingAvailable() {
  return process.env.VOICE_QUEUE_ENABLED === 'true';
}

function sendError(res, error, fallback) {
  if (error instanceof SingleCallError) {
    return res.status(error.status).json({ error: error.message, ...error.extra });
  }
  console.error('[single-call]', error);
  return res.status(500).json({ error: fallback });
}

/** Everything the Call a lead window needs: leads, scripts and the rules for each. */
router.get('/options', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const now = new Date();

    const [
      { data: leads, error: leadError },
      { data: campaigns, error: campaignError },
      { data: telephony, error: telephonyError },
      { data: lastCall, error: lastCallError },
    ] = await Promise.all([
      req.supabase
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('workspace_id', workspace.id)
        .or(leadSearchFilter(req.query.q))
        .order('updated_at', { ascending: false })
        .limit(30),
      req.supabase
        .from('campaigns')
        .select('id, workspace_id, name, status, timezone, active_days, sending_hours_start, sending_hours_end, voice_scripts!inner(status, language, opening_line, attested_at), voice_agents(status, retell_agent_id)')
        .eq('workspace_id', workspace.id)
        .eq('channel', 'voice')
        .eq('voice_scripts.status', 'approved')
        .order('updated_at', { ascending: false }),
      req.supabase.from('workspace_telephony').select('*').eq('workspace_id', workspace.id).maybeSingle(),
      req.supabase
        .from('calls')
        .select('campaign_id')
        .eq('workspace_id', workspace.id)
        .eq('source', 'manual')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    if (leadError) throw leadError;
    if (campaignError) throw campaignError;
    if (telephonyError) throw telephonyError;
    if (lastCallError) throw lastCallError;

    const monthly = await monthlyWorkspace(req.supabase, workspace.id);
    const sharedAgent = monthly ? await loadWorkspaceAgent(req.supabase, workspace.id) : null;

    const scripts = (campaigns || []).map(campaign => {
      const script = first(campaign.voice_scripts);
      const agent = monthly ? sharedAgent : first(campaign.voice_agents);
      const nextOpen = nextOpenAt(campaign, now);
      return {
        campaign_id: campaign.id,
        name: campaign.name,
        language: script?.language || 'en-US',
        opening_line: script?.opening_line || '',
        timezone: campaign.timezone || 'Asia/Singapore',
        sending_hours_start: campaign.sending_hours_start,
        window_open: callingWindowState(campaign, now).open,
        next_open_at: nextOpen ? nextOpen.toISOString() : null,
        problem: setupBlockers({ campaign, script, agent, telephony })[0]?.reason || null,
      };
    });

    const leadIds = (leads || []).map(lead => lead.id);
    const { data: queued, error: queuedError } = leadIds.length
      ? await req.supabase
        .from('voice_call_targets')
        .select('lead_id, campaigns!inner(name, status)')
        .in('lead_id', leadIds)
        .in('state', ['pending', 'in_flight'])
        .eq('campaigns.status', 'active')
      : { data: [], error: null };
    if (queuedError) throw queuedError;
    const queuedIn = new Map((queued || []).map(row => [row.lead_id, first(row.campaigns)?.name || null]));

    const access = await creditCheck(req.supabase, workspace.id).catch(() => ({ ok: true, reason: null }));
    const lastUsed = lastCall?.[0]?.campaign_id;
    const defaultScript = scripts.find(script => script.campaign_id === lastUsed && !script.problem)
      || scripts.find(script => !script.problem)
      || null;

    const options = (leads || []).map(lead => {
      const eligibility = voiceEligibility(lead, now);
      return {
        id: lead.id,
        full_name: lead.full_name,
        company_name: lead.company_name,
        title: lead.title,
        phone: lead.phone_e164 || lead.phone,
        callable: eligibility.callable,
        reason: eligibility.reason,
        // Consent can clear the Do Not Call check, but never an opt-out.
        can_record_consent: !eligibility.callable && requiresDncCheck(lead)
          && lead.status !== 'do_not_call' && lead.lifecycle_status !== 'suppressed'
          && lead.dnc_status !== 'blocked' && lead.voice_consent_status !== 'not_consented',
        queued_in: queuedIn.get(lead.id) || null,
      };
    }).sort((a, b) => Number(b.callable) - Number(a.callable));

    return res.json({
      leads: options,
      scripts,
      default_campaign_id: defaultScript?.campaign_id || null,
      from_number: telephony?.retell_phone_number || telephony?.from_number || null,
      calling_allowed: { ok: access.ok, reason: access.reason || null },
      scheduling_available: schedulingAvailable(),
    });
  } catch (error) {
    return sendError(res, error, 'Could not load calling options');
  }
});

router.post('/', async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a lead and script, and confirm the call' });

  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const call = await startSingleCall(req.supabase, {
      workspaceId: workspace.id,
      userId: req.user.id,
      leadId: parsed.data.lead_id,
      campaignId: parsed.data.campaign_id,
      schedule: parsed.data.schedule,
      callNow: parsed.data.call_now,
      schedulingAvailable: schedulingAvailable(),
    });
    return res.status(201).json({ call });
  } catch (error) {
    return sendError(res, error, 'Could not place the call');
  }
});

router.get('/:callId', async (req, res) => {
  if (!uuid.safeParse(req.params.callId).success) return res.status(404).json({ error: 'Call not found' });

  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: call, error } = await req.supabase
      .from('calls')
      .select('id, status, source, scheduled_for, to_number, from_number, duration_seconds, summary, outcome_type, outcome_summary, next_action, error_message, disconnection_reason, ended_at, leads(full_name, company_name), call_outcomes(outcome_type, next_action), meetings!calls_meeting_id_fkey(id, starts_at, status)')
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.callId)
      .maybeSingle();

    if (error) throw error;
    if (!call) return res.status(404).json({ error: 'Call not found' });
    return res.json({ call });
  } catch (error) {
    return sendError(res, error, 'Could not load the call');
  }
});

router.post('/:callId/cancel', async (req, res) => {
  if (!uuid.safeParse(req.params.callId).success) return res.status(404).json({ error: 'Call not found' });

  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: call, error } = await req.supabase
      .from('calls')
      .update({ status: 'canceled', success: false, error_message: 'Canceled before it was placed' })
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.callId)
      .eq('source', 'manual')
      .eq('status', 'scheduled')
      .select('*')
      .maybeSingle();

    if (error) throw error;
    if (!call) return res.status(409).json({ error: 'This call has already been placed or canceled' });
    return res.json({ call });
  } catch (error) {
    return sendError(res, error, 'Could not cancel the call');
  }
});

module.exports = router;
