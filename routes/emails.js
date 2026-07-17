const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { encrypt } = require('../lib/crypto');
const { createServiceClient } = require('../lib/supabase');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { publicAccount, testConnection } = require('../lib/smtp');
const { testConnection: testImapConnection } = require('../lib/imap');

const router = express.Router();

const emailAccountSchema = z.object({
  smtp_host: z.string().trim().min(1).max(255),
  smtp_port: z.coerce.number().int().min(1).max(65535),
  smtp_username: z.string().trim().min(1).max(255),
  smtp_password: z.string().min(1).max(2048),
  from_name: z.string().trim().min(1).max(255),
  from_email: z.string().trim().email().max(255),
  reply_to_email: z.string().trim().email().max(255).optional().or(z.literal('')),
  imap_host: z.string().trim().min(1).max(255),
  imap_port: z.coerce.number().int().min(1).max(65535),
  imap_username: z.string().trim().min(1).max(255),
  imap_password: z.string().min(1).max(2048),
});

async function getSmtpAccount(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider', 'smtp')
    .maybeSingle();

  if (error) throw error;
  return data;
}

router.get('/open/:messageId', async (req, res) => {
  try {
    const service = createServiceClient();
    if (service && req.params.messageId) {
      const { data: message } = await service
        .from('messages')
        .select('id, opened_at, open_count')
        .eq('id', req.params.messageId)
        .maybeSingle();

      if (message) {
        await service
          .from('messages')
          .update({
            opened_at: message.opened_at || new Date().toISOString(),
            open_count: Number(message.open_count || 0) + 1,
          })
          .eq('id', message.id);
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'email_open_tracking_failed',
      messageId: req.params.messageId,
      error: error.message,
    }));
  }

  const pixel = Buffer.from(
    'R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==',
    'base64'
  );
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  return res.end(pixel);
});

router.get('/unsubscribe/:leadId', async (req, res) => {
  try {
    const service = createServiceClient();
    if (!service) {
      return res.status(500).send('Unsubscribe service is not configured.');
    }

    const { data: lead, error: leadError } = await service
      .from('leads')
      .select('*')
      .eq('id', req.params.leadId)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) {
      return res.status(404).send('Lead not found.');
    }

    const now = new Date().toISOString();
    const { error: updateError } = await service
      .from('leads')
      .update({
        status: 'do_not_call',
        dnc_status: 'blocked',
        dnc_checked_at: now,
        callable_block_reason: 'Unsubscribed from email outreach',
      })
      .eq('id', lead.id);

    if (updateError) throw updateError;

    await service.from('dnc_checks').insert({
      workspace_id: lead.workspace_id,
      lead_id: lead.id,
      phone_e164: lead.phone_e164 || lead.phone || `email:${lead.email || lead.id}`,
      channel: 'email',
      source: 'manual',
      status: 'blocked',
      checked_at: now,
      raw_result: {
        reason: 'unsubscribe_link',
        email: lead.email || null,
      },
    }).throwOnError();

    return res
      .status(200)
      .type('html')
      .send('<!doctype html><html><body><h1>Unsubscribed</h1><p>You will not receive further outreach emails.</p></body></html>');
  } catch (error) {
    console.error(JSON.stringify({
      event: 'email_unsubscribe_failed',
      leadId: req.params.leadId,
      error: error.message,
    }));
    return res.status(500).send('Unsubscribe failed.');
  }
});

router.use(requireAuth);

router.get('/smtp/status', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const account = await getSmtpAccount(req.supabase, workspace.id);

    return res.json({
      connected: Boolean(account && account.status === 'connected'),
      account: publicAccount(account),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load SMTP status' });
  }
});

router.post('/smtp/connect', async (req, res) => {
  try {
    const parsed = emailAccountSchema.safeParse(req.body.account || req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid SMTP/IMAP account payload',
        details: parsed.error.flatten(),
      });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const account = parsed.data;
    const payload = {
      workspace_id: workspace.id,
      provider: 'smtp',
      smtp_host: account.smtp_host,
      smtp_port: account.smtp_port,
      smtp_username: account.smtp_username,
      smtp_password_encrypted: encrypt(account.smtp_password),
      from_name: account.from_name,
      from_email: account.from_email,
      reply_to_email: account.reply_to_email || account.from_email,
      imap_host: account.imap_host,
      imap_port: account.imap_port,
      imap_username: account.imap_username,
      imap_password_encrypted: encrypt(account.imap_password),
      status: 'disconnected',
      smtp_verified_at: null,
      imap_verified_at: null,
      last_error: null,
    };

    const { data, error } = await req.supabase
      .from('connected_accounts')
      .upsert(payload, { onConflict: 'workspace_id,provider' })
      .select('*')
      .single();

    if (error) throw error;

    try {
      await Promise.all([testConnection(data), testImapConnection(data)]);
      const verifiedAt = new Date().toISOString();
      const { data: verified, error: verifyUpdateError } = await req.supabase
        .from('connected_accounts')
        .update({
          status: 'connected',
          smtp_verified_at: verifiedAt,
          imap_verified_at: verifiedAt,
          last_tested_at: verifiedAt,
          last_error: null,
        })
        .eq('id', data.id)
        .select('*')
        .single();

      if (verifyUpdateError) throw verifyUpdateError;
      return res.status(201).json({ connected: true, account: publicAccount(verified) });
    } catch (connectionError) {
      const { data: failed } = await req.supabase
        .from('connected_accounts')
        .update({
          status: 'error',
          last_tested_at: new Date().toISOString(),
          last_error: connectionError.message || 'Mailbox verification failed',
        })
        .eq('id', data.id)
        .select('*')
        .single();

      return res.status(400).json({
        connected: false,
        error: connectionError.message || 'Mailbox verification failed',
        account: publicAccount(failed || data),
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to connect SMTP account' });
  }
});

router.post('/smtp/test', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const account = await getSmtpAccount(req.supabase, workspace.id);

    if (!account) {
      return res.status(404).json({ error: 'SMTP account is not connected' });
    }

    try {
      const [smtpResult, imapResult] = await Promise.allSettled([
        testConnection(account),
        testImapConnection(account),
      ]);
      const errors = [];
      if (smtpResult.status === 'rejected') errors.push(`SMTP: ${smtpResult.reason.message}`);
      if (imapResult.status === 'rejected') errors.push(`IMAP: ${imapResult.reason.message}`);
      if (errors.length) throw new Error(errors.join('; '));
      const verifiedAt = new Date().toISOString();
      const { data, error } = await req.supabase
        .from('connected_accounts')
        .update({
          status: 'connected',
          smtp_verified_at: verifiedAt,
          imap_verified_at: verifiedAt,
          last_tested_at: verifiedAt,
          last_error: null,
        })
        .eq('id', account.id)
        .select('*')
        .single();

      if (error) throw error;

      return res.json({
        ok: true,
        protocols: { smtp: true, imap: true },
        account: publicAccount(data),
      });
    } catch (smtpError) {
      const { data, error } = await req.supabase
        .from('connected_accounts')
        .update({
          status: 'error',
          last_tested_at: new Date().toISOString(),
          last_error: smtpError.message || 'SMTP connection test failed',
        })
        .eq('id', account.id)
        .select('*')
        .single();

      if (error) throw error;

      return res.status(400).json({
        ok: false,
        error: smtpError.message || 'SMTP connection test failed',
        account: publicAccount(data),
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to test SMTP account' });
  }
});

module.exports = router;
