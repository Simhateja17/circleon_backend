const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { encrypt, decrypt } = require('../lib/crypto');
const { normalizePhone } = require('../lib/calling');
const {
  deletePhoneNumber,
  getPhoneNumber,
  importPhoneNumber,
  listVoices,
  supportedLanguages,
} = require('../lib/retellVoice');
const {
  checkNumbersWithPdpc,
  pdpcCredentials,
  requiresDncCheck,
  summariseCallability,
} = require('../lib/dnc');
const { getCredits } = require('../lib/callCredits');
const { authorizationUrl } = require('../lib/googleCalendar');
const { generateVoiceScript, composeOpeningLine } = require('../lib/voiceScript');
const { syncVoiceAgent, monthlyWorkspace, loadWorkspaceAgent } = require('../lib/voiceAgentProvisioning');
const { createServiceClient } = require('../lib/supabase');
const { voiceCampaignState, requiresAttestation, ACTIVE_CALL_STATUSES } = require('../lib/voiceCampaign');
const { callingWindowState } = require('../lib/voiceScheduling');
const {
  ensureTerminationTrunk,
  fetchOwnedNumber,
  listEligibleNumbers,
  routeInboundToWebhook,
  validateAccount,
} = require('../lib/twilioByok');

const router = express.Router();
router.use(requireAuth);

async function loadVoiceCampaign(req, workspaceId, campaignId) {
  const { data: campaign, error } = await req.supabase
    .from('campaigns')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', campaignId)
    .eq('channel', 'voice')
    .maybeSingle();

  if (error) throw error;
  return campaign;
}

async function loadCampaignContext(req, workspaceId, campaignId) {
  const campaign = await loadVoiceCampaign(req, workspaceId, campaignId);
  if (!campaign) return null;

  const [
    { data: script },
    { data: agent },
    { data: telephony },
    { data: agentConfig },
  ] = await Promise.all([
    req.supabase.from('voice_scripts').select('*').eq('campaign_id', campaignId).maybeSingle(),
    monthlyWorkspace(req.supabase,workspaceId).then(async monthly => ({data:monthly ? await loadWorkspaceAgent(req.supabase,workspaceId) : (await req.supabase.from('voice_agents').select('*').eq('campaign_id',campaignId).maybeSingle()).data})),
    req.supabase.from('workspace_telephony').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    req.supabase.from('agent_configs').select('*').eq('workspace_id', workspaceId).maybeSingle(),
  ]);

  return { campaign, script, agent, telephony, agentConfig };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

router.get('/languages', (req, res) => {
  res.json({ languages: supportedLanguages() });
});

router.get('/voices', async (req, res) => {
  try {
    const voices = await listVoices({ language: req.query.language || 'en-US' });
    return res.json({ voices });
  } catch (error) {
    if (error.code === 'RETELL_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Voice provider is not configured yet', voices: [] });
    }
    return res.status(500).json({ error: error.message || 'Could not load voices' });
  }
});

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

