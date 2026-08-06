const test = require('node:test');
const assert = require('node:assert/strict');

const { actorInput, businessEmailDomain, getResearchTargets } = require('../lib/apify');
const { buildApolloMatchProfilePatch, extractBulkMatchUpdates, normalizeApolloLead } = require('../lib/apollo');
const { appendSignature, validateEmailDraft } = require('../lib/emailValidation');
const { normalizeResearch, saveNormalizedProfile, shouldRefreshApifyResearch } = require('../lib/leadResearch');
const { sequenceSubjectTarget } = require('../lib/gemini');
const { enqueueGeneration } = require('../workers/lead-research.worker');

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

test('Apollo bulk matches preserve person and company LinkedIn targets', () => {
  const updates = extractBulkMatchUpdates({
    request_id: 'request-1',
    matches: [{
      id: 'apollo-person-1',
      first_name: 'Jane',
      last_name: 'Doe',
      linkedin_url: 'http://www.linkedin.com/in/jane-doe',
      organization: {
        name: 'Acme',
        linkedin_url: 'http://www.linkedin.com/company/acme',
        website_url: 'https://acme.example',
      },
    }],
  });

  assert.equal(updates[0].personId, 'apollo-person-1');
  assert.equal(updates[0].linkedinUrl, 'http://www.linkedin.com/in/jane-doe');
  assert.equal(updates[0].companyLinkedinUrl, 'http://www.linkedin.com/company/acme');
  assert.equal(updates[0].companyDomain, 'acme.example');
  assert.equal(updates[0].match.organization.name, 'Acme');
});

test('Apollo normalization promotes LinkedIn and company domain fields', () => {
  const lead = normalizeApolloLead({
    id: 'apollo-person-1',
    first_name: 'Jane',
    last_name: 'Doe',
    linkedin_url: 'http://www.linkedin.com/in/jane-doe',
    organization: {
      name: 'Acme',
      linkedin_url: 'http://www.linkedin.com/company/acme',
      website_url: 'https://acme.example',
    },
  });

  assert.equal(lead.linkedin_url, 'http://www.linkedin.com/in/jane-doe');
  assert.equal(lead.company_domain, 'acme.example');
  assert.equal(lead.company_data.linkedin_url, 'http://www.linkedin.com/company/acme');
  assert.equal(lead.personalization_profile.company.linkedin_url, 'http://www.linkedin.com/company/acme');
});

test('Apollo match profile patch promotes URLs without discarding existing research metadata', () => {
  const patch = buildApolloMatchProfilePatch({
    linkedin_url: '',
    company_data: { name: 'Acme', industry: 'Logistics' },
    personalization_profile: {
      source: 'apify',
      evidence: [{ source_type: 'company_website', excerpt: 'Existing evidence' }],
      person: { title: 'Head of Operations' },
      company: { name: 'Acme', industry: 'Logistics' },
    },
  }, {
    personId: 'apollo-person-1',
    linkedinUrl: 'http://www.linkedin.com/in/jane-doe',
    companyLinkedinUrl: 'http://www.linkedin.com/company/acme',
    companyDomain: 'acme.example',
    match: {
      id: 'apollo-person-1',
      first_name: 'Jane',
      last_name: 'Doe',
      title: 'Head of Operations',
      linkedin_url: 'http://www.linkedin.com/in/jane-doe',
      organization: {
        name: 'Acme',
        industry: 'Logistics',
        linkedin_url: 'http://www.linkedin.com/company/acme',
        website_url: 'https://acme.example',
      },
    },
  });

  assert.equal(patch.linkedin_url, 'http://www.linkedin.com/in/jane-doe');
  assert.equal(patch.company_domain, 'acme.example');
  assert.equal(patch.company_data.linkedin_url, 'http://www.linkedin.com/company/acme');
  assert.equal(patch.company_data.domain, 'acme.example');
  assert.equal(patch.personalization_profile.source, 'apify');
  assert.equal(patch.personalization_profile.person.linkedin_url, 'http://www.linkedin.com/in/jane-doe');
  assert.equal(patch.personalization_profile.company.linkedin_url, 'http://www.linkedin.com/company/acme');
  assert.equal(patch.personalization_profile.evidence[0].excerpt, 'Existing evidence');
});

