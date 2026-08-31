const {
  apolloPersonId,
  buildPersonalizationProfile,
  enrichOrganizationForPerson,
  extractWebhookUpdates,
  normalizeApolloLead,
  pollWebhookResult,
  requestBulkEnrichment,
  searchPeople,
} = require('./apollo');
const { createQueueJobId, getFreeLeadPreviewQueue } = require('./redis');
const { sendFreeLeadPreviewEmail } = require('./freeLeadPreviewEmail');

const REQUESTED_LEAD_COUNT = 3;
const CANDIDATE_MULTIPLIER = 3;
const CANDIDATE_CAP = REQUESTED_LEAD_COUNT * CANDIDATE_MULTIPLIER;
const SEARCH_PAGE_CAP = 10;
const ENRICHMENT_TIMEOUT_MS = 10 * 60 * 1000;
const FINALIZE_DELAY_MS = 30 * 1000;

function clean(value, limit = 500) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeEmail(value) {
  return clean(value, 320).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function isUsableWorkEmail(value) {
  const email = normalizeEmail(value);
  if (!isValidEmail(email)) return false;
  const local = email.split('@')[0];
  return !['info', 'support', 'hello', 'contact', 'admin', 'sales'].includes(local);
}

function normalizeTitles(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,\n;]+/);
  return [...new Set(values.map(item => clean(item, 120)).filter(Boolean))].slice(0, 12);
}

function normalizePreviewInput(input = {}) {
  const normalized = {
    companyName: clean(input.companyName || input.company || input.businessName, 200),
    product: clean(input.product || input.whatYouSell, 500),
    titles: normalizeTitles(input.titles || input.targetTitles || input.whoBuys),
    industry: clean(input.industry || input.targetIndustry, 200),
    region: clean(input.region || input.targetRegion || input.location, 200),
    companySize: clean(input.companySize || input.targetCompanySize, 120),
    email: normalizeEmail(input.email),
  };
  const errors = {};
  if (!normalized.companyName) errors.companyName = 'Company name is required.';
  if (!normalized.product) errors.product = 'What you sell is required.';
  if (!normalized.titles.length) errors.titles = 'At least one buyer role is required.';
  if (!normalized.industry) errors.industry = 'Target industry is required.';
  if (!normalized.region) errors.region = 'Target location is required.';
  if (!normalized.companySize) errors.companySize = 'Target company size is required.';
  if (!isValidEmail(normalized.email)) errors.email = 'A valid work email is required.';
  return { ...normalized, errors, valid: Object.keys(errors).length === 0 };
}

function previewFilters(request) {
  return {
    titles: request.target_titles || request.titles || [],
    region: request.target_region || request.region || '',
    industry: request.target_industry || request.industry || '',
    companySize: request.target_company_size || request.companySize || '',
    limit: REQUESTED_LEAD_COUNT,
  };
}

function candidateIdentityKeys(person = {}) {
  const organization = person.organization || person.account || {};
  const firstName = clean(person.first_name || person.firstName, 120).toLowerCase();
  const lastName = clean(person.last_name || person.lastName, 120).toLowerCase();
  const fullName = clean(person.name || person.full_name || `${firstName} ${lastName}`, 200).toLowerCase();
  const company = clean(person.organization_name || person.company || organization.name, 200).toLowerCase();
  return [
    apolloPersonId(person),
    clean(person.linkedin_url || person.linkedinUrl || person.profile_url, 500).toLowerCase(),
    normalizeEmail(person.email || person.email_address),
    fullName && company ? `${fullName}|${company}` : '',
  ].filter(Boolean);
}

function dedupePreviewPeople(people = []) {
  const seen = new Set();
  const unique = [];
  for (const person of people) {
    if (!person || typeof person !== 'object') continue;
    if (!apolloPersonId(person)) continue;
    const keys = candidateIdentityKeys(person);
    if (keys.some(key => seen.has(key))) continue;
    keys.forEach(key => seen.add(key));
    unique.push(person);
  }
  return unique;
}

function appendUniquePreviewPeople(existing = [], incoming = [], limit = CANDIDATE_CAP) {
  const unique = [...existing];
  const seen = new Set(unique.flatMap(candidateIdentityKeys));
  for (const person of dedupePreviewPeople(incoming)) {
    if (unique.length >= limit) break;
    const keys = candidateIdentityKeys(person);
    if (keys.some(key => seen.has(key))) continue;
    keys.forEach(key => seen.add(key));
    unique.push(person);
  }
  return unique;
}

