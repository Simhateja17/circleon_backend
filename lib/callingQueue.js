const { createServiceClient } = require('./supabase');
const {
  createRetellPhoneCall,
  isInsideBusinessWindow,
  isLeadCallable,
  normalizePhone,
} = require('./calling');

const ACTIVE_CALL_STATUSES = ['queued', 'calling', 'ringing', 'in_progress'];
let running = false;

async function countTodayCalls(supabase, workspaceId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', start.toISOString());

  if (error) throw error;
  return count || 0;
}

async function hasActiveCall(supabase, workspaceId) {
  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ACTIVE_CALL_STATUSES);

  if (error) throw error;
  return Boolean(count);
}

async function processFollowUp(supabase, followUp) {
  const workspaceId = followUp.workspace_id;
  const telephony = followUp.workspaces?.workspace_telephony?.[0];
  const voiceAgent = followUp.workspaces?.voice_agents?.[0];
  const lead = followUp.leads;

  if (!telephony?.calling_enabled) return;
  if (!isInsideBusinessWindow(telephony)) return;
  if (await hasActiveCall(supabase, workspaceId)) return;
  if ((await countTodayCalls(supabase, workspaceId)) >= (telephony.daily_call_cap || 25)) return;

  if (!voiceAgent?.retell_agent_id || voiceAgent.status !== 'ready') {
    await supabase.from('follow_ups').update({ blocked_reason: 'Retell agent is not ready' }).eq('id', followUp.id);
    return;
  }

  const eligibility = isLeadCallable(lead);
  if (!eligibility.callable) {
    await Promise.all([
      supabase.from('follow_ups').update({ blocked_reason: eligibility.reason }).eq('id', followUp.id),
      supabase.from('leads').update({ callable_block_reason: eligibility.reason }).eq('id', lead.id),
    ]);
    return;
  }

  const toNumber = normalizePhone(lead.phone_e164 || lead.phone);
  const fromNumber = telephony.retell_phone_number || telephony.from_number;

  const { data: lockedFollowUp, error: lockError } = await supabase
    .from('follow_ups')
    .update({
      status: 'calling',
      blocked_reason: null,
    })
    .eq('id', followUp.id)
    .eq('status', 'scheduled')
    .select('*')
    .single();

  if (lockError || !lockedFollowUp) return;

  const { data: call, error: callError } = await supabase
    .from('calls')
    .insert({
      workspace_id: workspaceId,
      lead_id: lead.id,
      follow_up_id: followUp.id,
      voice_agent_id: voiceAgent.id,
      from_number: fromNumber,
      to_number: toNumber,
      status: 'queued',
    })
    .select('*')
    .single();

  if (callError) throw callError;

  try {
    const retellCall = await createRetellPhoneCall({
      fromNumber,
      toNumber,
      agentId: voiceAgent.retell_agent_id,
      metadata: {
        workspace_id: workspaceId,
        lead_id: lead.id,
        follow_up_id: followUp.id,
        call_id: call.id,
      },
      variables: {
        agent_name: followUp.workspaces?.agent_configs?.[0]?.agent_name || 'Barsha',
        company_name: followUp.workspaces?.agent_configs?.[0]?.company_name || followUp.workspaces?.name || 'our company',
        lead_name: lead.full_name,
        lead_company: lead.company_name || '',
        lead_title: lead.title || '',
        follow_up_title: followUp.title,
        follow_up_context: followUp.context_note || '',
      },
    });

    await supabase
      .from('calls')
      .update({
        retell_call_id: retellCall.call_id || retellCall.id || retellCall.retell_call_id || null,
        status: 'calling',
        raw_payload: retellCall,
      })
      .eq('id', call.id);
  } catch (error) {
    await Promise.all([
      supabase
        .from('calls')
        .update({
          status: 'failed',
          error_message: error.message || 'Retell call failed',
        })
        .eq('id', call.id),
      supabase
        .from('follow_ups')
        .update({
          status: 'scheduled',
          blocked_reason: error.message || 'Retell call failed',
        })
        .eq('id', followUp.id),
      supabase
        .from('workspace_telephony')
        .update({ last_error: error.message || 'Retell call failed' })
        .eq('workspace_id', workspaceId),
    ]);
  }
}

async function runCallingQueueOnce() {
  if (running) return;
  running = true;

  const supabase = createServiceClient();
  if (!supabase) {
    running = false;
    return;
  }

  try {
    const { data: dueFollowUps, error } = await supabase
      .from('follow_ups')
      .select(`
        *,
        leads(*),
        workspaces(
          id,
          name,
          workspace_telephony(*),
          voice_agents(*),
          agent_configs(agent_name, company_name)
        )
      `)
      .eq('status', 'scheduled')
      .eq('owner_type', 'agent')
      .not('approved_at', 'is', null)
      .lte('due_at', new Date().toISOString())
      .order('priority', { ascending: true })
      .order('due_at', { ascending: true })
      .limit(10);

    if (error) throw error;

    for (const followUp of dueFollowUps || []) {
      await processFollowUp(supabase, followUp);
    }
  } catch (error) {
    console.error('[calling-queue] failed', error);
  } finally {
    running = false;
  }
}

function startCallingQueue() {
  if (process.env.CALLING_QUEUE_ENABLED !== 'true') {
    console.log('Calling queue disabled. Set CALLING_QUEUE_ENABLED=true to run automatic due calls.');
    return;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('Calling queue disabled. SUPABASE_SERVICE_ROLE_KEY is required.');
    return;
  }

  setInterval(runCallingQueueOnce, Number(process.env.CALLING_QUEUE_INTERVAL_MS || 60000));
  runCallingQueueOnce();
}

module.exports = {
  runCallingQueueOnce,
  startCallingQueue,
};
