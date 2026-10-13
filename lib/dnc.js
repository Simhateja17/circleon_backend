// Singapore Do Not Call compliance.
//
// Under the PDPA's DNC provisions, marketing calls to Singapore numbers must be
// checked against the registry, and a result is valid for 30 days. Marketing
// messages sent to ORGANISATIONS fall outside those provisions, so a company
// switchboard does not need a check. The exemption attaches to the number being
// a business line, not to the call being business-related: a personal mobile is
// still protected even when the pitch is about the person's company.
//
// That makes number classification load-bearing, which is why we preserve the
// type Apollo gives us instead of collapsing every number into one field.

const { decrypt } = require('./crypto');
const { normalizePhone } = require('./calling');

const DNC_VALIDITY_DAYS = 30;
const PDPC_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Work out whether a number is an organisation line or a personal one, from the
 * field Apollo supplied it in. `organization_phone` is a company switchboard;
 * `mobile_phone` belongs to the person.
 */
function classifyPhoneType(sourceField) {
  switch (sourceField) {
    case 'organization_phone':
    case 'company_phone':
    case 'hq_phone':
      return { phoneType: 'business', source: sourceField };
    case 'mobile_phone':
    case 'direct_phone':
    case 'personal_phone':
    case 'revealed_phone_number':
      return { phoneType: 'personal', source: sourceField };
    default:
      return { phoneType: 'unknown', source: sourceField || null };
  }
}

/**
 * Singapore numbering gives a second signal: 8 and 9 prefixes are mobile, 6 is
 * a fixed line. Only used to firm up an unknown, never to override the source
 * field, and never to downgrade a personal number to a business one.
 */
function refinePhoneTypeFromNumber(phoneType, phoneE164) {
  if (phoneType && phoneType !== 'unknown') return phoneType;

  const phone = normalizePhone(phoneE164);
  if (!phone.startsWith('+65')) return 'unknown';

  const local = phone.slice(3);
  if (/^[89]/.test(local)) return 'personal';
  if (/^6/.test(local)) return 'business';
  return 'unknown';
}

