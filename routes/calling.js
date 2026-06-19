const express = require('express');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const {
  isLeadCallable,
  normalizePhone,
} = require('../lib/calling');
const { enqueueAgentLaunchJob } = require('../lib/agentLaunch');

const router = express.Router();

async function getWorkspaceBundle(supabase, user) {
  const workspace = await getOrCreateWorkspace(supabase, user);

  const [
    { data: agentConfig, error: agentConfigError },
    { data: telephony, error: telephonyError },
    { data: voiceAgent, error: voiceAgentError },
    { data: launchJobs, error: launchJobsError },
  ] = await Promise.all([
    supabase.from('agent_configs').select('*').eq('workspace_id', workspace.id).maybeSingle(),
    supabase.from('workspace_telephony').select('*').eq('workspace_id', workspace.id).maybeSingle(),
    supabase.from('voice_agents').select('*').eq('workspace_id', workspace.id).maybeSingle(),
    supabase
      .from('ai_jobs')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('job_type', 'agent_launch')
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  if (agentConfigError) throw agentConfigError;
  if (telephonyError) throw telephonyError;
  if (voiceAgentError) throw voiceAgentError;
  if (launchJobsError) throw launchJobsError;

  return { workspace, agentConfig, telephony, voiceAgent, latestLaunchJob: launchJobs?.[0] || null };
}

function readiness({ workspace, agentConfig, telephony, voiceAgent }) {
  const checks = [
    { key: 'plan', label: 'Plan selected', ready: Boolean(workspace?.plan), reason: workspace?.plan ? null : 'Select a plan first' },
    { key: 'onboarding', label: 'Onboarding complete', ready: Boolean(workspace?.onboarding_completed), reason: workspace?.onboarding_completed ? null : 'Finish onboarding' },
    { key: 'prompt', label: 'Agent prompt ready', ready: Boolean(agentConfig?.system_prompt), reason: agentConfig?.system_prompt ? null : 'Agent prompt missing' },
    { key: 'retell', label: 'Retell agent ready', ready: voiceAgent?.status === 'ready' && Boolean(voiceAgent?.retell_agent_id), reason: voiceAgent?.last_error || 'Create Retell agent' },
    { key: 'number', label: 'Dedicated number attached', ready: ['attached', 'verified'].includes(telephony?.phone_number_status), reason: 'Attach workspace calling number' },
    { key: 'dnc', label: 'DNC gate enforced', ready: true, reason: null },
  ];

  return {
    checks,
    ready: checks.every(check => check.ready),
    callingEnabled: Boolean(telephony?.calling_enabled),
  };
}

router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const bundle = await getWorkspaceBundle(req.supabase, req.user);
    const { workspace } = bundle;

    const [
      { count: callableCount, error: callableError },
      { count: blockedCount, error: blockedError },
      { count: activeCalls, error: activeError },
      { data: calls, error: callsError },
    ] = await Promise.all([
      req.supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .or('voice_consent_status.eq.consented,dnc_status.eq.clear'),
      req.supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .not('status', 'eq', 'do_not_call')
        .not('voice_consent_status', 'eq', 'consented')
        .not('dnc_status', 'eq', 'clear'),
      req.supabase
        .from('calls')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .in('status', ['queued', 'calling', 'ringing', 'in_progress']),
      req.supabase
        .from('calls')
        .select('*, leads(full_name, company_name, phone), follow_ups(title), call_outcomes(outcome_type, confidence, next_action, meeting_requested), meetings(id, status, starts_at, booking_url)')
        .eq('workspace_id', workspace.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (callableError) throw callableError;
    if (blockedError) throw blockedError;
    if (activeError) throw activeError;
    if (callsError) throw callsError;

    return res.json({
      workspaceTelephony: bundle.telephony,
      voiceAgent: bundle.voiceAgent,
      latestLaunchJob: bundle.latestLaunchJob,
      readiness: readiness(bundle),
      queue: {
        callableLeads: callableCount || 0,
        blockedLeads: blockedCount || 0,
        activeCalls: activeCalls || 0,
      },
      calls: calls || [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load calling status' });
  }
});

router.post('/telephony', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const fromNumber = normalizePhone(req.body.from_number || req.body.retell_phone_number);

    if (!fromNumber) {
      return res.status(400).json({ error: 'A dedicated workspace phone number is required' });
    }

    const { data, error } = await req.supabase
      .from('workspace_telephony')
      .upsert({
        workspace_id: workspace.id,
        from_number: fromNumber,
        retell_phone_number: fromNumber,
        phone_number_status: 'attached',
        launch_notes: req.body.launch_notes || null,
        last_error: null,
      }, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ workspaceTelephony: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to attach telephony' });
  }
});

router.post('/provision-agent', async (req, res) => {
  try {
    const bundle = await getWorkspaceBundle(req.supabase, req.user);
    const { workspace, agentConfig } = bundle;

    if (!bundle.workspace?.onboarding_completed) {
      return res.status(400).json({ error: 'Complete onboarding before launching the agent' });
    }

    if (!agentConfig?.system_prompt) {
      return res.status(400).json({ error: 'Complete onboarding before creating a Retell agent' });
    }

    const job = await enqueueAgentLaunchJob({
      supabase: req.supabase,
      workspace,
      agentConfig,
      userId: req.user.id,
      source: req.body.source || 'calling-route',
    });

    return res.status(202).json({ job });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to launch AI agent' });
  }
});

router.post('/launch', async (req, res) => {
  try {
    const bundle = await getWorkspaceBundle(req.supabase, req.user);
    const state = readiness(bundle);
    const enable = req.body.enabled !== false;

    if (enable && !state.ready) {
      return res.status(400).json({
        error: 'Workspace is not ready for automatic calling',
        readiness: state,
      });
    }

    const { data, error } = await req.supabase
      .from('workspace_telephony')
      .upsert({
        workspace_id: bundle.workspace.id,
        calling_enabled: enable,
      }, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ workspaceTelephony: data, readiness: readiness({ ...bundle, telephony: data }) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update launch status' });
  }
});

router.post('/dnc/check', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const leadId = req.body.lead_id;
    const phone = normalizePhone(req.body.phone_e164 || req.body.phone);
    const manualStatus = req.body.status;

    if (!phone) return res.status(400).json({ error: 'Phone number is required for DNC check' });
    if (manualStatus && !['clear', 'blocked', 'pending', 'unknown', 'error'].includes(manualStatus)) {
      return res.status(400).json({ error: 'Invalid DNC status' });
    }

    const hasPdpcConfig = Boolean(process.env.PDPC_DNC_API_URL && process.env.PDPC_DNC_ACCOUNT_ID);
    const status = manualStatus || (hasPdpcConfig ? 'pending' : 'error');
    const errorMessage = manualStatus || hasPdpcConfig
      ? null
      : 'PDPC DNC API credentials are not configured; lead remains blocked until manually cleared or API is connected';

    const { data: dncCheck, error: dncError } = await req.supabase
      .from('dnc_checks')
      .insert({
        workspace_id: workspace.id,
        lead_id: leadId || null,
        phone_e164: phone,
        source: manualStatus ? 'manual' : 'pdpc_api',
        status,
        checked_at: manualStatus ? new Date().toISOString() : null,
        valid_until: manualStatus === 'clear' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
        error_message: errorMessage,
      })
      .select('*')
      .single();

    if (dncError) throw dncError;

    let lead = null;
    if (leadId) {
      const { data: updatedLead, error: leadError } = await req.supabase
        .from('leads')
        .update({
          phone_e164: phone,
          dnc_status: status,
          dnc_checked_at: manualStatus ? new Date().toISOString() : null,
          callable_block_reason: status === 'clear' ? null : errorMessage || 'Lead is not DNC-cleared',
        })
        .eq('id', leadId)
        .eq('workspace_id', workspace.id)
        .select('*')
        .single();

      if (leadError) throw leadError;
      lead = updatedLead;
    }

    return res.json({ dncCheck, lead });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to run DNC check' });
  }
});

router.post('/follow-ups/:followUpId/approve', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('follow_ups')
      .update({
        status: 'scheduled',
        due_at: req.body.due_at || null,
        owner_type: 'agent',
        approved_at: new Date().toISOString(),
        approved_by: req.user.id,
        blocked_reason: null,
      })
      .eq('id', req.params.followUpId)
      .eq('workspace_id', workspace.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ followUp: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to approve follow-up' });
  }
});

router.get('/calls', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('calls')
      .select('*, leads(full_name, company_name, phone), follow_ups(title), call_outcomes(outcome_type, confidence, next_action, meeting_requested), meetings(id, status, starts_at, booking_url)')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ calls: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load calls' });
  }
});

router.post('/leads/:leadId/voice-consent', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const status = req.body.voice_consent_status;
    if (!['unknown', 'consented', 'not_consented'].includes(status)) {
      return res.status(400).json({ error: 'Invalid voice consent status' });
    }

    const { data: lead, error } = await req.supabase
      .from('leads')
      .update({
        voice_consent_status: status,
        callable_block_reason: status === 'consented' ? null : 'Lead requires DNC clearance or explicit voice consent',
      })
      .eq('id', req.params.leadId)
      .eq('workspace_id', workspace.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ lead, eligibility: isLeadCallable(lead) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update voice consent' });
  }
});

module.exports = router;