router.get('/credits', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const [credits, { data: entries, error }] = await Promise.all([
      getCredits(req.supabase, workspace.id),
      req.supabase
        .from('call_credit_entries')
        .select('*')
        .eq('workspace_id', workspace.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (error) throw error;
    return res.json({ credits, entries: entries || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load call credits' });
  }
});

// ---------------------------------------------------------------------------
// Telephony
// ---------------------------------------------------------------------------

// The Retell registration only proves Retell accepted the number. It is not
// proof of ownership, carrier routing, regulatory approval or a working call,
// so a registered number is "attached"; "verified" is set by an operator after
// real test calls.
const SECRET_COLUMNS = ['twilio_auth_token_encrypted', 'sip_auth_password_encrypted', 'pdpc_api_key_encrypted'];

function publicTelephony(data) {
  if (!data) return null;
  const telephony = { ...data };
  for (const column of SECRET_COLUMNS) delete telephony[column];
  telephony.pdpc_configured = Boolean(data.pdpc_account_id && data.pdpc_api_key_encrypted);
  telephony.twilio_connected = Boolean(data.twilio_account_sid && data.twilio_auth_token_encrypted && data.twilio_connected_at);
  return telephony;
}

async function ownerWorkspace(req, res) {
  const workspace = await getOrCreateWorkspace(req.supabase, req.user);
  if (workspace.owner_id !== req.user.id) {
    res.status(403).json({ error: 'Only the workspace owner manages the calling number.' });
    return null;
  }
  return workspace;
}

async function loadTelephony(req, workspaceId) {
  const { data, error } = await req.supabase
    .from('workspace_telephony')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function storedTwilio(telephony) {
  if (!telephony?.twilio_account_sid || !telephony?.twilio_auth_token_encrypted || !telephony?.twilio_connected_at) return null;
  return { accountSid: telephony.twilio_account_sid, authToken: decrypt(telephony.twilio_auth_token_encrypted) };
}

function sendError(res, error, fallback) {
  const status = error.status && error.status < 600 ? error.status : 500;
  return res.status(status).json({ error: error.message || fallback });
}

/** Another workspace already using this number would make inbound ambiguous. */
async function numberInUseElsewhere(fromNumber, workspaceId) {
  const { data, error } = await createServiceClient()
    .from('workspace_telephony')
    .select('workspace_id')
    .eq('from_number', fromNumber)
    .neq('workspace_id', workspaceId)
    .in('phone_number_status', ['attached', 'verified'])
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

/** Import into Retell, replacing a stale registration this workspace owns. */
async function registerWithRetell({ fromNumber, terminationUri, sipUsername, sipPassword, nickname }) {
  const options = { phoneNumber: fromNumber, terminationUri, sipUsername, sipPassword, nickname };
  try {
    await importPhoneNumber(options);
  } catch (error) {
    const existing = await getPhoneNumber(fromNumber).catch(() => null);
    if (!existing) throw error;
    await deletePhoneNumber(fromNumber);
    await importPhoneNumber(options);
  }
  await getPhoneNumber(fromNumber);
}

router.get('/telephony', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const telephony = await loadTelephony(req, workspace.id);
    return res.json({ telephony: publicTelephony(telephony), is_owner: workspace.owner_id === req.user.id });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load telephony settings' });
  }
});

const twilioAccountSchema = z.object({
  account_sid: z.string().trim().max(64),
  auth_token: z.string().trim().max(64),
});

/** Connect the customer's own Twilio account. The token is validated before it is stored. */
router.post('/telephony/twilio', async (req, res) => {
  try {
    const parsed = twilioAccountSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter your Twilio Account SID and Auth Token.' });

    const workspace = await ownerWorkspace(req, res);
    if (!workspace) return;

    const credentials = { accountSid: parsed.data.account_sid, authToken: parsed.data.auth_token };
    const account = await validateAccount(credentials);
    const current = await loadTelephony(req, workspace.id);

    // A different account invalidates the number, trunk and Retell registration.
    const switching = current?.twilio_account_sid && current.twilio_account_sid !== credentials.accountSid;
    const patch = {
      workspace_id: workspace.id,
      twilio_account_sid: credentials.accountSid,
      twilio_auth_token_encrypted: encrypt(credentials.authToken),
      twilio_connected_at: new Date().toISOString(),
      twilio_connected_by: req.user.id,
      last_error: null,
      ...(switching ? {
        phone_number_status: 'missing',
        twilio_phone_number_sid: null,
        twilio_trunk_sid: null,
        twilio_credential_list_sid: null,
        sip_auth_username: null,
        sip_auth_password_encrypted: null,
        termination_uri: null,
        retell_registered_at: null,
      } : {}),
    };

    const { data, error } = await req.supabase
      .from('workspace_telephony')
      .upsert(patch, { onConflict: 'workspace_id' })
      .select('*')
      .single();
    if (error) throw error;

    return res.json({ telephony: publicTelephony(data), account: { friendly_name: account.friendlyName, type: account.type } });
  } catch (error) {
    return sendError(res, error, 'Could not connect the Twilio account');
  }
});

/** Singapore voice numbers owned by the connected Twilio account. */
router.get('/telephony/twilio/numbers', async (req, res) => {
  try {
    const workspace = await ownerWorkspace(req, res);
    if (!workspace) return;
    const credentials = storedTwilio(await loadTelephony(req, workspace.id));
    if (!credentials) return res.status(409).json({ error: 'Connect your Twilio account first.' });
    return res.json({ numbers: await listEligibleNumbers(credentials) });
  } catch (error) {
    return sendError(res, error, 'Could not load your Twilio numbers');
  }
});

const twilioNumberSchema = z.object({ phone_number_sid: z.string().trim().max(64) });

/**
 * Connect one number from the customer's Twilio account: prove ownership
 * through their credentials, configure termination and inbound routing on
 * their account, then register the number with Retell.
 */
router.post('/telephony/twilio/number', async (req, res) => {
  let workspace;
  try {
    const parsed = twilioNumberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose a number from your Twilio account.' });

    workspace = await ownerWorkspace(req, res);
    if (!workspace) return;

    const publicUrl = process.env.API_PUBLIC_URL;
    if (!publicUrl || !process.env.RETELL_API_KEY) {
      return res.status(503).json({ error: 'Voice calling is not configured on this server yet.' });
    }

    const telephony = await loadTelephony(req, workspace.id);
    const credentials = storedTwilio(telephony);
    if (!credentials) return res.status(409).json({ error: 'Connect your Twilio account first.' });

    const number = await fetchOwnedNumber(credentials, parsed.data.phone_number_sid);
    const fromNumber = normalizePhone(number.phone_number);
    if (await numberInUseElsewhere(fromNumber, workspace.id)) {
      return res.status(409).json({ error: 'This number is already connected to another CircleOn workspace.' });
    }

    await req.supabase
      .from('workspace_telephony')
      .update({
        from_number: fromNumber,
        twilio_phone_number_sid: number.sid,
        phone_number_status: 'pending_verification',
        last_error: null,
      })
      .eq('workspace_id', workspace.id);

    const trunk = await ensureTerminationTrunk(credentials, {
      workspaceId: workspace.id,
      existing: {
        trunkSid: telephony.twilio_trunk_sid,
        credentialListSid: telephony.twilio_credential_list_sid,
        sipUsername: telephony.sip_auth_username,
        sipPassword: telephony.sip_auth_password_encrypted ? decrypt(telephony.sip_auth_password_encrypted) : null,
        terminationUri: telephony.termination_uri,
      },
    });

    // Store the trunk before anything else can fail so a retry reuses it.
    await req.supabase
      .from('workspace_telephony')
      .update({
        twilio_trunk_sid: trunk.trunkSid,
        twilio_credential_list_sid: trunk.credentialListSid,
        sip_auth_username: trunk.sipUsername,
        sip_auth_password_encrypted: encrypt(trunk.sipPassword),
        termination_uri: trunk.terminationUri,
      })
      .eq('workspace_id', workspace.id);

    await routeInboundToWebhook(credentials, number.sid, `${publicUrl.replace(/\/$/, '')}/api/billing/inbound/${workspace.id}`);
    await registerWithRetell({
      fromNumber,
      terminationUri: trunk.terminationUri,
      sipUsername: trunk.sipUsername,
      sipPassword: trunk.sipPassword,
      nickname: workspace.name,
    });

    const now = new Date().toISOString();
    const { data, error } = await req.supabase
      .from('workspace_telephony')
      .update({
        retell_phone_number: fromNumber,
        phone_number_status: 'attached',
        number_imported_at: now,
        retell_registered_at: now,
        last_error: null,
      })
      .eq('workspace_id', workspace.id)
      .select('*')
      .single();
    if (error) throw error;

    return res.json({ telephony: publicTelephony(data), registered: true });
  } catch (error) {
    if (workspace) {
      await req.supabase
        .from('workspace_telephony')
        .update({ phone_number_status: 'error', last_error: error.message || 'Could not connect the number' })
        .eq('workspace_id', workspace.id);
    }
    return sendError(res, error, 'Could not connect the number');
  }
});

const telephonySchema = z.object({
  from_number: z.string().trim().min(5).max(20),
  // Manual path for a trunk the customer configured themselves.
  termination_uri: z.string().trim().min(3).max(200),
  sip_username: z.string().trim().max(120).optional(),
  sip_password: z.string().trim().max(200).optional(),
});

/**
 * Attach a number through a SIP trunk the customer configured by hand. It
 * cannot prove ownership, and inbound needs the webhook set manually, so the
 * Twilio account flow above is the default.
 */
router.post('/telephony', async (req, res) => {
  try {
    const parsed = telephonySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid telephony payload', details: parsed.error.flatten() });
    }

    const workspace = await ownerWorkspace(req, res);
    if (!workspace) return;
    const payload = parsed.data;
    const fromNumber = normalizePhone(payload.from_number);

    if (!fromNumber.startsWith('+65')) {
      return res.status(400).json({ error: 'Calling numbers must be Singapore (+65) numbers' });
    }
    if (await numberInUseElsewhere(fromNumber, workspace.id)) {
      return res.status(409).json({ error: 'This number is already connected to another CircleOn workspace.' });
    }

    await req.supabase
      .from('workspace_telephony')
      .upsert({
        workspace_id: workspace.id,
        from_number: fromNumber,
        phone_number_status: 'pending_verification',
        last_error: null,
      }, { onConflict: 'workspace_id' });

    try {
      await registerWithRetell({
        fromNumber,
        terminationUri: payload.termination_uri,
        sipUsername: payload.sip_username,
        sipPassword: payload.sip_password,
        nickname: workspace.name,
      });

      const now = new Date().toISOString();
      const { data, error } = await req.supabase
        .from('workspace_telephony')
        .update({
          retell_phone_number: fromNumber,
          phone_number_status: 'attached',
          number_imported_at: now,
          retell_registered_at: now,
          termination_uri: payload.termination_uri,
          sip_auth_username: payload.sip_username || null,
          sip_auth_password_encrypted: payload.sip_password ? encrypt(payload.sip_password) : null,
          last_error: null,
        })
        .eq('workspace_id', workspace.id)
        .select('*')
        .single();

      if (error) throw error;
      return res.json({ telephony: publicTelephony(data), registered: true });
    } catch (importError) {
      const message = importError.message || 'Retell could not accept this number';
      await req.supabase
        .from('workspace_telephony')
        .update({ phone_number_status: 'error', last_error: message })
        .eq('workspace_id', workspace.id);

      return res.status(400).json({ error: message });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not attach the number' });
  }
});

const pdpcSchema = z.object({
  account_id: z.string().trim().min(1).max(120),
  api_key: z.string().trim().min(1).max(400),
  api_url: z.string().trim().url().optional(),
});

/** Each customer registers their own UEN with PDPC, so credentials are theirs. */
router.post('/telephony/pdpc', async (req, res) => {
  try {
    const parsed = pdpcSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid PDPC payload', details: parsed.error.flatten() });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { error } = await req.supabase
      .from('workspace_telephony')
      .upsert({
        workspace_id: workspace.id,
        pdpc_account_id: parsed.data.account_id,
        pdpc_api_key_encrypted: encrypt(parsed.data.api_key),
        pdpc_api_url: parsed.data.api_url || process.env.PDPC_DNC_API_URL || null,
      }, { onConflict: 'workspace_id' });

    if (error) throw error;
    return res.json({ configured: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not save PDPC credentials' });
  }
});

// ---------------------------------------------------------------------------
// DNC checking
// ---------------------------------------------------------------------------

/**
 * Check the leads in a campaign that actually need checking. Business lines are
 * skipped entirely, which is the whole point of classifying numbers: a customer
 * whose list is mostly company switchboards never has to buy a PDPC credit.
 */
router.post('/campaigns/:campaignId/dnc-check', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadVoiceCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Voice campaign not found' });

    const { data: telephony } = await req.supabase
      .from('workspace_telephony')
      .select('*')
      .eq('workspace_id', workspace.id)
      .maybeSingle();

    const credentials = pdpcCredentials(telephony);
    if (!credentials) {
      return res.status(400).json({
        error: 'Connect your PDPC Do Not Call account before checking personal numbers',
      });
    }

    const { data: rows, error } = await req.supabase
      .from('campaign_leads')
      .select('leads(*)')
      .eq('campaign_id', campaign.id)
      .eq('workspace_id', workspace.id);

    if (error) throw error;

    const leads = (rows || []).map(row => row.leads).filter(Boolean).filter(requiresDncCheck);
    if (!leads.length) {
      return res.json({ checked: 0, blocked: 0, message: 'No personal numbers need checking in this campaign' });
    }

    const results = await checkNumbersWithPdpc(credentials, leads.map(lead => lead.phone_e164 || lead.phone));
    const byNumber = new Map(results.map(result => [result.phone_e164, result.status]));
    const checkedAt = new Date().toISOString();

    let blocked = 0;
    for (const lead of leads) {
      const number = normalizePhone(lead.phone_e164 || lead.phone);
      const status = byNumber.get(number) || 'unknown';
      if (status === 'blocked') blocked += 1;

      await Promise.all([
        req.supabase.from('dnc_checks').insert({
          workspace_id: workspace.id,
          lead_id: lead.id,
          phone_e164: number,
          source: 'pdpc_api',
          status,
          checked_at: checkedAt,
          valid_until: status === 'clear'
            ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            : null,
        }),
        req.supabase.from('leads').update({
          dnc_status: status,
          dnc_checked_at: checkedAt,
          callable_block_reason: status === 'clear' ? null : 'Number is on the Do Not Call register',
        }).eq('id', lead.id),
      ]);
    }

    return res.json({ checked: leads.length, blocked });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Do Not Call check failed' });
  }
});

const phoneTypeSchema = z.object({
  phone_type: z.enum(['business', 'personal', 'unknown']),
});

/** The user can correct a classification we got wrong. Their call, recorded. */
router.patch('/leads/:leadId/phone-type', async (req, res) => {
  try {
    const parsed = phoneTypeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid phone type' });

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('leads')
      .update({
        phone_type: parsed.data.phone_type,
        phone_type_source: 'user_override',
        phone_type_overridden_by: req.user.id,
        phone_type_overridden_at: new Date().toISOString(),
      })
      .eq('id', req.params.leadId)
      .eq('workspace_id', workspace.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ lead: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not update the phone type' });
  }
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

router.get('/calendar', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('calendar_connections')
      .select('workspace_id, provider, account_email, calendar_id, slot_minutes, booking_hours_start, booking_hours_end, booking_days, timezone, status, last_error')
      .eq('workspace_id', workspace.id)
      .maybeSingle();

    if (error) throw error;
    return res.json({ calendar: data || null });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load the calendar connection' });
  }
});

/** Begin the Google consent flow. State carries the workspace back to us. */
router.post('/calendar/connect', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const state = Buffer.from(JSON.stringify({
      workspace_id: workspace.id,
      user_id: req.user.id,
      nonce: crypto.randomUUID(),
    })).toString('base64url');

    return res.json({ url: authorizationUrl(state) });
  } catch (error) {
    if (error.code === 'GOOGLE_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Calendar booking is not configured yet' });
    }
    return res.status(500).json({ error: error.message || 'Could not start the calendar connection' });
  }
});

