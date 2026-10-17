// Retell provider layer for voice campaigns.
//
// Everything here is per campaign: one LLM, one agent, one script. The older
// helpers in lib/calling.js create a single agent per workspace and are kept
// only until the follow-up dialer is fully retired.
//
// On numbers: Retell sells US and Canadian numbers only, so a Singapore number
// is always imported. Importing needs a SIP termination URI, which means the
// customer creates a Twilio Elastic SIP Trunk and points their +65 number at
// it. Twilio API credentials alone are not enough.

const RETELL_API_BASE = process.env.RETELL_API_BASE || 'https://api.retellai.com';

// Retell has no en-SG locale. Singapore English campaigns run on a neighbouring
// locale and take their accent from the voice, not from the language code.
const LANGUAGES = {
  'en-US': { label: 'English', retell: 'en-US' },
  'en-GB': { label: 'English (British)', retell: 'en-GB' },
  'zh-CN': { label: 'Mandarin', retell: 'zh-CN' },
};

const DEFAULT_LANGUAGE = 'en-US';

// An appointment setter that runs long is a cost problem and a quality problem.
// Three minutes is generous for a call designed to take under two.
const MAX_CALL_DURATION_MS = Number(process.env.RETELL_MAX_CALL_DURATION_MS || 180000);

function retellLanguage(language) {
  return LANGUAGES[language]?.retell || DEFAULT_LANGUAGE;
}

