// Timezone-aware scheduling for voice campaigns.
//
// Two jobs: decide whether a campaign may dial right now, and decide when a
// missed lead should be tried again. Retries deliberately land in a different
// part of the day each time, so three attempts sample a prospect's day instead
// of hitting the same dead 10am slot three mornings running.

const DAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DEFAULT_TIMEZONE = 'Asia/Singapore';
const DEFAULT_ACTIVE_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_START = '09:00';
const DEFAULT_END = '18:00';

// How many minutes of buffer we leave before the end of the window, so a call
// placed at the last moment is not cut off mid-conversation.
const WINDOW_TAIL_BUFFER_MINUTES = 10;

function minutesFromTime(value, fallback) {
  const [hour, minute] = String(value || fallback).split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    const [fh, fm] = fallback.split(':').map(Number);
    return fh * 60 + fm;
  }
  return hour * 60 + minute;
}

// The campaign schema accepts 0-6 (Sunday = 0) while the calling code uses
// ISO 1-7 (Sunday = 7). Normalise so a campaign set to run on Sundays actually
// does, whichever convention wrote the row.
function normaliseActiveDays(days) {
  if (!Array.isArray(days) || !days.length) return DEFAULT_ACTIVE_DAYS;
  return [...new Set(days.map(day => (Number(day) === 0 ? 7 : Number(day))))];
}

function scheduleFrom(source = {}) {
  return {
    timezone: source.timezone || DEFAULT_TIMEZONE,
    activeDays: normaliseActiveDays(source.active_days),
    startMinutes: minutesFromTime(source.sending_hours_start || source.business_hours_start, DEFAULT_START),
    endMinutes: minutesFromTime(source.sending_hours_end || source.business_hours_end, DEFAULT_END),
  };
}

/** Minutes that `timeZone` is ahead of UTC at the given instant. */
function timezoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return (asUtc - date.getTime()) / 60000;
}

/** Wall-clock view of an instant inside a timezone. */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    isoWeekday: DAY_INDEX[parts.weekday] || 1,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** The instant at which a wall-clock time in `timeZone` occurs. */
function fromZonedWallClock({ year, month, day, minutes }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  // Two passes so the result stays correct across a DST boundary. Singapore has
  // no DST, but campaigns can be scheduled in any timezone.
  let instant = naive - timezoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  instant = naive - timezoneOffsetMinutes(new Date(instant), timeZone) * 60000;
  return new Date(instant);
}

function addZonedDays(parts, days, timeZone) {
  const noon = fromZonedWallClock({ ...parts, minutes: 12 * 60 }, timeZone);
  const shifted = new Date(noon.getTime() + days * 24 * 60 * 60 * 1000);
  const next = zonedParts(shifted, timeZone);
  return { year: next.year, month: next.month, day: next.day, isoWeekday: next.isoWeekday };
}

/**
 * Is this campaign allowed to place a call right now?
 * Returns a reason when it is not, because "why is nothing happening" is the
 * single most common support question on any dialer.
 */
function callingWindowState(source, now = new Date()) {
  const schedule = scheduleFrom(source);
  const nowParts = zonedParts(now, schedule.timezone);

  if (!schedule.activeDays.includes(nowParts.isoWeekday)) {
    return { open: false, reason: 'Outside the campaign\'s active days' };
  }

  const closeAt = schedule.endMinutes - WINDOW_TAIL_BUFFER_MINUTES;
  if (nowParts.minutes < schedule.startMinutes) {
    return { open: false, reason: 'Before the campaign\'s calling hours' };
  }
  if (nowParts.minutes >= closeAt) {
    return { open: false, reason: 'After the campaign\'s calling hours' };
  }

  return { open: true, reason: null };
}

function isInsideCallingWindow(source, now = new Date()) {
  return callingWindowState(source, now).open;
}

/**
 * When should attempt number `attemptNumber` (1-based) be placed?
 *
 * The window is split into three bands and each attempt targets a different
 * one, so successive attempts hit the morning, the middle of the day and the
 * late afternoon rather than repeating a single slot.
 */
function nextAttemptAt(source, attemptNumber, { from = new Date(), gapHours = 24 } = {}) {
  const schedule = scheduleFrom(source);
  const earliest = new Date(from.getTime() + Math.max(1, gapHours) * 60 * 60 * 1000);

  const windowLength = Math.max(1, schedule.endMinutes - schedule.startMinutes);
  const bandCount = 3;
  const bandLength = windowLength / bandCount;
  // Attempt 1 aims at the first band, attempt 2 the second, and so on, cycling.
  const band = (Math.max(1, attemptNumber) - 1) % bandCount;
  const targetMinutes = Math.round(schedule.startMinutes + band * bandLength + bandLength / 2);

  let dayParts = zonedParts(earliest, schedule.timezone);

  // Walk forward to the first active day whose target slot is at or after the
  // earliest permitted time. Two weeks is far more than enough; the guard just
  // stops a misconfigured campaign from looping forever.
  for (let index = 0; index < 14; index += 1) {
    if (schedule.activeDays.includes(dayParts.isoWeekday)) {
      const candidate = fromZonedWallClock({ ...dayParts, minutes: targetMinutes }, schedule.timezone);
      if (candidate.getTime() >= earliest.getTime()) return candidate;
    }
    dayParts = addZonedDays(dayParts, 1, schedule.timezone);
  }

  return earliest;
}

module.exports = {
  callingWindowState,
  isInsideCallingWindow,
  nextAttemptAt,
  // exported for tests
  fromZonedWallClock,
  zonedParts,
};
