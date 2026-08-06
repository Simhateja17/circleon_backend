const COMMON_EVIDENCE_WORDS = new Set([
  'about', 'after', 'around', 'because', 'company', 'could', 'their', 'there', 'these', 'those',
  'through', 'using', 'which', 'would', 'your', 'you', 'with', 'from', 'that', 'this', 'into',
  'have', 'has', 'they', 'them', 'were', 'been', 'also', 'more', 'than', 'what', 'when', 'where',
]);

const SPAMMY_PHRASES = [
  'act now',
  'click here',
  'free money',
  'guaranteed',
  'limited time',
  'risk-free',
  'urgent',
  '100% free',
];

function wordCount(text) {
  return String(text || '').match(/[\p{L}\p{N}]+(?:['’/-][\p{L}\p{N}]+)*/gu)?.length || 0;
}

function evidenceTokens(evidence = []) {
  return evidence
    .flatMap(item => [item?.excerpt, item?.claim])
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'-]{5,}/g)
    ?.filter(token => !COMMON_EVIDENCE_WORDS.has(token))
    || [];
}

function validateEmailDraft({ email = {}, step = {}, evidence = [], personalizationScore = 0 }) {
  const subject = String(email.subject || '').trim();
  const body = String(email.body || '').trim();
  const errors = [];
  const subjectWords = wordCount(subject);
  const bodyWords = wordCount(body);
  const lowerBody = body.toLowerCase();

  if (subjectWords < 3 || subjectWords > 7) errors.push(`Subject must be 3-7 words, got ${subjectWords}`);
  if (/\{\{|\}\}|\[\s*(first|last|company|title|name|url)|\b(undefined|null)\b/i.test(`${subject}\n${body}`)) {
    errors.push('Email contains an unresolved merge field');
  }
  if (
    /\bI\s+(saw|noticed|read|came across)\b[^.?!\n]*(linkedin|linked-in|post|profile|website)/i.test(body)
    || /\b(?:on|from|via|through)\s+(?:your|the|their)\s+(?:linkedin|linked-in|website|profile|recent\s+(?:post|update)|post)\b/i.test(body)
    || /\b(?:your|the|their)\s+(?:linkedin|linked-in)\s+(?:post|profile|page|update)\b/i.test(body)
  ) {
    errors.push('Email exposes the research source instead of using the fact naturally');
  }
  if (/em dash|—/.test(body)) errors.push('Email contains an em dash');
  const spamPhrase = SPAMMY_PHRASES.find(phrase => lowerBody.includes(phrase));
  if (spamPhrase) errors.push(`Email contains a spammy phrase: ${spamPhrase}`);
  if (/!!+|\?{3,}/.test(body)) errors.push('Email uses excessive punctuation');

  if (Number(personalizationScore) >= 2 && evidence.length) {
    const tokens = evidenceTokens(evidence);
    const hasEvidenceToken = tokens.some(token => lowerBody.includes(token));
    if (tokens.length && !hasEvidenceToken) errors.push('Email does not contain a verifiable token from the selected evidence');
  }

  return { valid: errors.length === 0, errors, subjectWords, bodyWords };
}

function validateSequenceDrafts({ emails = [], steps = [], evidence = [], personalizationScore = 0 }) {
  const byStep = new Map((emails || []).map(email => [Number(email.step_number), email]));
  const results = steps.map(step => ({
    step_number: Number(step.step_number),
    ...validateEmailDraft({
      email: byStep.get(Number(step.step_number)) || {},
      step,
      evidence,
      personalizationScore,
    }),
  }));
  return {
    valid: results.every(result => result.valid),
    results,
    errors: results.flatMap(result => result.errors.map(error => `Step ${result.step_number}: ${error}`)),
  };
}

function appendSignature(body, signature) {
  const cleanBody = String(body || '').trim();
  const cleanSignature = String(signature || '').trim();
  if (!cleanSignature || !cleanBody) return cleanBody;
  if (cleanBody.endsWith(cleanSignature)) return cleanBody;
  return `${cleanBody}\n\n${cleanSignature}`;
}

module.exports = {
  appendSignature,
  validateEmailDraft,
  validateSequenceDrafts,
  wordCount,
};
