const CREDIT_URL = 'https://api.apollo.io/api/v1/usage_stats/credit_usage_stats';
function normalizeCreditStats(payload) {
  const stats = payload?.credit_usage_stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('Apollo returned no credit balances.');
  const balances = Object.entries(stats).map(([type, value]) => {
    if (!value || !['limit','consumed','left_over'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && value[k] >= 0)) throw new Error('Apollo returned an unsupported credit balance.');
    const {limit, consumed, left_over} = value;
    return {type, limit, consumed, left_over, percent_used: limit > 0 ? consumed / limit * 100 : null, alert: limit > 0 && consumed / limit >= 0.8};
  });
  if (!balances.length) throw new Error('Apollo returned no credit balances.');
  const cycle = payload.current_credit_cycle || null;
  return {balances, cycle};
}
async function fetchApolloCredits({key = process.env.APOLLO_API_KEY, fetchImpl = fetch} = {}) {
  if (!key) throw new Error('Apollo API key is not configured.');
  const response = await fetchImpl(CREDIT_URL, {method:'POST', headers:{'x-api-key':key,accept:'application/json','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Apollo credit balance request failed (${response.status}). Verify credit-usage permissions on the API key.`);
  return normalizeCreditStats(await response.json());
}
function manualSnapshot(input, now = new Date()) {
  const {type, limit, consumed, left_over, verified_at, source_note} = input || {};
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(type)) throw new Error('Enter the Apollo credit type.');
  if (typeof source_note !== 'string' || source_note.trim().length < 5 || source_note.length > 500) throw new Error('Record the source used to verify this balance.');
  const date = new Date(verified_at);
  if (!verified_at || !Number.isFinite(date.getTime()) || date > now) throw new Error('Enter a valid verification time, no later than now.');
  const normalized = normalizeCreditStats({credit_usage_stats:{[type]:{limit,consumed,left_over}}});
  return {...normalized, verified_at:date.toISOString(), source_note:source_note.trim()};
}
function isInternalAdmin(user, value = process.env.CIRCLEON_ADMIN_USER_IDS || '') {
  return Boolean(user?.id && value.split(',').map(v=>v.trim()).filter(Boolean).includes(user.id));
}
module.exports = {CREDIT_URL,normalizeCreditStats,fetchApolloCredits,manualSnapshot,isInternalAdmin};
