const express = require('express');
const requireAuth = require('../middleware/auth');
const m = require('../lib/monthlyBilling');
const { byId } = require('../lib/pricing');
const { setSessionCookies } = require('../lib/authCookies');
const { audit, gotrue, mfaState, rateLimit, requireAdminMfa, requireFounder, result, service, totpFactors } = require('../lib/admin');
const { sendSupportReplyEmail } = require('../lib/support');

const router = express.Router();
const PAGE_SIZE = 25;
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Admin request failed.' }); } };
const page = req => Math.max(0, Number.parseInt(req.query.page, 10) || 0);
const one = value => (Array.isArray(value) ? value[0] : value) || null;

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
router.use(requireAuth);
router.use(requireFounder);
router.use(rateLimit({ windowMs: 60_000, max: 120 }));

// --- Session and two-factor (reachable before MFA so the founder can complete it) ---

router.get('/me', wrap(async (req, res) => {
  const factors = await totpFactors(req.accessToken);
  res.json({
    user: { id: req.user.id, email: req.user.email },
    mfa: { enrolled: factors.some(f => f.status === 'verified'), ...mfaState(req.accessToken) },
  });
}));

router.post('/mfa/enroll', rateLimit({ windowMs: 15 * 60_000, max: 5, key: 'mfa-enroll' }), wrap(async (req, res) => {
  const factors = await totpFactors(req.accessToken);
  if (factors.some(f => f.status === 'verified')) throw Object.assign(new Error('An authenticator is already enrolled.'), { status: 409 });
  // Abandoned enrollments block a new one with the same name, so clear them first.
  for (const factor of factors) await gotrue(`/factors/${factor.id}`, req.accessToken, { method: 'DELETE' });
  const factor = await gotrue('/factors', req.accessToken, { method: 'POST', body: { factor_type: 'totp', friendly_name: `CircleOn admin ${Date.now()}` } });
  res.json({ factor_id: factor.id, qr_code: factor.totp?.qr_code, secret: factor.totp?.secret, uri: factor.totp?.uri });
}));