router.delete('/calendar', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { error } = await req.supabase
      .from('calendar_connections')
      .delete()
      .eq('workspace_id', workspace.id);

    if (error) throw error;
    return res.json({ disconnected: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not disconnect the calendar' });
  }
});

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

const scriptSchema = z.object({
  language: z.enum(['en-US', 'en-GB', 'zh-CN']).optional(),
  opening_line: z.string().trim().max(400).nullable().optional(),
  objective: z.string().trim().max(600).nullable().optional(),
  offer: z.string().trim().max(1200).nullable().optional(),
  qualifying_questions: z.array(z.string().trim().max(300)).max(4).optional(),
  objection_handling: z.string().trim().max(1200).nullable().optional(),
  success_criteria: z.string().trim().max(600).nullable().optional(),
  custom_prompt: z.string().trim().max(12000).nullable().optional(),
  voice_id: z.string().trim().max(120).optional(),
});

router.get('/campaigns/:campaignId/script', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const context = await loadCampaignContext(req, workspace.id, req.params.campaignId);
    if (!context) return res.status(404).json({ error: 'Voice campaign not found' });

    const { script, agent, agentConfig, telephony } = context;

    return res.json({
      script,
      voice_id: script?.voice_id || agent?.voice_id || null,
      agent_status: agent?.status || 'draft',
      requires_attestation: requiresAttestation(script?.language),
      // Exactly what the prospect will hear first, disclosure included, so the
      // user reviews the real thing rather than only their own half of it.
      opening_preview: composeOpeningLine({
        openingLine: script?.opening_line,
        agentName: agentConfig?.agent_name,
        companyName: agentConfig?.company_name || workspace.name,
        language: script?.language,
        recordingEnabled: telephony?.recording_enabled !== false,
      }),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load the script' });
  }
});

