// Customer-owned Twilio accounts (BYOK).
//
// The customer pays Twilio for the number and carrier minutes; CircleOn only
// supplies the Retell agent. With the customer's Account SID and Auth Token we:
//
//   1. confirm the account is real, active and not a trial account,
//   2. list the +65 voice numbers it owns,
//   3. create one Elastic SIP Trunk with a credential list so Retell can place
//      outbound calls through it (termination),
//   4. point the number's Voice URL at our signed inbound webhook.
//
// The number is deliberately NOT associated with the trunk. Twilio routes an
// associated number's inbound calls straight to the trunk's origination URI,
// which would bypass the webhook that enforces allowance, spending caps,
// concurrency, owner-approved inbound instructions and the customer fallback.
// Termination does not need the association: Twilio accepts any caller ID that
// is a number on the same account.
//
// The Auth Token is required (not an API key) because Twilio signs webhooks
// with the account's Auth Token, and inbound verification needs it.

const crypto = require('crypto');

const API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';
const TRUNKING_BASE = process.env.TWILIO_TRUNKING_BASE || 'https://trunking.twilio.com';
// Singapore numbers terminate through Twilio's Singapore edge.
const TERMINATION_EDGE = process.env.TWILIO_TERMINATION_EDGE || 'singapore';

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const AUTH_TOKEN = /^[0-9a-f]{32}$/;
const PHONE_SID = /^PN[0-9a-f]{32}$/;

function twilioError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

async function twilioRequest({ accountSid, authToken }, url, { method = 'GET', form } = {}) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw twilioError('Twilio rejected the Account SID or Auth Token.', 400, 'TWILIO_AUTH');
  if (!response.ok) throw twilioError(payload.message || `Twilio request failed: ${response.status}`, 502, payload.code);
  return payload;
}

const accountUrl = (sid, path = '') => `${API_BASE}/2010-04-01/Accounts/${sid}${path}.json`;

/** Confirm the credentials work and the account can make real calls. */
async function validateAccount(credentials) {
  if (!ACCOUNT_SID.test(credentials.accountSid || '')) throw twilioError('Enter a valid Twilio Account SID (starts with AC).', 400);
  if (!AUTH_TOKEN.test(credentials.authToken || '')) throw twilioError('Enter the 32-character Twilio Auth Token.', 400);
  const account = await twilioRequest(credentials, accountUrl(credentials.accountSid));
  if (account.status !== 'active') throw twilioError(`This Twilio account is ${account.status}, not active.`, 400);
  // Trial accounts can only call verified numbers and play a trial message.
  if (account.type === 'Trial') throw twilioError('Upgrade this Twilio account from trial before connecting it.', 400);
  return { friendlyName: account.friendly_name, type: account.type };
}

function eligible(number) {
  return String(number.phone_number || '').startsWith('+65') && number.capabilities?.voice !== false;
}

function publicNumber(number) {
  return {
    sid: number.sid,
    phone_number: number.phone_number,
    friendly_name: number.friendly_name,
    trunk_sid: number.trunk_sid || null,
    voice_url: number.voice_url || null,
  };
}

/** Singapore voice numbers owned by this account. */
async function listEligibleNumbers(credentials) {
  const numbers = [];
  let url = accountUrl(credentials.accountSid, '/IncomingPhoneNumbers') + '?PageSize=200';
  for (let page = 0; url && page < 10; page += 1) {
    const payload = await twilioRequest(credentials, url);
    numbers.push(...(payload.incoming_phone_numbers || []));
    url = payload.next_page_uri ? API_BASE + payload.next_page_uri : null;
  }
  return numbers.filter(eligible).map(publicNumber);
}

/** Fetch one number through the customer's own account, proving it owns it. */
async function fetchOwnedNumber(credentials, phoneNumberSid) {
  if (!PHONE_SID.test(phoneNumberSid || '')) throw twilioError('Choose a number from your Twilio account.', 400);
  let number;
  try {
    number = await twilioRequest(credentials, accountUrl(credentials.accountSid, `/IncomingPhoneNumbers/${phoneNumberSid}`));
  } catch (error) {
    if (error.code === 20404) throw twilioError('That number is not on the connected Twilio account.', 400);
    throw error;
  }
  if (number.account_sid !== credentials.accountSid) throw twilioError('That number is not on the connected Twilio account.', 400);
  if (!eligible(number)) throw twilioError('Only Singapore (+65) voice numbers can be connected.', 400);
  return number;
}

/** Twilio credential passwords need 12+ characters with upper, lower and a digit. */
function sipPassword() {
  return 'Co' + crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'x') + '7a';
}

/**
 * Create, or reuse, the CircleOn termination trunk on the customer's account.
 * `existing` carries ids stored from an earlier run so a retry does not create
 * a second trunk.
 */
async function ensureTerminationTrunk(credentials, { workspaceId, existing = {} }) {
  if (existing.trunkSid && existing.sipUsername && existing.sipPassword && existing.terminationUri) {
    try {
      await twilioRequest(credentials, `${TRUNKING_BASE}/v1/Trunks/${existing.trunkSid}`);
      return existing;
    } catch (error) {
      if (error.code !== 20404) throw error;
    }
  }

  const label = `circleon-${workspaceId.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`;
  const trunk = await twilioRequest(credentials, `${TRUNKING_BASE}/v1/Trunks`, {
    method: 'POST',
    form: { FriendlyName: 'CircleOn AI voice', DomainName: `${label}.pstn.twilio.com` },
  });
  const list = await twilioRequest(credentials, accountUrl(credentials.accountSid, '/SIP/CredentialLists'), {
    method: 'POST',
    form: { FriendlyName: `CircleOn ${label}` },
  });
  const sipUsername = label;
  const password = sipPassword();
  await twilioRequest(credentials, accountUrl(credentials.accountSid, `/SIP/CredentialLists/${list.sid}/Credentials`), {
    method: 'POST',
    form: { Username: sipUsername, Password: password },
  });
  await twilioRequest(credentials, `${TRUNKING_BASE}/v1/Trunks/${trunk.sid}/CredentialLists`, {
    method: 'POST',
    form: { CredentialListSid: list.sid },
  });

  return {
    trunkSid: trunk.sid,
    credentialListSid: list.sid,
    sipUsername,
    sipPassword: password,
    terminationUri: `${label}.pstn.${TERMINATION_EDGE}.twilio.com`,
  };
}

/**
 * Send the number's inbound calls to our signed webhook. Setting a Voice URL
 * also detaches the number from any trunk, and clearing the Voice Application
 * stops it overriding the URL.
 */
async function routeInboundToWebhook(credentials, phoneNumberSid, voiceUrl) {
  return twilioRequest(credentials, accountUrl(credentials.accountSid, `/IncomingPhoneNumbers/${phoneNumberSid}`), {
    method: 'POST',
    form: { VoiceUrl: voiceUrl, VoiceMethod: 'POST', VoiceApplicationSid: '' },
  });
}

module.exports = {
  ensureTerminationTrunk,
  fetchOwnedNumber,
  listEligibleNumbers,
  routeInboundToWebhook,
  sipPassword,
  validateAccount,
};
