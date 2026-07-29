const { buildDefaultFilters, normalizeFilters } = require('./apollo');

const DEFAULT_AUTOPILOT_SETTINGS = {
  enabled: false,
  include_all_launched_campaigns: false,
  campaign_ids: [],
  timezone: 'Asia/Singapore',
  daily_run_time: '08:00',
  workspace_daily_send_cap: 250,
  paused_at: null,
};

const DEFAULT_SEQUENCE_STEPS = [
  { step_number: 1, name: 'Intro', delay_days: 0, ai_instruction: 'Write a concise first touch. Use one factual, relevant company insight and invite a short conversation.' },
  { step_number: 2, name: 'Bump', delay_days: 3, ai_instruction: 'Write a brief follow-up that adds one useful angle without repeating the first email.' },
  { step_number: 3, name: 'Breakup', delay_days: 7, ai_instruction: 'Write a polite final follow-up with a low-pressure close.' },
];

function clean(value) {
  return String(value || '').trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function campaignGroups(titles = []) {
  const groups = new Map();
  for (const title of unique(Array.isArray(titles) ? titles : [])) {
    const lower = title.toLowerCase();
    const key = /(founder|ceo|chief executive|owner|managing director)/.test(lower)
      ? 'leadership'
      : /(sales|revenue|business development|growth)/.test(lower)
        ? 'sales'
        : /(cto|technology|engineering|it|technical)/.test(lower)
          ? 'technology'
          : `role:${lower}`;
    const label = key === 'leadership' ? 'Leadership' : key === 'sales' ? 'Sales leaders' : key === 'technology' ? 'Technology leaders' : title;
    const current = groups.get(key) || { key, label, titles: [] };
    current.titles.push(title);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function campaignBrief(agentConfig) {
  return {
    agent_config: {
      agent_name: agentConfig.agent_name || null,
      company_name: agentConfig.company_name || null,
      product: agentConfig.product || null,
      value_proposition: agentConfig.value_proposition || null,
      target_titles: agentConfig.target_titles || [],
      target_regions: agentConfig.target_regions || null,
      objections: agentConfig.objections || null,
      tone: agentConfig.tone || null,
      booking_link: agentConfig.booking_link || null,
    },
    campaign_angle: '',
    cta: agentConfig.booking_link || '',
    tone: agentConfig.tone || '',
  };
}

async function getAutopilotSettings(supabase, workspaceId) {
  const { data, error } = await supabase.from('workspace_autopilot_settings').select('*').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_AUTOPILOT_SETTINGS, ...(data || {}), workspace_id: workspaceId };
}

async function ensureSuggestedCampaigns(supabase, workspaceId, agentConfig) {
  const groups = campaignGroups(agentConfig?.target_titles || []);
  if (!groups.length) return [];
  const { data: existing, error: existingError } = await supabase
    .from('campaigns').select('id, name, autopilot_filters').eq('workspace_id', workspaceId);
  if (existingError) throw existingError;
  const existingKeys = new Set((existing || []).map(campaign => campaign.autopilot_filters?.onboarding_group).filter(Boolean));
  const defaultFilters = buildDefaultFilters(agentConfig || {});
  const pending = groups.filter(group => !existingKeys.has(group.key));
  if (!pending.length) return [];
  const rows = pending.map(group => ({
    workspace_id: workspaceId,
    name: `${group.label} outreach`,
    status: 'draft',
    lead_source: 'apollo',
    daily_send_cap: 50,
    cadence_per_hour: 25,
    timezone: 'Asia/Singapore',
    active_days: [1, 2, 3, 4, 5],
    brief: campaignBrief(agentConfig || {}),
    daily_lead_target: 20,
    attention_required: true,
    attention_reason: 'Review targeting, daily limits, and your email sequence before launching.',
    autopilot_filters: {
      ...defaultFilters,
      titles: group.titles,
      onboarding_group: group.key,
      generated_from: 'onboarding',
    },
  }));
  const { data: campaigns, error } = await supabase.from('campaigns').insert(rows).select('*');
  if (error) throw error;
  const sequenceRows = (campaigns || []).flatMap(campaign => DEFAULT_SEQUENCE_STEPS.map(step => ({ ...step, campaign_id: campaign.id, status: 'draft' })));
  if (sequenceRows.length) {
    const { error: sequenceError } = await supabase.from('email_sequences').insert(sequenceRows);
    if (sequenceError) throw sequenceError;
  }
  return campaigns || [];
}

function campaignFilters(campaign, agentConfig) {
  const saved = campaign.autopilot_filters || {};
  return normalizeFilters({ ...saved, limit: campaign.daily_lead_target || 20 }, agentConfig || {});
}

function isCampaignIncluded(settings, campaign) {
  return Boolean(settings.include_all_launched_campaigns || (settings.campaign_ids || []).includes(campaign.id));
}

module.exports = {
  DEFAULT_AUTOPILOT_SETTINGS,
  DEFAULT_SEQUENCE_STEPS,
  campaignGroups,
  campaignFilters,
  ensureSuggestedCampaigns,
  getAutopilotSettings,
  isCampaignIncluded,
};
