const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { getPreviewMessages, preGenerateStep1, regenerateStep1Message } = require('../lib/emailSequence');
const { createQueueJobId, getEmailSendQueue } = require('../lib/redis');
const { getOrCreateWorkspace } = require('../lib/workspace');

const router = express.Router();

const DEFAULT_SEQUENCE_STEPS = [
  { step_number: 1, name: 'Intro', delay_days: 0, ai_instruction: 'Write a concise first touch. Use one factual, relevant company insight and invite a short conversation.' },
  { step_number: 2, name: 'Bump', delay_days: 3, ai_instruction: 'Write a brief follow-up that adds one useful angle without repeating the first email.' },
  { step_number: 3, name: 'Breakup', delay_days: 7, ai_instruction: 'Write a polite final follow-up with a low-pressure close.' },
];

function parseTime(value, fallbackHour) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!match) return { hour: fallbackHour, minute: 0 };
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function setTime(date, time) {
  const next = new Date(date);
  next.setHours(time.hour, time.minute, 0, 0);
  return next;
}

function nextAllowedSendAt(from, campaign, sentPerDay) {
  const activeDays = new Set(campaign.active_days || [1, 2, 3, 4, 5]);
  const dailyCap = Number(campaign.daily_send_cap || 100);
  const start = parseTime(campaign.sending_hours_start, 9);
  const end = parseTime(campaign.sending_hours_end, 18);
  let candidate = new Date(from);

  for (let guard = 0; guard < 370; guard += 1) {
    const dayKey = candidate.toISOString().slice(0, 10);
    const dayStart = setTime(candidate, start);
    const dayEnd = setTime(candidate, end);

    if (!activeDays.has(candidate.getDay()) || (sentPerDay.get(dayKey) || 0) >= dailyCap) {
      candidate = setTime(new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + 1), start);
      continue;
    }

    if (candidate < dayStart) return dayStart;
    if (candidate > dayEnd) {
      candidate = setTime(new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + 1), start);
      continue;
    }

    return candidate;
  }

  throw new Error('Unable to find an allowed send window for campaign');
}

function buildSendJobs({ messages, campaign, workspaceId, now = new Date() }) {
  const sentPerDay = new Map();
  const intervalMs = Math.ceil(3600000 / Number(campaign.cadence_per_hour || 25));
  let cursor = new Date(now);

  return messages.map(message => {
    const scheduledAt = nextAllowedSendAt(cursor, campaign, sentPerDay);
    const dayKey = scheduledAt.toISOString().slice(0, 10);
    sentPerDay.set(dayKey, (sentPerDay.get(dayKey) || 0) + 1);
    cursor = new Date(scheduledAt.getTime() + intervalMs);

    return {
      name: 'send-step',
      data: {
        workspaceId,
        campaignId: campaign.id,
        messageId: message.id,
        leadId: message.lead_id,
        sequenceStep: 1,
        scheduledAt: scheduledAt.toISOString(),
      },
      opts: {
        jobId: createQueueJobId('send', message.id),
        delay: Math.max(0, scheduledAt.getTime() - now.getTime()),
      },
    };
  });
}

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  lead_source: z.enum(['apollo', 'csv', 'manual']).default('manual'),
  import_run_id: z.string().uuid().nullable().optional(),
  sending_hours_start: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  sending_hours_end: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
  active_days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  daily_send_cap: z.number().int().min(1).max(500).default(100),
  cadence_per_hour: z.number().int().min(1).max(100).default(25),
});

const campaignLeadSchema = z.object({
  lead_ids: z.array(z.string().uuid()).max(1000),
});

const campaignUpdateSchema = campaignSchema.partial().omit({ import_run_id: true, lead_source: true });

const sequenceStepSchema = z.object({
  id: z.string().uuid().optional(),
  step_number: z.number().int().min(1).max(12),
  name: z.string().trim().min(1).max(80),
  delay_days: z.number().int().min(0).max(365),
  ai_instruction: z.string().trim().min(1).max(2000),
});

