const express = require('express');
const requireAuth = require('../middleware/auth');

const router = express.Router();

const PLAN_IDS = new Set(['atelier', 'maison', 'sovereign']);

function getAnswer(answers, key, fallback = '') {
  const value = answers?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function generateSystemPrompt(answers) {
  const titles = Array.isArray(answers.titles) && answers.titles.length
    ? answers.titles.join(', ')
    : 'CEO, Founder, Director';

  return `# CircleOn- SYSTEM PROMPT
# Market: Singapore

## IDENTITY
You are ${getAnswer(answers, 'agentName', 'Aria')}, calling on behalf of ${getAnswer(answers, 'company', '[Company]')} based in ${getAnswer(answers, 'city', 'Singapore')}.
Industry: ${getAnswer(answers, 'industry', '[Industry]')}

## PDPA COMPLIANCE - READ FIRST
- You are operating under Singapore's Personal Data Protection Act (PDPA).
- Disclose you are an AI agent if the prospect directly asks.
- Do not call numbers on the DND Registry.
- Calling hours: Monday-Friday, 9am-6pm SGT only.
- On opt-out: log as DNC and end call immediately.
- Inform prospect this call may be recorded for quality purposes.

## COMPANY CONTEXT
${getAnswer(answers, 'desc', '[Not provided]')}

## YOUR OFFER
Product/Service: ${getAnswer(answers, 'product', '-')}
Pricing: ${getAnswer(answers, 'pricing', '-')}
Value Prop: ${getAnswer(answers, 'vp', '-')}
Booking Link: ${getAnswer(answers, 'calLink', '[Not set]')}

## TARGET PROSPECT
Business Model: ${getAnswer(answers, 'bizType', 'B2B')}
Decision Maker Titles: ${titles}
Company Size: ${getAnswer(answers, 'companySize', '-')}
Target Region: ${getAnswer(answers, 'region', 'Singapore')}
Min MRR: ${answers.mrr ? `S$${answers.mrr}k` : 'No filter'}

## CALL FLOW
[0:00] Open: "Hi, this is ${getAnswer(answers, 'agentName', 'Aria')} from ${getAnswer(answers, 'company', '[Company]')} - is now a good 2 minutes?"
[0:20] Hook: one-sentence value statement for their industry.
[0:45] Discovery: 1-2 open questions. Listen actively.
[2:00] Pitch: share the core offer if they are engaged.
[3:00] Objection Handling.
[4:00] Close: offer the Calendly link for a 20-minute discovery call.

## OBJECTION HANDLING
${getAnswer(answers, 'objections', '1. Too busy: offer a specific callback time\n2. Have a solution: ask what they would improve about it\n3. No budget: ask what would need to change for them to consider it')}

## TONE & CONSTRAINTS
Style: ${getAnswer(answers, 'tone', 'Professional & Warm')}
Max Clients: ${getAnswer(answers, 'capacity', '20')}/month - prioritise highest-intent prospects.
Never quote exact prices, make guarantees, or sign agreements.`;
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
        target_titles: Array.isArray(answers.titles) ? answers.titles : [],
        target_regions: getAnswer(answers, 'region'),
        company_size: getAnswer(answers, 'companySize'),
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
        onboarding_step: 17,
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
      target_titles: Array.isArray(answers.titles) ? answers.titles : [],
      target_regions: getAnswer(answers, 'region'),
      company_size: getAnswer(answers, 'companySize'),
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
