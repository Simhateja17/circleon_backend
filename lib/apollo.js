const { normalizePhone } = require('./calling');

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const APOLLO_BLOCK_REASON = 'Apollo email enrichment pending';
const DEFAULT_IMPORT_LIMIT = 25;
const MAX_IMPORT_LIMIT = 100;
const BULK_ENRICHMENT_BATCH_SIZE = 10;

function debug(event, details = {}) {
  if (process.env.APOLLO_DEBUG === 'false') return;
  console.log(`[apollo:${event}]`, JSON.stringify(details));
}

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

async function apolloFetch(path, body, query = {}, method = 'POST') {
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
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': process.env.APOLLO_API_KEY,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    debug('request_failed', {
      path,
      method,
      status: response.status,
      error: payload.error || payload.message || null,
    });
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

async function searchPeople(filters, page = 1, perPage = 100) {
  const query = {
    page,
    per_page: Math.min(Math.max(Number(perPage) || 100, 1), 100),
    'person_titles[]': filters.titles,
    include_similar_titles: true,
    'contact_email_status[]': ['verified', 'likely to engage', 'unverified'],
  };

  const locations = splitList(filters.region);
  if (locations.length) query['person_locations[]'] = locations;

  const ranges = employeeRanges(filters.companySize);
  if (ranges.length) query['organization_num_employees_ranges[]'] = ranges;

  if (filters.industry) {
    query['q_organization_keyword_tags[]'] = [filters.industry];
  }

  const payload = await apolloFetch('/mixed_people/api_search', {}, query);
  const people = peopleFromSearchPayload(payload);
  debug('people_search_complete', {
    page,
    perPage: query.per_page,
    returned: people.length,
    hasPagination: Boolean(payload.pagination),
  });
  return { people, payload };
}

function organizationFromPerson(person = {}) {
  return person.organization || person.account || person.employment_history?.[0]?.organization || {};
}

