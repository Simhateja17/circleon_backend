const test = require('node:test');
const assert = require('node:assert/strict');

const { applyMapping, parseCsv } = require('../lib/csvLeads');
const { calculateFitScore, usableEmail } = require('../routes/leads');

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
