const { createQueueJobId } = require('./redis');

function parseTime(value, fallbackHour) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!match) return { hour: fallbackHour, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day, hour: Number(parts.hour), minute: Number(parts.minute), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function localDateTimeToUtc(parts, timezone) {
  let candidate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(candidate, timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    candidate = new Date(candidate.getTime() + (target - actualAsUtc));
  }
  return candidate;
}

function nextLocalDate(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDayKey(date, timezone) {
  const local = zonedParts(date, timezone);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

function nextAllowedSendAt(from, campaign, sentPerDay) {
  const timezone = campaign.timezone || 'Asia/Singapore';
  const activeDays = new Set(campaign.active_days || [1, 2, 3, 4, 5]);
  const dailyCap = Number(campaign.daily_send_cap || 50);
  const start = parseTime(campaign.sending_hours_start, 9);
  const end = parseTime(campaign.sending_hours_end, 18);
  let candidate = new Date(from);

  for (let guard = 0; guard < 370; guard += 1) {
    const local = zonedParts(candidate, timezone);
    const dayKey = localDayKey(candidate, timezone);
    const localDay = { year: local.year, month: local.month, day: local.day };
    const dayStart = localDateTimeToUtc({ ...localDay, ...start }, timezone);
    const dayEnd = localDateTimeToUtc({ ...localDay, ...end }, timezone);
    if (!activeDays.has(local.weekday) || (sentPerDay.get(dayKey) || 0) >= dailyCap) {
      candidate = localDateTimeToUtc({ ...nextLocalDate(localDay), ...start }, timezone);
      continue;
    }
    if (candidate < dayStart) return dayStart;
    if (candidate > dayEnd) {
      candidate = localDateTimeToUtc({ ...nextLocalDate(localDay), ...start }, timezone);
      continue;
    }
    return candidate;
  }
  throw new Error('Unable to find an allowed send window for campaign');
}

async function existingScheduledCounts(supabase, campaign, from) {
  const { data, error } = await supabase.from('messages')
    .select('scheduled_at')
    .eq('campaign_id', campaign.id)
    .eq('direction', 'outbound')
    .in('status', ['draft', 'approved'])
    .not('scheduled_at', 'is', null)
    .gte('scheduled_at', from.toISOString());
  if (error) throw error;
  const counts = new Map();
  for (const message of data || []) {
    const key = localDayKey(new Date(message.scheduled_at), campaign.timezone || 'Asia/Singapore');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

async function workspaceScheduledCounts(supabase, workspaceId, timezone, from) {
  const [{ data: settings, error: settingsError }, { data: messages, error: messagesError }] = await Promise.all([
    supabase.from('workspace_autopilot_settings').select('workspace_daily_send_cap').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('messages').select('scheduled_at').eq('workspace_id', workspaceId).eq('direction', 'outbound').in('status', ['draft', 'approved']).not('scheduled_at', 'is', null).gte('scheduled_at', from.toISOString()),
  ]);
  if (settingsError || messagesError) throw settingsError || messagesError;
  const counts = new Map();
  for (const message of messages || []) {
    const key = localDayKey(new Date(message.scheduled_at), timezone);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { cap: Number(settings?.workspace_daily_send_cap || Number.MAX_SAFE_INTEGER), counts };
}

async function scheduleMessages({ supabase, queue, workspaceId, campaign, messages, now = new Date(), reason = 'Campaign schedule' }) {
  if (!messages.length) return [];
  const [sentPerDay, workspaceSchedule] = await Promise.all([
    existingScheduledCounts(supabase, campaign, now),
    workspaceScheduledCounts(supabase, workspaceId, campaign.timezone || 'Asia/Singapore', now),
  ]);
  const intervalMs = Math.ceil(3600000 / Number(campaign.cadence_per_hour || 25));
  let cursor = new Date(now);
  const jobs = [];
  const updates = [];
  for (const message of messages) {
    let scheduledAt = nextAllowedSendAt(cursor, campaign, sentPerDay);
    let workspaceKey = localDayKey(scheduledAt, campaign.timezone || 'Asia/Singapore');
    while ((workspaceSchedule.counts.get(workspaceKey) || 0) >= workspaceSchedule.cap) {
      scheduledAt = nextAllowedSendAt(new Date(scheduledAt.getTime() + 24 * 60 * 60 * 1000), campaign, sentPerDay);
      workspaceKey = localDayKey(scheduledAt, campaign.timezone || 'Asia/Singapore');
    }
    const key = localDayKey(scheduledAt, campaign.timezone || 'Asia/Singapore');
    sentPerDay.set(key, (sentPerDay.get(key) || 0) + 1);
    workspaceSchedule.counts.set(workspaceKey, (workspaceSchedule.counts.get(workspaceKey) || 0) + 1);
    cursor = new Date(scheduledAt.getTime() + intervalMs);
    updates.push({ id: message.id, scheduled_at: scheduledAt.toISOString(), schedule_reason: reason });
    jobs.push({
      name: 'send-step',
      data: { workspaceId, campaignId: campaign.id, messageId: message.id, leadId: message.lead_id, sequenceStep: message.sequence_step, scheduledAt: scheduledAt.toISOString() },
      opts: { jobId: createQueueJobId('send', message.id), delay: Math.max(0, scheduledAt.getTime() - now.getTime()) },
    });
  }
  for (const update of updates) {
    const { error } = await supabase.from('messages').update({ scheduled_at: update.scheduled_at, schedule_reason: update.schedule_reason }).eq('id', update.id);
    if (error) throw error;
  }
  await queue.addBulk(jobs);
  return jobs;
}

module.exports = { nextAllowedSendAt, scheduleMessages, zonedParts, localDayKey };
