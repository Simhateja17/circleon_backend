const { createServiceClient } = require('./supabase');
const { createQueueJobId, getAutopilotQueue } = require('./redis');
const { getAutopilotSettings, isCampaignIncluded } = require('./autopilot');

function localDateAndTime(timezone, now = new Date()) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

async function mailboxReady(supabase, workspaceId) {
  const { data, error } = await supabase.from('connected_accounts').select('id')
    .eq('workspace_id', workspaceId).eq('provider', 'smtp').eq('status', 'connected')
    .not('smtp_verified_at', 'is', null).not('imap_verified_at', 'is', null).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function eligibleCampaigns(supabase, workspaceId, settings) {
  const { data, error } = await supabase.from('campaigns').select('*')
    .eq('workspace_id', workspaceId).eq('status', 'active');
  if (error) throw error;
  return (data || []).filter(campaign => isCampaignIncluded(settings, campaign));
}

async function queueAutopilotRun({ supabase, workspaceId, campaign, localRunDate, source = 'scheduled' }) {
  const { data: run, error } = await supabase.from('autopilot_runs').upsert({
    workspace_id: workspaceId,
    campaign_id: campaign.id,
    local_run_date: localRunDate,
    status: 'queued',
    requested_leads: Number(campaign.daily_lead_target || 20),
    details: { source },
  }, { onConflict: 'workspace_id,campaign_id,local_run_date', ignoreDuplicates: true }).select('*').maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const queue = getAutopilotQueue();
  await queue.add('autopilot-campaign', { workspaceId, campaignId: campaign.id, autopilotRunId: run.id }, {
    jobId: createQueueJobId('autopilot', run.id),
  });
  return run;
}

async function queueDueAutopilotRuns({ supabase, now = new Date(), onlyWorkspaceId = null, force = false }) {
  let query = supabase.from('workspace_autopilot_settings').select('*').eq('enabled', true).is('paused_at', null);
  if (onlyWorkspaceId) query = query.eq('workspace_id', onlyWorkspaceId);
  const { data: settingsRows, error } = await query;
  if (error) throw error;
  const queued = [];
  for (const row of settingsRows || []) {
    const settings = await getAutopilotSettings(supabase, row.workspace_id);
    const local = localDateAndTime(settings.timezone || 'Asia/Singapore', now);
    if (!force && local.time !== String(settings.daily_run_time).slice(0, 5)) continue;
    if (!await mailboxReady(supabase, row.workspace_id)) continue;
    const campaigns = await eligibleCampaigns(supabase, row.workspace_id, settings);
    for (const campaign of campaigns) {
      const run = await queueAutopilotRun({ supabase, workspaceId: row.workspace_id, campaign, localRunDate: local.date, source: force ? 'manual' : 'scheduled' });
      if (run) queued.push(run);
    }
  }
  return queued;
}

function startAutopilotScheduler() {
  if (process.env.AUTOPILOT_SCHEDULER_ENABLED === 'false') return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const service = createServiceClient();
      if (!service) return;
      const queued = await queueDueAutopilotRuns({ supabase: service });
      if (queued.length) console.info(JSON.stringify({ event: 'autopilot_runs_queued', count: queued.length }));
    } catch (error) {
      console.error('[autopilot-scheduler] failed', error.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, 60 * 1000);
}

module.exports = { eligibleCampaigns, localDateAndTime, mailboxReady, queueAutopilotRun, queueDueAutopilotRuns, startAutopilotScheduler };