router.put('/campaigns/:campaignId/script', async (req, res) => {
  try {
    const parsed = scriptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid script payload', details: parsed.error.flatten() });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const context = await loadCampaignContext(req, workspace.id, req.params.campaignId);
    if (!context) return res.status(404).json({ error: 'Voice campaign not found' });

    const { voice_id: voiceId, ...scriptPatch } = parsed.data;

    // Editing a script drops any previous approval and attestation. A customer
    // must re-read what they are signing off on.
    const patch = {
      ...scriptPatch,
      ...(voiceId ? {voice_id:voiceId}:{}),
      status: 'draft',
      attested_at: null,
      attested_by: null,
    };

    const { data: script, error } = await req.supabase
      .from('voice_scripts')
      .update(patch)
      .eq('campaign_id', context.campaign.id)
      .select('*')
      .single();

    if (error) throw error;

    if (voiceId && !await monthlyWorkspace(req.supabase,workspace.id)) {
      await req.supabase
        .from('voice_agents')
        .upsert({
          workspace_id: workspace.id,
          campaign_id: context.campaign.id,
          voice_id: voiceId,
        }, { onConflict: 'campaign_id' });
    }

    return res.json({ script });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not save the script' });
  }
});

router.post('/campaigns/:campaignId/script/generate', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const context = await loadCampaignContext(req, workspace.id, req.params.campaignId);
    if (!context) return res.status(404).json({ error: 'Voice campaign not found' });

    const language = req.body.language || context.script?.language || 'en-US';

    await req.supabase
      .from('voice_scripts')
      .update({ generation_status: 'pending', generation_error: null })
      .eq('campaign_id', context.campaign.id);

    try {
      const draft = await generateVoiceScript({
        campaign: context.campaign,
        agentConfig: context.agentConfig,
        language,
      });

      const { suggested_opening_line: suggestedOpeningLine, ...fields } = draft;

      const { data: script, error } = await req.supabase
        .from('voice_scripts')
        .update({
          ...fields,
          language,
          generation_status: 'completed',
          generation_error: null,
          status: 'draft',
          attested_at: null,
          attested_by: null,
        })
        .eq('campaign_id', context.campaign.id)
        .select('*')
        .single();

      if (error) throw error;

      // Deliberately returned separately and never written to opening_line. The
      // user decides what the first sentence of their call is.
      return res.json({ script, suggested_opening_line: suggestedOpeningLine });
    } catch (generationError) {
      await req.supabase
        .from('voice_scripts')
        .update({
          generation_status: 'failed',
          generation_error: generationError.message || 'Script generation failed',
        })
        .eq('campaign_id', context.campaign.id);
      throw generationError;
    }
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not draft the script' });
  }
});

