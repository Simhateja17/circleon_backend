const OUTCOME_TYPES = new Set([
  'booked',
  'booking_link_sent',
  'interested',
  'follow_up_needed',
  'no_answer',
  'not_interested',
  'do_not_call',
  'unknown',
]);

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeOutcomeType(value) {
  const normalized = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (OUTCOME_TYPES.has(normalized)) return normalized;
  return 'unknown';
}

function inferOutcomeFromCall(call = {}, status = '') {
  const analysis = call.call_analysis || {};
  const custom = analysis.custom_analysis_data || call.custom_analysis_data || {};
  const summary = clean(analysis.call_summary || call.summary || call.call_summary);
  const joined = [
    custom.outcome,
    custom.call_outcome,
    custom.next_action,
    custom.follow_up,
    summary,
    call.transcript,
    call.disconnection_reason,
    status,
  ].map(clean).join(' ').toLowerCase();

  if (joined.includes('do not call') || joined.includes('remove me') || joined.includes('unsubscribe')) return 'do_not_call';
  if (joined.includes('booked') || joined.includes('meeting scheduled') || joined.includes('calendar invite')) return 'booked';
  if (joined.includes('booking link') || joined.includes('calendly') || joined.includes('calendar link')) return 'booking_link_sent';
  if (joined.includes('follow up') || joined.includes('call back') || joined.includes('next week')) return 'follow_up_needed';
  if (joined.includes('interested') || joined.includes('send more') || joined.includes('sounds good')) return 'interested';
  if (joined.includes('not interested') || joined.includes('no thanks')) return 'not_interested';
  if (joined.includes('no_answer') || joined.includes('no answer') || joined.includes('not_connected')) return 'no_answer';
  return 'unknown';
}

function extractOutcome(call = {}, status = '') {
  const analysis = call.call_analysis || {};
  const custom = analysis.custom_analysis_data || call.custom_analysis_data || {};
  const explicit = custom.outcome_type || custom.outcome || custom.call_outcome;
  const outcomeType = explicit ? normalizeOutcomeType(explicit) : inferOutcomeFromCall(call, status);
  const summary = clean(analysis.call_summary || call.summary || call.call_summary);
  const nextAction = clean(custom.next_action || custom.follow_up || call.next_action);
  const confidence = ['low', 'medium', 'high'].includes(clean(custom.outcome_confidence).toLowerCase())
    ? clean(custom.outcome_confidence).toLowerCase()
    : summary || explicit ? 'medium' : 'low';

  return {
    outcome_type: outcomeType,
    confidence,
    summary: summary || null,
    next_action: nextAction || null,
    meeting_requested: ['booked', 'booking_link_sent'].includes(outcomeType),
  };
}

function leadStatusForOutcome(outcomeType) {
  if (outcomeType === 'booked') return 'booked';
  if (['booking_link_sent', 'interested'].includes(outcomeType)) return 'interested';
  if (outcomeType === 'follow_up_needed') return 'follow_up';
  if (outcomeType === 'not_interested') return 'not_interested';
  if (outcomeType === 'do_not_call') return 'do_not_call';
  return null;
}

async function upsertCallOutcome(supabase, callRow, outcome, rawData = {}) {
  if (!callRow?.id || !callRow?.workspace_id) return null;

  const payload = {
    workspace_id: callRow.workspace_id,
    call_id: callRow.id,
    lead_id: callRow.lead_id,
    follow_up_id: callRow.follow_up_id,
    outcome_type: outcome.outcome_type || 'unknown',
    confidence: outcome.confidence || 'medium',
    summary: outcome.summary || null,
    next_action: outcome.next_action || null,
    meeting_requested: Boolean(outcome.meeting_requested),
    raw_data: rawData,
  };

  const { data, error } = await supabase
    .from('call_outcomes')
    .upsert(payload, { onConflict: 'call_id' })
    .select('*')
    .single();

  if (error) throw error;

  await supabase
    .from('calls')
    .update({
      outcome_type: payload.outcome_type,
      outcome_confidence: payload.confidence,
      outcome_summary: payload.summary,
      next_action: payload.next_action,
    })
    .eq('id', callRow.id);

  const leadStatus = leadStatusForOutcome(payload.outcome_type);
  if (leadStatus && callRow.lead_id) {
    const leadPatch = { status: leadStatus };
    if (payload.outcome_type === 'do_not_call') {
      leadPatch.dnc_status = 'blocked';
      leadPatch.voice_consent_status = 'not_consented';
      leadPatch.callable_block_reason = 'Lead requested no further calls';
    }
    await supabase.from('leads').update(leadPatch).eq('id', callRow.lead_id);
  }

  if (payload.outcome_type === 'booked') {
    const { data: existingMeeting } = await supabase
      .from('meetings')
      .select('*')
      .eq('workspace_id', callRow.workspace_id)
      .eq('call_id', callRow.id)
      .maybeSingle();

    if (!existingMeeting) {
      const { data: meeting, error: meetingError } = await supabase
        .from('meetings')
        .insert({
          workspace_id: callRow.workspace_id,
          lead_id: callRow.lead_id,
          call_id: callRow.id,
          call_outcome_id: data.id,
          provider: 'manual',
          status: 'requested',
          title: 'Discovery call requested',
          notes: payload.summary,
          raw_data: rawData,
        })
        .select('*')
        .single();

      if (meetingError) throw meetingError;
      await supabase.from('calls').update({ meeting_id: meeting.id }).eq('id', callRow.id);
    }
  }

  return data;
}

module.exports = {
  extractOutcome,
  leadStatusForOutcome,
  normalizeOutcomeType,
  upsertCallOutcome,
};