const sequenceSchema = z.object({
  steps: z.array(sequenceStepSchema).min(1).max(12),
});

const sendNowSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(500),
});

const messageEditSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
});

const approvalSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(500),
});

async function createDefaultSequence(req, campaignId) {
  const { data: existing, error: existingError } = await req.supabase
    .from('email_sequences')
    .select('id')
    .eq('campaign_id', campaignId)
    .limit(1);

  if (existingError) throw existingError;
  if (existing?.length) return;

  const { error } = await req.supabase
    .from('email_sequences')
    .insert(DEFAULT_SEQUENCE_STEPS.map(step => ({
      ...step,
      campaign_id: campaignId,
      status: 'draft',
    })));

  if (error) throw error;
}

async function loadCampaign(req, workspaceId, campaignId) {
  const { data, error } = await req.supabase
    .from('campaigns')
    .select('*, email_sequences(*)')
    .eq('workspace_id', workspaceId)
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function loadCampaignLeadIds(req, workspaceId, campaignId) {
  const { data, error } = await req.supabase
    .from('campaign_leads')
    .select('lead_id')
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId);
  if (error) throw error;
  return (data || []).map(row => row.lead_id);
}

async function restoreUnassignedLeadLifecycle(req, workspaceId, leadIds) {
  if (!leadIds.length) return;
  const { data: remaining, error: remainingError } = await req.supabase
    .from('campaign_leads')
    .select('lead_id')
    .eq('workspace_id', workspaceId)
    .in('lead_id', leadIds);
  if (remainingError) throw remainingError;
  const assigned = new Set((remaining || []).map(row => row.lead_id));
  const unassigned = leadIds.filter(id => !assigned.has(id));
  if (!unassigned.length) return;
  const { error } = await req.supabase
    .from('leads')
    .update({ lifecycle_status: 'ready' })
    .eq('workspace_id', workspaceId)
    .eq('lifecycle_status', 'selected_for_campaign')
    .in('id', unassigned);
  if (error) throw error;
}

function leadBlockReason(lead) {
  if (!lead) return 'Lead was not found in this workspace';
  if (lead.dnc_status === 'blocked' || lead.lifecycle_status === 'suppressed') return 'Lead is suppressed and cannot be contacted';
  if (!lead.email) return 'Lead does not have a verified work email';
  if (!['ready', 'selected_for_campaign'].includes(lead.lifecycle_status)) return 'Lead is not ready for a campaign yet';
  return null;
}

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('campaigns')
      .select('*, email_sequences(*)')
      .eq('workspace_id', workspace.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return res.json({ campaigns: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load campaigns' });
  }
});

router.post('/', async (req, res) => {
  try {
    const parsed = campaignSchema.safeParse(req.body.campaign || req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid campaign payload',
        details: parsed.error.flatten(),
      });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const payload = parsed.data;
    const { data: campaign, error } = await req.supabase
      .from('campaigns')
      .insert({
        ...payload,
        import_run_id: payload.import_run_id || null,
        workspace_id: workspace.id,
        channel: 'email',
        status: 'draft',
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (error) throw error;

    await createDefaultSequence(req, campaign.id);
    const savedCampaign = await loadCampaign(req, workspace.id, campaign.id);

    return res.status(201).json({ campaign: savedCampaign });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create campaign' });
  }
});

router.get('/:campaignId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    return res.json({ campaign });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load campaign' });
  }
});