const approvalSchema = z.object({
  // Required for any non-English script: the customer confirms they have read
  // it, because nobody here can evaluate a Mandarin sales call.
  attested: z.boolean().optional(),
});

router.post('/campaigns/:campaignId/script/approve', async (req, res) => {
  try {
    const parsed = approvalSchema.safeParse(req.body || {});
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const context = await loadCampaignContext(req, workspace.id, req.params.campaignId);
    if (!context) return res.status(404).json({ error: 'Voice campaign not found' });

    const { campaign, script, agentConfig, telephony, agent } = context;

    if (!script?.opening_line) {
      return res.status(400).json({ error: 'Write the opening line before approving the script' });
    }

    const needsAttestation = requiresAttestation(script.language);
    if (needsAttestation && !parsed.data?.attested) {
      return res.status(400).json({
        error: 'Confirm you have read and approved this non-English script',
        requires_attestation: true,
      });
    }

    const { data: approved, error } = await req.supabase
      .from('voice_scripts')
      .update({
        status: 'approved',
        attested_at: needsAttestation ? new Date().toISOString() : null,
        attested_by: needsAttestation ? req.user.id : null,
      })
      .eq('campaign_id', campaign.id)
      .select('*')
      .single();

    if (error) throw error;

    // Push the approved script to Retell now, so the campaign is ready to dial
    // the moment the number clears.
    try {
      await syncVoiceAgent(req.supabase, {
        campaign,
        script: approved,
        workspace,
        agentConfig,
        telephony,
        voiceId: script?.voice_id || agent?.voice_id,
      });
    } catch (syncError) {
      return res.status(502).json({
        error: syncError.message || 'Script approved, but the voice agent could not be prepared',
        script: approved,
      });
    }

    return res.json({ script: approved });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not approve the script' });
  }
});

