const { normalizePhone } = require('./calling');

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const APOLLO_BLOCK_REASON = 'Lead requires DNC clearance or explicit voice consent';
const DEFAULT_IMPORT_LIMIT = 25;
const MAX_IMPORT_LIMIT = 100;
const BULK_ENRICHMENT_BATCH_SIZE = 10;

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMPORT_LIMIT;
  return Math.min(parsed, MAX_IMPORT_LIMIT);
}

function employeeRanges(companySize) {
  const value = clean(companySize).toLowerCase();
  if (!value) return [];
  if (value.includes('1-10') || value.includes('1 to 10')) return ['1,10'];
  if (value.includes('11-50') || value.includes('11 to 50')) return ['11,50'];
  if (value.includes('51-200') || value.includes('51 to 200')) return ['51,200'];
  if (value.includes('201-500') || value.includes('201 to 500')) return ['201,500'];
  if (value.includes('501-1000') || value.includes('501 to 1000')) return ['501,1000'];
  if (value.includes('1000')) return ['1001,5000'];
  return [companySize];
}

function buildDefaultFilters(agentConfig = {}) {
  const titles = splitList(agentConfig.target_titles);
  return {
    titles: titles.length ? titles : ['Founder', 'CEO', 'Managing Director', 'Head of Sales'],
    region: clean(agentConfig.target_regions || agentConfig.city || 'Singapore'),
    industry: clean(agentConfig.industry),
    companySize: clean(agentConfig.company_size),
    limit: DEFAULT_IMPORT_LIMIT,
  };
}

function normalizeFilters(input = {}, agentConfig = {}) {
  const defaults = buildDefaultFilters(agentConfig);
  const titles = splitList(input.titles || input.target_titles);
  return {
    titles: titles.length ? titles : defaults.titles,
    region: clean(input.region || input.target_regions) || defaults.region,
    industry: clean(input.industry) || defaults.industry,
    companySize: clean(input.companySize || input.company_size) || defaults.companySize,
    limit: clampLimit(input.limit || defaults.limit),
  };
}

function getWebhookUrl() {
  if (process.env.APOLLO_WEBHOOK_URL) return process.env.APOLLO_WEBHOOK_URL;
  if (!process.env.APP_PUBLIC_URL) return null;
  return `${process.env.APP_PUBLIC_URL.replace(/\/$/, '')}/api/apollo/webhook`;
}