router.patch('/:campaignId', async (req, res) => {
  try {
    const parsed = campaignUpdateSchema.safeParse(req.body?.campaign || req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign settings', details: parsed.error.flatten() });
    if (!Object.keys(parsed.data).length) return res.status(400).json({ error: 'Provide at least one campaign setting to update' });
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused'].includes(campaign.status)) return res.status(400).json({ error: 'Pause the campaign before changing its settings' });
    const { data, error } = await req.supabase.from('campaigns').update(parsed.data)
      .eq('workspace_id', workspace.id).eq('id', campaign.id).select('*').single();
    if (error) throw error;
    return res.json({ campaign: await loadCampaign(req, workspace.id, data.id) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update campaign settings' });
  }
});

router.get('/:campaignId/leads', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const leadIds = await loadCampaignLeadIds(req, workspace.id, campaign.id);
    return res.json({ lead_ids: leadIds });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load campaign leads' });
  }
});

router.put('/:campaignId/leads', async (req, res) => {
  try {
    const parsed = campaignLeadSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid campaign leads payload', details: parsed.error.flatten() });

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Pause the campaign before changing its selected leads' });
    }

    const requestedIds = [...new Set(parsed.data.lead_ids)];
    let leads = [];
    if (requestedIds.length) {
      const { data, error } = await req.supabase
        .from('leads')
        .select('id, email, lifecycle_status, dnc_status')
        .eq('workspace_id', workspace.id)
        .in('id', requestedIds);
      if (error) throw error;
      leads = data || [];
    }
    const leadsById = new Map(leads.map(lead => [lead.id, lead]));
    const ineligible = requestedIds
      .map(leadId => ({ leadId, reason: leadBlockReason(leadsById.get(leadId)) }))
      .filter(item => item.reason);
    if (ineligible.length) {
      return res.status(400).json({
        error: ineligible.length === 1 ? ineligible[0].reason : `${ineligible.length} selected leads cannot be added to this campaign`,
        details: ineligible,
      });
    }

    const existingIds = await loadCampaignLeadIds(req, workspace.id, campaign.id);
    const requested = new Set(requestedIds);
    const removedIds = existingIds.filter(id => !requested.has(id));
    if (removedIds.length) {
      const { error } = await req.supabase
        .from('campaign_leads')
        .delete()
        .eq('workspace_id', workspace.id)
        .eq('campaign_id', campaign.id)
        .in('lead_id', removedIds);
      if (error) throw error;
    }
    if (requestedIds.length) {
      const { error } = await req.supabase.from('campaign_leads').upsert(
        requestedIds.map(leadId => ({ campaign_id: campaign.id, lead_id: leadId, workspace_id: workspace.id, selected_by: req.user.id })),
        { onConflict: 'campaign_id,lead_id' }
      );
      if (error) throw error;
      const { error: lifecycleError } = await req.supabase
        .from('leads')
        .update({ lifecycle_status: 'selected_for_campaign' })
        .eq('workspace_id', workspace.id)
        .in('id', requestedIds);
      if (lifecycleError) throw lifecycleError;
    }
    await restoreUnassignedLeadLifecycle(req, workspace.id, removedIds);
    return res.json({ lead_ids: requestedIds });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update campaign leads' });
  }
});

router.put('/:campaignId/sequences', async (req, res) => {
  try {
    const parsed = sequenceSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid sequence payload', details: parsed.error.flatten() });

    const stepNumbers = parsed.data.steps.map(step => step.step_number);
    if (new Set(stepNumbers).size !== stepNumbers.length) {
      return res.status(400).json({ error: 'Each sequence step needs a unique step number' });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Pause the campaign before changing its sequence' });
    }

    const nextSteps = [...parsed.data.steps].sort((a, b) => a.step_number - b.step_number);
    const existingSteps = campaign.email_sequences || [];
    const retainedNumbers = new Set(nextSteps.map(step => step.step_number));
    const removedNumbers = existingSteps.map(step => step.step_number).filter(number => !retainedNumbers.has(number));

    if (removedNumbers.length) {
      const { error: messageError } = await req.supabase
        .from('messages')
        .delete()
        .eq('workspace_id', workspace.id)
        .eq('campaign_id', campaign.id)
        .eq('direction', 'outbound')
        .in('sequence_step', removedNumbers)
        .in('status', ['draft', 'pending_approval', 'approved']);
      if (messageError) throw messageError;

      const { error: sequenceError } = await req.supabase
        .from('email_sequences')
        .delete()
        .eq('campaign_id', campaign.id)
        .in('step_number', removedNumbers);
      if (sequenceError) throw sequenceError;
    }

    const { error } = await req.supabase
      .from('email_sequences')
      .upsert(nextSteps.map(step => ({
        campaign_id: campaign.id,
        step_number: step.step_number,
        name: step.name,
        delay_days: step.delay_days,
        ai_instruction: step.ai_instruction,
        status: 'draft',
      })), { onConflict: 'campaign_id,step_number' });
    if (error) throw error;

    return res.json({ campaign: await loadCampaign(req, workspace.id, campaign.id), removed_steps: removedNumbers });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update campaign sequence' });
  }
});