// ---------------------------------------------------------------------------
// Campaign coverage, state and results
// ---------------------------------------------------------------------------

router.get('/campaigns/:campaignId/coverage', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadVoiceCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Voice campaign not found' });

    const { data: rows, error } = await req.supabase
      .from('campaign_leads')
      .select('leads(*)')
      .eq('campaign_id', campaign.id)
      .eq('workspace_id', workspace.id);

    if (error) throw error;

    const leads = (rows || []).map(row => row.leads).filter(Boolean);
    const coverage = summariseCallability(leads);

    // Companies where somebody has already asked not to be called. We do not
    // block a colleague, we warn before dialling one.
    const domains = [...new Set(leads.map(lead => lead.company_domain).filter(Boolean))];
    let warnings = [];
    if (domains.length) {
      const { data: suppressions } = await req.supabase
        .from('lead_suppressions')
        .select('company_domain, company_name, created_at, reason')
        .eq('workspace_id', workspace.id)
        .in('company_domain', domains);
      warnings = suppressions || [];
    }

    // Numbers we could not confidently classify. The user decides, because the
    // business exemption is their compliance position to take, not ours.
    const unclassified = leads
      .filter(lead => (lead.phone_e164 || lead.phone) && lead.phone_type === 'unknown')
      .slice(0, 50)
      .map(lead => ({
        id: lead.id,
        full_name: lead.full_name,
        company_name: lead.company_name,
        phone_e164: lead.phone_e164 || lead.phone,
      }));

    return res.json({ coverage, company_warnings: warnings, unclassified });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not summarise this campaign' });
  }
});