test('research can use a verified business email domain when Apollo has no website URL', () => {
  assert.equal(businessEmailDomain('alfonso_andrew@ite.edu.sg'), 'ite.edu.sg');
  assert.equal(businessEmailDomain('person@gmail.com'), null);
  assert.deepEqual(getResearchTargets({ email: 'alfonso_andrew@ite.edu.sg' }), {
    personUrl: null,
    personUsername: null,
    companyUrl: null,
    websiteUrl: 'https://ite.edu.sg',
  });
});

test('Apify refresh bypasses an otherwise fresh Apollo fallback cache when a target exists', () => {
  const lead = {
    research_status: 'fallback',
    research_expires_at: '2026-08-13T12:39:47.476Z',
    personalization_profile: { source: 'apollo_fallback' },
  };
  const targets = getResearchTargets({ ...lead, email: 'alfonso_andrew@ite.edu.sg' });
  assert.equal(shouldRefreshApifyResearch(lead, targets, { enabled: true }), true);
  assert.equal(shouldRefreshApifyResearch(lead, targets, { enabled: false }), false);
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

test('research profile persistence stores actor references from the Apify run', async () => {
  const patches = {};
  const supabase = {
    from(table) {
      return {
        insert: async () => ({ error: null }),
        update(patch) {
          patches[table] = patch;
          return {
            eq() { return this; },
            select() { return this; },
            single: async () => ({ data: { id: 'run-1', ...patch }, error: null }),
          };
        },
      };
    },
  };
  const actorRefs = [{ kind: 'website', run_id: 'apify-run-1', status: 'succeeded' }];

  const saved = await saveNormalizedProfile({
    supabase,
    lead: { id: 'lead-1', research_profile_version: 0, personalization_profile_version: 0 },
    workspaceId: 'workspace-1',
    campaignId: 'campaign-1',
    run: { id: 'run-1' },
    profile: { source: 'apify', evidence: [], personalization_score: 2, source_fields_used: [] },
    status: 'completed',
    runStatus: 'completed',
    actorRefs,
    config: { cacheTtlDays: 7 },
    now: NOW,
  });

  assert.equal(saved.id, 'run-1');
  assert.deepEqual(patches.lead_research_runs.actor_refs, actorRefs);
});

test('email validation keeps safety checks while allowing useful longer bodies', () => {
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

  const longerFollowUp = validateEmailDraft({
    step: { step_number: 2, name: 'Follow-up' },
    email: {
      subject: 'A simpler hiring support option',
      body: 'One idea worth considering is using external support to cover peak hiring periods without forcing a permanent team change. That can give your internal team more flexibility while keeping priorities moving. If that is useful, I can outline a simple setup and the expected handoff in 10 minutes.',
    },
  });
  assert.ok(longerFollowUp.bodyWords > 35);
  assert.equal(longerFollowUp.valid, true);

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

test('lead research hands off to campaign generation with a valid queue job id', async () => {
  const added = [];
  const queue = {
    getJob: async () => null,
    add: async (...args) => { added.push(args); },
  };
  const result = await enqueueGeneration({
    workspaceId: 'workspace-1',
    campaignId: 'campaign-1',
    leadIds: ['lead-1'],
    queue,
  });

  assert.equal(result.jobId, 'campaign-generate-campaign-1');
  assert.deepEqual(added[0], [
    'generate-sequence',
    { workspaceId: 'workspace-1', campaignId: 'campaign-1', leadIds: ['lead-1'] },
    { jobId: 'campaign-generate-campaign-1' },
  ]);
});

test('email subject targets remain concise without body word targets', () => {
  assert.deepEqual(sequenceSubjectTarget({ step_number: 1, name: 'Intro' }), {
    subjectMin: 4,
    subjectMax: 6,
  });
  assert.deepEqual(sequenceSubjectTarget({ step_number: 3, name: 'Breakup' }), {
    subjectMin: 4,
    subjectMax: 6,
  });
});