router.post('/:campaignId/generate', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Pause the campaign before generating additional emails' });
    }
    const selectedLeadIds = await loadCampaignLeadIds(req, workspace.id, campaign.id);
    if (!selectedLeadIds.length) return res.status(400).json({ error: 'Select at least one lead for this campaign before generating' });
    const { data: leads, error: leadError } = await req.supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id)
      .in('id', selectedLeadIds);
    if (leadError) throw leadError;
    const leadsById = new Map((leads || []).map(lead => [lead.id, lead]));
    const blocked = selectedLeadIds
      .map(leadId => ({ lead_id: leadId, reason: leadBlockReason(leadsById.get(leadId)) }))
      .filter(item => item.reason);
    const eligibleLeadIds = selectedLeadIds.filter(leadId => !blocked.some(item => item.lead_id === leadId));
    if (!eligibleLeadIds.length) {
      return res.status(400).json({ error: 'No selected leads are ready with a verified work email', blocked });
    }

    const result = await preGenerateStep1({
      supabase: req.supabase,
      workspaceId: workspace.id,
      campaignId: campaign.id,
      leadIds: eligibleLeadIds,
    });
    const [savedCampaign, messages] = await Promise.all([
      loadCampaign(req, workspace.id, campaign.id),
      getPreviewMessages({ supabase: req.supabase, workspaceId: workspace.id, campaignId: campaign.id, limit: 100 }),
    ]);
    return res.json({ campaign: savedCampaign, messages, result: { ...result, blocked } });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to generate campaign emails' });
  }
});

router.get('/:campaignId/preview', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const messages = await getPreviewMessages({
      supabase: req.supabase,
      workspaceId: workspace.id,
      campaignId: req.params.campaignId,
      limit: 100,
    });

    return res.json({ messages });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load campaign preview' });
  }
});

router.get('/:campaignId/messages', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('messages')
      .select('*, leads(full_name, company_name, title, email)')
      .eq('workspace_id', workspace.id)
      .eq('campaign_id', req.params.campaignId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ messages: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load campaign messages' });
  }
});

