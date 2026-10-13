// Provision the Retell agent that a voice campaign runs on.
//
// One agent per campaign. Re-running this for a campaign that already has an
// agent updates it in place rather than leaking a new Retell agent every time
// the user edits their script.

const {
  createAgent,
  createLlm,
  updateAgent,
  updateLlm,
} = require('./retellVoice');
const { composeOpeningLine, composeVoicePrompt } = require('./voiceScript');

async function syncLegacyVoiceAgent(supabase, { campaign, script, workspace, agentConfig, telephony, voiceId }) {
  const recordingEnabled = telephony?.recording_enabled !== false;

  const prompt = composeVoicePrompt({ script, campaign, workspace, agentConfig, recordingEnabled });
  const beginMessage = composeOpeningLine({
    openingLine: script?.opening_line,
    agentName: agentConfig?.agent_name,
    companyName: agentConfig?.company_name || workspace?.name,
    language: script?.language,
    recordingEnabled,
  });

  const { data: existing, error: existingError } = await supabase
    .from('voice_agents')
    .select('*')
    .eq('campaign_id', campaign.id)
    .maybeSingle();

  if (existingError) throw existingError;

  const resolvedVoiceId = voiceId
    || existing?.voice_id
    || process.env.RETELL_DEFAULT_VOICE_ID
    || '11labs-Adrian';

  const provisioning = {
    workspace_id: campaign.workspace_id, campaign_id: campaign.id,
    status: 'provisioning', voice_id: resolvedVoiceId,
    language: script?.language || 'en-US', last_error: null,
  };
  // A partial unique campaign index cannot serve an ON CONFLICT column target.
  await checked(existing
    ? supabase.from('voice_agents').update(provisioning).eq('id',existing.id)
    : supabase.from('voice_agents').insert(provisioning));


  try {
    let llmId = existing?.retell_llm_id;
    let agentId = existing?.retell_agent_id;

    if (llmId && agentId) {
      await updateLlm(llmId, { prompt, beginMessage });
      await updateAgent(agentId, {
        voiceId: resolvedVoiceId,
        language: script?.language,
        agentName: `${campaign.name} (${workspace?.name || 'CircleOn'})`,
      });
    } else {
      const llm = await createLlm({ prompt, beginMessage });
      llmId = llm.id;

      const agent = await createAgent({
        llmId,
        agentName: `${campaign.name} (${workspace?.name || 'CircleOn'})`,
        voiceId: resolvedVoiceId,
        language: script?.language,
      });
      agentId = agent.id;
    }

    const { data: saved, error: saveError } = await supabase
      .from('voice_agents')
      .update({
        retell_llm_id: llmId,
        retell_agent_id: agentId,
        status: 'ready',
        prompt_snapshot: prompt,
        prompt_version: (existing?.prompt_version || 0) + 1,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('campaign_id', campaign.id)
      .select('*')
      .single();

    if (saveError) throw saveError;

    await supabase
      .from('voice_scripts')
      .update({ composed_prompt: prompt })
      .eq('campaign_id', campaign.id);

    return saved;
  } catch (error) {
    const message = error.message || 'Could not prepare the voice agent';
    await supabase
      .from('voice_agents')
      .update({ status: 'error', last_error: message })
      .eq('campaign_id', campaign.id);
    throw error;
  }
}

const { byId } = require('./pricing');
const { createServiceClient } = require('./supabase');
// Retell supports interpolation for per-call context, not general_prompt overrides.
// These templates never change when a campaign is approved or edited.
const SHARED_PROMPT = '{{circleon_call_prompt}}';
const SHARED_OPENING = '{{circleon_opening_line}}';
async function monthlyWorkspace(db, workspaceId) {
  const {data,error}=await db.from('workspace_billing').select('plan').eq('workspace_id',workspaceId).maybeSingle();
  if(error) throw error;
  return Boolean(byId[data?.plan]);
}
async function loadWorkspaceAgent(db,workspaceId) {
  const {data,error}=await db.from('voice_agents').select('*').eq('workspace_id',workspaceId).eq('shared_scope',true).maybeSingle();
  if(error) throw error;
  return data;
}
function callContext({campaign,script,workspace,agentConfig,telephony}) {
  if(script?.status!=='approved') throw new Error('An approved voice script is required.');
  return {
    circleon_call_prompt: composeVoicePrompt({campaign,script,workspace,agentConfig,recordingEnabled:telephony?.recording_enabled!==false}),
    circleon_opening_line: composeOpeningLine({openingLine:script.opening_line,agentName:agentConfig?.agent_name,companyName:agentConfig?.company_name||workspace?.name,language:script.language,recordingEnabled:telephony?.recording_enabled!==false}),
  };
}
async function syncVoiceAgent(supabase, options) {
  if(!await monthlyWorkspace(supabase,options.campaign.workspace_id)) return syncLegacyVoiceAgent(supabase,options);
  const db=options.serviceDb || createServiceClient();
  if(!db) throw new Error('Voice provisioning requires the service database client.');
  const workspaceId=options.campaign.workspace_id;
  const context=callContext(options);
  const {data:claim,error}=await db.rpc('claim_workspace_voice_agent',{p_workspace_id:workspaceId});
  if(error) throw error;
  const row=claim?.agent;
  if(!claim?.claimed) {
    if(row?.status==='ready'&&row.retell_agent_id){if(options.campaign.id)await checked(db.from('voice_scripts').update({composed_prompt:context.circleon_call_prompt}).eq('campaign_id',options.campaign.id));return row;}
    throw new Error('Workspace voice agent provisioning is already in progress or needs operator recovery.');
  }
  // Never automatically retry a failed external create: provider may have created
  // the resource even when its HTTP response was lost. Operator reconciles it.
  const provider=options.provider || {createLlm,createAgent};
  try {
    const llm=await provider.createLlm({prompt:SHARED_PROMPT,beginMessage:SHARED_OPENING});
    if(!llm.id) throw new Error('Retell did not return an LLM identifier.');
    await checked(db.from('voice_agents').update({retell_llm_id:llm.id}).eq('id',row.id));
    const agent=await provider.createAgent({llmId:llm.id,agentName:`${options.workspace?.name||'CircleOn'} workspace`,voiceId:options.voiceId||process.env.RETELL_DEFAULT_VOICE_ID||'11labs-Adrian',language:'en-US'});
    if(!agent.id) throw new Error('Retell did not return an agent identifier.');
    const saved=await checked(db.from('voice_agents').update({retell_agent_id:agent.id,status:'ready',prompt_snapshot:SHARED_PROMPT,last_synced_at:new Date().toISOString(),last_error:null}).eq('id',row.id).select('*').single());
    if (options.campaign.id) await checked(db.from('voice_scripts').update({composed_prompt:context.circleon_call_prompt}).eq('campaign_id',options.campaign.id));
    return saved;
  } catch(error) {
    await db.from('voice_agents').update({status:'error',last_error:error.message}).eq('id',row.id);
    throw error;
  }
}
async function checked(query){const {data,error}=await query;if(error)throw error;return data;}
module.exports = { syncVoiceAgent, monthlyWorkspace, loadWorkspaceAgent, callContext, SHARED_PROMPT, SHARED_OPENING };