function contains(value, query) {
  const left = clean(value).toLowerCase();
  const right = clean(query).toLowerCase();
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function previewFitScore(lead = {}, request = {}) {
  const reasons = [];
  let score = 0;
  const title = lead.title || lead.personalization_profile?.person?.title;
  const company = lead.company_data || {};
  const profileCompany = lead.personalization_profile?.company || {};
  const industry = company.industry || profileCompany.industry;
  const location = lead.location || profileCompany.location;
  const titles = request.target_titles || request.titles || [];

  if (titles.some(target => contains(title, target))) {
    score += 40;
    reasons.push({ points: 40, reason: 'Buyer role matches' });
  }
  if (contains(industry, request.target_industry || request.industry)) {
    score += 25;
    reasons.push({ points: 25, reason: 'Target industry matches' });
  }
  if (contains(location, request.target_region || request.region)) {
    score += 15;
    reasons.push({ points: 15, reason: 'Target location matches' });
  }
  if (company.estimated_num_employees || profileCompany.employee_count || request.target_company_size || request.companySize) {
    score += 10;
    reasons.push({ points: 10, reason: 'Company-size information is available' });
  }
  if (lead.company_name && (lead.company_domain || company.domain || company.short_description)) {
    score += 10;
    reasons.push({ points: 10, reason: 'Contact and company information is available' });
  }
  return { score: Math.min(score, 100), reasons };
}

function researchQuality(lead = {}) {
  const profile = lead.personalization_profile || {};
  const person = profile.person || {};
  const company = profile.company || {};
  const companyData = lead.company_data || {};
  let score = 0;
  if (isUsableWorkEmail(lead.email)) score += 1;
  if (lead.full_name && lead.title) score += 1;
  if (lead.company_name) score += 1;
  if (company.description || company.industry || companyData.short_description || companyData.industry || companyData.domain) score += 1;
  if (person.linkedin_url || lead.linkedin_url || person.relevant_experience?.length || company.technologies?.length) score += 1;
  return score;
}

function hasEnoughPreviewResearch(lead = {}) {
  if (!isUsableWorkEmail(lead.email)) return false;
  if (!clean(lead.full_name) || !clean(lead.company_name) || !clean(lead.title)) return false;
  const profile = lead.personalization_profile || {};
  const person = profile.person || {};
  const company = profile.company || {};
  const companyData = lead.company_data || {};
  return Boolean(
    lead.linkedin_url
    || person.linkedin_url
    || company.linkedin_url
    || company.domain
    || companyData.domain
    || company.industry
    || companyData.industry
    || company.description
    || companyData.short_description
    || person.relevant_experience?.length,
  );
}

function mergeNonEmpty(existing = {}, incoming = {}) {
  const result = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) continue;
    result[key] = value;
  }
  return result;
}

function mergeRaw(existing = {}, incoming = {}) {
  return mergeNonEmpty(existing, incoming);
}

function personFromCandidate(candidate = {}) {
  const searchPerson = candidate.search_data || {};
  const enrichment = candidate.enrichment_data || {};
  const rawPerson = enrichment.person || enrichment.match || enrichment;
  const organization = rawPerson.organization
    || rawPerson.account
    || searchPerson.organization
    || searchPerson.account
    || {};
  return {
    ...searchPerson,
    ...rawPerson,
    organization,
    email: candidate.email || rawPerson.email || rawPerson.email_address || searchPerson.email,
    linkedin_url: candidate.linkedin_url || rawPerson.linkedin_url || searchPerson.linkedin_url,
    organization_name: candidate.company_name || rawPerson.organization_name || searchPerson.organization_name,
    title: candidate.title || rawPerson.title || searchPerson.title,
  };
}

