const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_AZURE_OPENAI_API_VERSION = '2024-10-21';
const DEFAULT_REQUESTS_PER_MINUTE = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

let processWindowStartedAt = 0;
let processWindowRequestCount = 0;
let processRateLimitQueue = Promise.resolve();

function sleep(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function getRequestsPerMinute() {
  return Math.max(1, Number(process.env.GEMINI_REQUESTS_PER_MINUTE || DEFAULT_REQUESTS_PER_MINUTE));
}

function getRateLimitWindowMs() {
  return Math.max(1000, Number(process.env.GEMINI_RATE_LIMIT_WINDOW_MS || DEFAULT_RATE_LIMIT_WINDOW_MS));
}

function getMaxRetries() {
  return Math.max(0, Number(process.env.AI_MAX_RETRIES || process.env.GEMINI_MAX_RETRIES || DEFAULT_MAX_RETRIES));
}

function getAiProvider() {
  const configured = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (configured === 'azure' || configured === 'azure-openai') return 'azure-openai';
  if (configured === 'gemini') return 'gemini';

  const hasAzureConfiguration = process.env.AZURE_OPENAI_ENDPOINT
    && process.env.AZURE_OPENAI_API_KEY
    && process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  return hasAzureConfiguration ? 'azure-openai' : 'gemini';
}

function getRateLimitKey() {
  return process.env.GEMINI_RATE_LIMIT_KEY || 'barsha:gemini:generate-content:rate-limit';
}

function getRedisConnection() {
  if (!process.env.REDIS_URL) return null;
  try {
    return require('./redis').getRedisConnection();
  } catch (error) {
    console.warn(JSON.stringify({ event: 'gemini_rate_limit_redis_unavailable', error: error.message }));
    return null;
  }
}

async function acquireProcessRateLimitSlot() {
  const waitForTurn = processRateLimitQueue.then(async () => {
    const windowMs = getRateLimitWindowMs();
    const requestsPerMinute = getRequestsPerMinute();
    const now = Date.now();
    if (!processWindowStartedAt || now - processWindowStartedAt >= windowMs) {
      processWindowStartedAt = now;
      processWindowRequestCount = 0;
    }

    if (processWindowRequestCount >= requestsPerMinute) {
      const waitMs = Math.max(1, windowMs - (now - processWindowStartedAt));
      console.info(JSON.stringify({ event: 'gemini_rate_limit_wait', scope: 'process', waitMs, requestsPerMinute }));
      await sleep(waitMs);
      processWindowStartedAt = Date.now();
      processWindowRequestCount = 0;
    }

    processWindowRequestCount += 1;
  });
  processRateLimitQueue = waitForTurn.catch(() => undefined);
  return waitForTurn;
}

async function acquireRedisRateLimitSlot(redis) {
  const requestsPerMinute = getRequestsPerMinute();
  const windowMs = getRateLimitWindowMs();
  const key = getRateLimitKey();
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if not current then redis.call('SET', KEYS[1], 1, 'PX', ARGV[2]); return {1, 0} end",
    "if tonumber(current) < tonumber(ARGV[1]) then redis.call('INCR', KEYS[1]); return {1, 0} end",
    "return {0, redis.call('PTTL', KEYS[1])}",
  ].join('\n');

  while (true) {
    const [allowed, retryAfterMs] = await redis.eval(script, 1, key, requestsPerMinute, windowMs);
    if (Number(allowed) === 1) return;

    const waitMs = Math.max(100, Number(retryAfterMs) || windowMs);
    console.info(JSON.stringify({ event: 'gemini_rate_limit_wait', scope: 'redis', waitMs, requestsPerMinute }));
    await sleep(waitMs);
  }
}

async function acquireGeminiRateLimitSlot() {
  const redis = getRedisConnection();
  if (redis) {
    await acquireRedisRateLimitSlot(redis);
    return;
  }
  await acquireProcessRateLimitSlot();
}

