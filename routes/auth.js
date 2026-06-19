const express = require('express');
const supabase = require('../lib/supabase');
const {
  clearAuthCookies,
  createOAuthClient,
  setSessionCookies,
} = require('../lib/authCookies');

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5001}`;

function appRedirect(path) {
  return `${FRONTEND_URL}${path}`;
}

function authCallbackUrl() {
  return `${API_PUBLIC_URL}/api/auth/callback`;
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, password, fullName, businessName, phone } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName || '',
        business_name: businessName || '',
        phone: phone || '',
      },
    },
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  setSessionCookies(res, data.session);

  return res.json({
    message: 'Signup successful. Please check your email to confirm your account.',
    user: data.user,
    authenticated: Boolean(data.session),
  });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.status(401).json({ error: error.message });
  }

  setSessionCookies(res, data.session);

  return res.json({
    message: 'Login successful',
    user: data.user,
    authenticated: true,
  });
});

// GET /api/auth/google
router.get('/google', async (req, res) => {
  const oauth = createOAuthClient(req, res);
  const { data, error } = await oauth.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: authCallbackUrl(),
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  });

  if (error) {
    return res.redirect(appRedirect(`/login?error=${encodeURIComponent(error.message)}`));
  }

  return res.redirect(data.url);
});

// GET /api/auth/callback
router.get('/callback', async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(appRedirect(`/login?error=${encodeURIComponent(errorDescription || error)}`));
  }

  if (!code || typeof code !== 'string') {
    return res.redirect(appRedirect('/login?error=Missing%20auth%20code'));
  }

  const oauth = createOAuthClient(req, res);
  const { data, error: exchangeError } = await oauth.auth.exchangeCodeForSession(code);

  if (exchangeError || !data.session) {
    clearAuthCookies(res);
    return res.redirect(appRedirect(`/login?error=${encodeURIComponent(exchangeError?.message || 'Google sign in failed')}`));
  }

  setSessionCookies(res, data.session);
  return res.redirect(appRedirect('/auth/complete'));
});

// POST /api/auth/logout
router.post('/logout', async (_req, res) => {
  clearAuthCookies(res);
  return res.json({ message: 'Logged out' });
});

module.exports = router;
