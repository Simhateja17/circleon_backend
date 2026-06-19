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

// POST /api/auth/otp/request
router.post('/otp/request', async (req, res) => {
  const {
    email: rawEmail,
    intent,
    fullName,
    businessName,
    phone,
  } = req.body;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

  if (!email || !['login', 'signup'].includes(intent)) {
    return res.status(400).json({ error: 'A valid email and intent are required' });
  }

  const isSignup = intent === 'signup';
  if (isSignup && (!fullName?.trim() || !businessName?.trim())) {
    return res.status(400).json({ error: 'Full name and business name are required' });
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: isSignup,
      ...(isSignup
        ? {
            data: {
              full_name: fullName.trim(),
              business_name: businessName.trim(),
              phone: typeof phone === 'string' ? phone.trim() : '',
            },
          }
        : {}),
    },
  });

  if (error) {
    console.error(JSON.stringify({
      event: 'otp_request_failed',
      intent,
      error: error.message,
      code: error.code || null,
      status: error.status || null,
    }));
    return res.status(400).json({ error: error.message });
  }

  return res.json({
    message: 'If this email can be used here, a verification code has been sent.',
    otpSent: true,
  });
});

// POST /api/auth/otp/verify
router.post('/otp/verify', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';

  if (!email || !/^\d{6,10}$/.test(token)) {
    return res.status(400).json({ error: 'Email and a verification code are required' });
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });

  if (error || !data.session) {
    console.warn(JSON.stringify({
      event: 'otp_verify_failed',
      error: error?.message || 'Session missing after OTP verification',
      code: error?.code || null,
      status: error?.status || null,
    }));
    return res.status(401).json({ error: error?.message || 'Invalid or expired code' });
  }

  setSessionCookies(res, data.session);
  console.info(JSON.stringify({ event: 'otp_verify_succeeded', userId: data.user?.id || null }));

  return res.json({
    message: 'Authentication successful',
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
