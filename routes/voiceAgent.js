// Endpoints the voice agent calls while it is on the phone.
//
// Retell invokes these as custom functions mid-conversation, so they are not
// browser endpoints and carry no user session. They are authenticated by a
// shared secret and scoped by the call id in the metadata, which means an agent
// can only ever read and write the calendar of the workspace whose call it is
// actually on.
//
// Both have to answer fast. A prospect waiting in silence while we talk to
// Google is a worse experience than not offering times at all, so each one
// fails to a short spoken fallback rather than an error.

const express = require('express');
const { createServiceClient } = require('../lib/supabase');
const { findOpenSlots, createEvent } = require('../lib/googleCalendar');

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

  const { data: connection } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('workspace_id', call.workspace_id)
    .eq('status', 'connected')
    .maybeSingle();

  return { call, connection, metadata };
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
  if (!supabase) return res.json({ slots: [], message: 'No times are available right now.' });

  try {
    const context = await callContext(supabase, req.body);

    if (!context?.connection) {
      // No calendar connected. Tell the agent to fall back to the link rather
      // than inventing a time it cannot honour.
      return res.json({
        slots: [],
        message: 'No calendar is connected. Offer to send a booking link by email instead.',
      });
    }

    const slots = await findOpenSlots(supabase, context.connection, { limit: 3 });

    if (!slots.length) {
      return res.json({
        slots: [],
        message: 'Nothing is free in the next few days. Offer to send a booking link by email instead.',
      });
    }

    return res.json({
      slots,
      message: `Offer these times: ${slots.map(slot => slot.spoken).join(', or ')}.`,
    });
  } catch (error) {
    console.error('[voice-agent] availability failed', error);
    return res.json({
      slots: [],
      message: 'The calendar could not be reached. Offer to send a booking link by email instead.',
    });
  }
});

/**
 * "Book that one." Creates the event, invites the prospect, and records the
 * meeting against the call so the campaign can report it.
 */
router.post('/book', async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ booked: false, message: 'The booking could not be completed.' });

  try {
    const context = await callContext(supabase, req.body);
    if (!context) return res.json({ booked: false, message: 'The booking could not be completed.' });

    const { call, connection } = context;
    const args = req.body?.args || req.body?.arguments || req.body || {};
    const start = args.start || args.start_time;
    const email = args.email || context.call.leads?.email || null;

    if (!connection) {
      return res.json({ booked: false, message: 'No calendar is connected. Offer to send a booking link instead.' });
    }
    if (!start) {
      return res.json({ booked: false, message: 'Ask the prospect which of the offered times works.' });
    }

    // Re-check the slot is still open. Two agents can be offering the same time
    // to two different prospects at once.
    const slots = await findOpenSlots(supabase, connection, { limit: 10 });
    const chosen = slots.find(slot => slot.start === start)
      || slots.find(slot => new Date(slot.start).getTime() === new Date(start).getTime());

    if (!chosen) {
      return res.json({
        booked: false,
        message: `That time has just been taken. Offer these instead: ${slots.slice(0, 2).map(slot => slot.spoken).join(', or ')}.`,
      });
    }

    const lead = call.leads;
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('name')
      .eq('id', call.workspace_id)
      .maybeSingle();

    const event = await createEvent(supabase, connection, {
      start: chosen.start,
      end: chosen.end,
      summary: `${workspace?.name || 'Intro'} · ${lead?.company_name || lead?.full_name || 'Introduction'}`,
      description: 'Booked by an AI assistant during an outbound call.',
      attendeeEmail: email,
      attendeeName: lead?.full_name,
    });

    await supabase.from('meetings').insert({
      workspace_id: call.workspace_id,
      campaign_id: call.campaign_id,
      lead_id: call.lead_id,
      call_id: call.id,
      provider: 'google_calendar',
      external_id: event.id || null,
      status: 'scheduled',
      title: event.summary || 'Discovery call',
      invitee_name: lead?.full_name || null,
      invitee_email: email,
      invitee_phone: call.to_number,
      meeting_url: event.hangoutLink || event.htmlLink || null,
      starts_at: chosen.start,
      ends_at: chosen.end,
      timezone: connection.timezone || 'Asia/Singapore',
      raw_data: event,
    });

    return res.json({
      booked: true,
      message: email
        ? `Booked for ${chosen.spoken}. Confirm that the invitation is on its way to ${email}.`
        : `Booked for ${chosen.spoken}. Ask for the best email so the invitation can be sent.`,
    });
  } catch (error) {
    console.error('[voice-agent] booking failed', error);
    return res.json({
      booked: false,
      message: 'The booking could not be completed. Offer to send a booking link by email instead.',
    });
  }
});

module.exports = router;