router.post('/:campaignId/messages/approve-batch', async (req, res) => {
  try {
    const parsed = approvalSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Select at least one draft to approve', details: parsed.error.flatten() });
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const ids = [...new Set(parsed.data.message_ids)];
    const { data: messages, error: messageError } = await req.supabase.from('messages')
      .select('id, status, direction').eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).in('id', ids);
    if (messageError) throw messageError;
    const approvable = (messages || []).filter(message => message.direction === 'outbound' && message.status === 'draft');
    if (approvable.length !== ids.length) return res.status(400).json({ error: 'Only unsent outbound drafts can be approved' });
    const now = new Date().toISOString();
    const { data, error } = await req.supabase.from('messages').update({
      status: 'approved', approved_by: req.user.id, approved_at: now, approved_source: 'batch',
    }).in('id', ids).select('*');
    if (error) throw error;
    return res.json({ approved: data?.length || 0, messages: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to approve campaign emails' });
  }
});

router.post('/:campaignId/messages/send-now', async (req, res) => {
  try {
    const parsed = sendNowSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Select at least one email to send', details: parsed.error.flatten() });

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const messageIds = [...new Set(parsed.data.message_ids)];
    const [campaign, accountResult, messagesResult] = await Promise.all([
      loadCampaign(req, workspace.id, req.params.campaignId),
      req.supabase.from('connected_accounts').select('id, status, smtp_verified_at, imap_verified_at').eq('workspace_id', workspace.id).eq('provider', 'smtp').maybeSingle(),
      req.supabase.from('messages').select('id, lead_id, status, direction, sequence_step, leads(email, dnc_status, status)').eq('workspace_id', workspace.id).eq('campaign_id', req.params.campaignId).in('id', messageIds),
    ]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'active') return res.status(400).json({ error: 'Launch the campaign before sending emails immediately' });
    if (accountResult.error) throw accountResult.error;
    const account = accountResult.data;
    if (!account || account.status !== 'connected' || !account.smtp_verified_at || !account.imap_verified_at) {
      return res.status(400).json({ error: 'Connect and verify both SMTP and IMAP before sending' });
    }
    if (messagesResult.error) throw messagesResult.error;
    const messages = messagesResult.data || [];
    const sendable = messages.filter(message => (
      message.direction === 'outbound'
      && message.sequence_step === 1
      && message.status === 'approved'
      && message.leads?.email
      && message.leads?.dnc_status !== 'blocked'
      && message.leads?.status !== 'do_not_call'
    ));
    if (sendable.length !== messageIds.length) {
      return res.status(400).json({ error: 'Every selected email must still be an eligible, unsent first-step campaign email' });
    }
    const now = new Date().toISOString();
    const queue = getEmailSendQueue();
    await queue.addBulk(sendable.map(message => ({
      name: 'send-step',
      data: {
        workspaceId: workspace.id,
        campaignId: campaign.id,
        messageId: message.id,
        leadId: message.lead_id,
        sequenceStep: 1,
        scheduledAt: now,
      },
      opts: { jobId: createQueueJobId('send-now', message.id) },
    })));
    return res.json({ queued: sendable.length, message_ids: sendable.map(message => message.id) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to queue the selected emails' });
  }
});

router.patch('/:campaignId/messages/:messageId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const parsed = messageEditSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid email content' });
    const { data: message, error: messageError } = await req.supabase
      .from('messages')
      .select('id, status, direction')
      .eq('workspace_id', workspace.id)
      .eq('campaign_id', req.params.campaignId)
      .eq('id', req.params.messageId)
      .maybeSingle();
    if (messageError) throw messageError;
    if (!message || message.direction !== 'outbound') return res.status(404).json({ error: 'Campaign email not found' });
    if (!['draft', 'approved'].includes(message.status)) return res.status(400).json({ error: `This email cannot be edited because it is ${message.status}` });
    const { data: updated, error: updateError } = await req.supabase
      .from('messages')
      .update({
        subject: parsed.data.subject,
        body: parsed.data.body,
        status: 'draft',
        approved_by: null,
        approved_at: null,
        manually_edited_at: new Date().toISOString(),
        manually_edited_by: req.user.id,
      })
      .eq('id', message.id)
      .select()
      .maybeSingle();
    if (updateError) throw updateError;
    return res.json({ message: updated });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update the email' });
  }
});

router.post('/:campaignId/messages/:messageId/regenerate', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused'].includes(campaign.status)) return res.status(400).json({ error: 'Pause the campaign before regenerating a draft' });
    const message = await regenerateStep1Message({
      supabase: req.supabase, workspaceId: workspace.id, campaignId: campaign.id, messageId: req.params.messageId,
    });
    return res.json({ message });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to regenerate the campaign email' });
  }
});

