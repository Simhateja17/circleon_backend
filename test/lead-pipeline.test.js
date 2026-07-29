const test = require('node:test');
const assert = require('node:assert/strict');

const { applyMapping, parseCsv } = require('../lib/csvLeads');
const { createQueueJobId } = require('../lib/redis');
const { calculateFitScore, usableEmail } = require('../routes/leads');
const { APOLLO_INDUSTRIES, buildDefaultFilters } = require('../lib/apollo');
const { campaignGroups } = require('../lib/autopilot');
const { nextAllowedSendAt, zonedParts } = require('../lib/campaignScheduling');

test('CSV parser preserves quoted commas and mapping keeps raw columns', () => {
  const parsed = parseCsv('Prospect,Firm,Business Email\n"Doe, Jane",Acme,jane@acme.com\n');
  assert.deepEqual(parsed.headers, ['Prospect', 'Firm', 'Business Email']);
  assert.equal(parsed.rows[0].Prospect, 'Doe, Jane');

  const mapped = applyMapping(parsed.rows[0], [
    { source: 'Prospect', target: 'full_name' },
    { source: 'Firm', target: 'company_name' },
    { source: 'Business Email', target: 'email' },
  ]);
  assert.equal(mapped.full_name, 'Doe, Jane');
  assert.equal(mapped.email, 'jane@acme.com');
  assert.equal(mapped.raw_data.csv.Firm, 'Acme');
});

test('usable email rejects generic mailboxes', () => {
  assert.equal(usableEmail('person@company.com'), true);
  assert.equal(usableEmail('info@company.com'), false);
  assert.equal(usableEmail('not-an-email'), false);
});

test('fit score is deterministic and explainable', () => {
  const result = calculateFitScore({
    title: 'Head of Operations',
    company_name: 'Acme',
    company_domain: 'acme.com',
    company_industry: 'Logistics',
    company_size: '51-200',
    company_data: { latest_funding_round_date: '2026-01-01' },
  }, {
    target_titles: ['Head of Operations'],
    industry: 'Logistics',
    company_size: '51-200',
  });

  assert.equal(result.score, 100);
  assert.equal(result.reasons.reduce((total, reason) => total + reason.points, 0), 100);
});

test('BullMQ custom job IDs never contain colons', () => {
  const id = createQueueJobId('apollo', 'f0d988e1-87dc-453d-adaa-cb1f77373cd3');
  assert.equal(id, 'apollo-f0d988e1-87dc-453d-adaa-cb1f77373cd3');
  assert.equal(id.includes(':'), false);
});

test('Apollo defaults retain the onboarding industry and provide selectable fallbacks', () => {
  const filters = buildDefaultFilters({ industry: 'logistics & supply chain' });

  assert.equal(filters.industry, 'logistics & supply chain');
  assert.equal(APOLLO_INDUSTRIES.includes('information technology & services'), true);
  assert.equal(APOLLO_INDUSTRIES.includes('logistics & supply chain'), true);
});

test('onboarding buyer titles become distinct reviewable campaign groups', () => {
  const groups = campaignGroups(['CEO', 'Founder', 'VP of Sales', 'CTO']);
  assert.deepEqual(groups.map(group => group.key), ['leadership', 'sales', 'technology']);
  assert.deepEqual(groups[0].titles, ['CEO', 'Founder']);
});

test('campaign scheduler rolls excess emails into the next allowed day', () => {
  const campaign = {
    timezone: 'Asia/Singapore', active_days: [1, 2, 3, 4, 5, 6, 0],
    daily_send_cap: 1, sending_hours_start: '09:00', sending_hours_end: '18:00',
  };
  const first = nextAllowedSendAt(new Date('2026-07-28T01:00:00.000Z'), campaign, new Map());
  const firstParts = zonedParts(first, campaign.timezone);
  const key = `${firstParts.year}-${String(firstParts.month).padStart(2, '0')}-${String(firstParts.day).padStart(2, '0')}`;
  const second = nextAllowedSendAt(new Date(first.getTime() + 60_000), campaign, new Map([[key, 1]]));
  assert.notEqual(zonedParts(second, campaign.timezone).day, firstParts.day);
});
