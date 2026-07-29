const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { requireActiveSubscription } = require('../lib/billing');
const { getAutopilotSettings } = require('../lib/autopilot');
const { eligibleCampaigns, mailboxReady, queueDueAutopilotRuns } = require('../lib/autopilotScheduler');

const router = express.Router();

function validTimezone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  include_all_launched_campaigns: z.boolean(),
  campaign_ids: z.array(z.string().uuid()).max(1000),
  timezone: z.string().min(1).max(100).refine(validTimezone, 'Invalid timezone'),
  daily_run_time: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).transform(value => value.slice(0, 5)),
  workspace_daily_send_cap: z.number().int().min(1).max(2000),
});

async function readiness(supabase, workspaceId, settings) {
  const [mailbox, campaigns] = await Promise.all([
    mailboxReady(supabase, workspaceId),
    eligibleCampaigns(supabase, workspaceId, settings),
  ]);
  const { count: launchedCount, error } = await supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('status', 'active');
  if (error) throw error;
  return {
    mailbox_ready: mailbox,
    launched_campaigns: launchedCount || 0,
    included_campaigns: campaigns.length,
    can_enable: mailbox && campaigns.length > 0,
  };
}

router.use(requireAuth);

router.get('/settings', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const settings = await getAutopilotSettings(req.supabase, workspace.id);
    return res.json({ settings, readiness: await readiness(req.supabase, workspace.id, settings) });
  } catch (error) { return res.status(500).json({ error: error.message || 'Failed to load autopilot settings' }); }
});

router.put('/settings', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    if (!await requireActiveSubscription(req, res, workspace)) return;
    const parsed = settingsSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid autopilot settings' });
    const payload = { workspace_id: workspace.id, ...parsed.data, paused_at: parsed.data.enabled ? null : new Date().toISOString() };
    const { data: settings, error } = await req.supabase.from('workspace_autopilot_settings').upsert(payload, { onConflict: 'workspace_id' }).select('*').single();
    if (error) throw error;
    const status = await readiness(req.supabase, workspace.id, settings);
    if (settings.enabled && !status.can_enable) {
      await req.supabase.from('workspace_autopilot_settings').update({ enabled: false, paused_at: new Date().toISOString() }).eq('workspace_id', workspace.id);
      return res.status(400).json({ error: 'Launch an included campaign and verify your mailbox before enabling autopilot', settings: { ...settings, enabled: false }, readiness: status });
    }
    return res.json({ settings, readiness: status });
  } catch (error) { return res.status(500).json({ error: error.message || 'Failed to save autopilot settings' }); }
});

router.get('/runs', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase.from('autopilot_runs').select('*, campaigns(name)').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    return res.json({ runs: data || [] });
  } catch (error) { return res.status(500).json({ error: error.message || 'Failed to load autopilot runs' }); }
});

router.post('/run-now', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const settings = await getAutopilotSettings(req.supabase, workspace.id);
    const status = await readiness(req.supabase, workspace.id, settings);
    if (!settings.enabled || !status.can_enable) return res.status(400).json({ error: 'Enable autopilot with a verified mailbox and launched campaign before running it', readiness: status });
    const runs = await queueDueAutopilotRuns({ supabase: req.supabase, onlyWorkspaceId: workspace.id, force: true });
    return res.status(202).json({ queued: runs.length, runs });
  } catch (error) { return res.status(500).json({ error: error.message || 'Failed to queue autopilot runs' }); }
});

module.exports = router;
