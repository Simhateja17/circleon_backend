// CircleOn's own calendar: the meetings table, shown on the Meetings page.
//
// Open times come from the campaign's calling hours and days, minus what is
// already booked in the workspace. The agent reads these aloud, so this returns
// a handful rather than every free slot.

const { localDateTimeToUtc, zonedParts } = require('./campaignScheduling');

const SLOT_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// A slot held by one of these cannot be offered to anyone else.
const HOLDING_STATUSES = ['requested', 'scheduled'];

function inHouseBookingLink(workspace) {
  const base = (process.env.FRONTEND_URL || 'https://circleon.ai').replace(/\/$/, '');
  return workspace?.booking_token ? `${base}/book/${workspace.booking_token}` : '';
}

function minutesFromTime(value, fallback) {
  const [hour, minute] = String(value || fallback).split(':').map(Number);
  return hour * 60 + (minute || 0);
}

async function bookedPeriods(supabase, workspaceId, from, to) {
  const { data, error } = await supabase
    .from('meetings')
    .select('starts_at, ends_at')
    .eq('workspace_id', workspaceId)
    .in('status', HOLDING_STATUSES)
    .gte('starts_at', new Date(from.getTime() - DAY_MS).toISOString())
    .lt('starts_at', to.toISOString());
  if (error) throw error;
  return (data || []).map(meeting => {
    const start = new Date(meeting.starts_at).getTime();
    return { start, end: meeting.ends_at ? new Date(meeting.ends_at).getTime() : start + SLOT_MINUTES * 60000 };
  });
}

async function findOpenSlots(supabase, { workspaceId, campaign, days = 5, limit = 3, perDay = 1, now = new Date() }) {
  const zone = campaign?.timezone || 'Asia/Singapore';
  const activeDays = new Set(campaign?.active_days?.length ? campaign.active_days : [1, 2, 3, 4, 5]);
  const windowStart = minutesFromTime(campaign?.sending_hours_start, '09:00');
  const windowEnd = minutesFromTime(campaign?.sending_hours_end, '18:00');
  const booked = await bookedPeriods(supabase, workspaceId, now, new Date(now.getTime() + (days + 1) * DAY_MS));

  // The prospect is on the phone now and needs time to get to the meeting.
  const earliest = now.getTime() + 60 * 60 * 1000;
  const slots = [];

  for (let dayIndex = 0; dayIndex < days && slots.length < limit; dayIndex += 1) {
    const day = zonedParts(new Date(now.getTime() + dayIndex * DAY_MS), zone);
    if (!activeDays.has(day.weekday)) continue;

    let offeredToday = 0;
    for (let minutes = windowStart; minutes + SLOT_MINUTES <= windowEnd && slots.length < limit; minutes += SLOT_MINUTES) {
      const start = localDateTimeToUtc({ year: day.year, month: day.month, day: day.day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, zone);
      const startMs = start.getTime();
      const endMs = startMs + SLOT_MINUTES * 60000;
      if (startMs < earliest || booked.some(period => startMs < period.end && endMs > period.start)) continue;

      slots.push({
        start: start.toISOString(),
        end: new Date(endMs).toISOString(),
        spoken: new Intl.DateTimeFormat('en-SG', { timeZone: zone, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(start),
      });
      // One option per day reads better on a call than three on Tuesday.
      offeredToday += 1;
      if (offeredToday >= perDay) break;
    }
  }
  return slots;
}

module.exports = { SLOT_MINUTES, findOpenSlots, inHouseBookingLink };
