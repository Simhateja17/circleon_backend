// What happens after a voice campaign call ends.
//
// Four jobs: charge the credit, decide whether the lead gets another attempt,
// honour a do-not-call request, and send the one email the agent promised on
// the call.
//
// That last one matters more than it sounds. If the agent says "I am sending
// that over now" and nothing arrives, the agent lied. So the follow-up is
// transactional and immediate, not an enrolment into a drip sequence.

const { chargeForCall } = require('./callCredits');
const { nextAttemptAt } = require('./voiceScheduling');
const { createTransport, sendEmail } = require('./smtp');

// Outcomes where the lead has given us an answer. No further attempts.
const DECISIVE_OUTCOMES = new Set([
  'booked',
  'booking_link_sent',
  'interested',
  'not_interested',
  'do_not_call',
  'follow_up_needed',
]);

// Outcomes that mean we simply did not reach them.
const RETRYABLE_STATUSES = new Set(['no_answer', 'busy', 'failed', 'canceled']);

const FOLLOW_UP_OUTCOMES = new Set(['booking_link_sent', 'follow_up_needed']);

function campaignSchedule(campaign) {
  return {
    timezone: campaign?.timezone,
    active_days: campaign?.active_days,
    sending_hours_start: campaign?.sending_hours_start,
    sending_hours_end: campaign?.sending_hours_end,
  };
}

/**
 * Did the prospect ask us to stop calling their whole company, rather than just
 * them? The agent is instructed to record the distinction, and the transcript
 * backs it up. We only ever suppress a whole domain on an explicit request.
 */
function isCompanyWideRefusal(payload) {
  const analysis = payload?.call_analysis?.custom_analysis_data || {};
  const scope = String(analysis.do_not_call_scope || analysis.dnc_scope || '').toLowerCase();
  return scope === 'company' || analysis.company_wide_do_not_call === true;
}

async function applySuppression(supabase, { call, lead, outcome, payload }) {
  if (outcome?.outcome_type !== 'do_not_call') return;

  // The individual always. The database trigger propagates this into
  // lifecycle_status, which is what stops the email side sending too.
  await supabase
    .from('leads')
    .update({
      status: 'do_not_call',
      suppression_reason: 'lead_requested_do_not_call',
    })
    .eq('id', lead.id);

  if (!isCompanyWideRefusal(payload) || !lead.company_domain) return;

  // An explicit company-level refusal suppresses the domain outright. An
  // individual refusal does not: it only raises a warning before a colleague is
  // dialled, which the campaign view surfaces.
  await supabase.from('lead_suppressions').insert({
    workspace_id: call.workspace_id,
    company_domain: lead.company_domain,
    company_name: lead.company_name || null,
    reason: 'voice_do_not_call_company',
    raw_data: { call_id: call.id, requested_at: new Date().toISOString() },
  });
}

async function advanceTarget(supabase, { call, campaign, outcome }) {
  const { data: target, error } = await supabase
    .from('voice_call_targets')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('lead_id', call.lead_id)
    .maybeSingle();

  if (error) throw error;
  if (!target) return;

  const outcomeType = outcome?.outcome_type || null;

  if (outcomeType && DECISIVE_OUTCOMES.has(outcomeType)) {
    await supabase
      .from('voice_call_targets')
      .update({ state: 'completed', last_outcome: outcomeType, last_call_id: call.id, block_reason: null })
      .eq('id', target.id);
    return;
  }

  if (!RETRYABLE_STATUSES.has(call.status)) {
    // Connected but the outcome was not classified. Treat as worked rather than
    // dialling someone we have already spoken to.
    await supabase
      .from('voice_call_targets')
      .update({ state: 'completed', last_outcome: outcomeType, last_call_id: call.id })
      .eq('id', target.id);
    return;
  }

  const attempts = target.attempts || call.attempt_number || 1;
  const maxAttempts = campaign.max_call_attempts || 3;

  if (attempts >= maxAttempts) {
    await supabase
      .from('voice_call_targets')
      .update({
        state: 'exhausted',
        last_outcome: outcomeType || call.status,
        last_call_id: call.id,
        block_reason: `No answer after ${attempts} attempts`,
      })
      .eq('id', target.id);
    return;
  }

  await supabase
    .from('voice_call_targets')
    .update({
      state: 'pending',
      last_outcome: outcomeType || call.status,
      last_call_id: call.id,
      block_reason: null,
      next_attempt_at: nextAttemptAt(campaignSchedule(campaign), attempts + 1, {
        gapHours: campaign.retry_gap_hours || 24,
      }).toISOString(),
    })
    .eq('id', target.id);
}

