const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { getPreviewMessages, preGenerateStep1 } = require('../lib/emailSequence');
const { getEmailSendQueue } = require('../lib/redis');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { enrichOrganizationForPerson } = require('../lib/apollo');

const router = express.Router();

const DEFAULT_SEQUENCE_STEPS = [
  { step_number: 1, name: 'Intro', delay_days: 0 },
  { step_number: 2, name: 'Bump', delay_days: 3 },
  { step_number: 3, name: 'Breakup', delay_days: 7 },
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
        jobId: `send:${message.id}`,
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

const generateSchema = z.object({
  lead_ids: z.array(z.string().uuid()).default([]),
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

router.post('/:campaignId/generate', async (req, res) => {
  try {
    const parsed = generateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid generate payload',
        details: parsed.error.flatten(),
      });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: leads, error: leadError } = await req.supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id)
      .in('id', parsed.data.lead_ids);
    if (leadError) throw leadError;
    const eligible = (leads || []).filter(lead => ['ready', 'selected_for_campaign'].includes(lead.lifecycle_status) && lead.dnc_status !== 'blocked' && lead.email);
    if (eligible.length !== parsed.data.lead_ids.length) {
      return res.status(400).json({ error: 'Every selected lead must be ready, have an email, and not be suppressed' });
    }

    for (const lead of eligible) {
      if (lead.source !== 'apollo') continue;
      if (lead.company_data?.enrichment_source === 'apollo_organization') continue;
      const person = lead.raw_data?.apollo?.searchPerson;
      if (!person) continue;
      const companyData = await enrichOrganizationForPerson(person);
      const { error: enrichError } = await req.supabase.from('leads').update({
        company_data: {
          ...(lead.company_data || {}),
          ...(companyData || {}),
          enrichment_source: 'apollo_organization',
          enriched_at: new Date().toISOString(),
        },
      }).eq('id', lead.id);
      if (enrichError) throw enrichError;
    }

    if (eligible.length) {
      const { error: selectionError } = await req.supabase.from('campaign_leads').upsert(
        eligible.map(lead => ({ campaign_id: req.params.campaignId, lead_id: lead.id, workspace_id: workspace.id, selected_by: req.user.id })),
        { onConflict: 'campaign_id,lead_id' }
      );
      if (selectionError) throw selectionError;
      const { error: lifecycleError } = await req.supabase.from('leads').update({ lifecycle_status: 'selected_for_campaign' }).in('id', eligible.map(lead => lead.id));
      if (lifecycleError) throw lifecycleError;
    }
    const result = await preGenerateStep1({
      supabase: req.supabase,
      workspaceId: workspace.id,
      campaignId: req.params.campaignId,
      leadIds: parsed.data.lead_ids,
    });

    return res.json({ result });
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
      limit: 5,
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
      .in('status', ['draft', 'approved']);

    if (messageError) throw messageError;
    if (!messages?.length) {
      return res.status(400).json({ error: 'Generate step 1 emails before launching' });
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

    const messageIds = messages.map(message => message.id);
    const { error: updateMessagesError } = await req.supabase
      .from('messages')
      .update({
        status: 'approved',
        approved_by: req.user.id,
        approved_at: now,
      })
      .in('id', messageIds);

    if (updateMessagesError) throw updateMessagesError;

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
