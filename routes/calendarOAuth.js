// Google's redirect lands here.
//
// Unauthenticated by necessity: Google sends the browser, not our session. The
// workspace comes from the signed-in user encoded into `state` at the moment
// the flow started, and we verify that user actually owns the workspace before
// storing anything.

const express = require('express');
const { createServiceClient } = require('../lib/supabase');
const { encrypt } = require('../lib/crypto');
const { exchangeCode } = require('../lib/googleCalendar');

const router = express.Router();

function appUrl(path) {
  const base = process.env.APP_BASE_URL || process.env.FRONTEND_URL || '';
  return `${base}${path}`;
}

function parseState(raw) {
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!decoded.workspace_id || !decoded.user_id) return null;
    return decoded;
  } catch (_error) {
    return null;
  }
}

async function accountEmail(accessToken) {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.email || null;
  } catch (_error) {
    return null;
  }
}

router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(appUrl('/dashboard?calendar=denied'));
  }

  const parsed = parseState(state);
  if (!code || !parsed) {
    return res.redirect(appUrl('/dashboard?calendar=invalid'));
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return res.redirect(appUrl('/dashboard?calendar=error'));
  }

  try {
    // The state is attacker-supplied until proven otherwise, so confirm the
    // user it names really does own the workspace it names.
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('id, owner_id')
      .eq('id', parsed.workspace_id)
      .maybeSingle();

    if (!workspace || workspace.owner_id !== parsed.user_id) {
      return res.redirect(appUrl('/dashboard?calendar=invalid'));
    }

    const tokens = await exchangeCode(code);
    const email = await accountEmail(tokens.access_token);

    const { error } = await supabase
      .from('calendar_connections')
      .upsert({
        workspace_id: workspace.id,
        provider: 'google_calendar',
        account_email: email,
        calendar_id: 'primary',
        refresh_token_encrypted: encrypt(tokens.refresh_token),
        access_token_encrypted: encrypt(tokens.access_token),
        access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
        status: 'connected',
        last_error: null,
      }, { onConflict: 'workspace_id' });

    if (error) throw error;

    return res.redirect(appUrl('/dashboard?calendar=connected'));
  } catch (error) {
    console.error('[calendar-oauth] failed', error);
    return res.redirect(appUrl('/dashboard?calendar=error'));
  }
});

module.exports = router;
