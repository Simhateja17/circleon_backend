const APIFY_API_BASE = 'https://api.apify.com';
const DEFAULT_ACTORS = {
  website: 'apify~website-content-crawler',
  companyProfile: 'harvestapi~linkedin-company',
  personPosts: 'apimaestro~linkedin-profile-posts',
  companyPosts: 'apimaestro~linkedin-company-posts-batch-scraper-no-cookies',
};
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com',
]);
const TERMINAL_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
  'TIMED-OUT',
  'TIMED_OUT',
]);

class ApifyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApifyError';
    Object.assign(this, details);
  }
}

class ApifyTimeoutError extends ApifyError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'ApifyTimeoutError';
    this.code = 'APIFY_TIMEOUT';
  }
}

function logApify(event, details = {}, level = 'info') {
  const entry = JSON.stringify({ event, ...details });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.info(entry);
}

function inputTarget(input = {}) {
  return input.startUrls?.[0]?.url
    || input.companies?.[0]
    || input.company_names?.[0]
    || input.username
    || null;
}

function getApifyConfig() {
  const token = String(process.env.APIFY_API_TOKEN || '').trim();
  return {
    enabled: Boolean(token),
    token,
    apiBase: String(process.env.APIFY_API_BASE || APIFY_API_BASE).replace(/\/+$/, ''),
    timeoutMs: Math.max(10_000, Number(process.env.APIFY_TIMEOUT_MS || 300_000)),
    pollIntervalMs: Math.max(1_000, Number(process.env.APIFY_POLL_INTERVAL_MS || 5_000)),
    cacheTtlDays: Math.max(1, Number(process.env.APIFY_CACHE_TTL_DAYS || 7)),
    actors: {
      website: String(process.env.APIFY_WEBSITE_ACTOR_ID || DEFAULT_ACTORS.website).trim(),
      companyProfile: String(process.env.APIFY_COMPANY_ACTOR_ID || DEFAULT_ACTORS.companyProfile).trim(),
      personPosts: String(process.env.APIFY_PERSON_POSTS_ACTOR_ID || DEFAULT_ACTORS.personPosts).trim(),
      companyPosts: String(process.env.APIFY_COMPANY_POSTS_ACTOR_ID || DEFAULT_ACTORS.companyPosts).trim(),
    },
    limits: {
      websitePages: Math.max(1, Number(process.env.APIFY_WEBSITE_MAX_PAGES || 20)),
      websiteDepth: Math.max(0, Number(process.env.APIFY_WEBSITE_MAX_DEPTH || 2)),
      personPosts: Math.max(1, Number(process.env.APIFY_PERSON_POST_LIMIT || 10)),
      companyPosts: Math.max(1, Number(process.env.APIFY_COMPANY_POST_LIMIT || 10)),
    },
  };
}

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = /^https?:\/\//i.test(text) ? new URL(text) : new URL(`https://${text}`);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function businessEmailDomain(email) {
  const value = String(email || '').trim().toLowerCase();
  const match = value.match(/@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i);
  if (!match) return null;
  const domain = match[1].replace(/^www\./, '');
  return FREE_EMAIL_DOMAINS.has(domain) ? null : domain;
}

