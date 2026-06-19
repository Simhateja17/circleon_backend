const express = require('express');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { enqueueAgentLaunchJob } = require('../lib/agentLaunch');

const router = express.Router();

router.use(requireAuth);

router.post('/agent-launch', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);

    if (!workspace.onboarding_completed) {
      return res.status(400).json({ error: 'Complete onboarding before launching the agent' });
    }

    const { data: agentConfig, error: agentConfigError } = await req.supabase
      .from('agent_configs')
      .select('*')
      .eq('workspace_id', workspace.id)
      .maybeSingle();

    if (agentConfigError) throw agentConfigError;
    if (!agentConfig?.system_prompt) {
      return res.status(400).json({ error: 'Complete onboarding before launching the agent' });
    }

    const job = await enqueueAgentLaunchJob({
      supabase: req.supabase,
      workspace,
      agentConfig,
      userId: req.user.id,
      source: req.body.source || 'summary',
    });

    return res.status(202).json({ job });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to start AI launch job' });
  }
});

router.get('/jobs/:jobId', async (req, res) => {
  try {
    const workspace = await getOrCreateWorkspace(req.supabase, req.user);
    const { data: job, error } = await req.supabase
      .from('ai_jobs')
      .select('*')
      .eq('id', req.params.jobId)
      .eq('workspace_id', workspace.id)
      .maybeSingle();

    if (error) throw error;
    if (!job) {
      return res.status(404).json({ error: 'AI launch job not found' });
    }

    return res.json({ job });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load AI launch job' });
  }
});

module.exports = router;
