const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendUniquePreviewPeople,
  buildPreviewMatchPatch,
  dedupePreviewPeople,
  hasEnoughPreviewResearch,
  isUsableWorkEmail,
  normalizePreviewInput,
  previewFitScore,
} = require('../lib/freeLeadPreview');
const { buildFreeLeadPreviewEmail, leadView } = require('../lib/freeLeadPreviewEmail');

test('free lead preview normalizes the five targeting answers', () => {
  const result = normalizePreviewInput({
    company: '  Acme  ',
    whatYouSell: 'Revenue operations software',
    whoBuys: 'VP Sales, Founder; Head of Revenue',
    targetIndustry: 'B2B SaaS',
    location: 'Singapore',
    targetCompanySize: '51-200 employees',
    email: 'OWNER@ACME.COM',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.titles, ['VP Sales', 'Founder', 'Head of Revenue']);
  assert.equal(result.email, 'owner@acme.com');
  assert.deepEqual(result.errors, {});
});

test('free lead preview rejects an incomplete request', () => {
  const result = normalizePreviewInput({ company: 'Acme', email: 'not-an-email' });

  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result.errors).sort(), [
    'companySize',
    'email',
    'industry',
    'product',
    'region',
    'titles',
  ]);
});

test('preview candidates are deduplicated by Apollo identity and profile', () => {
  const people = [
    { id: 'person-1', first_name: 'Jane', last_name: 'Doe', organization_name: 'Acme' },
    { id: 'person-1', first_name: 'Jane', last_name: 'Doe', organization_name: 'Acme' },
    { id: 'person-2', first_name: 'Jane', last_name: 'Doe', organization_name: 'Acme' },
    { id: 'person-3', first_name: 'Sam', last_name: 'Lee', organization_name: 'Other Co' },
    { first_name: 'Missing', last_name: 'Id' },
  ];

  assert.deepEqual(dedupePreviewPeople(people).map(person => person.id), ['person-1', 'person-3']);
  assert.deepEqual(
    appendUniquePreviewPeople([{ id: 'person-1', first_name: 'Jane', last_name: 'Doe', organization_name: 'Acme' }], people, 3)
      .map(person => person.id),
    ['person-1', 'person-3'],
  );
});

test('preview fit scoring explains a complete audience match', () => {
  const result = previewFitScore({
    title: 'VP Sales',
    company_name: 'Acme',
    location: 'Singapore',
    company_domain: 'acme.example',
    company_data: {
      industry: 'B2B SaaS',
      estimated_num_employees: 120,
      domain: 'acme.example',
    },
  }, {
    target_titles: ['VP Sales'],
    target_industry: 'SaaS',
    target_region: 'Singapore',
    target_company_size: '51-200',
  });

  assert.equal(result.score, 100);
  assert.deepEqual(result.reasons.map(reason => reason.reason), [
    'Buyer role matches',
    'Target industry matches',
    'Target location matches',
    'Company-size information is available',
    'Contact and company information is available',
  ]);
});

test('only verified individual work emails with core contact data qualify for a preview report', () => {
  assert.equal(isUsableWorkEmail('jane@acme.example'), true);
  assert.equal(isUsableWorkEmail('info@acme.example'), false);
  assert.equal(isUsableWorkEmail('jane@acme'), false);

  const lead = {
    full_name: 'Jane Doe',
    title: 'VP Sales',
    company_name: 'Acme',
    email: 'jane@acme.example',
    company_data: { domain: 'acme.example' },
  };
  assert.equal(hasEnoughPreviewResearch(lead), true);
  assert.equal(hasEnoughPreviewResearch({ ...lead, email: 'info@acme.example' }), false);
  assert.equal(hasEnoughPreviewResearch({ ...lead, company_data: {} }), true);
  assert.equal(hasEnoughPreviewResearch({ ...lead, title: '' }), false);
});

test('a verified Apollo contact remains reportable when optional company enrichment is unavailable', () => {
  assert.equal(hasEnoughPreviewResearch({
    full_name: 'Jane Doe',
    title: 'VP Sales',
    company_name: 'Acme',
    email: 'jane@acme.example',
    company_data: {},
    personalization_profile: {},
  }), true);
});

test('preview stores Apollo bulk-match research before the waterfall email callback', () => {
  const patch = buildPreviewMatchPatch({
    full_name: 'Jane Doe',
    company_name: 'Acme',
    title: 'VP Sales',
    company_data: {},
    personalization_profile: {},
    enrichment_data: {},
  }, {
    personId: 'person-1',
    match: {
      id: 'person-1',
      first_name: 'Jane',
      last_name: 'Doe',
      title: 'VP Sales',
      organization: {
        name: 'Acme',
        primary_domain: 'acme.example',
        industry: 'B2B SaaS',
      },
    },
    companyDomain: 'acme.example',
  });

  assert.equal(patch.company_domain, 'acme.example');
  assert.equal(patch.company_data.domain, 'acme.example');
  assert.equal(patch.personalization_profile.company.industry, 'B2B SaaS');
  assert.equal(patch.enrichment_data.match.id, 'person-1');
});

test('branded preview email renders the same research sections as lead research', () => {
  const lead = {
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    title: 'VP Sales',
    company_name: 'Acme & Co',
    email: 'jane@acme.example',
    location: 'Singapore',
    linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    company_domain: 'acme.example',
    company_data: {
      name: 'Acme & Co',
      industry: 'B2B SaaS',
      domain: 'acme.example',
      estimated_num_employees: 120,
      founded_year: 2013,
      latest_funding_stage: 'Series A',
      latest_funding_round_date: '2026-01-01',
      total_funding: 2500000,
      annual_revenue: 9000000,
      short_description: 'Revenue operations software for growing teams.',
      technologies: ['HubSpot'],
    },
    personalization_profile: {
      person: {
        linkedin_url: 'https://www.linkedin.com/in/jane-doe',
        departments: ['Sales'],
        relevant_experience: [{ title: 'Sales Director', organization: 'Earlier Co', current: false }],
      },
      company: { technologies: ['HubSpot'] },
      email_context: [{ fact: 'Acme & Co operates in B2B SaaS', source: 'Apollo company enrichment' }],
    },
  };
  const view = leadView(lead);
  const message = buildFreeLeadPreviewEmail({
    request: { company_name: 'BuyerCo', email: 'owner@buyer.example' },
    leads: [lead],
    frontendUrl: 'https://circleon.example',
  });

  assert.equal(view.initials, 'JD');
  assert.match(message.subject, /1 matched lead/);
  assert.match(message.text, /Contact intelligence/);
  assert.match(message.text, /Relevant experience/);
  assert.match(message.text, /Company intelligence/);
  assert.match(message.text, /Technology signals/);
  assert.match(message.html, /Acme &amp; Co/);
  assert.match(message.html, /Get unlimited leads/);
  assert.match(message.html, /https:\/\/circleon\.example\/signup\?source=free-leads/);
  assert.match(message.html, /No outreach has been sent/);
  assert.doesNotMatch(message.html, /https:\/\/apollo%20company%20enrichment/);
});
