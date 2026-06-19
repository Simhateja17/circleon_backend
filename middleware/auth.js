const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  createRequestClient,
  parseCookies,
  setSessionCookies,
  clearAuthCookies,
} = require('../lib/authCookies');

async function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const header = req.headers.authorization || '';
  const bearerToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const token = cookies[ACCESS_COOKIE] || bearerToken;

  if (!token && !cookies[REFRESH_COOKIE]) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let supabase = createRequestClient(token);
  let { data, error } = await supabase.auth.getUser();

  if ((error || !data.user) && cookies[REFRESH_COOKIE]) {
    const refreshClient = createRequestClient();
    const refreshResult = await refreshClient.auth.refreshSession({
      refresh_token: cookies[REFRESH_COOKIE],
    });

    if (!refreshResult.error && refreshResult.data.session) {
      setSessionCookies(res, refreshResult.data.session);
      supabase = createRequestClient(refreshResult.data.session.access_token);
      ({ data, error } = await supabase.auth.getUser());
    }
  }

  if (error || !data.user) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = data.user;
  req.supabase = supabase;
  return next();
}

module.exports = requireAuth;