router.get('/campaigns/:campaignId/state', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const context = await loadCampaignContext(req, workspace.id, req.params.campaignId);
    if (!context) return res.status(404).json({ error: 'Voice campaign not found' });

    const { campaign, script, agent, telephony } = context;
    const now = new Date();
    const monthly = await monthlyWorkspace(req.supabase, workspace.id);

    const [
      credits,
      { count: activeCalls },
      { data: targets, error: targetError },
      { data: nextRetry },
      { data: spend },
    ] = await Promise.all([
      getCredits(req.supabase, workspace.id),
      req.supabase
        .from('calls')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .in('status', ACTIVE_CALL_STATUSES),
      req.supabase
        .from('voice_call_targets')
        .select('state')
        .eq('campaign_id', campaign.id),
      req.supabase
        .from('voice_call_targets')
        .select('next_attempt_at')
        .eq('campaign_id', campaign.id)
        .eq('state', 'pending')
        .gt('next_attempt_at', now.toISOString())
        .order('next_attempt_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      req.supabase
        .from('calls')
        .select('credit_charged_cents')
        .eq('campaign_id', campaign.id)
        .not('credit_charged_cents', 'is', null),
    ]);

    if (targetError) throw targetError;

    const counts = (targets || []).reduce((acc, row) => {
      acc[row.state] = (acc[row.state] || 0) + 1;
      return acc;
    }, {});

    const duePending = (targets || []).filter(row => row.state === 'pending').length;

    const state = voiceCampaignState({
      campaign,
      script,
      agent,
      telephony,
      callsToday: undefined,
      activeCalls: activeCalls || 0,
      // Monthly plans are governed by allowance and caps in the queue, not prepaid credit.
      creditBalanceCents: monthly ? undefined : credits.balance_cents,
      pendingTargets: duePending,
      nextAttemptAt: nextRetry?.next_attempt_at || null,
    }, now);

    const spentCents = (spend || []).reduce((total, row) => total + (row.credit_charged_cents || 0), 0);

    return res.json({
      state,
      window: callingWindowState({
        timezone: campaign.timezone,
        active_days: campaign.active_days,
        sending_hours_start: campaign.sending_hours_start,
        sending_hours_end: campaign.sending_hours_end,
      }, now),
      targets: {
        pending: counts.pending || 0,
        in_flight: counts.in_flight || 0,
        completed: counts.completed || 0,
        exhausted: counts.exhausted || 0,
        blocked: counts.blocked || 0,
      },
      next_attempt_at: nextRetry?.next_attempt_at || null,
      credits: { balance_cents: credits.balance_cents, spent_on_campaign_cents: spentCents },
      monthly,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load campaign state' });
  }
});

router.get('/campaigns/:campaignId/calls', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const campaign = await loadVoiceCampaign(req, workspace.id, req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Voice campaign not found' });

    const { data, error } = await req.supabase
      .from('calls')
      .select('*, leads(id, full_name, company_name, title, phone_e164, phone_type), call_outcomes(outcome_type, summary, confidence)')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 100, 200));

    if (error) throw error;
    return res.json({ calls: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load calls' });
  }
});

