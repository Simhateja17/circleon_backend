const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { draftReply } = require('../lib/gemini');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { createQueueJobId, getEmailSendQueue } = require('../lib/redis');

const router = express.Router();

const approveSchema = z.object({
  body: z.string().trim().min(1).optional(),
});

async function getAgentConfig(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getMessage(supabase, workspaceId, messageId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*, leads(*)')
    .eq('workspace_id', workspaceId)
    .eq('id', messageId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getConversationHistory(supabase, workspaceId, leadId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, direction, subject, body, draft_body, status, created_at')
    .eq('workspace_id', workspaceId)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('messages')
      .select('*, leads(full_name, company_name, title, email)')
      .eq('workspace_id', workspace.id)
      .in('status', ['received', 'pending_approval'])
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({ conversations: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load inbox' });
  }
});

router.get('/sent', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('messages')
      .select('*, leads(full_name, company_name, title, email), campaigns(name)')
      .eq('workspace_id', workspace.id)
      .eq('direction', 'outbound')
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    return res.json({ messages: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load sent mail' });
  }
});

router.get('/:leadId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: lead, error: leadError } = await req.supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', req.params.leadId)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const messages = await getConversationHistory(req.supabase, workspace.id, lead.id);

    return res.json({ lead, messages });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load conversation' });
  }
});

router.post('/messages/:messageId/approve', async (req, res) => {
  try {
    const parsed = approveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid approval payload',
        details: parsed.error.flatten(),
      });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const message = await getMessage(req.supabase, workspace.id, req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.direction !== 'inbound') return res.status(400).json({ error: 'Only inbound messages can be approved as replies' });
    if (message.response_message_id) return res.status(400).json({ error: 'A reply has already been queued for this message' });
    if (!message.campaign_id || !message.lead_id || !message.leads?.email) {
      return res.status(400).json({ error: 'This inbound message is not linked to a sendable campaign lead' });
    }

    const body = parsed.data.body || message.draft_body;
    if (!body) {
      return res.status(400).json({ error: 'Message has no draft body to approve' });
    }

    const replySubject = /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || 'Your email'}`;
    const now = new Date().toISOString();
    const { data: reply, error: replyError } = await req.supabase
      .from('messages')
      .insert({
        workspace_id: workspace.id,
        campaign_id: message.campaign_id,
        lead_id: message.lead_id,
        direction: 'outbound',
        subject: replySubject,
        body,
        in_reply_to_header: message.message_id_header || null,
        status: 'approved',
        approved_by: req.user.id,
        approved_at: now,
        approved_source: 'inbox',
        raw_payload: {
          kind: 'inbox_reply',
          inbound_message_id: message.id,
        },
      })
      .select('*')
      .single();

    if (replyError) throw replyError;

    const { error: inboundUpdateError } = await req.supabase
      .from('messages')
      .update({
        responded_at: now,
        response_message_id: reply.id,
      })
      .eq('id', message.id);
    if (inboundUpdateError) throw inboundUpdateError;

    const queue = getEmailSendQueue();
    await queue.add('send-inbox-reply', {
      workspaceId: workspace.id,
      campaignId: message.campaign_id,
      messageId: reply.id,
      leadId: message.lead_id,
      scheduledAt: now,
    }, { jobId: createQueueJobId('inbox-reply', reply.id) });

    return res.json({ message: reply });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to approve reply' });
  }
});

router.post('/messages/:messageId/regenerate', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const message = await getMessage(req.supabase, workspace.id, req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!message.lead_id) return res.status(400).json({ error: 'Message is not linked to a lead' });

    const [agentConfig, conversationHistory] = await Promise.all([
      getAgentConfig(req.supabase, workspace.id),
      getConversationHistory(req.supabase, workspace.id, message.lead_id),
    ]);

    if (!agentConfig) {
      return res.status(400).json({ error: 'Agent configuration is required before drafting replies' });
    }

    const body = await draftReply({
      lead: message.leads,
      inboundMessage: {
        subject: message.subject,
        body: message.body,
        intent: message.intent_classification,
      },
      conversationHistory,
      agentConfig,
    });

    const { data, error } = await req.supabase
      .from('messages')
      .update({
        draft_body: body,
        status: 'pending_approval',
      })
      .eq('id', message.id)
      .select('*')
      .single();

    if (error) throw error;

    return res.json({ message: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to regenerate reply' });
  }
});

router.post('/messages/:messageId/reject', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const message = await getMessage(req.supabase, workspace.id, req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const { data, error } = await req.supabase
      .from('messages')
      .update({
        status: 'rejected',
        draft_body: null,
      })
      .eq('id', message.id)
      .select('*')
      .single();

    if (error) throw error;

    return res.json({ message: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to reject reply' });
  }
});

module.exports = router;