function parseRetryAfterMs(response, data) {
  const retryAfterHeader = response?.headers?.get?.('retry-after');
  if (retryAfterHeader && Number.isFinite(Number(retryAfterHeader))) {
    return Math.ceil(Number(retryAfterHeader) * 1000);
  }

  const message = String(data?.error?.message || '');
  const match = message.match(/retry in\s+([\d.]+)s/i);
  if (match) return Math.ceil(Number(match[1]) * 1000);
  return 5000;
}

function isRateLimitResponse(response, data) {
  if (response?.status === 429) return true;
  const message = String(data?.error?.message || '').toLowerCase();
  return message.includes('quota exceeded') || message.includes('rate limit');
}

function getModelName() {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return model.startsWith('models/') ? model : `models/${model}`;
}

function getAzureOpenAiConfiguration() {
  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY || '').trim();
  const deployment = String(process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || '').trim();
  if (!endpoint || !apiKey || !deployment) {
    throw new Error('AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_CHAT_DEPLOYMENT are required');
  }

  return {
    endpoint,
    apiKey,
    deployment,
    apiVersion: String(process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_OPENAI_API_VERSION).trim(),
  };
}

function getAiModelName() {
  return getAiProvider() === 'azure-openai'
    ? getAzureOpenAiConfiguration().deployment
    : getModelName();
}

function extractText(response) {
  return response?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim() || '';
}

function extractAzureOpenAiText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('').trim();
  return '';
}

function parseJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  return JSON.parse(cleaned);
}

async function generateJson({ systemInstruction, prompt, temperature = 0.7 }) {
  const provider = getAiProvider();
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const azure = provider === 'azure-openai' ? getAzureOpenAiConfiguration() : null;
  if (provider === 'gemini' && !geminiApiKey) throw new Error('GEMINI_API_KEY is required');

  for (let attempt = 0; attempt <= getMaxRetries(); attempt += 1) {
    if (provider === 'gemini') await acquireGeminiRateLimitSlot();
    const response = provider === 'azure-openai'
      ? await fetch(`${azure.endpoint}/openai/deployments/${encodeURIComponent(azure.deployment)}/chat/completions?api-version=${encodeURIComponent(azure.apiVersion)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': azure.apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
          temperature,
          response_format: { type: 'json_object' },
        }),
      })
      : await fetch(`${GEMINI_API_BASE}/${getModelName()}:generateContent?key=${geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [{
            role: 'user',
            parts: [{ text: prompt }],
          }],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
          },
        }),
      });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (isRateLimitResponse(response, data) && attempt < getMaxRetries()) {
        const retryAfterMs = parseRetryAfterMs(response, data);
        console.warn(JSON.stringify({
          event: `${provider.replace(/-/g, '_')}_rate_limited_retry`,
          model: getAiModelName(),
          attempt: attempt + 1,
          retryAfterMs,
        }));
        await sleep(retryAfterMs);
        continue;
      }
      throw new Error(data.error?.message || 'Gemini request failed');
    }

    const text = provider === 'azure-openai' ? extractAzureOpenAiText(data) : extractText(data);
    if (!text) {
      throw new Error(`${provider === 'azure-openai' ? 'Azure OpenAI' : 'Gemini'} returned an empty response`);
    }

    return parseJson(text);
  }

  throw new Error('Gemini request retries were exhausted');
}

function leadSummary(lead = {}) {
  const profile = lead.personalization_profile || {};
  return {
    full_name: lead.full_name,
    title: lead.title,
    company_name: lead.company_name,
    location: lead.location,
    linkedin_url: lead.linkedin_url || null,
    person: profile.person || {},
    company: profile.company || lead.company_data || {},
    evidence: profile.email_context || [],
  };
}

function agentSummary(agentConfig = {}) {
  return {
    agent_name: agentConfig.agent_name,
    company_name: agentConfig.company_name,
    product: agentConfig.product,
    value_proposition: agentConfig.value_proposition,
    target_titles: agentConfig.target_titles,
    target_regions: agentConfig.target_regions,
    objections: agentConfig.objections,
    tone: agentConfig.tone,
    booking_link: agentConfig.booking_link,
    campaign_angle: agentConfig.campaign_angle,
  };
}

