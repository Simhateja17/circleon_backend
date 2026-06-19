const { createServiceClient } = require('./supabase');
const { buildDisclosurePrompt } = require('./callingPrompt');
const { createRetellAgent, createRetellLlm } = require('./retell');

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const AGENT_LAUNCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_name: { type: 'string' },
    company_name: { type: 'string' },
    positioning: { type: 'string' },
    target_titles: {
      type: 'array',
      items: { type: 'string' },
    },
    target_regions: {
      type: 'array',
      items: { type: 'string' },
    },
    tone: { type: 'string' },
    value_proposition: { type: 'string' },
    key_objections: {
      type: 'array',
      items: { type: 'string' },
    },
    discovery_questions: {
      type: 'array',
      items: { type: 'string' },
    },
    call_flow: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          phase: { type: 'string' },
          goal: { type: 'string' },
          example_line: { type: 'string' },
        },
        required: ['phase', 'goal', 'example_line'],
      },
    },
    compliance_notes: {
      type: 'array',
      items: { type: 'string' },
    },
    launch_summary: { type: 'string' },
    retell_system_prompt: { type: 'string' },
  },
  required: [
    'agent_name',
    'company_name',
    'positioning',
    'target_titles',
    'target_regions',
    'tone',
    'value_proposition',
    'key_objections',
    'discovery_questions',
    'call_flow',
    'compliance_notes',
    'launch_summary',
    'retell_system_prompt',
  ],
};

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(item => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

function buildGeminiPrompt({ workspace, agentConfig }) {
  const rawAnswers = agentConfig?.raw_answers || {};
  const targetTitles = toArray(agentConfig?.target_titles).join(', ') || 'CEO, Founder, Director';
  const targetRegions = toArray(agentConfig?.target_regions).join(', ') || 'Singapore';

  return [
    'You are designing a launch-ready outbound calling playbook for a sales agent.',
    'Return only valid JSON matching the provided schema. Do not include markdown, code fences, or commentary.',
    'The response must be directly usable to provision a Retell LLM after a compliance wrapper is added by the backend.',
    '',
    `Workspace: ${workspace?.name || 'My Workspace'}`,
    `Company: ${agentConfig?.company_name || workspace?.name || 'Unknown Company'}`,
    `Agent name: ${agentConfig?.agent_name || 'Aria'}`,
    `Industry: ${agentConfig?.industry || 'Not specified'}`,
    `City: ${agentConfig?.city || 'Singapore'}`,
    `Business model: ${agentConfig?.business_model || 'B2B'}`,
    `Target titles: ${targetTitles}`,
    `Target regions: ${targetRegions}`,
    `Tone: ${agentConfig?.tone || 'Professional & Warm'}`,
    `Value proposition: ${agentConfig?.value_proposition || 'Not provided'}`,
    `Product: ${agentConfig?.product || 'Not provided'}`,
    `Pricing model: ${agentConfig?.pricing_model || 'Not provided'}`,
    `Objections: ${agentConfig?.objections || 'Not provided'}`,
    `Booking link: ${agentConfig?.booking_link || 'Not provided'}`,
    `Monthly capacity: ${agentConfig?.monthly_capacity || 20}`,
    `Raw answers: ${JSON.stringify(rawAnswers)}`,
    '',
    'Requirements:',
    '- Produce a concise positioning statement.',
    '- Produce short discovery questions that sound like a human seller, not a script robot.',
    '- Produce call flow steps for opener, discovery, pitch, objection handling, and close.',
    '- Produce compliance notes that respect AI disclosure and opt-out handling.',
    '- Produce retell_system_prompt as a clean system prompt for Retell.',
    '- Keep the prompt specific to this business and this target audience.',
  ].join('\n');
}

function cleanJsonText(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

async function generateLaunchPlaybook({ workspace, agentConfig }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.code = 'GEMINI_NOT_CONFIGURED';
    throw error;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const endpoint = `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: buildGeminiPrompt({ workspace, agentConfig }) }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: AGENT_LAUNCH_SCHEMA,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error?.status || `Gemini request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const text = cleanJsonText(payload?.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join(''));
  if (!text) {
    throw new Error('Gemini returned an empty playbook');
  }

  let playbook;
  try {
    playbook = JSON.parse(text);
  } catch (error) {
    const parseError = new Error('Gemini returned invalid JSON');
    parseError.cause = error;
    parseError.raw = text;
    throw parseError;
  }

  return { playbook, model };
}

async function getNextVersionNumber(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('agent_config_versions')
    .select('version_number')
    .eq('workspace_id', workspaceId)
    .order('version_number', { ascending: false })
    .limit(1);

  if (error) throw error;
  return (data?.[0]?.version_number || 0) + 1;
}

function validatePlaybook(playbook) {
  if (!playbook || typeof playbook !== 'object') {
    throw new Error('Gemini playbook response was empty');
  }

  for (const key of AGENT_LAUNCH_SCHEMA.required) {
    if (playbook[key] === undefined || playbook[key] === null || playbook[key] === '') {
      throw new Error(`Gemini playbook is missing required field: ${key}`);
    }
  }
}

async function enqueueAgentLaunchJob({ supabase, workspace, agentConfig, userId, source = 'manual' }) {
  const { data: job, error } = await supabase
    .from('ai_jobs')
    .insert({
      workspace_id: workspace.id,
      created_by: userId,
      job_type: 'agent_launch',
      status: 'queued',
      progress: 0,
      current_step: 'queued',
      input: {
        source,
        workspace_name: workspace.name,
        agent_config_id: agentConfig.id,
      },
    })
    .select('*')
    .single();

  if (error) throw error;

  setImmediate(() => {
    processAgentLaunchJob(job.id).catch(error => {
      console.error(JSON.stringify({
        event: 'agent_launch_worker_failed',
        jobId: job.id,
        error: error.message || 'Agent launch worker failed',
      }));
    });
  });

  return job;
}

async function processAgentLaunchJob(jobId) {
  const supabase = createServiceClient();
  if (!supabase) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for AI launch jobs');
  }

  const { data: job, error: jobError } = await supabase
    .from('ai_jobs')
    .select('*, workspaces(*)')
    .eq('id', jobId)
    .maybeSingle();

  if (jobError) throw jobError;
  if (!job) throw new Error('AI launch job not found');
  if (job.status === 'completed') return job;

  const workspace = job.workspaces;
  const agentConfigId = job.input?.agent_config_id;
  if (!agentConfigId) throw new Error('AI launch job is missing its agent config ID');

  const { data: agentConfig, error: agentConfigError } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('id', agentConfigId)
    .eq('workspace_id', job.workspace_id)
    .maybeSingle();

  if (agentConfigError) throw agentConfigError;
  if (!agentConfig) throw new Error('Agent configuration was not found for this launch job');

  const updateJob = async patch => {
    const { error: updateError } = await supabase
      .from('ai_jobs')
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    if (updateError) throw updateError;
  };

  try {
    await updateJob({
      status: 'running',
      progress: 10,
      current_step: 'generating_playbook',
      started_at: job.started_at || new Date().toISOString(),
      error_message: null,
    });

    const { playbook, model } = await generateLaunchPlaybook({ workspace, agentConfig });
    validatePlaybook(playbook);

    await updateJob({
      progress: 45,
      current_step: 'saving_version',
    });

    const nextVersion = await getNextVersionNumber(supabase, workspace.id);
    const finalPrompt = buildDisclosurePrompt(agentConfig, workspace, playbook.retell_system_prompt);

    const { data: versionRow, error: versionError } = await supabase
      .from('agent_config_versions')
      .insert({
        workspace_id: workspace.id,
        agent_config_id: agentConfig.id,
        ai_job_id: job.id,
        version_number: nextVersion,
        playbook,
        retell_system_prompt: finalPrompt,
        gemini_model: model,
        is_active: false,
      })
      .select('*')
      .single();

    if (versionError) throw versionError;

    await updateJob({
      progress: 65,
      current_step: 'provisioning_retell_llm',
    });

    const voiceId = agentConfig.voice_id || process.env.RETELL_DEFAULT_VOICE_ID || '11labs-Adrian';
    const { error: provisioningError } = await supabase
      .from('voice_agents')
      .upsert({
        workspace_id: workspace.id,
        status: 'provisioning',
        voice_id: voiceId,
        prompt_snapshot: finalPrompt,
        last_error: null,
        prompt_version: nextVersion,
      }, { onConflict: 'workspace_id' });
    if (provisioningError) throw provisioningError;

    const llm = await createRetellLlm(finalPrompt);

    const { error: llmUpdateError } = await supabase
      .from('agent_config_versions')
      .update({
        retell_llm_id: llm.id,
      })
      .eq('id', versionRow.id);
    if (llmUpdateError) throw llmUpdateError;

    await updateJob({
      progress: 85,
      current_step: 'provisioning_retell_agent',
    });

    const agent = await createRetellAgent({
      llmId: llm.id,
      agentName: playbook.agent_name || agentConfig.agent_name || 'Barsha AI',
      voiceId,
    });

    const voiceAgentPayload = {
      workspace_id: workspace.id,
      status: 'ready',
      voice_id: voiceId,
      retell_llm_id: llm.id,
      retell_agent_id: agent.id,
      prompt_snapshot: finalPrompt,
      last_synced_at: new Date().toISOString(),
      last_error: null,
      prompt_version: nextVersion,
    };

    const { data: voiceAgent, error: voiceAgentError } = await supabase
      .from('voice_agents')
      .upsert(voiceAgentPayload, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (voiceAgentError) throw voiceAgentError;

    const { error: versionActivateError } = await supabase
      .from('agent_config_versions')
      .update({
        retell_agent_id: agent.id,
        is_active: true,
      })
      .eq('id', versionRow.id);
    if (versionActivateError) throw versionActivateError;

    const { error: versionDeactivateError } = await supabase
      .from('agent_config_versions')
      .update({ is_active: false })
      .eq('workspace_id', workspace.id)
      .neq('id', versionRow.id);
    if (versionDeactivateError) throw versionDeactivateError;

    const { error: configUpdateError } = await supabase
      .from('agent_configs')
      .update({
        status: 'launched',
        system_prompt: finalPrompt,
      })
      .eq('id', agentConfig.id);
    if (configUpdateError) throw configUpdateError;

    await updateJob({
      status: 'completed',
      progress: 100,
      current_step: 'completed',
      completed_at: new Date().toISOString(),
      output: {
        version_number: nextVersion,
        agent_config_version_id: versionRow.id,
        retell_llm_id: llm.id,
        retell_agent_id: agent.id,
        voice_agent_id: voiceAgent.id,
      },
      error_message: null,
    });

    return voiceAgent;
  } catch (error) {
    await updateJob({
      status: 'failed',
      progress: 100,
      current_step: 'failed',
      completed_at: new Date().toISOString(),
      error_message: error.message || 'Agent launch failed',
      output: {
        error: error.message || 'Agent launch failed',
      },
    }).catch(() => undefined);

    try {
      const { error: voiceAgentUpdateError } = await supabase
        .from('voice_agents')
        .update({
          status: 'error',
          last_error: error.message || 'Agent launch failed',
        })
        .eq('workspace_id', workspace.id);

      if (voiceAgentUpdateError) {
        console.error('[agent-launch] failed to persist voice agent error', voiceAgentUpdateError);
      }
    } catch (voiceAgentUpdateError) {
      console.error('[agent-launch] failed to persist voice agent error', voiceAgentUpdateError);
    }

    throw error;
  }
}

async function resumeQueuedAgentLaunchJobs() {
  const supabase = createServiceClient();
  if (!supabase) {
    console.warn(JSON.stringify({
      event: 'agent_launch_recovery_disabled',
      error: 'SUPABASE_SERVICE_ROLE_KEY is required for AI launch jobs',
    }));
    return;
  }

  const { data: jobs, error } = await supabase
    .from('ai_jobs')
    .select('id')
    .eq('job_type', 'agent_launch')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) throw error;

  for (const job of jobs || []) {
    try {
      await processAgentLaunchJob(job.id);
    } catch (jobError) {
      console.error(JSON.stringify({
        event: 'agent_launch_recovery_failed',
        jobId: job.id,
        error: jobError.message || 'Agent launch recovery failed',
      }));
    }
  }
}

module.exports = {
  enqueueAgentLaunchJob,
  generateLaunchPlaybook,
  processAgentLaunchJob,
  resumeQueuedAgentLaunchJobs,
};
