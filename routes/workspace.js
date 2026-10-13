const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { suggestTargetTerms } = require('../lib/gemini');
const { getBilling, isActiveSubscription, requireActiveSubscription } = require('../lib/billing');
const { ensureSuggestedCampaigns } = require('../lib/autopilot');
const { applyTourPatch, normalizeTourState } = require('../lib/tourState');

const router = express.Router();

const PLAN_IDS = new Set(['atelier', 'maison', 'sovereign']);

// Every field is optional: the client sends only what changed, and a failed
// write must never be able to blank out the rest of the record.
const tourPatchSchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped']).optional(),
  lastStepId: z.string().min(1).max(80).nullable().optional(),
  lastStepIndex: z.number().int().min(0).max(500).optional(),
  seenStepIds: z.array(z.string().min(1).max(80)).max(200).optional(),
  restart: z.boolean().optional(),
});

function getAnswer(answers, key, fallback = '') {
  const value = answers?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function targetTitles(answers) {
  const selected = Array.isArray(answers?.titles) ? answers.titles : [];
  const custom = String(answers?.titlesCustom || '').split(',').map(value => value.trim()).filter(Boolean);
  return [...new Set([...selected, ...custom])];
}

function answerWithCustom(answers, key, fallback = '') {
  const value = getAnswer(answers, key, fallback);
  return value === 'Other' ? getAnswer(answers, `${key}Custom`, fallback) : value;
}

function generateSystemPrompt(answers) {
  const normalizedTitles = targetTitles(answers);
  const titles = normalizedTitles.length
    ? normalizedTitles.join(', ')
    : 'CEO, Founder, Director';

  return `# CircleOn AI Email Sales Agent

Company: ${getAnswer(answers, 'company', '[Company]')}
Product or service: ${getAnswer(answers, 'product', '-')}
Typical buyers: ${titles}
Target region: ${answerWithCustom(answers, 'region', 'Singapore')}
Target company size: ${answerWithCustom(answers, 'companySize', '-')}
Business model: ${getAnswer(answers, 'bizType', 'B2B')}

Customer problem: ${answerWithCustom(answers, 'customerProblem', '-')}
Desired result: ${answerWithCustom(answers, 'vp', '-')}
Common concern: ${answerWithCustom(answers, 'objections', '-')}
Likely timing signal: ${answerWithCustom(answers, 'timingSignal', '-')}

Write concise, truthful, personalized B2B emails. Use only supplied lead and company facts. Respect opt-outs immediately. Never invent praise, customer results, or urgency. Tone: ${answerWithCustom(answers, 'tone', 'Professional')}. Booking link: ${answerWithCustom(answers, 'calLink', '[Not set]')}.`;
}

const { getOrCreateWorkspace } = require('../lib/workspace');

router.use(requireAuth);

router.get('/me', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: agentConfig, error } = await req.supabase
      .from('agent_configs')
      .select('*')
      .eq('workspace_id', workspace.id)
      .maybeSingle();

    if (error) throw error;

    const billing = await getBilling(req.supabase, workspace.id);
    return res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
      },
      workspace,
      agentConfig,
      billing,
      subscriptionActive: isActiveSubscription(billing),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load workspace' });
  }
});

router.get('/tour', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    return res.json({ tour: normalizeTourState(workspace.tour_state) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load tour progress' });
  }
});

router.patch('/tour', async (req, res) => {
  const parsed = tourPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid tour progress update' });
  }

  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const tour = applyTourPatch(workspace.tour_state, parsed.data);

    const { data, error } = await req.supabase
      .from('workspaces')
      .update({ tour_state: tour })
      .eq('id', workspace.id)
      .select('tour_state')
      .single();

    if (error) throw error;
    return res.json({ tour: normalizeTourState(data.tour_state) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save tour progress' });
  }
});

router.post('/plan', async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLAN_IDS.has(plan)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data, error } = await req.supabase
      .from('workspaces')
      .update({ plan })
      .eq('id', workspace.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ workspace: data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save plan' });
  }
});

router.post('/target-suggestions', async (req, res) => {
  try {
    const suggestions = await suggestTargetTerms({
      product: String(req.body.product || ''),
      buyer: String(req.body.buyer || ''),
      industry: String(req.body.industry || ''),
    });
    return res.json({ suggestions });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to suggest buyer roles' });
  }
});

