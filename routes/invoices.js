const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { requireFeature } = require('../lib/entitlements');
const { createServiceClient } = require('../lib/supabase');
const { createTransport } = require('../lib/smtp');
const inv = require('../lib/invoices');

const router = express.Router();
router.use(requireAuth, requireFeature('invoices'));

// Workspace access is checked above; the service client keeps owners who
// predate workspace_members working, and every query filters by workspace.
function db() {
  const client = createServiceClient();
  if (!client) throw Object.assign(new Error('Invoicing is not configured on this server.'), { status: 503 });
  return client;
}
const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Check the invoice details.' });
    if (error.code === '23505') return res.status(409).json({ error: 'An invoice with that number already exists.' });
    return res.status(error.status || 500).json({ error: error.message || 'Invoice request failed.' });
  }
};
const result = async query => { const { data, error } = await query; if (error) throw error; return data; };

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD.');
const lineItem = z.object({
  description: z.string().trim().min(1, 'Each line item needs a description.').max(300),
  quantity: z.number().positive().max(1e6),
  unit_cents: z.number().int().min(0).max(1e11),
});
const invoiceInput = z.object({
  number: z.string().trim().max(40).optional(),
  client_name: z.string().trim().min(1, 'Enter the client name.').max(200),
  client_email: z.string().trim().email('Enter a valid client email.').max(320),
  lead_id: z.string().uuid().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('SGD'),
  line_items: z.array(lineItem).min(1, 'Add at least one line item.').max(50),
  issue_date: dateString.optional(),
  due_date: dateString,
  notes: z.string().max(2000).nullable().optional(),
  payment_link: z.string().url('Enter a full payment link, starting with https://').max(1000).nullable().optional().or(z.literal('')),
  reminders_enabled: z.boolean().optional(),
  checkins_enabled: z.boolean().optional(),
});
const offsets = z.array(z.number().int().min(-60).max(365)).max(10);
const settingsInput = z.object({
  reminder_offsets: offsets.optional(),
  checkin_offsets: z.array(z.number().int().min(0).max(365)).max(10).optional(),
  reminders_enabled: z.boolean().optional(),
  checkins_enabled: z.boolean().optional(),
  review_link: z.string().url().max(1000).nullable().optional().or(z.literal('')),
});

function present(invoice, events = []) {
  return { ...invoice, display_status: inv.invoiceStatus(invoice), events };
}

async function nextNumber(client, workspaceId) {
  const year = new Date().getFullYear();
  const { count, error } = await client.from('invoices').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  if (error) throw error;
  return `INV-${year}-${String((count || 0) + 1).padStart(4, '0')}`;
}

async function loadInvoice(client, workspaceId, id) {
  const invoice = await result(client.from('invoices').select('*').eq('workspace_id', workspaceId).eq('id', id).maybeSingle());
  if (!invoice) throw Object.assign(new Error('Invoice not found.'), { status: 404 });
  return invoice;
}

router.get('/', wrap(async (req, res) => {
  const client = db();
  const invoices = await result(client.from('invoices').select('*').eq('workspace_id', req.workspace.id).order('created_at', { ascending: false }).limit(500));
  const events = invoices.length ? await result(client.from('invoice_events').select('invoice_id,kind,step,subject,created_at').in('invoice_id', invoices.map(i => i.id)).order('created_at')) : [];
  const list = invoices.map(i => present(i, events.filter(e => e.invoice_id === i.id)));
  const totals = { outstanding_cents: 0, overdue_cents: 0, paid_cents: 0 };
  for (const i of list) {
    if (i.display_status === 'sent') totals.outstanding_cents += Number(i.amount_cents);
    if (i.display_status === 'overdue') { totals.outstanding_cents += Number(i.amount_cents); totals.overdue_cents += Number(i.amount_cents); }
    if (i.display_status === 'paid') totals.paid_cents += Number(i.amount_cents);
  }
  res.json({ invoices: list, totals });
}));

router.post('/', wrap(async (req, res) => {
  const client = db();
  const input = invoiceInput.parse(req.body);
  const issue = input.issue_date || inv.localDate();
  if (input.due_date < issue) throw Object.assign(new Error('The due date cannot be before the issue date.'), { status: 400 });
  const invoice = await result(client.from('invoices').insert({
    ...input,
    workspace_id: req.workspace.id,
    number: input.number || await nextNumber(client, req.workspace.id),
    issue_date: issue,
    payment_link: input.payment_link || null,
    amount_cents: inv.lineItemsTotal(input.line_items),
  }).select('*').single());
  res.status(201).json({ invoice: present(invoice) });
}));