function organizationDomain(organization = {}, person = {}) {
  return clean(
    organization.primary_domain
    || organization.domain
    || organization.website_url
    || organization.website
    || person.organization_website_url
  )
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

function organizationName(organization = {}, person = {}) {
  return clean(person.organization_name || person.company || organization.name);
}

function compactOrganizationData(organization = {}) {
  return {
    id: clean(organization.id),
    name: clean(organization.name),
    domain: organizationDomain(organization),
    website_url: clean(organization.website_url || organization.website),
    linkedin_url: clean(organization.linkedin_url),
    industry: clean(organization.industry),
    estimated_num_employees: organization.estimated_num_employees || organization.num_employees || null,
    annual_revenue: organization.annual_revenue || null,
    total_funding: organization.total_funding || null,
    latest_funding_round_date: clean(organization.latest_funding_round_date),
    latest_funding_stage: clean(organization.latest_funding_stage),
    short_description: clean(organization.short_description || organization.description),
    city: clean(organization.city),
    state: clean(organization.state),
    country: clean(organization.country),
    technologies: organization.technologies || [],
    raw: organization,
  };
}

async function enrichOrganizationForPerson(person = {}) {
  const organization = organizationFromPerson(person);
  const query = {};
  const domain = organizationDomain(organization, person);
  const name = organizationName(organization, person);
  const linkedinUrl = clean(organization.linkedin_url || person.organization_linkedin_url);
  const website = clean(organization.website_url || organization.website || person.organization_website_url);

  if (domain) query.domain = domain;
  else if (linkedinUrl) query.linkedin_url = linkedinUrl;
  else if (website) query.website = website;
  else if (name) query.name = name;
  else return compactOrganizationData(organization);

  try {
    const payload = await apolloFetch('/organizations/enrich', null, query, 'GET');
    debug('organization_enrich_complete', {
      queryType: Object.keys(query)[0] || 'none',
      found: Boolean(payload.organization || payload.account),
    });
    return compactOrganizationData(payload.organization || payload.account || payload);
  } catch (error) {
    debug('organization_enrich_failed', {
      queryType: Object.keys(query)[0] || 'none',
      error: error.message,
    });
    return {
      ...compactOrganizationData(organization),
      enrichment_error: error.message || 'Apollo organization enrichment failed',
    };
  }
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
    company_data: compactOrganizationData(organization),
    raw_data: {
      apollo: {
        searchPerson: person,
        searchMeta: sourcePayload,
        organization,
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
  const batches = [];

  for (let index = 0; index < people.length; index += BULK_ENRICHMENT_BATCH_SIZE) {
    const batch = people.slice(index, index + BULK_ENRICHMENT_BATCH_SIZE);
    if (!batch.length) continue;

    const query = { run_waterfall_email: true };
    if (webhookUrl) query.webhook_url = webhookUrl;

    const payload = await apolloFetch('/people/bulk_match', {
      details: batch.map(enrichmentDetail),
      run_waterfall_email: true,
      webhook_url: webhookUrl || undefined,
      client_reference_id: importRunId,
    }, query);

    const requestId = clean(payload.request_id || payload.id || payload.batch_id);
    debug('bulk_enrichment_requested', {
      batchSize: batch.length,
      requestIdSuffix: requestId ? requestId.slice(-8) : null,
      hasWebhookUrl: Boolean(webhookUrl),
      hasImmediatePeople: Boolean(payload.people || payload.matches || payload.contacts),
    });

    batches.push({
      request_id: requestId,
      payload,
      people: batch.map(person => apolloPersonId(person)).filter(Boolean),
    });
  }

  return batches;
}

async function pollWebhookResult(requestId) {
  if (!requestId) return null;
  debug('poll_webhook_result_start', {
    requestIdSuffix: requestId.slice(-8),
  });
  const payload = await apolloFetch(`/webhook_result/${encodeURIComponent(requestId)}`, null, {}, 'GET');
  debug('poll_webhook_result_complete', {
    requestIdSuffix: requestId.slice(-8),
    topLevelKeys: Object.keys(payload || {}).slice(0, 8),
  });
  return payload;
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

function firstArrayValue(value, keys) {
  if (!Array.isArray(value)) return '';

  for (const item of value) {
    if (typeof item === 'string') {
      const result = clean(item);
      if (result) return result;
      continue;
    }

    if (!item || typeof item !== 'object') continue;
    for (const key of keys) {
      const result = clean(item[key]);
      if (result) return result;
    }
  }

  return '';
}

function extractWebhookUpdates(payload = {}) {
  const updates = [];
  walk(payload, node => {
    const email = clean(
      node.email
      || node.email_address
      || firstArrayValue(node.emails, ['email', 'email_address']),
    ).toLowerCase();
    const phone = clean(
      node.phone
      || node.phone_number
      || node.sanitized_phone
      || node.mobile_phone
      || node.direct_phone
      || node.revealed_phone_number
      || firstArrayValue(node.phone_numbers, ['sanitized_number', 'raw_number', 'phone_number', 'number'])
    );

    // Nested email/phone objects also contain an `id`; only use a plain `id`
    // as the Apollo person ID when this object is a person/webhook result.
    const isWebhookResult = Boolean(
      node.person_id
      || node.apollo_person_id
      || node.apollo_id
      || node.emails
      || node.phone_numbers
      || node.waterfall,
    );
    const personId = clean(
      node.person_id
      || node.apollo_person_id
      || node.apollo_id
      || (isWebhookResult ? node.id : ''),
    );

    if (isWebhookResult && (personId || email || phone)) {
      updates.push({
        personId,
        email,
        phone,
        phone_e164: normalizePhone(phone),
        hasContactData: Boolean(email || phone),
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
  pollWebhookResult,
  enrichOrganizationForPerson,
  searchPeople,
  apolloPersonId,
  extractWebhookUpdates,
  getWebhookUrl,
};