async function generateIcebreaker({ lead, companyData, agentConfig }) {
  const result = await generateJson({
    temperature: 0.7,
    systemInstruction: [
      'You write concise B2B outbound email icebreakers for Singapore SMB prospecting.',
      'Return JSON only: {"icebreaker":"..."}',
      'Use concrete lead or company data when available.',
      'Avoid clichés, fake praise, exclamation marks, em dashes, and AI filler.',
      'Do not say "Love your profile" or "I came across".',
      'One sentence only, under 24 words.',
    ].join('\n'),
    prompt: JSON.stringify({
      lead: leadSummary({ ...lead, company_data: companyData || lead?.company_data }),
      agent: agentSummary(agentConfig),
    }),
  });

  if (!result.icebreaker || typeof result.icebreaker !== 'string') {
    throw new Error('Gemini did not return an icebreaker');
  }

  return result.icebreaker.trim();
}

async function generateEmailStep({ step, lead, companyData, agentConfig, previousEmails = [], icebreaker = '' }) {
  const isFirstTouch = Number(step?.step_number || 1) === 1;
  const wordLimit = isFirstTouch ? '50-80 words' : '20-40 words';
  const result = await generateJson({
    temperature: 0.7,
    systemInstruction: [
      'You write personalized B2B outbound sales emails for Singapore SMBs.',
      'Return JSON only: {"subject":"...","body":"..."}',
      'Use plain text body. No markdown. No placeholders.',
      `Keep the email concise: ${wordLimit}.`,
      'Use one factual, source-backed detail from the supplied evidence. Use a second only when it is essential and natural.',
      'Follow the sequence instruction exactly, without repeating a prior email.',
      'Make a clear but low-pressure CTA for a short meeting.',
      'Do not include unsubscribe footer; the system appends it.',
      'Avoid em dashes, fake praise, hype, guarantees, and US-specific claims.',
    ].join('\n'),
    prompt: JSON.stringify({
      step,
      sequence_instruction: step?.ai_instruction || '',
      icebreaker,
      lead: leadSummary({ ...lead, company_data: companyData || lead?.company_data }),
      agent: agentSummary(agentConfig),
      previousEmails,
    }),
  });

  if (!result.subject || !result.body) {
    throw new Error('Gemini did not return email subject and body');
  }

  return {
    subject: String(result.subject).trim(),
    body: String(result.body).trim(),
  };
}

async function generateEmailSequence({ steps, lead, companyData, agentConfig, previousEmails = [] }) {
  const requestedSteps = Array.isArray(steps) ? steps : [];
  if (!requestedSteps.length) return [];

  const result = await generateJson({
    temperature: 0.7,
    systemInstruction: [
      'You write personalized B2B outbound sales email sequences for Singapore SMBs.',
      'Return JSON only: {"emails":[{"step_number":1,"subject":"...","body":"..."}]}.',
      'Return exactly one email for every requested step, in the same order, with no extra steps.',
      'Use plain text bodies. No markdown. No placeholders.',
      'Keep the first touch to 50-80 words and each follow-up to 20-40 words.',
      'Use one factual, source-backed detail from supplied evidence when available; never invent facts.',
      'Make the sequence progress naturally: each follow-up needs a distinct angle and must not repeat an earlier email.',
      'Follow each step instruction exactly. Make a clear, low-pressure CTA for a short meeting.',
      'Do not include unsubscribe footers; the system appends them.',
      'Avoid em dashes, fake praise, hype, guarantees, and US-specific claims.',
    ].join('\n'),
    prompt: JSON.stringify({
      requested_steps: requestedSteps.map(step => ({
        step_number: step.step_number,
        name: step.name,
        delay_days: step.delay_days,
        sequence_instruction: step.ai_instruction || '',
      })),
      lead: leadSummary({ ...lead, company_data: companyData || lead?.company_data }),
      agent: agentSummary(agentConfig),
      earlier_emails_to_preserve: previousEmails,
    }),
  });

  const byStep = new Map((Array.isArray(result.emails) ? result.emails : []).map(email => [Number(email.step_number), email]));
  return requestedSteps.map(step => {
    const email = byStep.get(Number(step.step_number));
    if (!email?.subject || !email?.body) {
      throw new Error(`Gemini did not return a complete email for sequence step ${step.step_number}`);
    }
    return {
      step_number: Number(step.step_number),
      subject: String(email.subject).trim(),
      body: String(email.body).trim(),
    };
  });
}

