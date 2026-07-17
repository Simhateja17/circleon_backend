require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection } = require('../lib/redis');
const {
  appendTrackingPixel,
  appendUnsubscribeFooter,
  createTransport,
  sendEmail,
  textToHtml,
} = require('../lib/smtp');

function fromHeader(account) {
  return account.from_name
    ? `"${account.from_name.replace(/"/g, '\\"')}" <${account.from_email}>`
    : account.from_email;
}

async function loadSendContext(service, job) {
  const { workspaceId, campaignId, messageId } = job.data;

  const { data: message, error: messageError } = await service
    .from('messages')
    .select('*, leads(*)')
    .eq('workspace_id', workspaceId)
    .eq('campaign_id', campaignId)
    .eq('id', messageId)
    .maybeSingle();

  if (messageError) throw messageError;
  if (!message) throw new Error('Message not found');

  const { data: account, error: accountError } = await service
    .from('connected_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider', 'smtp')
    .eq('status', 'connected')
    .not('smtp_verified_at', 'is', null)
    .not('imap_verified_at', 'is', null)
    .maybeSingle();

  if (accountError) throw accountError;
  if (!account) throw new Error('Connected SMTP account not found');

  const { data: campaign, error: campaignError } = await service
    .from('campaigns')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', campaignId)
    .maybeSingle();

  if (campaignError) throw campaignError;
  if (!campaign) throw new Error('Campaign not found');

  return { account, campaign, message };
}

async function processSendJob(job) {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for email workers');

  const { account, campaign, message } = await loadSendContext(service, job);
  const lead = message.leads;

  if (campaign.status !== 'active') {
    return { skipped: true, reason: 'Campaign is not active' };
  }

  if (!lead?.email) {
    throw new Error('Lead email is missing');
  }

  if (lead.status === 'do_not_call' || lead.dnc_status === 'blocked') {
    return { skipped: true, reason: 'Lead is blocked or unsubscribed' };
  }

  const { data: inboundReplies, error: inboundError } = await service
    .from('messages')
    .select('id')
    .eq('workspace_id', campaign.workspace_id)
    .eq('campaign_id', campaign.id)
    .eq('lead_id', lead.id)
    .eq('direction', 'inbound')
    .limit(1);

  if (inboundError) throw inboundError;
  if (inboundReplies?.length) {
    return { skipped: true, reason: 'Lead already replied' };
  }

  if (!['approved', 'draft'].includes(message.status)) {
    return { skipped: true, reason: `Message status is ${message.status}` };
  }

  const baseUrl = process.env.APP_PUBLIC_URL || process.env.API_PUBLIC_URL;
  if (!baseUrl) throw new Error('APP_PUBLIC_URL or API_PUBLIC_URL is required');

  const unsubscribeUrl = `${baseUrl.replace(/\/$/, '')}/api/emails/unsubscribe/${encodeURIComponent(lead.id)}`;
  const withFooter = appendUnsubscribeFooter(
    message.body,
    unsubscribeUrl,
    account.from_email
  );
  const html = appendTrackingPixel(textToHtml(withFooter), message.id);

  const transport = createTransport(account);
  const sent = await sendEmail({
    transport,
    from: fromHeader(account),
    to: lead.email,
    subject: message.subject,
    body: withFooter,
    html,
    replyTo: account.reply_to_email || account.from_email,
  });

  const { error } = await service
    .from('messages')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      message_id_header: sent.messageId || null,
      raw_payload: {
        ...(message.raw_payload || {}),
        smtp_response: sent.response || null,
      },
    })
    .eq('id', message.id);

  if (error) throw error;

  return {
    sent: true,
    messageId: message.id,
    providerMessageId: sent.messageId,
  };
}

function createWorker() {
  const worker = new Worker('email-send', processSendJob, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.EMAIL_SEND_WORKER_CONCURRENCY || 3),
  });

  worker.on('completed', job => {
    console.info(JSON.stringify({
      event: 'email_send_job_completed',
      jobId: job.id,
    }));
  });

  worker.on('failed', (job, error) => {
    console.error(JSON.stringify({
      event: 'email_send_job_failed',
      jobId: job?.id || null,
      error: error.message,
    }));
  });

  return worker;
}

if (require.main === module) {
  createWorker();
}

module.exports = {
  createWorker,
  processSendJob,
};