function linkedinUsername(value) {
  const url = cleanUrl(value);
  if (!url) return null;
  const match = url.pathname.match(/\/in\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function companyLinkedinUrl(lead = {}) {
  const company = lead.company_data || {};
  const apolloOrganization = lead.raw_data?.apollo?.organization || {};
  const profileCompany = lead.personalization_profile?.company || {};
  return cleanUrl(
    company.linkedin_url
    || apolloOrganization.linkedin_url
    || lead.company_linkedin_url
    || profileCompany.linkedin_url
  );
}

function companyWebsiteUrl(lead = {}) {
  const company = lead.company_data || {};
  const apolloOrganization = lead.raw_data?.apollo?.organization || {};
  const profileCompany = lead.personalization_profile?.company || {};
  return cleanUrl(
    company.website_url
    || company.domain
    || lead.company_domain
    || apolloOrganization.website_url
    || apolloOrganization.website
    || apolloOrganization.domain
    || profileCompany.website_url
    || profileCompany.domain
    || businessEmailDomain(lead.email)
  );
}

function getResearchTargets(lead = {}) {
  const profilePerson = lead.personalization_profile?.person || {};
  const personUrl = cleanUrl(lead.linkedin_url || profilePerson.linkedin_url);
  const companyUrl = companyLinkedinUrl(lead);
  const websiteUrl = companyWebsiteUrl(lead);
  return {
    personUrl,
    personUsername: linkedinUsername(personUrl),
    companyUrl,
    websiteUrl,
  };
}

function actorInput(kind, target, config = getApifyConfig()) {
  if (kind === 'companyProfile') return { companies: [target] };
  if (kind === 'companyPosts') return { company_names: [target], limit: config.limits.companyPosts };
  if (kind === 'personPosts') return { username: target, total_posts: config.limits.personPosts };
  if (kind === 'website') {
    return {
      startUrls: [{ url: target }],
      crawlerType: 'playwright:adaptive',
      maxCrawlPages: config.limits.websitePages,
      maxCrawlDepth: config.limits.websiteDepth,
      maxConcurrency: 2,
      respectRobotsTxtFile: true,
      saveMarkdown: true,
    };
  }
  throw new Error(`Unsupported Apify research actor kind: ${kind}`);
}

async function apifyRequest(path, { method = 'GET', body, fetchImpl = global.fetch, config = getApifyConfig() } = {}) {
  if (!config.token) throw new ApifyError('APIFY_API_TOKEN is required for public research');
  if (typeof fetchImpl !== 'function') throw new ApifyError('Fetch is unavailable for Apify integration');

  let response;
  try {
    response = await fetchImpl(`${config.apiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    logApify('apify_request_failed', {
      method,
      path,
      error: error.message || 'network error',
    }, 'error');
    throw new ApifyError(`Apify request failed: ${error.message || 'network error'}`, { cause: error });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Apify returned HTTP ${response.status}`;
    logApify('apify_api_error', {
      method,
      path,
      status: response.status,
      error: message,
    }, 'error');
    throw new ApifyError(message, { status: response.status, payload });
  }
  return payload?.data ?? payload;
}

async function startActor({ kind, actorId, input, fetchImpl, config = getApifyConfig() }) {
  logApify('apify_actor_starting', {
    kind,
    actorId,
    target: inputTarget(input),
  });
  const run = await apifyRequest(`/v2/actors/${encodeURIComponent(actorId)}/runs`, {
    method: 'POST',
    body: input,
    fetchImpl,
    config,
  });
  if (!run?.id) throw new ApifyError(`Apify did not return a run id for ${kind}`);
  logApify('apify_actor_started', {
    kind,
    actorId,
    runId: run.id,
    datasetId: run.defaultDatasetId || null,
    target: inputTarget(input),
  });
  return {
    kind,
    actorId,
    runId: run.id,
    datasetId: run.defaultDatasetId || null,
    input,
  };
}

async function getActorRun(runId, { fetchImpl, config = getApifyConfig() } = {}) {
  return apifyRequest(`/v2/actor-runs/${encodeURIComponent(runId)}`, { fetchImpl, config });
}

async function getDatasetItems(datasetId, { fetchImpl, config = getApifyConfig() } = {}) {
  if (!datasetId) return [];
  const result = await apifyRequest(`/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json`, { fetchImpl, config });
  return Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : []);
}

function sleep(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

async function waitForActorRun(ref, { timeoutMs, pollIntervalMs, fetchImpl, config = getApifyConfig() } = {}) {
  const effectiveTimeout = Math.max(1_000, Number(timeoutMs || config.timeoutMs));
  const effectivePollInterval = Math.max(250, Number(pollIntervalMs || config.pollIntervalMs));
  const startedAt = Date.now();
  let lastRun = null;

  while (Date.now() - startedAt < effectiveTimeout) {
    lastRun = await getActorRun(ref.runId, { fetchImpl, config });
    const status = String(lastRun?.status || '').toUpperCase();
    if (TERMINAL_STATUSES.has(status)) {
      const datasetId = lastRun.defaultDatasetId || ref.datasetId || null;
      const items = status === 'SUCCEEDED' ? await getDatasetItems(datasetId, { fetchImpl, config }) : [];
      logApify(status === 'SUCCEEDED' ? 'apify_actor_completed' : 'apify_actor_terminal', {
        kind: ref.kind,
        actorId: ref.actorId,
        runId: ref.runId,
        datasetId,
        status,
        itemCount: items.length,
        durationMs: Date.now() - startedAt,
      }, status === 'SUCCEEDED' ? 'info' : 'warn');
      return { ...ref, status, datasetId, items, finishedAt: new Date().toISOString() };
    }
    await sleep(Math.min(effectivePollInterval, Math.max(250, effectiveTimeout - (Date.now() - startedAt))));
  }

  logApify('apify_actor_timeout', {
    kind: ref.kind,
    actorId: ref.actorId,
    runId: ref.runId,
    lastStatus: lastRun?.status || 'RUNNING',
    timeoutMs: effectiveTimeout,
  }, 'warn');
  throw new ApifyTimeoutError(`Apify actor ${ref.actorId} exceeded the ${Math.round(effectiveTimeout / 1000)} second research timeout`, {
    ...ref,
    lastStatus: lastRun?.status || 'RUNNING',
  });
}

async function runConfiguredResearchActors({ lead, fetchImpl, config = getApifyConfig() }) {
  if (!config.enabled) return { disabled: true, results: [], failures: [] };

  const targets = getResearchTargets(lead);
  const requests = [];
  if (targets.companyUrl) {
    requests.push({ kind: 'companyProfile', actorId: config.actors.companyProfile, target: targets.companyUrl });
    requests.push({ kind: 'companyPosts', actorId: config.actors.companyPosts, target: targets.companyUrl });
  }
  if (targets.personUsername) requests.push({ kind: 'personPosts', actorId: config.actors.personPosts, target: targets.personUsername });
  if (targets.websiteUrl) requests.push({ kind: 'website', actorId: config.actors.website, target: targets.websiteUrl });

  const started = await Promise.allSettled(requests.map(request => startActor({
    ...request,
    input: actorInput(request.kind, request.target, config),
    fetchImpl,
    config,
  })));
  const refs = [];
  const failures = [];
  started.forEach((result, index) => {
    if (result.status === 'fulfilled') refs.push(result.value);
    else failures.push({ kind: requests[index].kind, actorId: requests[index].actorId, message: result.reason?.message || 'Actor could not be started' });
  });

  const completed = await Promise.allSettled(refs.map(ref => waitForActorRun(ref, {
    fetchImpl,
    config,
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  })));
  const results = [];
  completed.forEach((result, index) => {
    if (result.status === 'fulfilled') results.push(result.value);
    else failures.push({
      ...refs[index],
      timedOut: result.reason instanceof ApifyTimeoutError,
      message: result.reason?.message || 'Actor did not complete',
    });
  });

  return { disabled: false, results, failures, targets };
}

module.exports = {
  ApifyError,
  ApifyTimeoutError,
  actorInput,
  businessEmailDomain,
  companyLinkedinUrl,
  companyWebsiteUrl,
  getApifyConfig,
  getDatasetItems,
  getResearchTargets,
  getActorRun,
  linkedinUsername,
  runConfiguredResearchActors,
  startActor,
  waitForActorRun,
};