async function getPreviewRequest(supabase, requestId) {
  const { data, error } = await supabase
    .from('free_lead_preview_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function updatePreviewRequest(supabase, requestId, patch) {
  const { data, error } = await supabase
    .from('free_lead_preview_requests')
    .update(patch)
    .eq('id', requestId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function refreshPreviewCounts(supabase, requestId) {
  const [{ count: readyCount, error: readyError }, { count: candidateCount, error: candidateError }] = await Promise.all([
    supabase.from('free_lead_preview_candidates').select('id', { count: 'exact', head: true }).eq('preview_request_id', requestId).eq('status', 'ready'),
    supabase.from('free_lead_preview_candidates').select('id', { count: 'exact', head: true }).eq('preview_request_id', requestId),
  ]);
  if (readyError || candidateError) throw readyError || candidateError;
  return updatePreviewRequest(supabase, requestId, {
    ready_count: readyCount || 0,
    candidate_count: candidateCount || 0,
  });
}

async function enqueueFreeLeadPreview(requestId, queue = getFreeLeadPreviewQueue()) {
  const jobId = createQueueJobId('free-lead-preview-start', requestId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) return { jobId, reused: true };
    await existing.remove();
  }
  await queue.add('start', { requestId }, { jobId });
  return { jobId, reused: false };
}

async function enqueueFreeLeadPreviewFinalize(requestId, delay = FINALIZE_DELAY_MS, queue = getFreeLeadPreviewQueue()) {
  const jobId = createQueueJobId('free-lead-preview-finalize', requestId, Date.now());
  await queue.add('finalize', { requestId }, { jobId, delay });
  return { jobId };
}

async function insertPreviewCandidates(supabase, requestId, people, filters) {
  const rows = people.map((person, index) => {
    const normalized = normalizeApolloLead(person, { searchFilters: filters, searchPage: Math.floor(index / 100) + 1 });
    return {
      preview_request_id: requestId,
      external_id: normalized.external_id,
      search_rank: index + 1,
      status: 'enriching',
      full_name: normalized.full_name,
      first_name: normalized.first_name,
      last_name: normalized.last_name,
      company_name: normalized.company_name,
      title: normalized.title,
      location: normalized.location,
      linkedin_url: normalized.linkedin_url || null,
      company_domain: normalized.company_domain || null,
      search_data: person,
    };
  });
  if (rows.length) {
    const { error } = await supabase
      .from('free_lead_preview_candidates')
      .upsert(rows, {
        onConflict: 'preview_request_id,external_id',
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }

  const { data, error } = await supabase
    .from('free_lead_preview_candidates')
    .select('*')
    .eq('preview_request_id', requestId)
    .order('search_rank', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function applyFreeLeadPreviewWebhookUpdates(supabase, updates = {}) {
  const list = Array.isArray(updates) ? updates : [];
  let matched = 0;
  let updated = 0;
  const requestIds = new Set();

  for (const update of list) {
    if (!update?.requestId && !update?.personId) continue;
    let query = supabase.from('free_lead_preview_candidates').select('*').eq('status', 'enriching');
    if (update.requestId) query = query.eq('apollo_request_id', update.requestId);
    if (update.personId) query = query.eq('external_id', update.personId);
    const { data: candidates, error } = await query.limit(10);
    if (error) throw error;
    let matchingCandidates = candidates || [];
    // Apollo can deliver the provider request ID in a nested result object
    // that differs from the ID returned by bulk_match. Fall back to the
    // globally unique Apollo person ID only when it identifies one pending
    // preview candidate, matching the authenticated lead-import behavior.
    if (!matchingCandidates.length && update.personId && update.requestId) {
      const fallback = await supabase
        .from('free_lead_preview_candidates')
        .select('*')
        .eq('status', 'enriching')
        .eq('external_id', update.personId)
        .limit(2);
      if (fallback.error) throw fallback.error;
      matchingCandidates = fallback.data || [];
    }
    if (!matchingCandidates.length) continue;
    const candidate = matchingCandidates.length === 1
      ? matchingCandidates[0]
      : update.personId
        ? matchingCandidates.find(item => item.external_id === update.personId)
        : null;
    if (!candidate) continue;
    matched += 1;
    requestIds.add(candidate.preview_request_id);
    const email = normalizeEmail(update.email);
    const hasEmail = isUsableWorkEmail(email);
    const { error: updateError } = await supabase
      .from('free_lead_preview_candidates')
      .update({
        status: hasEmail ? 'ready' : 'rejected',
        email: hasEmail ? email : null,
        email_status: hasEmail ? 'verified' : 'not_found',
        linkedin_url: update.linkedinUrl || candidate.linkedin_url || null,
        company_domain: update.companyDomain || candidate.company_domain || null,
        enrichment_data: mergeRaw(candidate.enrichment_data, update.raw || {}),
        rejection_reason: hasEmail ? null : 'Apollo returned no verified work email',
      })
      .eq('id', candidate.id)
      .eq('status', 'enriching');
    if (updateError) throw updateError;
    updated += 1;
  }

  for (const requestId of requestIds) {
    await refreshPreviewCounts(supabase, requestId);
    try {
      await enqueueFreeLeadPreviewFinalize(requestId, 1000);
    } catch (error) {
      console.error(JSON.stringify({ event: 'free_lead_preview_finalize_enqueue_failed', requestId, error: error.message }));
    }
  }
  return { matched, updated, requestIds: [...requestIds] };
}

async function startFreeLeadPreview({ supabase, requestId }) {
  const request = await getPreviewRequest(supabase, requestId);
  if (!request) throw new Error('Free lead preview request not found');
  if (['sending', 'sent', 'partial'].includes(request.status)) return { status: request.status, skipped: true };

  const filters = previewFilters(request);
  const startedAt = new Date().toISOString();
  const existingMeta = request.provider_meta || {};
  const existingTimeout = Date.parse(existingMeta.timeout_at || '');
  const timeoutAt = existingTimeout > Date.now()
    ? existingMeta.timeout_at
    : new Date(Date.now() + ENRICHMENT_TIMEOUT_MS).toISOString();
  await updatePreviewRequest(supabase, requestId, {
    status: 'searching',
    started_at: startedAt,
    error_message: null,
    provider_meta: {
      ...existingMeta,
      filters,
      candidate_cap: CANDIDATE_CAP,
      search_page_cap: SEARCH_PAGE_CAP,
      timeout_at: timeoutAt,
    },
  });

  const people = [];
  let page = 1;
  let searchedPages = 0;
  while (page <= SEARCH_PAGE_CAP && people.length < CANDIDATE_CAP) {
    const result = await searchPeople(filters, page, 100);
    searchedPages = page;
    people.splice(0, people.length, ...appendUniquePreviewPeople(people, result.people, CANDIDATE_CAP));
    if (!(result.people || []).length) break;
    page += 1;
  }

  const candidates = await insertPreviewCandidates(supabase, requestId, people, filters);
  await updatePreviewRequest(supabase, requestId, {
    status: candidates.length ? 'enriching' : 'sending',
    candidate_count: candidates.length,
    search_pages: searchedPages,
    provider_meta: {
      ...existingMeta,
      filters,
      candidate_cap: CANDIDATE_CAP,
      search_page_cap: SEARCH_PAGE_CAP,
      timeout_at: timeoutAt,
      searched_pages: searchedPages,
    },
  });

  if (!candidates.length) return finalizeFreeLeadPreview({ supabase, requestId, force: true });

  const peopleById = new Map([
    ...people.map(person => [apolloPersonId(person), person]),
    ...candidates.map(candidate => [candidate.external_id, candidate.search_data]).filter(([, person]) => person),
  ]);
  const peopleToEnrich = candidates
    .filter(candidate => candidate.status === 'enriching' && !candidate.apollo_request_id)
    .map(candidate => peopleById.get(candidate.external_id))
    .filter(Boolean);
  const batches = peopleToEnrich.length ? await requestBulkEnrichment(peopleToEnrich, requestId) : [];
  const requestIds = [...new Set((existingMeta.apollo_request_ids || []).map(id => clean(id, 200)).filter(Boolean))];
  for (const batch of batches) {
    const requestIdFromApollo = clean(batch.request_id, 200);
    if (requestIdFromApollo) requestIds.push(requestIdFromApollo);
    if (requestIdFromApollo) {
      const externalIds = (batch.people || []).filter(personId => peopleById.has(personId));
      if (externalIds.length) {
        const { error } = await supabase
          .from('free_lead_preview_candidates')
          .update({ apollo_request_id: requestIdFromApollo })
          .eq('preview_request_id', requestId)
          .in('external_id', externalIds);
        if (error) throw error;
      }
    }
    const immediateUpdates = extractWebhookUpdates(batch.payload || {});
    if (immediateUpdates.length) await applyFreeLeadPreviewWebhookUpdates(supabase, immediateUpdates);
  }

  await updatePreviewRequest(supabase, requestId, {
    status: 'enriching',
    provider_meta: {
      ...existingMeta,
      filters,
      candidate_cap: CANDIDATE_CAP,
      search_page_cap: SEARCH_PAGE_CAP,
      timeout_at: timeoutAt,
      searched_pages: searchedPages,
      apollo_request_ids: [...new Set(requestIds)],
    },
  });
  await enqueueFreeLeadPreviewFinalize(requestId);
  return { status: 'enriching', candidateCount: candidates.length, requestIds };
}

async function pollPreviewApolloResults(supabase, candidates) {
  const requestIds = [...new Set(candidates.map(candidate => candidate.apollo_request_id).filter(Boolean))];
  let polled = 0;
  for (const requestId of requestIds) {
    try {
      const payload = await pollWebhookResult(requestId, { force: true });
      const updates = extractWebhookUpdates(payload || {});
      if (updates.length) {
        const result = await applyFreeLeadPreviewWebhookUpdates(supabase, updates);
        polled += result.updated;
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'free_lead_preview_poll_failed', requestIdSuffix: requestId.slice(-8), error: error.message }));
    }
  }
  return polled;
}

async function buildEnrichedCandidate(candidate, request) {
  const person = personFromCandidate(candidate);
  const normalized = normalizeApolloLead(person);
  const companyData = await enrichOrganizationForPerson(person);
  const canonicalCompanyData = mergeNonEmpty(normalized.company_data, companyData);
  const profile = buildPersonalizationProfile(person, canonicalCompanyData, new Date().toISOString());
  const lead = {
    ...candidate,
    ...normalized,
    email: candidate.email,
    email_status: candidate.email_status,
    company_data: canonicalCompanyData,
    personalization_profile: profile,
  };
  const fit = previewFitScore(lead, request);
  const quality = researchQuality(lead);
  return {
    lead,
    patch: {
      full_name: lead.full_name,
      first_name: lead.first_name || null,
      last_name: lead.last_name || null,
      company_name: lead.company_name || null,
      title: lead.title || null,
      location: lead.location || null,
      linkedin_url: lead.linkedin_url || null,
      company_domain: lead.company_domain || canonicalCompanyData.domain || null,
      company_data: canonicalCompanyData,
      personalization_profile: profile,
      fit_score: fit.score,
      fit_reasons: fit.reasons,
      research_quality: quality,
      status: hasEnoughPreviewResearch(lead) ? 'ready' : 'rejected',
      rejection_reason: hasEnoughPreviewResearch(lead) ? null : 'Not enough reliable research to prepare the lead report',
    },
  };
}

function sortPreviewLeads(leads) {
  return [...leads].sort((a, b) => (
    Number(b.fit_score || 0) - Number(a.fit_score || 0)
    || Number(b.research_quality || 0) - Number(a.research_quality || 0)
    || Number(a.search_rank || 0) - Number(b.search_rank || 0)
  ));
}

async function finalizeFreeLeadPreview({ supabase, requestId, force = false }) {
  let request = await getPreviewRequest(supabase, requestId);
  if (!request) throw new Error('Free lead preview request not found');
  if (['sent', 'partial'].includes(request.status)) return { status: request.status, skipped: true };

  let { data: candidates, error: candidateError } = await supabase
    .from('free_lead_preview_candidates')
    .select('*')
    .eq('preview_request_id', requestId)
    .order('search_rank', { ascending: true });
  if (candidateError) throw candidateError;
  candidates = candidates || [];

  if (!force && candidates.some(candidate => candidate.status === 'enriching')) {
    await pollPreviewApolloResults(supabase, candidates);
    const refreshed = await supabase.from('free_lead_preview_candidates').select('*').eq('preview_request_id', requestId).order('search_rank', { ascending: true });
    if (refreshed.error) throw refreshed.error;
    candidates = refreshed.data || [];
  }

  const timeoutAt = request.provider_meta?.timeout_at ? new Date(request.provider_meta.timeout_at).getTime() : 0;
  const timedOut = timeoutAt > 0 && Date.now() >= timeoutAt;
  if (candidates.some(candidate => candidate.status === 'enriching') && !timedOut && !force) {
    await updatePreviewRequest(supabase, requestId, { status: 'enriching' });
    await enqueueFreeLeadPreviewFinalize(requestId);
    return { status: 'enriching', pending: true };
  }
  if (candidates.some(candidate => candidate.status === 'enriching')) {
    const { error } = await supabase
      .from('free_lead_preview_candidates')
      .update({ status: 'rejected', email_status: 'not_found', rejection_reason: 'Apollo enrichment did not complete in time' })
      .eq('preview_request_id', requestId)
      .eq('status', 'enriching');
    if (error) throw error;
  }

  const refreshedCandidates = await supabase.from('free_lead_preview_candidates').select('*').eq('preview_request_id', requestId).order('search_rank', { ascending: true });
  if (refreshedCandidates.error) throw refreshedCandidates.error;
  candidates = refreshedCandidates.data || [];
  const readyCandidates = [];
  for (const candidate of candidates.filter(item => item.status === 'ready' && item.email)) {
    if (candidate.personalization_profile && Object.keys(candidate.personalization_profile).length) {
      readyCandidates.push(candidate);
      continue;
    }
    const enriched = await buildEnrichedCandidate(candidate, request);
    const { data, error } = await supabase.from('free_lead_preview_candidates').update(enriched.patch).eq('id', candidate.id).select('*').single();
    if (error) throw error;
    if (data.status === 'ready') readyCandidates.push(data);
  }

  const selected = sortPreviewLeads(readyCandidates).slice(0, REQUESTED_LEAD_COUNT);
  for (let index = 0; index < selected.length; index += 1) {
    const { error } = await supabase.from('free_lead_preview_candidates').update({ selected_rank: index + 1 }).eq('id', selected[index].id);
    if (error) throw error;
    selected[index] = { ...selected[index], selected_rank: index + 1 };
  }
  await refreshPreviewCounts(supabase, requestId);

  const { data: claimed, error: claimError } = await supabase
    .from('free_lead_preview_requests')
    .update({ status: 'sending', ready_count: selected.length, error_message: null })
    .eq('id', requestId)
    .in('status', ['queued', 'searching', 'enriching'])
    .select('*')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) {
    request = await getPreviewRequest(supabase, requestId);
    return { status: request?.status || 'unknown', skipped: true };
  }

  try {
    const mail = await sendFreeLeadPreviewEmail({ request: claimed, leads: selected });
    const status = selected.length === REQUESTED_LEAD_COUNT ? 'sent' : 'partial';
    const resultSummary = selected.map(lead => ({
      id: lead.id,
      name: lead.full_name,
      title: lead.title,
      company: lead.company_name,
      email: lead.email,
      domain: lead.company_domain || lead.company_data?.domain || null,
      fit_score: lead.fit_score,
      research_quality: lead.research_quality,
    }));
    await updatePreviewRequest(supabase, requestId, {
      status,
      ready_count: selected.length,
      result_summary: { leads: resultSummary, email_message_id: mail.messageId || null, email_subject: mail.subject },
      completed_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
      error_message: null,
    });
    return { status, selectedCount: selected.length, messageId: mail.messageId || null };
  } catch (error) {
    await updatePreviewRequest(supabase, requestId, {
      status: 'failed',
      error_message: error.message || 'Lead preview email could not be sent',
      completed_at: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
}

async function processFreeLeadPreviewJob(job) {
  const { createServiceClient } = require('./supabase');
  const service = createServiceClient();
  if (!service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for free lead preview workers');
  if (job.name === 'start') return startFreeLeadPreview({ supabase: service, requestId: job.data.requestId });
  if (job.name === 'finalize') return finalizeFreeLeadPreview({ supabase: service, requestId: job.data.requestId });
  throw new Error(`Unsupported free lead preview job ${job.name}`);
}

async function markFreeLeadPreviewFailed(supabase, requestId, error) {
  if (!supabase || !requestId) return;
  const { error: updateError } = await supabase
    .from('free_lead_preview_requests')
    .update({
      status: 'failed',
      error_message: error?.message || 'Lead preview processing failed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .in('status', ['queued', 'searching', 'enriching', 'sending']);
  if (updateError) throw updateError;
}

module.exports = {
  CANDIDATE_CAP,
  ENRICHMENT_TIMEOUT_MS,
  REQUESTED_LEAD_COUNT,
  SEARCH_PAGE_CAP,
  applyFreeLeadPreviewWebhookUpdates,
  appendUniquePreviewPeople,
  dedupePreviewPeople,
  enqueueFreeLeadPreview,
  enqueueFreeLeadPreviewFinalize,
  finalizeFreeLeadPreview,
  hasEnoughPreviewResearch,
  isUsableWorkEmail,
  markFreeLeadPreviewFailed,
  normalizePreviewInput,
  previewFitScore,
  processFreeLeadPreviewJob,
  researchQuality,
  startFreeLeadPreview,
};