function followUpContent({ outcome, lead, campaign, agentConfig }) {
  const firstName = lead.first_name || (lead.full_name || '').split(' ')[0] || 'there';
  const company = agentConfig?.company_name || campaign?.name || 'us';
  const bookingLink = agentConfig?.booking_link;

  if (outcome.outcome_type === 'booking_link_sent') {
    return {
      subject: `Booking link, as promised`,
      body: `Hi ${firstName},\n\nThanks for taking the call just now. Here is the link to pick a time that suits you:\n\n${bookingLink}\n\nIf none of those work, reply to this email and we will find something that does.\n\nBest,\n${company}`,
    };
  }

  const summary = outcome.summary ? `\n\nQuick recap of what we discussed:\n${outcome.summary}` : '';
  return {
    subject: `Following up on our call`,
    body: `Hi ${firstName},\n\nThanks for taking the call just now.${summary}\n\nI will follow up as agreed. If anything changes in the meantime, just reply here.\n\nBest,\n${company}`,
  };
}

/**
 * Send the one thing the agent promised. Always from the customer's own
 * connected mailbox: an email from a platform address, about a call from a
 * company the prospect has never emailed, reads as spam.
 */
async function sendTransactionalFollowUp(supabase, { call, lead, campaign, outcome, agentConfig }) {
  if (!FOLLOW_UP_OUTCOMES.has(outcome?.outcome_type)) return;
  if (!lead?.email) return;

  if (outcome.outcome_type === 'booking_link_sent' && !agentConfig?.booking_link) return;

  const { data: account, error: accountError } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('workspace_id', call.workspace_id)
    .eq('provider', 'smtp')
    .not('smtp_verified_at', 'is', null)
    .maybeSingle();

  if (accountError) throw accountError;
  if (!account) return;

  const {data:monthlyBilling,error:billingError}=await supabase.from('workspace_billing').select('*').eq('workspace_id',call.workspace_id).maybeSingle();
  if(billingError)throw billingError;
  const monthlyPlan=require('./pricing').byId[monthlyBilling?.plan];
  if(monthlyPlan?.family==='voice')return;
  if(monthlyPlan){const reservation=await require('./monthlyBilling').consumeUsage(supabase,call.workspace_id,'emails',1,'voice-email:'+call.id);if(reservation?.duplicate)return;}
  const { subject, body } = followUpContent({ outcome, lead, campaign, agentConfig });

  const { data: message, error: messageError } = await supabase
    .from('messages')
    .insert({
      workspace_id: call.workspace_id,
      campaign_id: campaign.id,
      lead_id: lead.id,
      direction: 'outbound',
      subject,
      body,
      status: 'approved',
      raw_payload: { source: 'voice_call_follow_up', call_id: call.id, outcome: outcome.outcome_type },
    })
    .select('*')
    .single();

  if (messageError) throw messageError;

  try {
    const transport = createTransport(account);
    const sent = await sendEmail({
      transport,
      from: `"${account.from_name}" <${account.from_email}>`,
      to: lead.email,
      subject,
      body,
      replyTo: account.reply_to_email || account.from_email,
    });

    await supabase
      .from('messages')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        message_id_header: sent.messageId || null,
      })
      .eq('id', message.id);
  } catch (error) {
    await supabase
      .from('messages')
      .update({
        status: 'failed',
        raw_payload: {
          source: 'voice_call_follow_up',
          call_id: call.id,
          error: error.message || 'Follow-up email failed',
        },
      })
      .eq('id', message.id);
  }
}

/**
 * Entry point from the Retell webhook. Safe to run more than once for the same
 * call: the credit charge is idempotent in the database and every other step
 * settles on the same value.
 */
async function handleVoiceCallCompletion(supabase, { call, outcome, payload }) {
  if (!call?.campaign_id) return; // A legacy follow-up call, not a campaign one.

  const [{ data: campaign }, { data: lead }, { data: agentConfig }] = await Promise.all([
    supabase.from('campaigns').select('*').eq('id', call.campaign_id).maybeSingle(),
    supabase.from('leads').select('*').eq('id', call.lead_id).maybeSingle(),
    supabase.from('agent_configs').select('*').eq('workspace_id', call.workspace_id).maybeSingle(),
  ]);

  if (!campaign) return;

  const charge = await chargeForCall(supabase, call);
  if (charge.chargedCents) {
    await supabase
      .from('calls')
      .update({ credit_charged_cents: charge.chargedCents })
      .eq('id', call.id);
  }

  if (lead) {
    await applySuppression(supabase, { call, lead, outcome, payload });
  }

  await advanceTarget(supabase, { call, campaign, outcome });

  if (lead) {
    await sendTransactionalFollowUp(supabase, { call, lead, campaign, outcome, agentConfig });
  }
}

module.exports = {
  DECISIVE_OUTCOMES,
  RETRYABLE_STATUSES,
  advanceTarget,
  handleVoiceCallCompletion,
  isCompanyWideRefusal,
};