async function apolloFetch(path, body, query = {}) {
  if (!process.env.APOLLO_API_KEY) {
    const error = new Error('APOLLO_API_KEY is not configured');
    error.statusCode = 400;
    throw error;
  }

  const url = new URL(`${APOLLO_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value.filter(item => item !== undefined && item !== null && item !== '').forEach(item => {
        url.searchParams.append(key, String(item));
      });
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `Apollo request failed with ${response.status}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function peopleFromSearchPayload(payload) {
  return payload.people || payload.contacts || payload.persons || payload.results || [];
}

async function searchPeople(filters) {
  const query = {
    page: 1,
    per_page: filters.limit,
    'person_titles[]': filters.titles,
  };

  const locations = splitList(filters.region);
  if (locations.length) query['person_locations[]'] = locations;

  const ranges = employeeRanges(filters.companySize);
  if (ranges.length) query['organization_num_employees_ranges[]'] = ranges;

  if (filters.industry) {
    query['q_organization_keyword_tags[]'] = [filters.industry];
  }

  const payload = await apolloFetch('/mixed_people/api_search', {}, query);
  return { people: peopleFromSearchPayload(payload).slice(0, filters.limit), payload };
}

function apolloPersonId(person = {}) {
  return clean(person.id || person.person_id || person.apollo_id || person.contact_id);
}

function normalizeApolloLead(person = {}, sourcePayload = {}) {
  const organization = person.organization || person.account || {};
  const firstName = clean(person.first_name);
  const lastName = clean(person.last_name);
  const name = clean(person.name || person.full_name || `${firstName} ${lastName}`);
  const phone = clean(
    person.phone
    || person.phone_number
    || person.sanitized_phone
    || person.mobile_phone
    || person.direct_phone
    || person.organization_phone
  );

  return {
    external_id: apolloPersonId(person),
    full_name: name || 'Apollo lead',
    company_name: clean(person.organization_name || person.company || organization.name),
    title: clean(person.title || person.headline),
    phone,
    phone_e164: normalizePhone(phone),
    email: clean(person.email || person.email_address).toLowerCase(),
    location: clean(person.city || person.state || person.country || person.location),
    status: 'new',
    priority: 'normal',
    voice_consent_status: 'unknown',
    dnc_status: 'unknown',
    callable_block_reason: APOLLO_BLOCK_REASON,
    raw_data: {
      apollo: {
        searchPerson: person,
        searchMeta: sourcePayload,
        enrichment_status: 'pending',
      },
    },
  };
}

function enrichmentDetail(person = {}) {
  const detail = {};
  const id = apolloPersonId(person);
  if (id) detail.id = id;
  if (person.linkedin_url) detail.linkedin_url = person.linkedin_url;
  if (person.email) detail.email = person.email;
  if (person.first_name) detail.first_name = person.first_name;
  if (person.last_name) detail.last_name = person.last_name;
  if (person.organization_name) detail.organization_name = person.organization_name;
  if (person.title) detail.title = person.title;
  return detail;
}

async function requestBulkEnrichment(people, importRunId) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    const error = new Error('APOLLO_WEBHOOK_URL or APP_PUBLIC_URL is required for Apollo phone enrichment');
    error.statusCode = 400;
    throw error;
  }
  const batches = [];

  for (let index = 0; index < people.length; index += BULK_ENRICHMENT_BATCH_SIZE) {
    const batch = people.slice(index, index + BULK_ENRICHMENT_BATCH_SIZE);
    if (!batch.length) continue;

    const query = {
      reveal_phone_number: true,
      run_waterfall_email: true,
    };
    query.webhook_url = webhookUrl;

    const payload = await apolloFetch('/people/bulk_match', {
      details: batch.map(enrichmentDetail),
      reveal_phone_number: true,
      run_waterfall_email: true,
      webhook_url: webhookUrl || undefined,
      client_reference_id: importRunId,
    }, query);

    batches.push({
      request_id: clean(payload.request_id || payload.id || payload.batch_id),
      payload,
      people: batch.map(person => apolloPersonId(person)).filter(Boolean),
    });
  }

  return batches;
}

function walk(value, visitor) {
  if (!value || typeof value !== 'object') return;
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => walk(item, visitor));
    return;
  }
  Object.values(value).forEach(item => walk(item, visitor));
}

function extractWebhookUpdates(payload = {}) {
  const updates = [];
  walk(payload, node => {
    const personId = clean(node.person_id || node.apollo_person_id || node.apollo_id || node.id);
    const email = clean(node.email || node.email_address).toLowerCase();
    const phone = clean(
      node.phone
      || node.phone_number
      || node.sanitized_phone
      || node.mobile_phone
      || node.direct_phone
      || node.revealed_phone_number
    );

    if (personId || email || phone) {
      updates.push({
        personId,
        email,
        phone,
        phone_e164: normalizePhone(phone),
        requestId: clean(node.request_id || node.batch_id || payload.request_id || payload.id),
        raw: node,
      });
    }
  });

  const unique = new Map();
  for (const update of updates) {
    const key = update.personId || update.email || update.phone;
    if (!key) continue;
    unique.set(key, { ...unique.get(key), ...update });
  }
  return [...unique.values()];
}

module.exports = {
  APOLLO_BLOCK_REASON,
  DEFAULT_IMPORT_LIMIT,
  buildDefaultFilters,
  normalizeFilters,
  normalizeApolloLead,
  requestBulkEnrichment,
  searchPeople,
  apolloPersonId,
  extractWebhookUpdates,
  getWebhookUrl,
};