router.post('/mfa/verify', rateLimit({ windowMs: 15 * 60_000, max: 10, key: 'mfa-verify' }), wrap(async (req, res) => {
  const code = String(req.body.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from your authenticator app.');
  const factors = await totpFactors(req.accessToken);
  const factor = factors.find(f => f.id === req.body.factor_id) || factors.find(f => f.status === 'verified');
  if (!factor) throw new Error('Set up an authenticator first.');
  const challenge = await gotrue(`/factors/${factor.id}/challenge`, req.accessToken, { method: 'POST', body: {} });
  const session = await gotrue(`/factors/${factor.id}/verify`, req.accessToken, { method: 'POST', body: { challenge_id: challenge.id, code } });
  setSessionCookies(res, session);
  await audit(req, service(), { action: factor.status === 'verified' ? 'mfa.verified' : 'mfa.enrolled', targetType: 'user', targetId: req.user.id });
  res.json({ verified: true });
}));

// --- Everything below needs a fresh two-factor session ---

router.use(requireAdminMfa);

router.get('/overview', wrap(async (req, res) => {
  const db = service();
  const [metrics, recent, tickets] = await Promise.all([
    result(db.rpc('admin_metrics')),
    result(db.from('admin_audit_log').select('id,action,target_type,target_id,created_at').order('created_at', { ascending: false }).limit(8)),
    result(db.from('support_tickets').select('id,subject,status,last_message_at,workspaces(name)').eq('status', 'open').order('last_message_at', { ascending: false }).limit(5)),
  ]);
  res.json({ metrics, recent, tickets });
}));

async function ownerEmails(db, ids) {
  const entries = await Promise.all([...new Set(ids.filter(Boolean))].map(async id => {
    const { data } = await db.auth.admin.getUserById(id);
    return [id, data?.user?.email || null];
  }));
  return Object.fromEntries(entries);
}

router.get('/organizations', wrap(async (req, res) => {
  const db = service(), p = page(req), q = String(req.query.q || '').trim().slice(0, 100);
  let query = db.from('workspaces')
    .select('id,name,owner_id,created_at,onboarding_completed,workspace_billing(plan,subscription_status,payment_failed,suspended_at,trial_end)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);
  if (q) query = query.ilike('name', `%${q.replace(/[%_\\]/g, '\\$&')}%`);
  const { data, count, error } = await query;
  if (error) throw error;
  const emails = await ownerEmails(db, data.map(w => w.owner_id));
  res.json({
    organizations: data.map(({ workspace_billing, ...w }) => ({ ...w, owner_email: emails[w.owner_id], billing: one(workspace_billing) })),
    total: count || 0, page: p, page_size: PAGE_SIZE,
  });
}));

router.get('/organizations/:id', wrap(async (req, res) => {
  const db = service(), id = req.params.id;
  const workspace = await result(db.from('workspaces').select('*').eq('id', id).maybeSingle());
  if (!workspace) throw Object.assign(new Error('Organization not found.'), { status: 404 });
  const count = table => db.from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', id);
  const [billing, members, campaigns, leads, sent, tickets, history, usage] = await Promise.all([
    result(db.from('workspace_billing').select('*').eq('workspace_id', id).maybeSingle()),
    result(db.from('workspace_members').select('user_id,role,status,created_at').eq('workspace_id', id)).catch(() => []),
    result(db.from('campaigns').select('id,name,status,created_at').eq('workspace_id', id).order('created_at', { ascending: false }).limit(50)),
    count('leads'),
    count('messages').in('status', ['sent', 'auto_sent']),
    result(db.from('support_tickets').select('id,subject,status,last_message_at').eq('workspace_id', id).order('last_message_at', { ascending: false }).limit(20)),
    result(db.from('admin_audit_log').select('id,action,before,after,created_at').eq('target_id', id).order('created_at', { ascending: false }).limit(20)),
    result(db.from('billing_usage').select('*').eq('workspace_id', id).order('period_start', { ascending: false }).limit(3)),
  ]);
  const emails = await ownerEmails(db, [workspace.owner_id, ...members.map(x => x.user_id)]);
  res.json({
    workspace: { ...workspace, owner_email: emails[workspace.owner_id] },
    billing,
    members: members.map(x => ({ ...x, email: emails[x.user_id] })),
    campaigns,
    counts: { leads: leads.count || 0, emails_sent: sent.count || 0 },
    usage, tickets, history,
  });
}));

async function requireConfirmation(db, id, confirm) {
  const workspace = await result(db.from('workspaces').select('id,name').eq('id', id).maybeSingle());
  if (!workspace) throw Object.assign(new Error('Organization not found.'), { status: 404 });
  if (String(confirm || '').trim() !== workspace.name) throw new Error('Type the organization name exactly to confirm.');
  return workspace;
}

router.post('/organizations/:id/suspend', wrap(async (req, res) => {
  const db = service(), id = req.params.id, reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw new Error('Give a reason of at least 5 characters.');
  await requireConfirmation(db, id, req.body.confirm);
  const before = await result(db.from('workspace_billing').select('suspended_at,suspended_reason').eq('workspace_id', id).maybeSingle());
  if (before?.suspended_at) throw new Error('This organization is already suspended.');
  const after = { suspended_at: new Date().toISOString(), suspended_reason: reason };
  await audit(req, db, { action: 'organization.suspend', targetType: 'workspace', targetId: id, before, after });
  await result(db.from('workspace_billing').upsert({ workspace_id: id, ...after }, { onConflict: 'workspace_id' }));
  res.json({ saved: true });
}));

router.post('/organizations/:id/unsuspend', wrap(async (req, res) => {
  const db = service(), id = req.params.id;
  await requireConfirmation(db, id, req.body.confirm);
  const before = await result(db.from('workspace_billing').select('suspended_at,suspended_reason').eq('workspace_id', id).maybeSingle());
  if (!before?.suspended_at) throw new Error('This organization is not suspended.');
  const after = { suspended_at: null, suspended_reason: null };
  await audit(req, db, { action: 'organization.unsuspend', targetType: 'workspace', targetId: id, before, after });
  await result(db.from('workspace_billing').update(after).eq('workspace_id', id));
  res.json({ saved: true });
}));

// --- Launch settings and billing approvals (moved from /api/billing/admin) ---

const SETTING_FLAGS = ['founding_offer_active', 'gst_registered', 'legal_ready', 'pdpa_verified', 'dnc_verified'];

router.get('/settings', wrap(async (req, res) => { res.json({ settings: await m.settings(service()) }); }));

router.patch('/settings', wrap(async (req, res) => {
  const db = service(), patch = {};
  for (const key of SETTING_FLAGS) if (typeof req.body[key] === 'boolean') patch[key] = req.body[key];
  if ('demo_url' in req.body) { if (req.body.demo_url && !/^https:\/\//.test(req.body.demo_url)) throw new Error('Use an HTTPS booking URL.'); patch.demo_url = req.body.demo_url || null; }
  if (!Object.keys(patch).length) throw new Error('Nothing to save.');
  const current = await m.settings(db);
  await audit(req, db, { action: 'settings.update', targetType: 'pricing_settings', before: Object.fromEntries(Object.keys(patch).map(k => [k, current[k]])), after: patch });
  await result(db.from('pricing_settings').update(patch).eq('id', true));
  res.json({ saved: true });
}));

router.get('/billing', wrap(async (req, res) => {
  const db = service(), p = page(req);
  const { data, count, error } = await db.from('workspaces').select('id,name,workspace_billing(*)', { count: 'exact' })
    .order('created_at', { ascending: false }).range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);
  if (error) throw error;
  res.json({ customers: data.map(w => ({ ...(one(w.workspace_billing) || {}), workspace_id: w.id, name: w.name })), total: count || 0, page: p, page_size: PAGE_SIZE });
}));

router.patch('/billing/:id', wrap(async (req, res) => {
  const db = service(), id = req.params.id, patch = {};
  for (const key of ['trial_approved', 'voice_approved', 'voice_ready']) if (typeof req.body[key] === 'boolean') patch[key] = req.body[key];
  if ('fallback_number' in req.body) { if (!/^\+[1-9]\d{7,14}$/.test(req.body.fallback_number)) throw new Error('Enter a fallback number in international format.'); patch.fallback_number = req.body.fallback_number; }
  if ('company_trial_key' in req.body) { if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(req.body.company_trial_key)) throw new Error('Identify the approved company by its actual domain.'); patch.company_trial_key = req.body.company_trial_key; }
  if (!Object.keys(patch).length) throw new Error('Nothing to save.');
  const b = await result(db.from('workspace_billing').select('*').eq('workspace_id', id).maybeSingle());
  if (patch.trial_approved && !(patch.company_trial_key || b?.company_trial_key)) throw new Error('Save the actual company domain before approving a personal-email trial.');
  if (patch.voice_ready && !(patch.fallback_number || b?.fallback_number)) throw new Error('Set an inbound fallback number before marking voice ready.');
  const touchesStripe = typeof patch.voice_ready === 'boolean' && b?.subscription_status === 'trialing' && byId[b.plan]?.family === 'allinone';
  if (touchesStripe) await requireConfirmation(db, id, req.body.confirm);
  await audit(req, db, { action: 'billing.update', targetType: 'workspace', targetId: id, before: Object.fromEntries(Object.keys(patch).map(k => [k, b?.[k] ?? null])), after: { ...patch, stripe_changed: touchesStripe } });
  if (touchesStripe && patch.voice_ready) {
    await m.stripeClient().subscriptions.update(b.stripe_subscription_id, { cancel_at: '' });
    if (b.founding) await m.configureFounderSchedule(m.stripeClient(), await m.stripeClient().subscriptions.retrieve(b.stripe_subscription_id), { ...b, voice_ready: true });
  }
  if (touchesStripe && patch.voice_ready === false) {
    const stripe = m.stripeClient(), sub = await stripe.subscriptions.retrieve(b.stripe_subscription_id);
    if (sub.schedule) await stripe.subscriptionSchedules.release(typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id);
    await stripe.subscriptions.update(sub.id, { cancel_at: sub.trial_end });
  }
  await result(db.from('workspace_billing').upsert({ workspace_id: id, ...patch }, { onConflict: 'workspace_id' }));
  res.json({ saved: true, stripe_changed: touchesStripe });
}));

router.get('/demos', wrap(async (req, res) => {
  res.json({ demos: await result(service().from('demo_requests').select('*').order('created_at', { ascending: false }).limit(100)) });
}));

router.use('/provider-credits', require('./providerCredits'));

// --- Support ---

router.get('/support', wrap(async (req, res) => {
  const db = service(), p = page(req), status = ['open', 'answered', 'closed'].includes(req.query.status) ? req.query.status : null;
  let query = db.from('support_tickets').select('id,subject,status,last_message_at,created_at,workspace_id,workspaces(name)', { count: 'exact' })
    .order('last_message_at', { ascending: false }).range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1);
  if (status) query = query.eq('status', status);
  const { data, count, error } = await query;
  if (error) throw error;
  res.json({ tickets: data, total: count || 0, page: p, page_size: PAGE_SIZE });
}));

router.get('/support/:id', wrap(async (req, res) => {
  const db = service();
  const ticket = await result(db.from('support_tickets').select('*,workspaces(name)').eq('id', req.params.id).maybeSingle());
  if (!ticket) throw Object.assign(new Error('Ticket not found.'), { status: 404 });
  const messages = await result(db.from('support_messages').select('id,sender,body,created_at').eq('ticket_id', ticket.id).order('created_at'));
  res.json({ ticket, messages });
}));

router.post('/support/:id/reply', wrap(async (req, res) => {
  const db = service(), body = String(req.body.body || '').trim();
  if (!body) throw new Error('Write a reply first.');
  if (body.length > 10000) throw new Error('Keep replies under 10,000 characters.');
  const ticket = await result(db.from('support_tickets').select('*').eq('id', req.params.id).maybeSingle());
  if (!ticket) throw Object.assign(new Error('Ticket not found.'), { status: 404 });
  await audit(req, db, { action: 'support.reply', targetType: 'support_ticket', targetId: ticket.id, after: { length: body.length } });
  const now = new Date().toISOString();
  await result(db.from('support_messages').insert({ ticket_id: ticket.id, workspace_id: ticket.workspace_id, sender: 'admin', body, created_by: req.user.id }));
  await result(db.from('support_tickets').update({ status: 'answered', last_message_at: now, updated_at: now }).eq('id', ticket.id));
  const emailed = await sendSupportReplyEmail(db, ticket, body).then(() => true, error => { console.error('[support-mail]', error.message); return false; });
  res.json({ saved: true, emailed });
}));

router.post('/support/:id/status', wrap(async (req, res) => {
  const db = service(), status = req.body.status;
  if (!['open', 'answered', 'closed'].includes(status)) throw new Error('Unknown ticket status.');
  const ticket = await result(db.from('support_tickets').select('id,status').eq('id', req.params.id).maybeSingle());
  if (!ticket) throw Object.assign(new Error('Ticket not found.'), { status: 404 });
  await audit(req, db, { action: 'support.status', targetType: 'support_ticket', targetId: ticket.id, before: { status: ticket.status }, after: { status } });
  await result(db.from('support_tickets').update({ status, updated_at: new Date().toISOString() }).eq('id', ticket.id));
  res.json({ saved: true });
}));

// --- Audit log ---

router.get('/audit', wrap(async (req, res) => {
  const p = page(req);
  const { data, count, error } = await service().from('admin_audit_log').select('*', { count: 'exact' })
    .order('created_at', { ascending: false }).range(p * PAGE_SIZE * 2, p * PAGE_SIZE * 2 + PAGE_SIZE * 2 - 1);
  if (error) throw error;
  res.json({ entries: data, total: count || 0, page: p, page_size: PAGE_SIZE * 2 });
}));

module.exports = router;
