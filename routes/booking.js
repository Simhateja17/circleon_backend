// The public booking page that emails link to. A prospect has no account, so the
// unguessable token in the link decides which workspace's calendar this is.

const express = require('express');
const { z } = require('zod');
const { createServiceClient } = require('../lib/supabase');
const { findOpenSlots, SLOT_MINUTES } = require('../lib/inHouseCalendar');

const router = express.Router();
const TIMEZONE = 'Asia/Singapore';
const OFFERED = { campaign: null, days: 14, limit: 60, perDay: 6 };

const bookingSchema = z.object({
  start: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
});

function limitPerMinute(max) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now - entry.start >= 60000) {
      hits.set(req.ip, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    return next();
  };
}

async function loadWorkspace(supabase, token) {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const { data, error } = await supabase.from('workspaces').select('id, name').eq('booking_token', token).maybeSingle();
  if (error) throw error;
  return data;
}

router.get('/:token', limitPerMinute(60), async (req, res) => {
  try {
    const supabase = createServiceClient();
    const workspace = await loadWorkspace(supabase, req.params.token);
    if (!workspace) return res.status(404).json({ error: 'This booking link is not valid.' });
    const slots = await findOpenSlots(supabase, { workspaceId: workspace.id, ...OFFERED });
    return res.json({ company: workspace.name, timezone: TIMEZONE, slot_minutes: SLOT_MINUTES, slots });
  } catch (error) {
    console.error('[booking] could not load times', error);
    return res.status(500).json({ error: 'Could not load open times.' });
  }
});

router.post('/:token', express.json({ limit: '16kb' }), limitPerMinute(10), async (req, res) => {
  try {
    const parsed = bookingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter your name and a valid email address.' });

    const supabase = createServiceClient();
    const workspace = await loadWorkspace(supabase, req.params.token);
    if (!workspace) return res.status(404).json({ error: 'This booking link is not valid.' });

    const { start, name, email } = parsed.data;
    const slots = await findOpenSlots(supabase, { workspaceId: workspace.id, ...OFFERED });
    const chosen = slots.find(slot => new Date(slot.start).getTime() === new Date(start).getTime());
    if (!chosen) return res.status(409).json({ error: 'That time has just been taken. Please choose another.' });

    const { data: leads, error: leadError } = await supabase
      .from('leads')
      .select('id, phone_e164')
      .eq('workspace_id', workspace.id)
      .ilike('email', email.replace(/[\\%_]/g, '\\$&'))
      .limit(1);
    if (leadError) throw leadError;
    const lead = leads?.[0];

    const { error: insertError } = await supabase.from('meetings').insert({
      workspace_id: workspace.id,
      lead_id: lead?.id || null,
      provider: 'manual',
      status: 'scheduled',
      title: `${workspace.name} · ${name}`,
      invitee_name: name,
      invitee_email: email,
      invitee_phone: lead?.phone_e164 || null,
      starts_at: chosen.start,
      ends_at: chosen.end,
      timezone: TIMEZONE,
      notes: 'Booked through the booking page.',
    });
    if (insertError?.code === '23505') return res.status(409).json({ error: 'That time has just been taken. Please choose another.' });
    if (insertError) throw insertError;

    return res.status(201).json({ booked: true, start: chosen.start, end: chosen.end });
  } catch (error) {
    console.error('[booking] could not book', error);
    return res.status(500).json({ error: 'Could not complete the booking.' });
  }
});

module.exports = router;
