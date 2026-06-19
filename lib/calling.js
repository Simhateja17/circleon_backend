const crypto = require('crypto');

const RETELL_API_BASE = process.env.RETELL_API_BASE || 'https://api.retellai.com';
const DEFAULT_VOICE_ID = process.env.RETELL_DEFAULT_VOICE_ID || '11labs-Adrian';

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizePhone(rawPhone) {
  const phone = clean(rawPhone);
  if (!phone) return '';

  const compact = phone.replace(/[\s().-]/g, '');
  if (compact.startsWith('+')) return compact;
  if (compact.startsWith('65') && compact.length === 10) return `+${compact}`;
  if (/^[689]\d{7}$/.test(compact)) return `+65${compact}`;
  return compact;
}

function isLeadCallable(lead) {
  if (!lead) return { callable: false, reason: 'Lead not found' };
  if (lead.status === 'do_not_call') return { callable: false, reason: 'Lead is marked do not call' };
  if (!normalizePhone(lead.phone_e164 || lead.phone)) return { callable: false, reason: 'Lead has no callable phone number' };
  if (lead.voice_consent_status === 'consented') return { callable: true, reason: null };
  if (lead.dnc_status === 'clear') return { callable: true, reason: null };
  if (lead.dnc_status === 'blocked') return { callable: false, reason: 'Phone number is blocked by DNC status' };
  if (lead.voice_consent_status === 'not_consented') return { callable: false, reason: 'Lead has not consented to voice calls' };
  return { callable: false, reason: 'Lead requires DNC clearance or explicit voice consent' };
}

function isInsideBusinessWindow(telephony, date = new Date()) {
  const timezone = telephony?.timezone || 'Asia/Singapore';
  const parts = new Intl.DateTimeFormat('en-SG', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const weekday = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const activeDays = Array.isArray(telephony?.active_days) ? telephony.active_days : [1, 2, 3, 4, 5];
  const day = dayMap[weekday];

  if (!activeDays.includes(day)) return false;

  const current = hour * 60 + minute;
  const [startHour, startMinute] = String(telephony?.business_hours_start || '09:00').split(':').map(Number);
  const [endHour, endMinute] = String(telephony?.business_hours_end || '18:00').split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return current >= start && current < end;
}

function buildDisclosurePrompt(agentConfig, workspace) {
  const companyName = agentConfig?.company_name || workspace?.name || 'the company I represent';
  const agentName = agentConfig?.agent_name || 'Barsha';
  const basePrompt = agentConfig?.system_prompt || '';

  return `# DISCLOSURE REQUIREMENT
You must open every outbound cold call by saying you are an AI assistant calling on behalf of ${companyName}. Do not wait for the prospect to ask.

Example opening:
"Hi, this is ${agentName}, an AI assistant calling on behalf of ${companyName}. I will keep this brief. Is now a good time for a quick two-minute conversation?"

# COMPLIANCE
- If the prospect asks not to be called again, acknowledge it, end the call, and mark the outcome as do_not_call.
- Do not pressure, mislead, or imply a human is speaking.
- If recording is enabled, mention that the call may be recorded for quality and training.

${basePrompt}`;
}

async function retellRequest(path, options = {}) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    const error = new Error('RETELL_API_KEY is not configured');
    error.code = 'RETELL_NOT_CONFIGURED';
    throw error;
  }

  const response = await fetch(`${RETELL_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Retell request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function getRetellId(payload, keys) {
  for (const key of keys) {
    if (payload?.[key]) return payload[key];
  }
  return '';
}

async function createRetellLlm(prompt) {
  const payload = await retellRequest('/create-retell-llm', {
    method: 'POST',
    body: JSON.stringify({
      general_prompt: prompt,
      begin_message: 'Hi, this is {{agent_name}}, an AI assistant calling on behalf of {{company_name}}. I will keep this brief. Is now a good time for a quick two-minute conversation?',
    }),
  });

  return {
    id: getRetellId(payload, ['llm_id', 'retell_llm_id', 'id']),
    payload,
  };
}

async function createRetellAgent({ llmId, agentName, voiceId }) {
  const payload = await retellRequest('/create-agent', {
    method: 'POST',
    body: JSON.stringify({
      response_engine: {
        type: 'retell-llm',
        llm_id: llmId,
      },
      agent_name: agentName,
      voice_id: voiceId || DEFAULT_VOICE_ID,
      webhook_url: process.env.RETELL_WEBHOOK_URL,
    }),
  });

  return {
    id: getRetellId(payload, ['agent_id', 'retell_agent_id', 'id']),
    payload,
  };
}

async function createRetellPhoneCall({ fromNumber, toNumber, agentId, metadata, variables }) {
  return retellRequest('/create-phone-call', {
    method: 'POST',
    body: JSON.stringify({
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agentId,
      metadata,
      retell_llm_dynamic_variables: variables,
    }),
  });
}

function verifyRetellSignature(rawBody, signature) {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const normalized = String(signature).replace(/^sha256=/, '');
  if (expected.length !== normalized.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized));
}

module.exports = {
  buildDisclosurePrompt,
  createRetellAgent,
  createRetellLlm,
  createRetellPhoneCall,
  isInsideBusinessWindow,
  isLeadCallable,
  normalizePhone,
  verifyRetellSignature,
};
