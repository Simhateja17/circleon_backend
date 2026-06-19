const RETELL_API_BASE = process.env.RETELL_API_BASE || 'https://api.retellai.com';
const DEFAULT_VOICE_ID = process.env.RETELL_DEFAULT_VOICE_ID || '11labs-Adrian';

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

module.exports = {
  createRetellAgent,
  createRetellLlm,
  createRetellPhoneCall,
};