async function classifyIntent({ inboundMessage }) {
  const result = await generateJson({
    temperature: 0.2,
    systemInstruction: [
      'Classify an inbound B2B sales email reply.',
      'Return JSON only: {"intent":"positive|pricing|not_interested|dnc_request|auto_reply"}',
    ].join('\n'),
    prompt: JSON.stringify({ inboundMessage }),
  });

  return result.intent;
}

async function draftReply({ lead, inboundMessage, conversationHistory = [], agentConfig }) {
  const result = await generateJson({
    temperature: 0.6,
    systemInstruction: [
      'Draft a concise B2B sales reply for a Singapore SMB.',
      'Return JSON only: {"body":"..."}',
      'Respect opt-out requests. Do not make unsupported promises.',
    ].join('\n'),
    prompt: JSON.stringify({
      lead: leadSummary(lead),
      inboundMessage,
      conversationHistory,
      agent: agentSummary(agentConfig),
    }),
  });

  if (!result.body) {
    throw new Error('Gemini did not return a reply draft');
  }

  return String(result.body).trim();
}

async function mapCsvColumns({ headers, sampleRows }) {
  const approvedFields = [
    'full_name', 'first_name', 'last_name', 'company_name', 'title', 'email',
    'phone', 'location', 'linkedin_url', 'company_domain', 'company_industry',
    'company_size', 'external_id', 'ignore',
  ];
  const result = await generateJson({
    temperature: 0.1,
    systemInstruction: [
      'Map CSV lead columns to Barsha canonical fields.',
      `Allowed mappings only: ${approvedFields.join(', ')}.`,
      'Return JSON only: {"mappings":[{"source":"...","target":"...","confidence":0.0,"reason":"..."}]}',
      'Use ignore for columns that do not represent an approved field.',
      'Never infer values that are not present in the CSV.',
    ].join('\n'),
    prompt: JSON.stringify({ headers, sampleRows: (sampleRows || []).slice(0, 5) }),
  });

  const mappings = Array.isArray(result.mappings) ? result.mappings : [];
  return mappings.filter(item => headers.includes(item.source) && approvedFields.includes(item.target));
}

async function suggestTargetTerms({ product, buyer, industry }) {
  const result = await generateJson({
    temperature: 0.3,
    systemInstruction: [
      'Suggest practical B2B buyer job titles for Apollo people search.',
      'Return JSON only: {"titles":["..."],"consumer_warning":false,"explanation":"..."}.',
      'Return at most 8 concise titles. Do not invent niche facts.',
      'Set consumer_warning true when the described buyer is mainly a private consumer rather than an identifiable business buyer.',
    ].join('\n'),
    prompt: JSON.stringify({ product, buyer, industry }),
  });
  return {
    titles: Array.isArray(result.titles) ? result.titles.map(String).slice(0, 8) : [],
    consumer_warning: Boolean(result.consumer_warning),
    explanation: String(result.explanation || ''),
  };
}

module.exports = {
  classifyIntent,
  draftReply,
  generateJson,
  generateEmailSequence,
  generateEmailStep,
  generateIcebreaker,
  getAiModelName,
  getAiProvider,
  mapCsvColumns,
  suggestTargetTerms,
};