router.post('/:campaignId/messages/:messageId/send-now', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const [campaign, accountResult, messageResult] = await Promise.all([
      loadCampaign(req, workspace.id, req.params.campaignId),
      req.supabase.from('connected_accounts').select('id, status, smtp_verified_at, imap_verified_at').eq('workspace_id', workspace.id).eq('provider', 'smtp').maybeSingle(),
      req.supabase.from('messages').select('id, lead_id, status, direction, sequence_step, leads(email, dnc_status, status)').eq('workspace_id', workspace.id).eq('campaign_id', req.params.campaignId).eq('id', req.params.messageId).maybeSingle(),
    ]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'active') return res.status(400).json({ error: 'Launch the campaign before sending an email immediately' });
    if (accountResult.error) throw accountResult.error;
    const account = accountResult.data;
    if (!account || account.status !== 'connected' || !account.smtp_verified_at || !account.imap_verified_at) {
      return res.status(400).json({ error: 'Connect and verify both SMTP and IMAP before sending' });
    }
    if (messageResult.error) throw messageResult.error;
    const message = messageResult.data;
    if (!message || message.direction !== 'outbound' || message.sequence_step !== 1) return res.status(404).json({ error: 'Campaign email not found' });
    if (message.status !== 'approved') return res.status(400).json({ error: `Approve this email before sending it; it is currently ${message.status}` });
    if (!message.leads?.email || message.leads?.dnc_status === 'blocked' || message.leads?.status === 'do_not_call') {
      return res.status(400).json({ error: 'This lead cannot receive email' });
    }
    const now = new Date().toISOString();
    const queue = getEmailSendQueue();
    await queue.add('send-step', {
      workspaceId: workspace.id,
      campaignId: campaign.id,
      messageId: message.id,
      leadId: message.lead_id,
      sequenceStep: 1,
      scheduledAt: now,
    }, { jobId: createQueueJobId('send-now', message.id) });
    return res.json({ queued: true, message_id: message.id });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to queue the immediate email' });
  }
});

router.post('/:campaignId/launch', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);

    const { data: account, error: accountError } = await req.supabase
      .from('connected_accounts')
      .select('id, status, smtp_verified_at, imap_verified_at')
      .eq('workspace_id', workspace.id)
      .eq('provider', 'smtp')
      .maybeSingle();

    if (accountError) throw accountError;
    if (!account || account.status !== 'connected' || !account.smtp_verified_at || !account.imap_verified_at) {
      return res.status(400).json({ error: 'Connect and verify both SMTP and IMAP before launching a campaign' });
    }

    const { data: campaign, error: campaignError } = await req.supabase
      .from('campaigns')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.campaignId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Only draft or paused campaigns can be launched' });
    }

    const { data: messages, error: messageError } = await req.supabase
      .from('messages')
      .select('id, lead_id')
      .eq('workspace_id', workspace.id)
      .eq('campaign_id', campaign.id)
      .eq('direction', 'outbound')
      .eq('sequence_step', 1)
      .eq('status', 'approved');

    if (messageError) throw messageError;
    if (!messages?.length) {
      return res.status(400).json({ error: 'Approve at least one generated email before launching' });
    }

    const now = new Date().toISOString();
    const { data: updatedCampaign, error: updateCampaignError } = await req.supabase
      .from('campaigns')
      .update({
        status: 'active',
        launched_at: campaign.launched_at || now,
      })
      .eq('id', campaign.id)
      .select('*')
      .single();

    if (updateCampaignError) throw updateCampaignError;

    const queue = getEmailSendQueue();
    await queue.addBulk(buildSendJobs({
      messages,
      campaign: updatedCampaign,
      workspaceId: workspace.id,
      now: new Date(now),
    }));

    return res.json({
      campaign: updatedCampaign,
      queued: messages.length,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to launch campaign' });
  }
});

router.post('/:campaignId/pause', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('campaigns')
      .update({ status: 'paused' })
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.campaignId)
      .select('*')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Campaign not found' });

    return res.json({ campaign: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to pause campaign' });
  }
});

router.post('/:campaignId/resume', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('campaigns')
      .update({ status: 'active' })
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.campaignId)
      .in('status', ['paused'])
      .select('*')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Paused campaign not found' });

    return res.json({ campaign: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to resume campaign' });
  }
});

module.exports = router;
module.exports.buildSendJobs = buildSendJobs;
