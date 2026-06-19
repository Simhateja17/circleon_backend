const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const ACCESS_COOKIE = 'barsha_access_token';
const REFRESH_COOKIE = 'barsha_refresh_token';
const OAUTH_VERIFIER_COOKIE = 'barsha_oauth_code_verifier';
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function cookieSameSite() {
  return process.env.AUTH_COOKIE_SAME_SITE || 'Lax';
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return cookies;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }

    return cookies;
  }, {});
}

function appendCookie(res, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    'HttpOnly',
    `SameSite=${options.sameSite || cookieSameSite()}`,
  ];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (isProd()) parts.push('Secure');

  const previous = res.getHeader('Set-Cookie');
  const next = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  res.setHeader('Set-Cookie', [...next, parts.join('; ')]);
}

function clearAuthCookies(res) {
  appendCookie(res, ACCESS_COOKIE, '', { maxAge: 0 });
  appendCookie(res, REFRESH_COOKIE, '', { maxAge: 0 });
  appendCookie(res, OAUTH_VERIFIER_COOKIE, '', { maxAge: 0 });
}

function setSessionCookies(res, session) {
  if (!session?.access_token || !session?.refresh_token) return;

  appendCookie(res, ACCESS_COOKIE, session.access_token, {
    maxAge: session.expires_in || 60 * 60,
  });
  appendCookie(res, REFRESH_COOKIE, session.refresh_token, {
    maxAge: THIRTY_DAYS_SECONDS,
  });
}

function createRequestClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
  });
}

function createOAuthClient(req, res) {
  const cookies = parseCookies(req);
  const storage = {
    getItem(key) {
      if (!key.endsWith('code-verifier')) return null;
      return cookies[OAUTH_VERIFIER_COOKIE] || null;
    },
    setItem(key, value) {
      if (!key.endsWith('code-verifier')) return;
      appendCookie(res, OAUTH_VERIFIER_COOKIE, value, { maxAge: 60 * 10 });
    },
    removeItem(key) {
      if (!key.endsWith('code-verifier')) return;
      appendCookie(res, OAUTH_VERIFIER_COOKIE, '', { maxAge: 0 });
    },
  };

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage,
    },
  });
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  clearAuthCookies,
  createOAuthClient,
  createRequestClient,
  parseCookies,
  setSessionCookies,
};
