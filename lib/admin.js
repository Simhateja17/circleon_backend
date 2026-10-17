const { createServiceClient } = require('./supabase');
const { isInternalAdmin } = require('./providerCredits');

// Admin sessions must have completed TOTP within this window, even though the
// customer session they ride on lasts 30 days.
const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function service() {
  const db = createServiceClient();
  if (!db) throw new Error('Admin requires the service database connection.');
  return db;
}

async function result(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Only call this on a token requireAuth has already verified with Supabase;
// it reads claims without checking the signature.
function tokenClaims(token) {
  try {
    const payload = String(token || '').split('.')[1];
    return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

function mfaState(token, now = Date.now()) {
  const claims = tokenClaims(token);
  const totp = (Array.isArray(claims.amr) ? claims.amr : []).filter(entry => entry?.method === 'totp');
  const verifiedAt = totp.length ? Math.max(...totp.map(entry => Number(entry.timestamp) || 0)) : 0;
  const aal2 = claims.aal === 'aal2' && verifiedAt > 0;
  return {
    aal2,
    fresh: aal2 && now / 1000 - verifiedAt <= ADMIN_SESSION_MAX_AGE_SECONDS,
    verified_at: verifiedAt ? new Date(verifiedAt * 1000).toISOString() : null,
  };
}

function requireFounder(req, res, next) {
  if (!isInternalAdmin(req.user)) return res.status(403).json({ error: 'Internal CircleOn access only.' });
  return next();
}

function requireAdminMfa(req, res, next) {
  const state = mfaState(req.accessToken);
  if (!state.aal2) return res.status(403).json({ error: 'Two-factor verification is required for admin access.', code: 'mfa_required' });
  if (!state.fresh) return res.status(403).json({ error: 'Your admin verification has expired. Verify again to continue.', code: 'mfa_expired' });
  return next();
}

// Fixed-window limiter keyed per user. In-memory is enough for a single
// founder account on one API process; it resets on deploy.
function rateLimit({ windowMs, max, key = 'admin' }) {
  const hits = new Map();
  return (req, res, next) => {
    const id = `${key}:${req.user?.id || req.ip}`;
    const now = Date.now();
    const entry = hits.get(id);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(id, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: 'Too many admin requests. Wait a moment and try again.' });
    return next();
  };
}

// The audit row is written before the change so an action never happens
// without a record. If the change then fails, the row still shows the attempt.
async function audit(req, db, { action, targetType, targetId = null, before = null, after = null }) {
  await result(db.from('admin_audit_log').insert({
    actor_id: req.user.id,
    action,
    target_type: targetType,
    target_id: targetId,
    before,
    after,
    ip: req.ip || null,
  }));
}

async function gotrue(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.msg || data.message || data.error_description || 'Two-factor request failed.'), { status: res.status === 422 ? 400 : res.status });
  return data;
}

async function totpFactors(token) {
  const user = await gotrue('/user', token);
  return (user.factors || []).filter(factor => factor.factor_type === 'totp');
}

module.exports = {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  audit,
  gotrue,
  mfaState,
  rateLimit,
  requireAdminMfa,
  requireFounder,
  result,
  service,
  tokenClaims,
  totpFactors,
};
