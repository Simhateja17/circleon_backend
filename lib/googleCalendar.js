// Google Calendar, so the voice agent can offer real times instead of reading a
// URL aloud to a stranger.
//
// Scope note: calendar.events is a SENSITIVE scope. Publishing needs a verified
// domain, a published privacy policy and a demo video, and Google's review runs
// three to five business days. Testing mode allows 100 users without review, so
// this blocks public launch, not development.

const { encrypt, decrypt } = require('./crypto');
const { fromZonedWallClock, zonedParts } = require('./voiceScheduling');

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

function oauthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    const error = new Error('Google Calendar is not configured');
    error.code = 'GOOGLE_NOT_CONFIGURED';
    throw error;
  }

  return { clientId, clientSecret, redirectUri };
}

function authorizationUrl(state) {
  const { clientId, redirectUri } = oauthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // Offline plus consent is what actually returns a refresh token; without
    // both, a reconnect silently yields none and booking breaks an hour later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = oauthConfig();

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google rejected the authorisation');
  }
  if (!payload.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app from your Google account and reconnect.');
  }

  return payload;
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = oauthConfig();

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Could not refresh Google access');
  }

  return payload;
}

/**
 * A usable access token for this workspace, refreshed if needed and cached back
 * to the row. Called mid-call, so it has to be quick.
 */
async function accessTokenFor(supabase, connection) {
  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at).getTime()
    : 0;

  // Refresh a minute early rather than racing the expiry during a live call.
  if (connection.access_token_encrypted && expiresAt - 60000 > Date.now()) {
    return decrypt(connection.access_token_encrypted);
  }

  const refreshed = await refreshAccessToken(decrypt(connection.refresh_token_encrypted));
  const accessToken = refreshed.access_token;

  await supabase
    .from('calendar_connections')
    .update({
      access_token_encrypted: encrypt(accessToken),
      access_token_expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
      status: 'connected',
      last_error: null,
    })
    .eq('workspace_id', connection.workspace_id);

  return accessToken;
}

async function calendarRequest(accessToken, path, options = {}) {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Google Calendar request failed: ${response.status}`);
  }
  return payload;
}

function bookingDays(connection) {
  const days = Array.isArray(connection.booking_days) && connection.booking_days.length
    ? connection.booking_days
    : [1, 2, 3, 4, 5];
  return new Set(days.map(day => (Number(day) === 0 ? 7 : Number(day))));
}

function minutesFromTime(value, fallback) {
  const [hour, minute] = String(value || fallback).split(':').map(Number);
  return (Number.isFinite(hour) ? hour : 9) * 60 + (Number.isFinite(minute) ? minute : 0);
}

/**
 * Candidate meeting times over the next few working days, minus anything the
 * customer's calendar says is busy.
 *
 * Deliberately returns a handful, not a wall of options: the agent reads two or
 * three aloud and a longer list makes for a worse phone call.
 */
async function findOpenSlots(supabase, connection, { days = 5, limit = 3, now = new Date() } = {}) {
  const accessToken = await accessTokenFor(supabase, connection);
  const zone = connection.timezone || 'Asia/Singapore';
  const slotMinutes = connection.slot_minutes || 30;
  const windowStart = minutesFromTime(connection.booking_hours_start, '09:00');
  const windowEnd = minutesFromTime(connection.booking_hours_end, '18:00');
  const allowedDays = bookingDays(connection);

  const searchEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const busyResponse = await calendarRequest(accessToken, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: searchEnd.toISOString(),
      timeZone: zone,
      items: [{ id: connection.calendar_id || 'primary' }],
    }),
  });

  const busy = (busyResponse.calendars?.[connection.calendar_id || 'primary']?.busy || [])
    .map(period => ({ start: new Date(period.start).getTime(), end: new Date(period.end).getTime() }));

  const overlapsBusy = (start, end) => busy.some(period => start < period.end && end > period.start);

  // Never offer a slot in the next hour: the prospect is on the phone now and
  // needs time to get to it.
  const earliest = now.getTime() + 60 * 60 * 1000;
  const slots = [];
  let cursor = zonedParts(now, zone);

  for (let dayIndex = 0; dayIndex < days && slots.length < limit; dayIndex += 1) {
    if (allowedDays.has(cursor.isoWeekday)) {
      for (let minutes = windowStart; minutes + slotMinutes <= windowEnd; minutes += slotMinutes) {
        const start = fromZonedWallClock({ ...cursor, minutes }, zone);
        const startMs = start.getTime();
        const endMs = startMs + slotMinutes * 60000;

        if (startMs < earliest) continue;
        if (overlapsBusy(startMs, endMs)) continue;

        slots.push({
          start: start.toISOString(),
          end: new Date(endMs).toISOString(),
          // What the agent actually says out loud.
          spoken: new Intl.DateTimeFormat('en-SG', {
            timeZone: zone,
            weekday: 'long',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          }).format(start),
        });

        // One option per day reads better on a call than three on Tuesday.
        break;
      }
    }

    const nextDay = new Date(fromZonedWallClock({ ...cursor, minutes: 12 * 60 }, zone).getTime() + 24 * 60 * 60 * 1000);
    cursor = zonedParts(nextDay, zone);
  }

  return slots;
}

async function createEvent(supabase, connection, { start, end, summary, description, attendeeEmail, attendeeName }) {
  const accessToken = await accessTokenFor(supabase, connection);

  const event = {
    summary,
    description,
    start: { dateTime: start, timeZone: connection.timezone || 'Asia/Singapore' },
    end: { dateTime: end, timeZone: connection.timezone || 'Asia/Singapore' },
    ...(attendeeEmail ? { attendees: [{ email: attendeeEmail, displayName: attendeeName || undefined }] } : {}),
  };

  return calendarRequest(
    accessToken,
    `/calendars/${encodeURIComponent(connection.calendar_id || 'primary')}/events?sendUpdates=all`,
    { method: 'POST', body: JSON.stringify(event) },
  );
}

module.exports = {
  SCOPES,
  accessTokenFor,
  authorizationUrl,
  createEvent,
  exchangeCode,
  findOpenSlots,
  oauthConfig,
  refreshAccessToken,
};
