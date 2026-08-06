const crypto = require('node:crypto');
const {
  ApifyTimeoutError,
  actorInput,
  getApifyConfig,
  getActorRun,
  getDatasetItems,
  getResearchTargets,
  startActor,
  waitForActorRun,
} = require('./apify');
const { createQueueJobId, getLeadResearchQueue } = require('./redis');

const RESEARCH_SOURCE_TYPES = new Set(['company_profile', 'company_posts', 'person_posts', 'website']);
const RESEARCH_SUCCESS_STATUSES = new Set(['completed', 'partial', 'fallback']);

function logResearch(event, details = {}, level = 'info') {
  const entry = JSON.stringify({ event, ...details });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.info(entry);
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function uniqueStrings(values, limit = 20) {
  return [...new Set((values || []).map(clean).filter(Boolean))].slice(0, limit);
}

function clip(text, limit = 1200) {
  const value = clean(text);
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit - 1).trim()}…` : value;
}

function hashEvidence(sourceUrl, excerpt) {
  return crypto.createHash('sha1').update(`${sourceUrl || ''}\n${excerpt || ''}`).digest('hex').slice(0, 20);
}

function unwrapItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.posts)) return value.posts;
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.data?.posts)) return value.data.posts;
  if (Array.isArray(value.data?.items)) return value.data.items;
  return [value];
}

function timestampFrom(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const number = Number(value);
    const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function postObservedAt(post = {}) {
  const postedAt = post.posted_at || post.postedAt || post.created_at || post.createdAt || post.date;
  if (postedAt && typeof postedAt === 'object') {
    return timestampFrom(postedAt.timestamp || postedAt.date || postedAt.value);
  }
  return timestampFrom(postedAt || post.timestamp);
}

function postText(post = {}) {
  return clip(post.text || post.content || post.commentary || post.description || post.title, 1600);
}

function isRecent(isoDate, now, days = 30) {
  if (!isoDate) return false;
  const difference = new Date(now).getTime() - new Date(isoDate).getTime();
  return difference >= 0 && difference <= days * 24 * 60 * 60 * 1000;
}

function sourceTypeFor(kind) {
  if (kind === 'companyProfile') return 'company_profile';
  if (kind === 'companyPosts') return 'company_posts';
  if (kind === 'personPosts') return 'person_posts';
  return 'website';
}

function evidenceItem({ claim, excerpt, sourceUrl, sourceType, observedAt, confidence = 1, priority = 10 }) {
  const cleanExcerpt = clip(excerpt, 1600);
  if (!cleanExcerpt) return null;
  return {
    id: hashEvidence(sourceUrl, cleanExcerpt),
    claim: clean(claim) || cleanExcerpt,
    excerpt: cleanExcerpt,
    source_url: clean(sourceUrl),
    source_type: sourceType,
    observed_at: observedAt || null,
    confidence,
    priority,
  };
}

function existingApolloEvidence(lead = {}) {
  const profile = lead.personalization_profile || {};
  const context = Array.isArray(profile.email_context) ? profile.email_context : [];
  const fromProfile = context.map(item => evidenceItem({
    claim: item.fact || item.claim,
    excerpt: item.excerpt || item.fact || item.claim,
    sourceUrl: item.source_url || null,
    sourceType: item.source_type || 'apollo',
    observedAt: item.observed_at || profile.enriched_at || lead.last_enriched_at || lead.updated_at,
    confidence: 0.8,
    priority: 50,
  })).filter(Boolean);
  if (fromProfile.length) return fromProfile;

  const company = lead.company_data || {};
  const fallback = [
    lead.title && evidenceItem({
      claim: 'Apollo lists the prospect title as',
      excerpt: lead.title,
      sourceType: 'apollo',
      observedAt: lead.last_enriched_at || lead.updated_at,
      confidence: 0.75,
      priority: 60,
    }),
    company.industry && evidenceItem({
      claim: 'Apollo lists the company industry as',
      excerpt: company.industry,
      sourceType: 'apollo',
      observedAt: lead.last_enriched_at || lead.updated_at,
      confidence: 0.75,
      priority: 61,
    }),
    company.short_description && evidenceItem({
      claim: 'Apollo describes the company as',
      excerpt: company.short_description,
      sourceType: 'apollo',
      observedAt: lead.last_enriched_at || lead.updated_at,
      confidence: 0.7,
      priority: 62,
    }),
    lead.company_name && evidenceItem({
      claim: 'Apollo associates the prospect with this company',
      excerpt: lead.company_name,
      sourceType: 'apollo',
      observedAt: lead.last_enriched_at || lead.updated_at,
      confidence: 0.75,
      priority: 63,
    }),
  ].filter(Boolean);
  return fallback;
}

function normalizeCompany(companyRaw = {}, lead = {}) {
  const locations = Array.isArray(companyRaw.locations) ? companyRaw.locations : [];
  const headquarters = locations.find(location => location?.headquarter) || locations[0] || {};
  const employeeCount = companyRaw.employeeCount
    || companyRaw.employee_count
    || companyRaw.employeeCountRange?.start
    || companyRaw.estimated_num_employees
    || null;
  const funding = companyRaw.fundingData?.lastFundingRound || {};
  const company = lead.company_data || {};

  return {
    name: clean(companyRaw.name || company.name || lead.company_name),
    linkedin_url: clean(companyRaw.linkedinUrl || companyRaw.linkedin_url || company.linkedin_url),
    website_url: clean(companyRaw.website || companyRaw.website_url || company.website_url || company.domain || lead.company_domain),
    headline: clean(companyRaw.tagline),
    industry: clean(companyRaw.industries?.[0] || companyRaw.industry || company.industry),
    employee_count: employeeCount ? Number(employeeCount) || employeeCount : null,
    employee_count_range: companyRaw.employeeCountRange || null,
    description: clean(companyRaw.description || companyRaw.short_description || company.short_description),
    company_type: clean(companyRaw.companyType || companyRaw.company_type),
    founded_year: Number(companyRaw.foundedOn?.year || companyRaw.founded_year || company.founded_year) || null,
    follower_count: Number(companyRaw.followerCount || companyRaw.follower_count) || null,
    location: clean(headquarters.parsed?.text || headquarters.city || company.location || lead.location),
    locations: locations.slice(0, 10),
    industries: uniqueStrings(companyRaw.industries || [companyRaw.industry || company.industry], 10),
    specialties: uniqueStrings(companyRaw.specialities || companyRaw.specialties, 12),
    funding_stage: clean(funding.fundingType || company.funding_stage),
    funding_date: timestampFrom(funding.announcedOn ? `${funding.announcedOn.year}-${funding.announcedOn.month || 1}-${funding.announcedOn.day || 1}` : company.funding_date),
  };
}

function normalizePerson(posts, lead = {}) {
  const profile = lead.personalization_profile?.person || {};
  const firstPost = posts[0] || {};
  const author = firstPost.author || {};
  return {
    first_name: clean(lead.first_name || author.first_name),
    last_name: clean(lead.last_name || author.last_name),
    headline: clean(author.headline || profile.headline),
    title: clean(lead.title || profile.title),
    location: clean(profile.location || lead.location || author.location),
    linkedin_url: clean(lead.linkedin_url || author.profile_url),
    about_section: clean(profile.about_section),
    recent_activity_type: clean(firstPost.post_type || firstPost.type),
    recent_post_text: posts.map(postText).filter(Boolean).slice(0, 3),
  };
}

function normalizeResearch({ lead = {}, sourceResults = [], now = new Date() } = {}) {
  const byType = new Map(sourceResults.map(result => [result.kind, result]));
  const companyProfileResult = byType.get('companyProfile');
  const companyPostsResult = byType.get('companyPosts');
  const personPostsResult = byType.get('personPosts');
  const websiteResult = byType.get('website');
  const companyRaw = unwrapItems(companyProfileResult?.items)[0] || {};
  const personPosts = unwrapItems(personPostsResult?.items)
    .filter(post => postText(post))
    .sort((a, b) => new Date(postObservedAt(b) || 0).getTime() - new Date(postObservedAt(a) || 0).getTime());
  const companyPosts = unwrapItems(companyPostsResult?.items)
    .filter(post => postText(post))
    .sort((a, b) => new Date(postObservedAt(b) || 0).getTime() - new Date(postObservedAt(a) || 0).getTime());
  const person = normalizePerson(personPosts, lead);
  const company = normalizeCompany(companyRaw, lead);
  const evidence = [];
  const sourceFieldsUsed = [];

  personPosts.slice(0, 3).forEach(post => {
    const excerpt = postText(post);
    const observedAt = postObservedAt(post);
    const recent = isRecent(observedAt, now, 30);
    const item = evidenceItem({
      claim: 'The prospect published this public LinkedIn post',
      excerpt,
      sourceUrl: post.url || personPostsResult?.sourceUrl || lead.linkedin_url,
      sourceType: 'linkedin_person_post',
      observedAt,
      confidence: recent ? 1 : 0.9,
      priority: recent ? 1 : 5,
    });
    if (item) evidence.push(item);
    sourceFieldsUsed.push('person.recent_post_text');
  });

  companyPosts.slice(0, 3).forEach(post => {
    const excerpt = postText(post);
    const observedAt = postObservedAt(post);
    const recent = isRecent(observedAt, now, 30);
    const item = evidenceItem({
      claim: 'The company published this public LinkedIn update',
      excerpt,
      sourceUrl: post.url || companyPostsResult?.sourceUrl || company.linkedin_url,
      sourceType: 'linkedin_company_post',
      observedAt,
      confidence: recent ? 1 : 0.9,
      priority: recent ? 2 : 6,
    });
    if (item) evidence.push(item);
    sourceFieldsUsed.push('company.recent_post_text');
  });

  if (person.headline && personPostsResult?.items?.length) {
    const item = evidenceItem({
      claim: 'The prospect public LinkedIn headline is shown as',
      excerpt: person.headline,
      sourceUrl: lead.linkedin_url,
      sourceType: 'linkedin_person_profile',
      observedAt: null,
      confidence: 0.95,
      priority: 10,
    });
    if (item) evidence.push(item);
    sourceFieldsUsed.push('person.linkedin_headline');
  }

  if (company.industry && companyProfileResult?.items?.length) {
    const item = evidenceItem({
      claim: 'The public company profile lists this industry',
      excerpt: company.industry,
      sourceUrl: company.linkedin_url || companyProfileResult?.sourceUrl,
      sourceType: 'linkedin_company_profile',
      observedAt: null,
      confidence: 0.95,
      priority: 12,
    });
    if (item) evidence.push(item);
    sourceFieldsUsed.push('company.industry');
  }
  if (company.description && companyProfileResult?.items?.length) {
    const item = evidenceItem({
      claim: 'The public company profile describes the business as',
      excerpt: company.description,
      sourceUrl: company.linkedin_url || companyProfileResult?.sourceUrl,
      sourceType: 'linkedin_company_profile',
      observedAt: null,
      confidence: 0.9,
      priority: 14,
    });
    if (item) evidence.push(item);
    sourceFieldsUsed.push('company.about_section');
  }

  const websitePages = unwrapItems(websiteResult?.items)
    .map(page => ({
      url: clean(page.url || page.pageUrl || websiteResult?.sourceUrl),
      title: clean(page.title || page.metadata?.title || page.h1),
      description: clip(page.description || page.text || page.markdown || page.content, 1000),
    }))
    .filter(page => page.title || page.description)
    .slice(0, 20);
  websitePages.slice(0, 3).forEach(page => {
    const excerpt = page.title && page.description ? `${page.title}: ${page.description}` : page.title || page.description;
    const item = evidenceItem({
      claim: 'The public company website contains this text',
      excerpt,
      sourceUrl: page.url,
      sourceType: 'company_website',
      observedAt: null,
      confidence: 0.85,
      priority: 20,
    });
    if (item) evidence.push(item);
    sourceFieldsUsed.push('company.website');
  });

  const apolloEvidence = existingApolloEvidence(lead);
  if (!evidence.length) evidence.push(...apolloEvidence);
  else if (evidence.length < 3) evidence.push(...apolloEvidence.slice(0, 3 - evidence.length));
  const sortedEvidence = evidence
    .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 8);
  const recentPost = sortedEvidence.find(item => ['linkedin_person_post', 'linkedin_company_post'].includes(item.source_type) && isRecent(item.observed_at, now, 30));
  const hasApifyProfileSignal = sortedEvidence.some(item => [
    'linkedin_person_profile', 'linkedin_company_profile', 'company_website',
  ].includes(item.source_type));
  const score = recentPost ? 3 : hasApifyProfileSignal ? 2 : sortedEvidence.length ? 1 : 0;
  const researchedAt = nowIso(now);

  return {
    version: 1,
    source: sourceResults.length ? 'apify' : (sortedEvidence.length ? 'apollo_fallback' : 'none'),
    researched_at: researchedAt,
    personalization_score: score,
    person: {
      ...person,
      recent_post_text: person.recent_post_text.slice(0, 3),
    },
    company: {
      ...company,
      website_pages: websitePages,
    },
    evidence: sortedEvidence.map(({ priority, ...item }) => item),
    email_context: sortedEvidence.map(item => ({
      fact: item.claim,
      excerpt: item.excerpt,
      source: item.source_type,
      source_url: item.source_url,
      observed_at: item.observed_at,
    })),
    source_fields_used: uniqueStrings(sourceFieldsUsed, 30),
    recent_activity_type: person.recent_activity_type || (companyPosts.length ? 'company_post' : null),
  };
}

function isFreshLeadResearch(lead = {}, now = new Date()) {
  if (!RESEARCH_SUCCESS_STATUSES.has(String(lead.research_status || ''))) return false;
  if (!lead.research_expires_at || !lead.personalization_profile) return false;
  return new Date(lead.research_expires_at).getTime() > new Date(now).getTime();
}

function shouldRefreshApifyResearch(lead = {}, targets = {}, config = {}) {
  if (!config.enabled) return false;
  if (lead.personalization_profile?.source !== 'apollo_fallback') return false;
  return Boolean(targets.companyUrl || targets.websiteUrl || targets.personUsername);
}

async function createResearchRun(supabase, payload) {
  const { data, error } = await supabase.from('lead_research_runs').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function updateResearchRun(supabase, runId, patch) {
  const { data, error } = await supabase.from('lead_research_runs').update(patch).eq('id', runId).select('*').single();
  if (error) throw error;
  return data;
}

async function getSourceCache(supabase, workspaceId, sourceType, sourceUrl) {
  if (!sourceUrl || !RESEARCH_SOURCE_TYPES.has(sourceType)) return null;
  const { data, error } = await supabase.from('research_source_cache')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_type', sourceType)
    .eq('source_url', sourceUrl)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function saveSourceCache(supabase, { workspaceId, sourceType, sourceUrl, result, config, now = new Date() }) {
  if (!sourceUrl || !result || (result.status && result.status !== 'SUCCEEDED')) return;
  const existing = await getSourceCache(supabase, workspaceId, sourceType, sourceUrl);
  const payload = {
    workspace_id: workspaceId,
    source_type: sourceType,
    source_url: sourceUrl,
    version: Number(existing?.version || 0) + 1,
    status: 'succeeded',
    actor_refs: {
      actor_id: result.actorId,
      run_id: result.runId,
      dataset_id: result.datasetId,
    },
    raw_payload: { items: Array.isArray(result.items) ? result.items : [] },
    observed_at: result.finishedAt || nowIso(now),
    last_success_at: nowIso(now),
    expires_at: addDays(now, config.cacheTtlDays),
    last_error: null,
  };
  const { error } = await supabase.from('research_source_cache').upsert(payload, { onConflict: 'workspace_id,source_type,source_url' });
  if (error) throw error;
}

async function runSingleSource({ kind, target, config, fetchImpl }) {
  const sourceType = sourceTypeFor(kind);
  const ref = await startActor({
    kind,
    actorId: config.actors[kind],
    input: actorInput(kind, target, config),
    fetchImpl,
    config,
  });
  const result = await waitForActorRun(ref, { fetchImpl, config });
  return { ...result, sourceUrl: target, sourceType };
}

function sourceFromCache(kind, sourceUrl, cache, stale = false) {
  if (!cache?.raw_payload) return null;
  return {
    kind,
    sourceUrl,
    sourceType: sourceTypeFor(kind),
    actorId: cache.actor_refs?.actor_id || null,
    runId: cache.actor_refs?.run_id || null,
    datasetId: cache.actor_refs?.dataset_id || null,
    items: unwrapItems(cache.raw_payload.items || cache.raw_payload),
    cacheHit: true,
    stale,
  };
}

async function loadSharedSource({ supabase, workspaceId, kind, target, config, fetchImpl, now }) {
  const sourceType = sourceTypeFor(kind);
  const cache = await getSourceCache(supabase, workspaceId, sourceType, target);
  const fresh = cache && cache.expires_at && new Date(cache.expires_at).getTime() > new Date(now).getTime();
  if (fresh) {
    const cached = sourceFromCache(kind, target, cache);
    logResearch('research_source_cache_hit', {
      workspaceId,
      kind,
      sourceType,
      sourceUrl: target,
      itemCount: cached?.items?.length || 0,
      expiresAt: cache.expires_at,
    });
    return cached;
  }

  logResearch('research_source_cache_miss', { workspaceId, kind, sourceType, sourceUrl: target });

  try {
    const result = await runSingleSource({ kind, target, config, fetchImpl });
    await saveSourceCache(supabase, { workspaceId, sourceType, sourceUrl: target, result, config, now });
    logResearch('research_source_saved', {
      workspaceId,
      kind,
      sourceType,
      sourceUrl: target,
      itemCount: result.items?.length || 0,
      cacheHit: false,
    });
    return result;
  } catch (error) {
    const stale = sourceFromCache(kind, target, cache, true);
    if (stale) {
      logResearch('research_source_failed_using_stale_cache', {
        workspaceId,
        kind,
        sourceType,
        sourceUrl: target,
        itemCount: stale.items?.length || 0,
        error: error.message,
      }, 'warn');
      return { ...stale, failure: error.message };
    }
    logResearch('research_source_failed', {
      workspaceId,
      kind,
      sourceType,
      sourceUrl: target,
      timedOut: error instanceof ApifyTimeoutError,
      error: error.message,
    }, 'error');
    return { kind, sourceUrl: target, sourceType, items: [], failure: error.message, timedOut: error instanceof ApifyTimeoutError, runId: error.runId || null, actorId: error.actorId || config.actors[kind] };
  }
}

async function updateLeadStatus(supabase, leadId, workspaceId, patch) {
  const { error } = await supabase.from('leads').update(patch).eq('id', leadId).eq('workspace_id', workspaceId);
  if (error) throw error;
}

async function saveNormalizedProfile({ supabase, lead, workspaceId, campaignId, run, profile, status, runStatus = status, errors = [], actorRefs = [], config = getApifyConfig(), now = new Date() }) {
  const version = Number(lead.research_profile_version || 0) + 1;
  const expiresAt = addDays(now, config.cacheTtlDays);
  const { error: profileError } = await supabase.from('lead_research_profiles').insert({
    workspace_id: workspaceId,
    lead_id: lead.id,
    campaign_id: campaignId || null,
    run_id: run.id,
    version,
    status,
    profile,
    evidence: profile.evidence || [],
    personalization_score: Number(profile.personalization_score || 0),
    source_fields_used: profile.source_fields_used || [],
    observed_at: nowIso(now),
    expires_at: expiresAt,
  });
  if (profileError) throw profileError;

  await updateLeadStatus(supabase, lead.id, workspaceId, {
    personalization_profile: profile,
    personalization_profile_version: Number(lead.personalization_profile_version || 0) + 1,
    research_profile_version: version,
    research_status: status,
    research_last_success_at: ['completed', 'partial'].includes(status) ? nowIso(now) : lead.research_last_success_at || null,
    research_last_error: errors.length ? errors.join('; ').slice(0, 2000) : null,
    research_expires_at: expiresAt,
  });

  return updateResearchRun(supabase, run.id, {
    status: runStatus === 'completed' ? 'succeeded' : runStatus,
    normalized_profile: profile,
    evidence: profile.evidence || [],
    personalization_score: Number(profile.personalization_score || 0),
    source_fields_used: profile.source_fields_used || [],
    actor_refs,
    error_message: errors.length ? errors.join('; ').slice(0, 2000) : null,
    completed_at: nowIso(now),
    expires_at: expiresAt,
  });
}

function actorRefsFromResults(results = []) {
  return results.map(result => ({
    kind: result.kind,
    source_type: result.sourceType || sourceTypeFor(result.kind),
    source_url: result.sourceUrl || null,
    actor_id: result.actorId || null,
    run_id: result.runId || null,
    dataset_id: result.datasetId || null,
    status: result.status || (result.failure ? 'failed' : 'succeeded'),
    cache_hit: Boolean(result.cacheHit),
    stale: Boolean(result.stale),
  }));
}

async function researchLead({ supabase, workspaceId, campaignId, lead, sharedLoader = null, config = getApifyConfig(), fetchImpl, now = new Date() }) {
  const targets = getResearchTargets(lead);
  const refreshForApify = shouldRefreshApifyResearch(lead, targets, config);
  if (isFreshLeadResearch(lead, now) && !refreshForApify) {
    logResearch('lead_research_skipped_fresh_cache', {
      workspaceId,
      campaignId,
      leadId: lead.id,
      score: Number(lead.personalization_profile?.personalization_score || 0),
      expiresAt: lead.research_expires_at,
    });
    return { lead_id: lead.id, skipped: true, reason: 'fresh_research_cache', score: Number(lead.personalization_profile?.personalization_score || 0) };
  }
  if (refreshForApify) {
    logResearch('lead_research_cache_bypassed_for_apify', {
      workspaceId,
      campaignId,
      leadId: lead.id,
      cachedSource: lead.personalization_profile?.source || null,
      targets: {
        companyLinkedIn: Boolean(targets.companyUrl),
        companyWebsite: Boolean(targets.websiteUrl),
        personLinkedIn: Boolean(targets.personUsername),
      },
    });
  }

  const requestedSources = [];
  if (targets.companyUrl) requestedSources.push('company_profile', 'company_posts');
  if (targets.personUsername) requestedSources.push('person_posts');
  if (targets.websiteUrl) requestedSources.push('website');
  const run = await createResearchRun(supabase, {
    workspace_id: workspaceId,
    lead_id: lead.id,
    campaign_id: campaignId || null,
    status: 'running',
    requested_sources: requestedSources,
    input: { targets, cache_ttl_days: config.cacheTtlDays },
    raw_payload: {},
    normalized_profile: {},
    evidence: [],
    actor_refs: [],
    requested_at: nowIso(now),
    started_at: nowIso(now),
    timeout_at: new Date(new Date(now).getTime() + config.timeoutMs).toISOString(),
  });
  await updateLeadStatus(supabase, lead.id, workspaceId, { research_status: 'running', research_last_error: null });
  logResearch('lead_research_started', {
    workspaceId,
    campaignId,
    leadId: lead.id,
    runId: run.id,
    apifyEnabled: config.enabled,
    requestedSources,
    targets: {
      companyLinkedIn: Boolean(targets.companyUrl),
      companyWebsite: Boolean(targets.websiteUrl),
      personLinkedIn: Boolean(targets.personUsername),
    },
  });

  let sourceResults = [];
  let failures = [];
  let disabled = !config.enabled;
  if (config.enabled) {
    const shared = [];
    if (targets.companyUrl) {
      shared.push({ kind: 'companyProfile', target: targets.companyUrl });
      shared.push({ kind: 'companyPosts', target: targets.companyUrl });
    }
    if (targets.websiteUrl) shared.push({ kind: 'website', target: targets.websiteUrl });
    const sharedResults = await Promise.all(shared.map(item => sharedLoader
      ? sharedLoader(item.kind, item.target)
      : loadSharedSource({ supabase, workspaceId, ...item, config, fetchImpl, now })));
    sourceResults.push(...sharedResults);
    if (targets.personUsername) {
      try {
        sourceResults.push({
          ...(await runSingleSource({ kind: 'personPosts', target: targets.personUsername, config, fetchImpl })),
          sourceUrl: targets.personUrl,
        });
      } catch (error) {
        failures.push({ kind: 'personPosts', sourceUrl: targets.personUrl, message: error.message, runId: error.runId || null, actorId: error.actorId || config.actors.personPosts, timedOut: error instanceof ApifyTimeoutError });
      }
    }
    failures.push(...sourceResults.filter(result => result.failure).map(result => ({
      kind: result.kind,
      sourceUrl: result.sourceUrl || null,
      message: result.failure,
      runId: result.runId || null,
      actorId: result.actorId || config.actors[result.kind],
      timedOut: Boolean(result.timedOut),
    })));
    disabled = false;
  }

  const usableResults = sourceResults.filter(result => Array.isArray(result.items) && result.items.length);
  const profile = normalizeResearch({ lead, sourceResults: usableResults, now });
  const actorRefs = actorRefsFromResults([...sourceResults, ...failures]);
  const errors = failures.map(item => item.message).filter(Boolean);
  const hasApifyEvidence = usableResults.length > 0 && profile.source === 'apify';
  const status = disabled || !hasApifyEvidence ? (profile.personalization_score ? 'fallback' : 'failed') : (errors.length ? 'partial' : 'completed');
  const timedOut = failures.some(item => item.timedOut);
  const runStatus = timedOut ? 'timed_out' : status;
  const rawPayload = {
    provider: 'apify',
    disabled,
    results: usableResults,
    failures,
    captured_at: nowIso(now),
  };
  await updateResearchRun(supabase, run.id, { raw_payload: rawPayload, actor_refs: actorRefs });
  const savedRun = await saveNormalizedProfile({
    supabase,
    lead,
    workspaceId,
    campaignId,
    run,
    profile,
    status,
    runStatus,
    errors,
    actorRefs,
    config,
    now,
  });

  logResearch('lead_research_profile_ready', {
    workspaceId,
    campaignId,
    leadId: lead.id,
    runId: savedRun.id,
    status,
    runStatus,
    score: Number(profile.personalization_score || 0),
    evidenceCount: profile.evidence?.length || 0,
    sourceCount: usableResults.length,
    failureCount: failures.length,
    timedOut,
  });

  return {
    lead_id: lead.id,
    skipped: false,
    status,
    score: Number(profile.personalization_score || 0),
    run_id: savedRun.id,
    timed_out: timedOut,
    reconciliation_refs: failures.filter(item => item.timedOut && item.runId).map(item => ({ ...item, lead_id: lead.id, research_run_id: savedRun.id })),
    error: errors.length ? errors.join('; ') : null,
  };
}

async function getResearchLeads(supabase, workspaceId, leadIds) {
  const { data, error } = await supabase.from('leads').select('*').eq('workspace_id', workspaceId).in('id', leadIds);
  if (error) throw error;
  return data || [];
}

async function researchCampaign({ supabase, workspaceId, campaignId, leadIds = [], concurrency = 2, onProgress = null, fetchImpl, config = getApifyConfig(), now = new Date() }) {
  if (!leadIds.length) return { total: 0, researched: 0, skipped: 0, fallback: 0, failed: 0, timed_out: 0, errors: [], reconciliation_refs: [] };
  logResearch('lead_research_campaign_started', {
    workspaceId,
    campaignId,
    total: leadIds.length,
    concurrency,
    apifyEnabled: config.enabled,
  });
  const leads = await getResearchLeads(supabase, workspaceId, leadIds);
  const leadById = new Map(leads.map(lead => [lead.id, lead]));
  const results = [];
  let nextIndex = 0;
  let processed = 0;
  const sharedPromises = new Map();
  const sharedLoader = (kind, target) => {
    const key = `${kind}:${target}`;
    if (!sharedPromises.has(key)) {
      sharedPromises.set(key, loadSharedSource({ supabase, workspaceId, kind, target, config, fetchImpl, now }));
    }
    return sharedPromises.get(key);
  };

  async function next() {
    while (nextIndex < leadIds.length) {
      const leadId = leadIds[nextIndex];
      nextIndex += 1;
      const lead = leadById.get(leadId);
      let result;
      try {
        result = lead
          ? await researchLead({ supabase, workspaceId, campaignId, lead, sharedLoader, config, fetchImpl, now })
          : { lead_id: leadId, status: 'failed', error: 'Lead was not found' };
      } catch (error) {
        result = { lead_id: leadId, status: 'failed', error: error.message || 'Research failed' };
      }
      results.push(result);
      processed += 1;
      if (onProgress) await onProgress({
        total: leadIds.length,
        processed,
        researched: results.filter(item => ['completed', 'partial'].includes(item.status)).length,
        skipped: results.filter(item => item.skipped).length,
        fallback: results.filter(item => item.status === 'fallback').length,
        failed: results.filter(item => item.status === 'failed').length,
        timed_out: results.filter(item => item.timed_out).length,
        leadId,
      });
      logResearch('lead_research_progress', {
        workspaceId,
        campaignId,
        total: leadIds.length,
        processed,
        leadId,
        status: result.status || (result.skipped ? 'skipped' : 'failed'),
        score: result.score || 0,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, leadIds.length)) }, next));
  const summary = {
    total: leadIds.length,
    researched: results.filter(item => ['completed', 'partial'].includes(item.status)).length,
    skipped: results.filter(item => item.skipped).length,
    fallback: results.filter(item => item.status === 'fallback').length,
    failed: results.filter(item => item.status === 'failed').length,
    timed_out: results.filter(item => item.timed_out).length,
    errors: results.filter(item => item.error).map(item => ({ lead_id: item.lead_id, message: item.error })),
    reconciliation_refs: results.flatMap(item => item.reconciliation_refs || []),
    results,
  };
  logResearch('lead_research_campaign_completed', {
    workspaceId,
    campaignId,
    total: summary.total,
    researched: summary.researched,
    skipped: summary.skipped,
    fallback: summary.fallback,
    failed: summary.failed,
    timedOut: summary.timed_out,
    reconciliationRefs: summary.reconciliation_refs.length,
  });
  return summary;
}

async function reconcileResearchRun({ supabase, researchRunId, fetchImpl, config = getApifyConfig(), now = new Date() }) {
  logResearch('research_reconciliation_started', { researchRunId });
  const { data: run, error: runError } = await supabase.from('lead_research_runs').select('*').eq('id', researchRunId).maybeSingle();
  if (runError) throw runError;
  if (!run || !['timed_out', 'partial', 'fallback', 'running'].includes(run.status)) return { skipped: true, reason: 'Run is already terminal' };
  const { data: lead, error: leadError } = await supabase.from('leads').select('*').eq('id', run.lead_id).eq('workspace_id', run.workspace_id).maybeSingle();
  if (leadError) throw leadError;
  if (!lead) throw new Error('Lead for research reconciliation was not found');
  const refs = Array.isArray(run.actor_refs) ? run.actor_refs : [];
  const lateResults = [];
  for (const ref of refs.filter(item => item.run_id && !item.cache_hit)) {
    const actorRun = await getActorRun(ref.run_id, { fetchImpl, config });
    const status = String(actorRun?.status || '').toUpperCase();
    if (status !== 'SUCCEEDED') continue;
    const items = await getDatasetItems(actorRun.defaultDatasetId || ref.dataset_id, { fetchImpl, config });
    const result = {
      kind: ref.kind,
      sourceUrl: ref.source_url,
      sourceType: ref.source_type,
      actorId: ref.actor_id,
      runId: ref.run_id,
      datasetId: actorRun.defaultDatasetId || ref.dataset_id,
      status,
      items,
    };
    lateResults.push(result);
    if (ref.source_url && ref.source_type) await saveSourceCache(supabase, {
      workspaceId: run.workspace_id,
      sourceType: ref.source_type,
      sourceUrl: ref.source_url,
      result,
      config,
      now,
    });
  }
  if (!lateResults.length) {
    logResearch('research_reconciliation_waiting', { researchRunId });
    return { skipped: true, reason: 'Late Apify results are not ready' };
  }
  const previousResults = run.raw_payload?.results || [];
  const profile = normalizeResearch({ lead, sourceResults: [...previousResults, ...lateResults], now });
  const actorRefs = actorRefsFromResults([...previousResults, ...lateResults]);
  await updateResearchRun(supabase, run.id, {
    raw_payload: { ...(run.raw_payload || {}), results: [...previousResults, ...lateResults], reconciled_at: nowIso(now) },
    actor_refs: actorRefs,
  });
  const saved = await saveNormalizedProfile({
    supabase,
    lead,
    workspaceId: run.workspace_id,
    campaignId: run.campaign_id,
    run,
    profile,
    status: 'completed',
    runStatus: 'succeeded',
    errors: [],
    actorRefs,
    config,
    now,
  });
  logResearch('research_reconciliation_completed', {
    researchRunId,
    runId: saved.id,
    lateSourceCount: lateResults.length,
    score: profile.personalization_score,
  });
  return { reconciled: true, run_id: saved.id, score: profile.personalization_score };
}

async function scheduleResearchReconciliation(refs = [], { queue = null, delayMs = null } = {}) {
  if (!refs.length) return 0;
  const researchQueue = queue || getLeadResearchQueue();
  const delay = Math.max(60_000, Number(delayMs || process.env.APIFY_RECONCILE_DELAY_MS || 300_000));
  let queued = 0;
  for (const ref of refs) {
    const jobId = createQueueJobId('research-reconcile', ref.research_run_id, ref.runId);
    const existing = await researchQueue.getJob(jobId);
    if (existing) continue;
    await researchQueue.add('reconcile-research', {
      researchRunId: ref.research_run_id,
      leadId: ref.lead_id,
    }, { jobId, delay });
    logResearch('research_reconciliation_queued', {
      jobId,
      researchRunId: ref.research_run_id,
      leadId: ref.lead_id,
      delayMs: delay,
    });
    queued += 1;
  }
  return queued;
}

module.exports = {
  RESEARCH_SOURCE_TYPES,
  existingApolloEvidence,
  isFreshLeadResearch,
  shouldRefreshApifyResearch,
  normalizeResearch,
  reconcileResearchRun,
  researchCampaign,
  researchLead,
  scheduleResearchReconciliation,
  unwrapItems,
};
