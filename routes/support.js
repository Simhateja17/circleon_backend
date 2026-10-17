const express = require('express');
const requireAuth = require('../middleware/auth');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { result, service } = require('../lib/admin');

const router = express.Router();
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Support request failed.' }); } };
router.use(requireAuth);

function cleanBody(value) {
  const body = String(value || '').trim();
  if (!body) throw new Error('Write a message first.');
  if (body.length > 10000) throw new Error('Keep messages under 10,000 characters.');
  return body;
}

// Tickets are read with the service client, so every query is scoped to the
// caller's own workspace here rather than by RLS.
async function ownTicket(db, workspace, id) {
  const ticket = await result(db.from('support_tickets').select('*').eq('id', id).eq('workspace_id', workspace.id).maybeSingle());
  if (!ticket) throw Object.assign(new Error('Ticket not found.'), { status: 404 });
  return ticket;
}

router.get('/', wrap(async (req, res) => {
  const workspace = await getOrCreateWorkspace(req.supabase, req.user);
  res.json({ tickets: await result(service().from('support_tickets').select('id,subject,status,last_message_at,created_at').eq('workspace_id', workspace.id).order('last_message_at', { ascending: false }).limit(50)) });
}));

router.post('/', wrap(async (req, res) => {
  const subject = String(req.body.subject || '').trim(), body = cleanBody(req.body.body);
  if (subject.length < 3 || subject.length > 200) throw new Error('Give your request a subject of 3 to 200 characters.');
  const db = service(), workspace = await getOrCreateWorkspace(req.supabase, req.user);
  const open = await db.from('support_tickets').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('status', 'open');
  if ((open.count || 0) >= 10) throw new Error('You have 10 open requests. We will reply to those first.');
  const ticket = await result(db.from('support_tickets').insert({ workspace_id: workspace.id, created_by: req.user.id, subject }).select('id').single());
  await result(db.from('support_messages').insert({ ticket_id: ticket.id, workspace_id: workspace.id, sender: 'user', body, created_by: req.user.id }));
  res.json({ ticket_id: ticket.id });
}));

router.get('/:id', wrap(async (req, res) => {
  const db = service(), workspace = await getOrCreateWorkspace(req.supabase, req.user);
  const ticket = await ownTicket(db, workspace, req.params.id);
  res.json({ ticket, messages: await result(db.from('support_messages').select('id,sender,body,created_at').eq('ticket_id', ticket.id).order('created_at')) });
}));

router.post('/:id/messages', wrap(async (req, res) => {
  const body = cleanBody(req.body.body), db = service(), workspace = await getOrCreateWorkspace(req.supabase, req.user);
  const ticket = await ownTicket(db, workspace, req.params.id), now = new Date().toISOString();
  await result(db.from('support_messages').insert({ ticket_id: ticket.id, workspace_id: workspace.id, sender: 'user', body, created_by: req.user.id }));
  await result(db.from('support_tickets').update({ status: 'open', last_message_at: now, updated_at: now }).eq('id', ticket.id));
  res.json({ saved: true });
}));

module.exports = router;