// Only drafts can be edited; a sent invoice is a record the client already has.
router.patch('/:id', wrap(async (req, res) => {
  const client = db();
  const current = await loadInvoice(client, req.workspace.id, req.params.id);
  const toggles = z.object({ reminders_enabled: z.boolean().optional(), checkins_enabled: z.boolean().optional() }).strict();
  let patch;
  if (current.status === 'draft') {
    const input = invoiceInput.partial().parse(req.body);
    patch = { ...input, ...(input.line_items ? { amount_cents: inv.lineItemsTotal(input.line_items) } : {}), ...('payment_link' in input ? { payment_link: input.payment_link || null } : {}) };
  } else {
    patch = toggles.parse(req.body);
  }
  const invoice = await result(client.from('invoices').update(patch).eq('workspace_id', req.workspace.id).eq('id', current.id).select('*').single());
  res.json({ invoice: present(invoice) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const client = db();
  const current = await loadInvoice(client, req.workspace.id, req.params.id);
  if (current.status !== 'draft') throw Object.assign(new Error('Only drafts can be deleted. Void a sent invoice instead.'), { status: 409 });
  await result(client.from('invoices').delete().eq('workspace_id', req.workspace.id).eq('id', current.id));
  res.json({ deleted: true });
}));

router.post('/:id/send', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  if (!['draft', 'sent'].includes(invoice.status)) throw Object.assign(new Error('Only draft or unpaid invoices can be sent.'), { status: 409 });
  const account = await inv.loadSmtpAccount(client, req.workspace.id);
  const content = inv.composeEmail('invoice', invoice, { businessName: account.from_name || req.workspace.name });
  // A resend gets its own step so the original send stays on record.
  const step = invoice.status === 'draft' ? '' : `resend-${Date.now()}`;
  const sent = await inv.sendInvoiceEmail(client, invoice, 'invoice', step, content, { account, transport: createTransport(account) });
  if (!sent) throw Object.assign(new Error('This invoice is already being sent.'), { status: 409 });
  const updated = invoice.status === 'draft'
    ? await result(client.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invoice.id).select('*').single())
    : invoice;
  res.json({ invoice: present(updated) });
}));

router.post('/:id/mark-paid', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  if (!['draft', 'sent'].includes(invoice.status)) throw Object.assign(new Error('This invoice is already closed.'), { status: 409 });
  const updated = await result(client.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', invoice.id).select('*').single());
  await client.from('invoice_events').insert({ invoice_id: invoice.id, workspace_id: invoice.workspace_id, kind: 'paid', step: '' });
  // Send the thank-you now instead of waiting for the next worker pass.
  inv.loadSettings(client, req.workspace.id).then(async settings => {
    const account = await inv.loadSmtpAccount(client, req.workspace.id);
    const events = await result(client.from('invoice_events').select('kind,step,created_at').eq('invoice_id', invoice.id));
    await inv.followUpInvoice(client, updated, { settings, events: events.filter(e => e.kind !== 'invoice' && e.kind !== 'reminder'), account, transport: createTransport(account), businessName: account.from_name || req.workspace.name });
  }).catch(error => console.error('[invoices] thank-you failed', invoice.id, error.message));
  res.json({ invoice: present(updated) });
}));

router.post('/:id/void', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  if (invoice.status !== 'sent') throw Object.assign(new Error('Only unpaid sent invoices can be voided.'), { status: 409 });
  const updated = await result(client.from('invoices').update({ status: 'void', voided_at: new Date().toISOString() }).eq('id', invoice.id).select('*').single());
  await client.from('invoice_events').insert({ invoice_id: invoice.id, workspace_id: invoice.workspace_id, kind: 'void', step: '' });
  res.json({ invoice: present(updated) });
}));

router.get('/settings', wrap(async (req, res) => {
  res.json({ settings: await inv.loadSettings(db(), req.workspace.id) });
}));

router.put('/settings', wrap(async (req, res) => {
  const input = settingsInput.parse(req.body);
  const patch = { ...input, workspace_id: req.workspace.id, updated_at: new Date().toISOString() };
  if ('review_link' in input) patch.review_link = input.review_link || null;
  for (const key of ['reminder_offsets', 'checkin_offsets']) if (patch[key]) patch[key] = [...new Set(patch[key])].sort((a, b) => a - b);
  const settings = await result(db().from('invoice_settings').upsert(patch, { onConflict: 'workspace_id' }).select('*').single());
  res.json({ settings });
}));

module.exports = router;
