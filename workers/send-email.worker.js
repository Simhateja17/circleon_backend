require('dotenv').config();

const { Worker } = require('bullmq');
const { createServiceClient } = require('../lib/supabase');
const { getRedisConnection } = require('../lib/redis');
const { getBilling, isActiveSubscription } = require('../lib/billing');
const { getAutopilotSettings, isCampaignIncluded } = require('../lib/autopilot');
const { completeCampaignIfFinished, isPermanentRecipientRejection, scheduleNextStep } = require('../lib/campaignFollowUps');
const { getEmailSendQueue } = require('../lib/redis');
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

  let sequence = null;
  // Direct replies are not campaign sequence steps, so sequence_step is null.
  // Avoid sending `eq.null` to PostgREST for an integer column.
  if (message.sequence_step !== null && message.sequence_step !== undefined) {
    const { data, error: sequenceError } = await service
      .from('email_sequences')
      .select('attachments')
      .eq('campaign_id', campaignId)
      .eq('step_number', message.sequence_step)
      .maybeSingle();
    if (sequenceError) throw sequenceError;
    sequence = data;
  }

  return { account, campaign, message, sequence };
}

async function processSendJob(job) {
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for email workers');

  const result = await sendJobMessage(job, service);
  // The email is already dealt with here, so a failed check must not retry the job.
  try {
    await completeCampaignIfFinished({ service, workspaceId: job.data.workspaceId, campaignId: job.data.campaignId });
  } catch (error) {
    console.error(JSON.stringify({ event: 'campaign_completion_check_failed', campaignId: job.data.campaignId, error: error.message }));
  }
  return result;
}

async function sendJobMessage(job, service) {

  const { account, campaign, message, sequence } = await loadSendContext(service, job);
  const lead = message.leads;
  const isInboxReply = ['inbox_reply', 'manual_reply'].includes(message.raw_payload?.kind);

  const billing = await getBilling(service, campaign.workspace_id);
  if (!isActiveSubscription(billing)) {
    return { skipped: true, reason: 'Subscription is not active' };
  }

  if (!isInboxReply && campaign.status !== 'active') {
    return { skipped: true, reason: 'Campaign is not active' };
  }

  if (!isInboxReply && campaign.autopilot_enabled) {
    const settings = await getAutopilotSettings(service, campaign.workspace_id);
    if (!settings.enabled || settings.paused_at || !isCampaignIncluded(settings, campaign)) {
      return { skipped: true, reason: 'Autopilot is paused for this campaign' };
    }
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
  if (!isInboxReply && inboundReplies?.length) {
    return { skipped: true, reason: 'Lead already replied' };
  }

  if (!['approved', 'draft'].includes(message.status)) {
    // A retry lands here if the send worked but scheduling the next step did not.
    if (message.status === 'sent' && !isInboxReply) await scheduleNextStep({ service, queue: getEmailSendQueue(), campaign, message });
    return { skipped: true, reason: `Message status is ${message.status}` };
  }

  const baseUrl = process.env.APP_PUBLIC_URL || process.env.API_PUBLIC_URL;
  if (!baseUrl) throw new Error('APP_PUBLIC_URL or API_PUBLIC_URL is required');

  const unsubscribeUrl = `${baseUrl.replace(/\/$/, '')}/api/emails/unsubscribe/${encodeURIComponent(lead.id)}`;
  const withFooter = isInboxReply
    ? message.body
    : appendUnsubscribeFooter(message.body, unsubscribeUrl, account.from_email);
  const html = isInboxReply
    ? textToHtml(withFooter)
    : appendTrackingPixel(textToHtml(withFooter), message.id);

  const attachments = [];
  if (!isInboxReply) {
    for (const attachment of sequence?.attachments || []) {
      const { data, error } = await service.storage
        .from('campaign-attachments')
        .download(attachment.storage_path);
      if (error) throw error;
      attachments.push({
        filename: attachment.filename,
        content: Buffer.from(await data.arrayBuffer()),
        contentType: attachment.mime_type,
      });
    }
  }

  const monthly = require('../lib/monthlyBilling');
  const usageKey = 'email:' + message.id;
  const reservation = await monthly.consumeUsage(service,campaign.workspace_id,'emails',1,usageKey);
  if(reservation?.duplicate) return {skipped:true,reason:'Email delivery already reserved; inspect before retrying'};
  const transport = createTransport(account);
  let sent;
  try { sent = await sendEmail({
    transport,
    from: fromHeader(account),
    to: lead.email,
    subject: message.subject,
    body: withFooter,
    html,
    replyTo: account.reply_to_email || account.from_email,
    inReplyTo: isInboxReply ? message.in_reply_to_header : undefined,
    references: isInboxReply ? message.in_reply_to_header : undefined,
    attachments,
  }); } catch(error) {
    await service.rpc('release_email_usage',{wid:campaign.workspace_id,usage_key:usageKey});
    if (!isInboxReply && isPermanentRecipientRejection(error)) {
      const { error: failedError } = await service.from('messages').update({
        status: 'failed',
        raw_payload: { ...(message.raw_payload || {}), smtp_error: String(error.response || error.message) },
      }).eq('id', message.id);
      if (failedError) throw failedError;
      return { skipped: true, reason: 'Recipient address was refused' };
    }
    throw error;
  }

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

  // The next step waits for its delay. When its job runs it is still stopped by
  // a reply, an opt-out, or a campaign or workspace pause.
  if (!isInboxReply) await scheduleNextStep({ service, queue: getEmailSendQueue(), campaign, message });

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
