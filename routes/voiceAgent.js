// Endpoints the voice agent calls while it is on the phone.
//
// Retell invokes these as custom functions mid-conversation, so they are not
// browser endpoints and carry no user session. They are authenticated by a
// shared secret and scoped by the call id in the metadata, which means an agent
// can only ever read and write the calendar of the workspace whose call it is
// actually on.
//
// Both fail to a short spoken fallback rather than an error, because the prospect
// is waiting on the phone.

const express = require('express');
const { createServiceClient } = require('../lib/supabase');
const { findOpenSlots } = require('../lib/inHouseCalendar');

const NO_TIMES = 'No times are available right now. Say the team will follow up to arrange one.';
const BOOKING_FAILED = 'The booking could not be completed. Say the team will follow up to arrange a time.';

const router = express.Router();

function authorised(req) {
  const secret = process.env.RETELL_FUNCTION_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${secret}`;
}

/** Resolve the call this request belongs to, and everything hanging off it. */
async function callContext(supabase, body) {
  const metadata = body?.call?.metadata || body?.metadata || {};
  const callId = metadata.call_id || body?.call_id;
  if (!callId) return null;

  const { data: call } = await supabase
    .from('calls')
    .select('*, leads(id, full_name, first_name, email, company_name)')
    .eq('id', callId)
    .maybeSingle();

  if (!call) return null;

  const { data: campaign } = call.campaign_id
    ? await supabase.from('campaigns').select('timezone, active_days, sending_hours_start, sending_hours_end').eq('id', call.campaign_id).maybeSingle()
    : { data: null };

  return { call, campaign, metadata };
}

router.use(express.json({ limit: '256kb' }));

router.use((req, res, next) => {
  if (!authorised(req)) return res.status(403).json({ error: 'Forbidden' });
  return next();
});

/**
 * "What times are free?" The agent reads two or three of these aloud.
 */
router.post('/availability', async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ slots: [], message: NO_TIMES });

  try {
    const context = await callContext(supabase, req.body);
    if (!context) return res.json({ slots: [], message: NO_TIMES });

    const slots = await findOpenSlots(supabase, { workspaceId: context.call.workspace_id, campaign: context.campaign, limit: 3 });
    if (!slots.length) return res.json({ slots: [], message: NO_TIMES });

    return res.json({
      slots,
      message: `Offer these times: ${slots.map(slot => slot.spoken).join(', or ')}.`,
    });
  } catch (error) {
    console.error('[voice-agent] availability failed', error);
    return res.json({ slots: [], message: NO_TIMES });
  }
});

/**
 * "Book that one." Records the meeting on the Meetings calendar, against the
 * call so the campaign can report it.
 */
router.post('/book', async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ booked: false, message: BOOKING_FAILED });

  try {
    const context = await callContext(supabase, req.body);
    if (!context) return res.json({ booked: false, message: BOOKING_FAILED });

    const { call, campaign } = context;
    const args = req.body?.args || req.body?.arguments || req.body || {};
    const start = args.start || args.start_time;
    const email = args.email || call.leads?.email || null;

    if (!start) {
      return res.json({ booked: false, message: 'Ask the prospect which of the offered times works.' });
    }

    // Re-check the slot is still open. Two agents can be offering the same time
    // to two different prospects at once.
    const slots = await findOpenSlots(supabase, { workspaceId: call.workspace_id, campaign, limit: 10 });
    const chosen = slots.find(slot => new Date(slot.start).getTime() === new Date(start).getTime());
    const taken = `That time has just been taken. Offer these instead: ${slots.slice(0, 2).map(slot => slot.spoken).join(', or ')}.`;

    if (!chosen) return res.json({ booked: false, message: taken });

    const lead = call.leads;
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('name')
      .eq('id', call.workspace_id)
      .maybeSingle();

    const { data: meeting, error: insertError } = await supabase.from('meetings').insert({
      workspace_id: call.workspace_id,
      campaign_id: call.campaign_id,
      lead_id: call.lead_id,
      call_id: call.id,
      provider: 'manual',
      status: 'scheduled',
      title: `${workspace?.name || 'Intro'} · ${lead?.company_name || lead?.full_name || 'Introduction'}`,
      invitee_name: lead?.full_name || null,
      invitee_email: email,
      invitee_phone: call.to_number,
      starts_at: chosen.start,
      ends_at: chosen.end,
      timezone: campaign?.timezone || 'Asia/Singapore',
      notes: 'Booked by an AI assistant during an outbound call.',
    }).select('id').single();
    // The unique index caught another agent booking this time first.
    if (insertError?.code === '23505') return res.json({ booked: false, message: taken });
    if (insertError) throw insertError;

    // So the Calls page can show the meeting alongside the call that booked it.
    const { error: linkError } = await supabase.from('calls').update({ meeting_id: meeting.id }).eq('id', call.id);
    if (linkError) console.error('[voice-agent] could not link meeting to call', call.id, linkError.message);

    return res.json({
      booked: true,
      message: email
        ? `Booked for ${chosen.spoken}. Say the team will confirm the details at ${email}.`
        : `Booked for ${chosen.spoken}. Ask for the best email so the team can confirm the details.`,
    });
  } catch (error) {
    console.error('[voice-agent] booking failed', error);
    return res.json({ booked: false, message: BOOKING_FAILED });
  }
});

module.exports = router;