function supportedLanguages() {
  return Object.entries(LANGUAGES).map(([code, value]) => ({ code, label: value.label }));
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

function retellId(payload, keys) {
  for (const key of keys) {
    if (payload?.[key]) return payload[key];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * The voices offered in the campaign builder. Deliberately a shortlist rather
 * than Retell's full catalogue: someone has to have listened to each one on a
 * real +65 call before it appears here.
 *
 * Accent matters more in Singapore than almost anything else in this build. A
 * Western-accented voice on a local number reads as an overseas call centre.
 */
async function listVoices({ language = DEFAULT_LANGUAGE } = {}) {
  const payload = await retellRequest('/list-voices');
  const voices = Array.isArray(payload) ? payload : payload?.voices || [];
  const family = String(language).split('-')[0];

  return voices
    .filter(voice => {
      if (!family) return true;
      const voiceLanguage = String(voice.language || voice.locale || '').toLowerCase();
      return !voiceLanguage || voiceLanguage.startsWith(family);
    })
    .map(voice => ({
      voice_id: voice.voice_id || voice.id,
      name: voice.voice_name || voice.name,
      provider: voice.provider || null,
      gender: voice.gender || null,
      accent: voice.accent || null,
      preview_url: voice.preview_audio_url || voice.preview_url || null,
    }))
    .filter(voice => voice.voice_id);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Tools the agent can call mid-conversation. These are what turn it from
 * something that promises to send a link into something that books a meeting
 * while the prospect is still on the phone.
 *
 * `speak_during_execution` matters: a calendar lookup takes a second or two and
 * silence on a cold call reads as a dropped line.
 */
function bookingTools() {
  const base = process.env.RETELL_FUNCTION_BASE_URL;
  if (!base || !process.env.RETELL_FUNCTION_SECRET) return [];

  const headers = { Authorization: `Bearer ${process.env.RETELL_FUNCTION_SECRET}` };

  return [
    {
      type: 'custom',
      name: 'check_availability',
      description: 'Get real open meeting times from the caller\'s calendar. Call this before offering any time. Never invent a time.',
      url: `${base}/api/voice/agent/availability`,
      headers,
      speak_during_execution: true,
      speak_after_execution: true,
      execution_message_description: 'Say you are checking the calendar, in a few words.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      type: 'custom',
      name: 'book_meeting',
      description: 'Book one of the times returned by check_availability, after the prospect agrees to it.',
      url: `${base}/api/voice/agent/book`,
      headers,
      speak_during_execution: true,
      speak_after_execution: true,
      execution_message_description: 'Say you are putting it in the calendar now.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'The exact start value from check_availability, in ISO 8601.' },
          email: { type: 'string', description: 'Email for the invitation, if the prospect gives one.' },
        },
        required: ['start'],
      },
    },
  ];
}

async function createLlm({ prompt, beginMessage }) {
  const payload = await retellRequest('/create-retell-llm', {
    method: 'POST',
    body: JSON.stringify({
      general_prompt: prompt,
      begin_message: beginMessage,
      general_tools: bookingTools(),
    }),
  });

  return { id: retellId(payload, ['llm_id', 'retell_llm_id', 'id']), payload };
}

async function updateLlm(llmId, { prompt, beginMessage }) {
  return retellRequest(`/update-retell-llm/${llmId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      general_prompt: prompt,
      begin_message: beginMessage,
      general_tools: bookingTools(),
    }),
  });
}

async function createAgent({ llmId, agentName, voiceId, language }) {
  const payload = await retellRequest('/create-agent', {
    method: 'POST',
    body: JSON.stringify({
      response_engine: { type: 'retell-llm', llm_id: llmId },
      agent_name: agentName,
      voice_id: voiceId,
      language: retellLanguage(language),
      webhook_url: process.env.RETELL_WEBHOOK_URL,
      max_call_duration_ms: MAX_CALL_DURATION_MS,
      // An appointment setter has nothing useful to say to a voicemail box, and
      // a rambling AI message is worse than no message at all.
      voicemail_option: { action: { type: 'hang_up' } },
    }),
  });

  return { id: retellId(payload, ['agent_id', 'retell_agent_id', 'id']), payload };
}

async function updateAgent(agentId, patch) {
  const body = {};
  if (patch.voiceId) body.voice_id = patch.voiceId;
  if (patch.language) body.language = retellLanguage(patch.language);
  if (patch.agentName) body.agent_name = patch.agentName;

  return retellRequest(`/update-agent/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Bring a customer-owned Singapore number into Retell.
 *
 * `terminationUri` comes from the customer's Twilio Elastic SIP Trunk, which is
 * how their +65 number reaches Retell. Outbound is restricted to Singapore so a
 * misconfigured campaign cannot dial another country on their account.
 */
async function importPhoneNumber({ phoneNumber, terminationUri, sipUsername, sipPassword, nickname, agentId }) {
  const body = {
    phone_number: phoneNumber,
    termination_uri: terminationUri,
    nickname: nickname || undefined,
    allowed_outbound_country_list: ['SG'],
  };

  if (sipUsername) body.sip_trunk_auth_username = sipUsername;
  if (sipPassword) body.sip_trunk_auth_password = sipPassword;
  if (agentId) body.outbound_agents = [{ agent_id: agentId, weight: 1 }];

  const payload = await retellRequest('/import-phone-number', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    phoneNumber: payload.phone_number || phoneNumber,
    payload,
  };
}

/** Confirm a number really is registered with Retell before we call it verified. */
async function getPhoneNumber(phoneNumber) {
  return retellRequest(`/get-phone-number/${encodeURIComponent(phoneNumber)}`);
}

async function deletePhoneNumber(phoneNumber) {
  return retellRequest(`/delete-phone-number/${encodeURIComponent(phoneNumber)}`, { method: 'DELETE' });
}

async function createPhoneCall({ fromNumber, toNumber, agentId, metadata, variables, agentOverride }) {
  return retellRequest('/v2/create-phone-call', {
    method: 'POST',
    body: JSON.stringify({
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agentId,
      ...(agentOverride ? {agent_override:agentOverride} : {}),
      metadata,
      retell_llm_dynamic_variables: variables,
    }),
  });
}

module.exports = {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  MAX_CALL_DURATION_MS,
  createAgent,
  createLlm,
  createPhoneCall,
  deletePhoneNumber,
  getPhoneNumber,
  importPhoneNumber,
  listVoices,
  retellLanguage,
  retellRequest,
  supportedLanguages,
  updateAgent,
  updateLlm,
};