// Explicit inbound configuration is independent of outbound campaign scripts.
router.get('/inbound-context',async(req,res)=>{
 try{const workspace=await getOrCreateWorkspace(req.supabase,req.user);if(workspace.owner_id!==req.user.id)return res.status(403).json({error:'Only the workspace owner manages inbound context.'});const a=await loadWorkspaceAgent(req.supabase,workspace.id);return res.json({context:a?.inbound_prompt?{prompt:a.inbound_prompt,opening_line:a.inbound_opening_line,language:a.inbound_language,approved_at:a.inbound_approved_at,agent_status:a.status}:null});}catch(error){return res.status(400).json({error:error.message});}
});
router.put('/inbound-context', async (req,res)=>{
  try {
    const workspace=await getOrCreateWorkspace(req.supabase,req.user);
    if(workspace.owner_id!==req.user.id)return res.status(403).json({error:'Only the workspace owner approves inbound context.'});
    const {data:billing,error:billingError}=await req.supabase.from('workspace_billing').select('plan,subscription_status,payment_failed').eq('workspace_id',workspace.id).single();if(billingError)throw billingError;
    if(!['voice_starter','voice_growth','voice_pro','allinone_starter','allinone_growth','allinone_pro'].includes(billing.plan)||billing.subscription_status!=='active'||billing.payment_failed)return res.status(400).json({error:'An active paid monthly voice plan is required.'});
    const parsed=z.object({prompt:z.string().trim().min(20).max(20000),opening_line:z.string().trim().min(10).max(1000),approved:z.literal(true),language:z.enum(['en-US','en-GB','zh-CN']).default('en-US')}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Review and explicitly approve the inbound prompt and AI disclosure opening line.'});
    const {data:agentConfig,error:configError}=await req.supabase.from('agent_configs').select('*').eq('workspace_id',workspace.id).maybeSingle();if(configError)throw configError;
    const script={status:'approved',custom_prompt:parsed.data.prompt,opening_line:parsed.data.opening_line,language:parsed.data.language};
    const agent=await syncVoiceAgent(req.supabase,{workspace,campaign:{id:null,workspace_id:workspace.id,name:'Inbound'},script,agentConfig});
    const db=createServiceClient();
    const {error}=await db.from('voice_agents').update({inbound_prompt:parsed.data.prompt,inbound_opening_line:parsed.data.opening_line,inbound_language:parsed.data.language,inbound_approved_at:new Date().toISOString(),inbound_approved_by:req.user.id}).eq('id',agent.id).eq('workspace_id',workspace.id).eq('shared_scope',true);
    if(error)throw error;return res.json({approved:true});
  }catch(error){return res.status(400).json({error:error.message||'Could not approve inbound context.'});}
});
module.exports = router;
