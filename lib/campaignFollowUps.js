const { scheduleMessages } = require('./campaignScheduling');
const { createQueueJobId } = require('./redis');
const { getAutopilotSettings, isCampaignIncluded } = require('./autopilot');

const DAY_MS = 24 * 60 * 60 * 1000;
const SENT_STATUSES = new Set(['sent', 'auto_sent']);
const PAGE_SIZE = 1000;

// Unattended campaigns send their drafts; everyone else only sends what they approved.
function sendableStatuses(campaign) {
  return campaign.autopilot_enabled ? ['draft', 'approved'] : ['approved'];
}

// A lead is finished once they replied, booked a meeting or opted out, once a step was refused or
// left unapproved, or once every step has gone out. Otherwise their first unsent
// step is what still has to send.
function pendingSteps(messages, { allowedStatuses }) {
  const byLead = new Map();
  const droppedLeads = new Set();
  for (const message of messages) {
    if (!message.lead_id) continue;
    if (message.direction === 'inbound' || message.leads?.dnc_status === 'blocked' || message.leads?.status === 'do_not_call' || message.leads?.meetings?.some(meeting => meeting.status === 'scheduled')) {
      droppedLeads.add(message.lead_id);
    }
    if (message.direction !== 'outbound' || message.sequence_step === null || message.sequence_step === undefined) continue;
    if (!byLead.has(message.lead_id)) byLead.set(message.lead_id, []);
    byLead.get(message.lead_id).push(message);
  }

  const pending = [];
  for (const [leadId, steps] of byLead) {
    if (droppedLeads.has(leadId)) continue;
    steps.sort((a, b) => a.sequence_step - b.sequence_step);
    const next = steps.findIndex(step => !SENT_STATUSES.has(step.status));
    if (next === -1 || !allowedStatuses.includes(steps[next].status)) continue;
    pending.push({ message: steps[next], previous: steps[next - 1] || null });
  }
  return pending;
}

function isCampaignFinished(messages, options) {
  const anySent = messages.some(message => message.direction === 'outbound' && SENT_STATUSES.has(message.status));
  return anySent && pendingSteps(messages, options).length === 0;
}

async function loadCampaignMessages(db, campaign) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db.from('messages')
      .select('id, lead_id, sequence_step, status, direction, scheduled_at, sent_at, leads(dnc_status, status, meetings(status))')
      .eq('workspace_id', campaign.workspace_id)
      .eq('campaign_id', campaign.id)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

// Called after a step sends. It only picks up a step with no send time, so a
// retried job cannot schedule the same follow-up twice.
async function scheduleNextStep({ service, queue, campaign, message }) {
  const nextStep = Number(message.sequence_step || 0) + 1;
  const [{ data: nextMessage, error: messageError }, { data: sequence, error: sequenceError }] = await Promise.all([
    service.from('messages').select('id, lead_id, sequence_step')
      .eq('workspace_id', campaign.workspace_id).eq('campaign_id', campaign.id).eq('lead_id', message.lead_id)
      .eq('direction', 'outbound').eq('sequence_step', nextStep)
      .in('status', sendableStatuses(campaign)).is('scheduled_at', null).maybeSingle(),
    service.from('email_sequences').select('delay_days').eq('campaign_id', campaign.id).eq('step_number', nextStep).maybeSingle(),
  ]);
  if (messageError || sequenceError) throw messageError || sequenceError;
  if (!nextMessage || !sequence) return [];
  return scheduleMessages({
    supabase: service,
    queue,
    workspaceId: campaign.workspace_id,
    campaign,
    messages: [nextMessage],
    now: new Date(Date.now() + Math.max(0, Number(sequence.delay_days || 0)) * DAY_MS),
    reason: `Sequence step ${nextStep}`,
  });
}

// A job that comes due during a pause is skipped and gone, so resuming has to
// queue those steps again. First steps that were never scheduled are left out:
// those are newly approved and still wait for Launch.
async function requeuePendingSteps({ db, queue, campaign, now = new Date() }) {
  const messages = await loadCampaignMessages(db, campaign);
  const pending = pendingSteps(messages, { allowedStatuses: sendableStatuses(campaign) })
    .filter(({ message, previous }) => {
      if (message.scheduled_at) return new Date(message.scheduled_at) <= now;
      return Boolean(previous);
    });
  if (!pending.length) return 0;

  const { data: sequences, error } = await db.from('email_sequences').select('step_number, delay_days').eq('campaign_id', campaign.id);
  if (error) throw error;
  const delayDays = new Map((sequences || []).map(step => [step.step_number, Number(step.delay_days || 0)]));

  const ready = [];
  const later = [];
  for (const { message, previous } of pending) {
    const sentAt = previous?.sent_at ? new Date(previous.sent_at).getTime() : 0;
    const due = sentAt + (delayDays.get(message.sequence_step) || 0) * DAY_MS;
    if (due > now.getTime()) later.push({ message, due: new Date(due) });
    else ready.push(message);
    // Finished jobs stay in Redis, and a job with the same id would not be added again.
    const stale = await queue.getJob(createQueueJobId('send', message.id));
    if (stale) await stale.remove().catch(() => {});
  }

  const reason = 'Campaign resumed';
  await scheduleMessages({ supabase: db, queue, workspaceId: campaign.workspace_id, campaign, messages: ready, now, reason });
  for (const { message, due } of later) {
    await scheduleMessages({ supabase: db, queue, workspaceId: campaign.workspace_id, campaign, messages: [message], now: due, reason });
  }
  return pending.length;
}

async function completeCampaignIfFinished({ service, workspaceId, campaignId }) {
  const { data: campaign, error } = await service.from('campaigns').select('*').eq('workspace_id', workspaceId).eq('id', campaignId).maybeSingle();
  if (error) throw error;
  if (!campaign || campaign.status !== 'active' || campaign.channel === 'voice' || campaign.autopilot_enabled) return false;

  // Autopilot keeps adding leads to the campaigns it includes, so those never finish.
  const settings = await getAutopilotSettings(service, workspaceId);
  if (settings.enabled && isCampaignIncluded(settings, campaign)) return false;

  const messages = await loadCampaignMessages(service, campaign);
  if (!isCampaignFinished(messages, { allowedStatuses: sendableStatuses(campaign) })) return false;

  const { error: updateError } = await service.from('campaigns')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', campaign.id)
    .eq('status', 'active');
  if (updateError) throw updateError;
  return true;
}

// Only a mail server refusing this address is final. Auth, connection and quota
// failures also affect every other lead, so those stay retryable.
function isPermanentRecipientRejection(error) {
  return error?.code === 'EENVELOPE' && Array.isArray(error.rejected) && error.rejected.length > 0
    && /\b5\.1\.(1|2|3|10)\b/.test(String(error.response || ''));
}

module.exports = {
  completeCampaignIfFinished,
  isCampaignFinished,
  isPermanentRecipientRejection,
  pendingSteps,
  requeuePendingSteps,
  scheduleNextStep,
  sendableStatuses,
};
