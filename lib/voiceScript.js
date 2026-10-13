// Composing and generating the script a voice campaign runs.
//
// Two rules shape everything here:
//
// 1. The opening line is the user's to write. We prefill a suggestion, but a
//    generated opening never ships unread, because that is the sentence the
//    call lives or dies on.
//
// 2. The AI disclosure and the recording notice are enforced in code, not left
//    to a line in a prompt that the model may or may not follow. They are
//    prepended to whatever the user wrote and cannot be edited away.

const { generateJson } = require('./gemini');

const MAX_QUALIFYING_QUESTIONS = 4;

// Disclosure wording per language. English is the only one written by someone
// who speaks it; the Mandarin text needs a native reviewer before any Mandarin
// campaign goes live, which is what the script attestation gate is for.
const DISCLOSURES = {
  en: {
    ai: (agentName, companyName) =>
      `Hi, this is ${agentName}, an AI assistant calling on behalf of ${companyName}.`,
    recording: 'This call is recorded.',
  },
  zh: {
    ai: (agentName, companyName) =>
      `您好，我是 ${companyName} 的人工智能助理 ${agentName}。`,
    recording: '本次通话将被录音。',
  },
};

function languageFamily(language) {
  return String(language || 'en-US').toLowerCase().split('-')[0];
}

function disclosureFor(language) {
  return DISCLOSURES[languageFamily(language)] || DISCLOSURES.en;
}

/**
 * The first thing the prospect hears. Mandatory disclosure, then the recording
 * notice if recording is on, then the line the user wrote.
 *
 * The notice comes before anything else because recording begins at connect: a
 * notice delivered later would arrive after collection has already started.
 */
function composeOpeningLine({ openingLine, agentName, companyName, language, recordingEnabled }) {
  const disclosure = disclosureFor(language);
  const parts = [disclosure.ai(agentName || 'CircleOn AI', companyName || 'the company I represent')];

  if (recordingEnabled !== false) parts.push(disclosure.recording);
  if (openingLine) parts.push(String(openingLine).trim());

  return parts.join(' ');
}

function bulletList(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return 'None provided.';
  return values.map(value => `- ${value}`).join('\n');
}

/**
 * The full system prompt sent to Retell, composed from the structured fields the
 * user reviewed. A user who wants total control can supply `custom_prompt`,
 * which replaces the body but never the compliance sections.
 */
function composeVoicePrompt({ script, campaign, workspace, agentConfig, recordingEnabled }) {
  const companyName = agentConfig?.company_name || workspace?.name || 'the company I represent';
  const agentName = agentConfig?.agent_name || 'CircleOn AI';
  const bookingLink = agentConfig?.booking_link || '';

  const body = script?.custom_prompt?.trim() || `# YOUR JOB
You are booking a short introductory meeting. You are not selling. Keep the call under two minutes.

## Objective
${script?.objective || 'Book a short introductory meeting.'}

## What ${companyName} offers
${script?.offer || agentConfig?.value_proposition || 'Not provided.'}

## Questions you may ask, if the conversation allows
${bulletList(script?.qualifying_questions)}

## Handling objections
${script?.objection_handling || 'Acknowledge the objection once, offer a short meeting, and do not push a second time.'}

## What counts as success
${script?.success_criteria || 'The prospect agrees to a meeting time.'}

## Booking
- The moment the prospect shows interest, call check_availability. Never guess or
  invent a time, and never read a web address aloud.
- Offer at most two of the times it returns. If neither suits, ask what part of
  the week is better and offer from the remaining times.
- Once they agree to a time, call book_meeting with that exact start value, and
  ask for the best email if you do not already have one.
- If the tools tell you no calendar is available, say you will send a booking
  link by email and confirm the address.${bookingLink ? `\n- Booking link, only if they ask for it directly: ${bookingLink}` : ''}`;

  return `# IDENTITY AND DISCLOSURE
You are an AI assistant calling on behalf of ${companyName}. You have already
disclosed this in your opening line. If asked at any point whether you are a
human, say plainly that you are an AI assistant. Never imply otherwise.

# COMPLIANCE, NON-NEGOTIABLE
- If the prospect asks not to be called again, acknowledge it warmly, end the
  call, and record the outcome as do_not_call.
- If they say nobody at their company should be called, record that it applies
  to the whole company, not just to them.
- If they object to being recorded, tell them you will note it, and end the call
  politely rather than continuing to record.
- Never pressure, mislead, or overstate what ${companyName} does.
- If they are busy, offer to call back and end the call within fifteen seconds.

# CONVERSATION
${body}

# STYLE
- Speak the way a person does on the phone: short sentences, no lists read aloud.
- One question at a time, then wait.
- If the prospect is not interested, thank them and end the call. Do not try a
  second angle.`;
}

/**
 * Draft a script from the campaign brief, mirroring how email sequences are
 * already generated. Returns structured fields for the user to review, never a
 * finished prompt, and deliberately never an opening line.
 */
async function generateVoiceScript({ campaign, agentConfig, language = 'en-US' }) {
  const brief = campaign?.brief || {};
  const config = brief.agent_config || agentConfig || {};

  const systemInstruction = `You write scripts for short outbound phone calls made by an AI appointment setter.
The only goal of the call is to book a short introductory meeting. The agent does not sell, negotiate, or pitch at length.
Calls must stay under two minutes. Write for the ear, not the page: short sentences, plain words, no marketing language.
Respond with JSON only.`;

  const prompt = `Write the script fields for this outbound calling campaign.

Company: ${config.company_name || 'Unknown'}
What they offer: ${config.value_proposition || config.product || 'Unknown'}
People they are calling: ${(config.target_titles || []).join(', ') || 'Unknown'}
Campaign angle: ${brief.campaign_angle || 'None given'}
Proof or credibility points: ${brief.proof || 'None given'}
Known objections: ${config.objections || 'None given'}
Tone: ${brief.tone || config.tone || 'Warm and direct'}
Language for the script: ${language}

Return JSON with exactly these keys:
{
  "objective": "one sentence, what this call is for",
  "offer": "two sentences at most, what the company does, in words a stranger understands",
  "qualifying_questions": ["at most ${MAX_QUALIFYING_QUESTIONS} short questions, each answerable in one breath"],
  "objection_handling": "how to respond to the most likely brush-off, in two sentences",
  "success_criteria": "one sentence describing what a successful call looks like",
  "suggested_opening_line": "one sentence the caller could say after introducing themselves, as a starting point for the user to rewrite"
}`;

  const result = await generateJson({ systemInstruction, prompt, temperature: 0.6 });

  return {
    objective: result?.objective || '',
    offer: result?.offer || '',
    qualifying_questions: Array.isArray(result?.qualifying_questions)
      ? result.qualifying_questions.slice(0, MAX_QUALIFYING_QUESTIONS)
      : [],
    objection_handling: result?.objection_handling || '',
    success_criteria: result?.success_criteria || '',
    // Offered as a starting point only. Never written straight into
    // opening_line: the user has to accept or rewrite it themselves.
    suggested_opening_line: result?.suggested_opening_line || '',
  };
}

module.exports = {
  MAX_QUALIFYING_QUESTIONS,
  composeOpeningLine,
  composeVoicePrompt,
  disclosureFor,
  generateVoiceScript,
  languageFamily,
};