function isSingaporeNumber(phone) {
  return normalizePhone(phone).startsWith('+65');
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function isDncResultFresh(checkedAt, now = new Date()) {
  if (!checkedAt) return false;
  const checked = new Date(checkedAt);
  if (Number.isNaN(checked.getTime())) return false;
  const ageDays = (now.getTime() - checked.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays < DNC_VALIDITY_DAYS;
}

/**
 * Does this lead need a PDPC check before we may call it?
 * Business lines are exempt. Non-Singapore numbers are outside the registry.
 */
function requiresDncCheck(lead) {
  if (!lead) return false;
  if (lead.voice_consent_status === 'consented') return false;
  if (!isSingaporeNumber(lead.phone_e164 || lead.phone)) return false;
  return lead.phone_type !== 'business';
}

/**
 * The single gate the dialer asks before placing a call. Returns a reason on
 * refusal so the campaign view can explain itself rather than silently stalling.
 */
function voiceEligibility(lead, now = new Date()) {
  if (!lead) return { callable: false, reason: 'Lead not found' };

  if (lead.status === 'do_not_call') {
    return { callable: false, reason: 'Lead asked not to be called' };
  }
  if (lead.lifecycle_status === 'suppressed') {
    return { callable: false, reason: lead.suppression_reason || 'Lead is suppressed' };
  }

  const phone = normalizePhone(lead.phone_e164 || lead.phone);
  if (!phone) return { callable: false, reason: 'Lead has no phone number' };

  if (lead.dnc_status === 'blocked') {
    return { callable: false, reason: 'Number is on the Do Not Call register' };
  }

  // Explicit consent overrides everything below it.
  if (lead.voice_consent_status === 'consented') return { callable: true, reason: null };
  if (lead.voice_consent_status === 'not_consented') {
    return { callable: false, reason: 'Lead has not consented to calls' };
  }

  if (!requiresDncCheck(lead)) {
    // A business line, or a number outside the Singapore registry.
    return { callable: true, reason: null };
  }

  if (lead.dnc_status === 'clear' && isDncResultFresh(lead.dnc_checked_at, now)) {
    return { callable: true, reason: null };
  }
  if (lead.dnc_status === 'clear') {
    return { callable: false, reason: 'DNC clearance has expired and must be rechecked' };
  }

  return { callable: false, reason: 'Personal number needs a Do Not Call check' };
}

/** Coverage summary shown in the builder before a campaign is launched. */
function summariseCallability(leads = [], now = new Date()) {
  const summary = {
    total: leads.length,
    withPhone: 0,
    business: 0,
    personal: 0,
    unknownType: 0,
    callableNow: 0,
    needsDncCheck: 0,
    blocked: 0,
  };

  for (const lead of leads) {
    if (!normalizePhone(lead.phone_e164 || lead.phone)) continue;
    summary.withPhone += 1;

    if (lead.phone_type === 'business') summary.business += 1;
    else if (lead.phone_type === 'personal') summary.personal += 1;
    else summary.unknownType += 1;

    const eligibility = voiceEligibility(lead, now);
    if (eligibility.callable) summary.callableNow += 1;
    else if (requiresDncCheck(lead) && lead.dnc_status !== 'blocked') summary.needsDncCheck += 1;
    else summary.blocked += 1;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// PDPC registry client
// ---------------------------------------------------------------------------
//
// Credentials are per workspace: a PDPC account is bound to an organisation's
// UEN, so each customer registers their own rather than sharing ours.
//
// NOTE: the request and response shapes below follow the published DNC API
// outline (batches of up to 100 numbers, one credit per number, results
// returned inline). They have NOT been verified against a live account. Parsing
// is deliberately tolerant, and `parsePdpcResults` is the single place to adjust
// once the real contract is confirmed.

function pdpcCredentials(telephony) {
  if (!telephony?.pdpc_account_id || !telephony?.pdpc_api_key_encrypted) return null;

  let apiKey;
  try {
    apiKey = decrypt(telephony.pdpc_api_key_encrypted);
  } catch (_error) {
    return null;
  }

  return {
    accountId: telephony.pdpc_account_id,
    apiKey,
    apiUrl: telephony.pdpc_api_url || process.env.PDPC_DNC_API_URL,
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Map whatever the registry returns onto our own status vocabulary. */
function parsePdpcResults(payload, requested) {
  const rows = payload?.results || payload?.numbers || payload?.data || [];
  const byNumber = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const number = normalizePhone(row.number || row.phone || row.phone_number || row.msisdn);
    if (!number) continue;

    // The registry tells us whether the number is listed. Listed means we may
    // not call it.
    const listed = row.listed ?? row.is_listed ?? row.on_dnc ?? row.registered;
    const status = typeof listed === 'boolean'
      ? (listed ? 'blocked' : 'clear')
      : String(row.status || '').toLowerCase();

    if (status === 'blocked' || status === 'listed' || status === 'registered') {
      byNumber.set(number, 'blocked');
    } else if (status === 'clear' || status === 'not_listed' || status === 'unregistered') {
      byNumber.set(number, 'clear');
    } else {
      byNumber.set(number, 'unknown');
    }
  }

  // Anything the registry did not answer for stays unknown, and therefore
  // stays uncallable. We fail closed.
  return requested.map(number => ({
    phone_e164: number,
    status: byNumber.get(number) || 'unknown',
  }));
}

async function checkNumbersWithPdpc(credentials, numbers) {
  if (!credentials?.apiUrl) {
    const error = new Error('PDPC DNC API is not configured for this workspace');
    error.code = 'PDPC_NOT_CONFIGURED';
    throw error;
  }

  const normalized = [...new Set(numbers.map(normalizePhone).filter(Boolean))];
  const results = [];

  for (const batch of chunk(normalized, PDPC_BATCH_SIZE)) {
    const response = await fetch(credentials.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({
        account_id: credentials.accountId,
        // The registry works in local numbers; strip the country code.
        numbers: batch.map(number => number.replace(/^\+65/, '')),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `PDPC check failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    results.push(...parsePdpcResults(payload, batch));
  }

  return results;
}

module.exports = {
  DNC_VALIDITY_DAYS,
  PDPC_BATCH_SIZE,
  checkNumbersWithPdpc,
  classifyPhoneType,
  isDncResultFresh,
  isSingaporeNumber,
  parsePdpcResults,
  pdpcCredentials,
  refinePhoneTypeFromNumber,
  requiresDncCheck,
  summariseCallability,
  voiceEligibility,
};
