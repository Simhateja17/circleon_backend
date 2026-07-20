const DEFAULT_MODEL = 'gemini-3.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function getModelName() {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  return model.startsWith('models/') ? model : `models/${model}`;
}

function extractText(response) {
  return response?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim() || '';
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required');
  }

  const response = await fetch(`${GEMINI_API_BASE}/${getModelName()}:generateContent?key=${apiKey}`, {
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
    throw new Error(data.error?.message || 'Gemini request failed');
  }

  const text = extractText(data);
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJson(text);
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
  generateEmailStep,
  generateIcebreaker,
  mapCsvColumns,
  suggestTargetTerms,
};
