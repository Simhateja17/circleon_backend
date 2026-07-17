require('dotenv').config();

const { classifyIntent, draftReply } = require('../lib/gemini');
const { fetchUnseenMessages } = require('../lib/imap');
const { createServiceClient } = require('../lib/supabase');

function normalizeHeader(value) {
  return String(value || '').trim().replace(/^<|>$/g, '');
}

async function findOriginalMessage(service, workspaceId, parsed) {
  const candidates = [
    parsed.in_reply_to_header,
    ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references]),
  ]
    .filter(Boolean)
    .map(normalizeHeader);

  for (const candidate of candidates) {
    const { data, error } = await service
      .from('messages')
      .select('*')
      .eq('workspace_id', workspaceId)
      .ilike('message_id_header', `%${candidate}%`)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    if (data?.[0]) return data[0];
  }

  return null;
}

async function getConversationHistory(service, workspaceId, leadId) {
  const { data, error } = await service
    .from('messages')
    .select('direction, subject, body, draft_body, status, created_at')
    .eq('workspace_id', workspaceId)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function processInboundMessage(service, account, item, agentConfig) {
  const parsed = item.parsed;
  const original = await findOriginalMessage(service, account.workspace_id, parsed);
  if (!original?.lead_id) {
    return { matched: false };
  }

  const { data: lead, error: leadError } = await service
    .from('leads')
    .select('*')
    .eq('id', original.lead_id)
    .maybeSingle();

  if (leadError) throw leadError;
  if (!lead) return { matched: false };

  const intent = await classifyIntent({ inboundMessage: parsed });
  const isDnc = intent === 'dnc_request' || /\b(unsubscribe|stop|remove me|opt out)\b/i.test(parsed.body);
  const history = await getConversationHistory(service, account.workspace_id, lead.id);
  const replyDraft = isDnc
    ? ''
    : await draftReply({
        lead,
        inboundMessage: parsed,
        conversationHistory: history,
        agentConfig,
      });

  if (parsed.message_id_header) {
    const { data: duplicate, error: duplicateError } = await service
      .from('messages')
      .select('id')
      .eq('workspace_id', account.workspace_id)
      .eq('message_id_header', parsed.message_id_header)
      .maybeSingle();

    if (duplicateError) throw duplicateError;
    if (duplicate) return { matched: true, duplicate: true };
  }

  const { data: inbound, error: insertError } = await service
    .from('messages')
    .insert({
      workspace_id: account.workspace_id,
      campaign_id: original.campaign_id,
      lead_id: lead.id,
      direction: 'inbound',
      subject: parsed.subject,
      body: parsed.body,
      draft_body: replyDraft || null,
      message_id_header: parsed.message_id_header || null,
      in_reply_to_header: parsed.in_reply_to_header || null,
      status: isDnc ? 'received' : 'pending_approval',
      intent_classification: intent,
      raw_payload: {
        uid: item.uid,
        from_email: parsed.from_email,
        from_name: parsed.from_name,
        raw: parsed.raw,
      },
    })
    .select('*')
    .single();

  if (insertError) throw insertError;

  const leadPatch = {
    status: isDnc ? 'do_not_call' : 'contacted',
  };
  if (isDnc) {
    leadPatch.dnc_status = 'blocked';
    leadPatch.dnc_checked_at = new Date().toISOString();
    leadPatch.callable_block_reason = 'Opted out by email reply';
  }

  await service
    .from('leads')
    .update(leadPatch)
    .eq('id', lead.id)
    .throwOnError();

  if (isDnc) {
    await service.from('dnc_checks').insert({
      workspace_id: account.workspace_id,
      lead_id: lead.id,
      phone_e164: lead.phone_e164 || lead.phone || `email:${lead.email || lead.id}`,
      channel: 'email',
      source: 'manual',
      status: 'blocked',
      checked_at: new Date().toISOString(),
      raw_result: {
        reason: 'email_reply_opt_out',
        inbound_message_id: inbound.id,
        email: lead.email || parsed.from_email || null,
      },
    }).throwOnError();
  }

  return { matched: true, message: inbound };
}

async function pollWorkspaceInbox(service, account) {
  const { data: agentConfig, error: agentError } = await service
    .from('agent_configs')
    .select('*')
    .eq('workspace_id', account.workspace_id)
    .maybeSingle();

  if (agentError) throw agentError;
  if (!agentConfig) return { processed: 0, matched: 0 };

  const messages = await fetchUnseenMessages(account);
  let matched = 0;

  for (const item of messages) {
    const result = await processInboundMessage(service, account, item, agentConfig);
    if (result.matched) matched += 1;
  }

  return { processed: messages.length, matched };
}

async function pollAllInboxes() {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for inbox polling');

  const { data: accounts, error } = await service
    .from('connected_accounts')
    .select('*')
    .eq('provider', 'smtp')
    .eq('status', 'connected')
    .not('smtp_verified_at', 'is', null)
    .not('imap_verified_at', 'is', null);

  if (error) throw error;

  const results = [];
  for (const account of accounts || []) {
    try {
      results.push({
        workspace_id: account.workspace_id,
        ...(await pollWorkspaceInbox(service, account)),
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'poll_inbox_workspace_failed',
        workspaceId: account.workspace_id,
        error: error.message,
      }));
    }
  }

  return results;
}

function startPolling() {
  const intervalMs = Number(process.env.POLL_INBOX_INTERVAL_MS || 180000);

  const run = async () => {
    try {
      const results = await pollAllInboxes();
      console.info(JSON.stringify({ event: 'poll_inbox_completed', results }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'poll_inbox_failed', error: error.message }));
    }
  };

  run();
  return setInterval(run, intervalMs);
}

if (require.main === module) {
  startPolling();
}

module.exports = {
  pollAllInboxes,
  pollWorkspaceInbox,
  processInboundMessage,
  startPolling,
};
