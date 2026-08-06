const test = require('node:test');
const assert = require('node:assert/strict');

const { actorInput } = require('../lib/apify');
const { appendSignature, validateEmailDraft } = require('../lib/emailValidation');
const { normalizeResearch } = require('../lib/leadResearch');

const NOW = new Date('2026-08-06T08:00:00.000Z');

test('Apify actor inputs preserve public URLs and configured research limits', () => {
  const config = {
    limits: { websitePages: 20, websiteDepth: 2, personPosts: 10, companyPosts: 10 },
  };
  assert.deepEqual(actorInput('companyProfile', 'https://www.linkedin.com/company/acme', config), {
    companies: ['https://www.linkedin.com/company/acme'],
  });
  assert.deepEqual(actorInput('personPosts', 'jane-doe', config), {
    username: 'jane-doe',
    total_posts: 10,
  });
  assert.deepEqual(actorInput('companyPosts', 'https://www.linkedin.com/company/acme', config), {
    company_names: ['https://www.linkedin.com/company/acme'],
    limit: 10,
  });
  assert.equal(actorInput('website', 'https://acme.example', config).maxCrawlPages, 20);
});

test('research normalization prioritizes recent public posts and keeps provenance', () => {
  const profile = normalizeResearch({
    now: NOW,
    lead: {
      id: 'lead-1',
      full_name: 'Jane Doe',
      first_name: 'Jane',
      title: 'Head of Operations',
      company_name: 'Acme',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      company_data: { industry: 'Logistics' },
    },
    sourceResults: [
      {
        kind: 'personPosts',
        sourceUrl: 'https://www.linkedin.com/in/jane-doe',
        items: [{
          text: 'We launched a new dispatch workflow for regional teams.',
          url: 'https://www.linkedin.com/posts/jane-launch',
          posted_at: { timestamp: new Date('2026-08-01T10:00:00.000Z').getTime() },
          post_type: 'regular',
          author: { first_name: 'Jane', headline: 'Head of Operations at Acme' },
        }],
      },
      {
        kind: 'companyProfile',
        sourceUrl: 'https://www.linkedin.com/company/acme',
        items: [{ name: 'Acme', industries: ['Logistics'], description: 'Regional logistics software.' }],
      },
    ],
  });

  assert.equal(profile.personalization_score, 3);
  assert.equal(profile.source, 'apify');
  assert.equal(profile.evidence[0].source_type, 'linkedin_person_post');
  assert.equal(profile.evidence[0].source_url, 'https://www.linkedin.com/posts/jane-launch');
  assert.match(profile.evidence[0].excerpt, /dispatch workflow/);
  assert.equal(profile.person.recent_activity_type, 'regular');
});

test('research normalization falls back to explicit Apollo fields without inventing a hook', () => {
  const profile = normalizeResearch({
    now: NOW,
    lead: {
      title: 'Finance Director',
      company_name: 'Acme',
      company_data: { industry: 'Manufacturing' },
    },
    sourceResults: [],
  });

  assert.equal(profile.personalization_score, 1);
  assert.equal(profile.source, 'apollo_fallback');
  assert.equal(profile.evidence[0].source_type, 'apollo');
  assert.equal(profile.evidence.some(item => item.source_type === 'linkedin_person_post'), false);
});

test('email validation enforces concise sequence lengths and rejects source disclosure', () => {
  const validBody = [
    'Hi Jane,',
    'Your dispatch workflow for regional teams stood out because operations teams often need a simple way to keep new processes visible.',
    'We help teams reduce follow-up gaps without replacing their existing tools.',
    'The setup is practical, lightweight, and designed to fit the process you already use.',
    'Would a 10-minute conversation next week be useful?',
  ].join(' ');
  const valid = validateEmailDraft({
    step: { step_number: 1, name: 'Intro' },
    email: { subject: 'Dispatch workflow follow-up', body: validBody },
    evidence: [{ excerpt: 'We launched a new dispatch workflow for regional teams.' }],
    personalizationScore: 3,
  });
  assert.equal(valid.valid, true);

  const invalid = validateEmailDraft({
    step: { step_number: 1, name: 'Intro' },
    email: { subject: 'Hi', body: 'I saw your LinkedIn post. {{company_name}}' },
    evidence: [{ excerpt: 'dispatch workflow' }],
    personalizationScore: 3,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => /3-7 words/.test(error)));
  assert.ok(invalid.errors.some(error => /source|merge/i.test(error)));

  const disclosedLocation = validateEmailDraft({
    step: { step_number: 2, name: 'Bump' },
    email: { subject: 'A relevant follow-up', body: 'On your LinkedIn profile, I noticed the operations focus and wanted to share a practical idea for your team.' },
  });
  assert.ok(disclosedLocation.errors.some(error => /source/i.test(error)));
});

test('campaign signatures are appended without being changed by the writer', () => {
  assert.equal(appendSignature('Hello there.', 'Teja\nBarsha'), 'Hello there.\n\nTeja\nBarsha');
  assert.equal(appendSignature('Hello there.\n\nTeja\nBarsha', 'Teja\nBarsha'), 'Hello there.\n\nTeja\nBarsha');
});
