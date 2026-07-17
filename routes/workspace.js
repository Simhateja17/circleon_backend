const express = require('express');
const requireAuth = require('../middleware/auth');
const { suggestTargetTerms } = require('../lib/gemini');

const router = express.Router();

const PLAN_IDS = new Set(['atelier', 'maison', 'sovereign']);

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

  return `# Barsha Email Sales Agent

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

async function getOrCreateWorkspace(supabase, user) {
  const { data: existing, error: selectError } = await supabase
    .from('workspaces')
    .select('*')
    .eq('owner_id', user.id)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing) return existing;

  const fallbackName = user.user_metadata?.business_name
    || user.email?.split('@')[0]
    || 'My Workspace';

  const { data, error } = await supabase
    .from('workspaces')
    .insert({
      owner_id: user.id,
      name: fallbackName,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

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

    return res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
      },
      workspace,
      agentConfig,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load workspace' });
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

    return res.json({
      workspace: updatedWorkspace,
      agentConfig,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save onboarding' });
  }
});

module.exports = router;
