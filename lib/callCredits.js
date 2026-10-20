// Prepaid call credits.
//
// Voice is the first feature in the product with genuinely variable unit cost,
// and billing elsewhere is a flat subscription with no metering. Prepaid fails
// safely: running out pauses the campaign, which is recoverable, rather than
// producing an invoice the customer disputes a month later.
//
// Two numbers here are commercial decisions still with the founder, so both are
// configuration rather than assumptions baked into code:
//   VOICE_CREDIT_MARGIN         multiplier applied to the raw provider cost
//   VOICE_CHARGE_UNANSWERED     whether a call nobody answered consumes credit

const DEFAULT_MARGIN = 1;
// Roughly a three minute call. Used as the minimum balance required before we
// will start a call, so a campaign cannot begin a conversation it cannot pay to
// finish.
const DEFAULT_MIN_BALANCE_CENTS = 60;

function marginMultiplier() {
  const value = Number(process.env.VOICE_CREDIT_MARGIN);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MARGIN;
}

function minimumBalanceCents() {
  const value = Number(process.env.VOICE_MIN_BALANCE_CENTS);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_MIN_BALANCE_CENTS;
}

function chargesUnansweredCalls() {
  return process.env.VOICE_CHARGE_UNANSWERED === 'true';
}

/**
 * What we charge the customer for a completed call, given what the provider
 * charged us. Returns 0 when the call should not consume credit at all.
 */
function billableCents(call) {
  const providerCents = Number(call?.cost_cents);
  if (!Number.isFinite(providerCents) || providerCents <= 0) return 0;

  const connected = call?.status === 'completed' && Number(call?.duration_seconds) > 0;
  if (!connected && !chargesUnansweredCalls()) return 0;

  return Math.max(1, Math.round(providerCents * marginMultiplier()));
}

async function getCredits(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('workspace_call_credits')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw error;

  return data || {
    workspace_id: workspaceId,
    balance_cents: 0,
    lifetime_purchased_cents: 0,
    lifetime_spent_cents: 0,
  };
}

/**
 * Can this workspace afford to start a call? Returns a reason when it cannot,
 * because the campaign view needs to explain itself rather than just stopping.
 */
async function creditCheck(supabase, workspaceId) {
  // Monthly plans spend their included minutes first; prepaid credits cover
  // calls after the allowance runs out, and every call on legacy plans.
  const access = await require('./monthlyBilling').voiceAccess(supabase, workspaceId);
  if (access && (access.ok || access.reason !== 'Voice allowance reached.')) return access;
  const credits = await getCredits(supabase, workspaceId);
  const required = minimumBalanceCents();

  if (credits.balance_cents < required) {
    return {
      ok: false,
      balanceCents: credits.balance_cents,
      reason: access ? 'Plan minutes used up and not enough call credits for another call' : 'Not enough call credits to start another call',
    };
  }

  return { ok: true, balanceCents: credits.balance_cents, reason: null, concurrency: access?.concurrency };
}

/**
 * Charge a finished call. Safe to call repeatedly for the same call: Retell can
 * deliver a webhook more than once, and the database enforces one charge per
 * call.
 */
async function chargeForCall(supabase, call) {
  const {data:billing,error:billingError}=await supabase.from('workspace_billing').select('*').eq('workspace_id',call.workspace_id).maybeSingle();
  if(billingError) throw billingError;
  if(require('./pricing').byId[billing?.plan]) {
    if(call.status==='completed' && Number(call.duration_seconds)>0) await require('./voiceUsage').chargeMonthlyVoice(supabase,call);
    return {chargedCents:0,balanceCents:null};
  }
  const amount = billableCents(call);
  if (!amount) return { chargedCents: 0, balanceCents: null };

  const { data, error } = await supabase.rpc('charge_call_credits', {
    p_workspace_id: call.workspace_id,
    p_call_id: call.id,
    p_campaign_id: call.campaign_id || null,
    p_amount_cents: amount,
  });

  if (error) throw error;

  return { chargedCents: amount, balanceCents: typeof data === 'number' ? data : null };
}

async function addCredits(supabase, workspaceId, amountCents, reason, note = null) {
  const { data, error } = await supabase.rpc('add_call_credits', {
    p_workspace_id: workspaceId,
    p_amount_cents: Math.round(amountCents),
    p_reason: reason,
    p_note: note,
  });

  if (error) throw error;
  return typeof data === 'number' ? data : null;
}

module.exports = {
  addCredits,
  billableCents,
  chargeForCall,
  creditCheck,
  getCredits,
  minimumBalanceCents,
};