router.post('/onboarding-draft', async (req, res) => {
  try {
    const answers = req.body.answers || {};
    const step = Math.max(0, Number(req.body.step || 0));
    const companyName = String(getAnswer(answers, 'company', '')).trim();
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);

    const workspacePatch = {
      onboarding_step: step,
    };

    if (companyName) {
      workspacePatch.name = companyName;
    }

    const { data: updatedWorkspace, error: workspaceError } = await req.supabase
      .from('workspaces')
      .update(workspacePatch)
      .eq('id', workspace.id)
      .select('*')
      .single();

    if (workspaceError) throw workspaceError;

    const existingCompany = companyName || workspace.name;
    const { data: agentConfig, error: agentError } = await req.supabase
      .from('agent_configs')
      .upsert({
        workspace_id: workspace.id,
        agent_name: getAnswer(answers, 'agentName', 'Aria'),
        company_name: existingCompany,
        industry: getAnswer(answers, 'industry'),
        city: getAnswer(answers, 'city'),
        business_model: getAnswer(answers, 'bizType'),
        target_titles: targetTitles(answers),
        target_regions: answerWithCustom(answers, 'region'),
        company_size: answerWithCustom(answers, 'companySize'),
        min_mrr_k_sgd: Number(getAnswer(answers, 'mrr', 0)),
        product: getAnswer(answers, 'product'),
        pricing_model: getAnswer(answers, 'pricing'),
        value_proposition: getAnswer(answers, 'vp'),
        objections: getAnswer(answers, 'objections'),
        monthly_capacity: Number(getAnswer(answers, 'capacity', 20)),
        booking_link: getAnswer(answers, 'calLink'),
        tone: getAnswer(answers, 'tone'),
        raw_answers: answers,
        system_prompt: generateSystemPrompt(answers),
        status: 'draft',
      }, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (agentError) throw agentError;

    return res.json({
      workspace: updatedWorkspace,
      agentConfig,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save onboarding draft' });
  }
});

router.post('/onboarding', async (req, res) => {
  try {
    const answers = req.body.answers || {};
    const companyName = String(getAnswer(answers, 'company', 'My Workspace')).trim();
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    if (!await requireActiveSubscription(req, res, workspace)) return;
    const systemPrompt = generateSystemPrompt(answers);

    const { data: updatedWorkspace, error: workspaceError } = await req.supabase
      .from('workspaces')
      .update({
        name: companyName || workspace.name,
        onboarding_step: 5,
        onboarding_completed: true,
      })
      .eq('id', workspace.id)
      .select('*')
      .single();

    if (workspaceError) throw workspaceError;

    const payload = {
      workspace_id: workspace.id,
      agent_name: getAnswer(answers, 'agentName', 'Aria'),
      company_name: companyName || workspace.name,
      industry: getAnswer(answers, 'industry'),
      city: getAnswer(answers, 'city'),
      business_model: getAnswer(answers, 'bizType', 'B2B'),
      target_titles: targetTitles(answers),
      target_regions: answerWithCustom(answers, 'region'),
      company_size: answerWithCustom(answers, 'companySize'),
      min_mrr_k_sgd: Number(getAnswer(answers, 'mrr', 0)),
      product: getAnswer(answers, 'product'),
      pricing_model: getAnswer(answers, 'pricing'),
      value_proposition: getAnswer(answers, 'vp'),
      objections: getAnswer(answers, 'objections'),
      monthly_capacity: Number(getAnswer(answers, 'capacity', 20)),
      booking_link: getAnswer(answers, 'calLink'),
      tone: getAnswer(answers, 'tone', 'Professional'),
      raw_answers: answers,
      system_prompt: systemPrompt,
      status: 'draft',
    };

    const { data: agentConfig, error: agentError } = await req.supabase
      .from('agent_configs')
      .upsert(payload, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (agentError) throw agentError;

    // Create reviewable campaign drafts only after onboarding completes. This
    // is idempotent and never launches a campaign or sends an email.
    await ensureSuggestedCampaigns(req.supabase, workspace.id, agentConfig).catch(error => {
      console.error('[autopilot] failed to create onboarding campaign suggestions', error.message);
    });

    return res.json({
      workspace: updatedWorkspace,
      agentConfig,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save onboarding' });
  }
});

module.exports = router;
