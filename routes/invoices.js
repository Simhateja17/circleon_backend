const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { requireFeature } = require('../lib/entitlements');
const { createServiceClient } = require('../lib/supabase');
const { createTransport } = require('../lib/smtp');
const crypto = require('crypto');
const inv = require('../lib/invoices');
const booking = require('../lib/bookingReminders');
const { extractInvoiceFields } = require('../lib/gemini');

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

const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
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
  line_items: z.array(lineItem).max(50).optional(),
  // Used when the invoice was uploaded and has no itemised lines, in major units.
  amount: z.number().min(0).max(1e9).optional(),
  file_path: z.string().max(500).nullable().optional(),
  file_name: z.string().trim().max(200).nullable().optional(),
  file_mime: z.enum(FILE_TYPES).nullable().optional(),
  booking_at: z.string().datetime({ offset: true }).nullable().optional(),
  booking_title: z.string().trim().max(120).nullable().optional(),
  booking_notes: z.string().trim().max(2000).nullable().optional(),
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
  booking_reminders_enabled: z.boolean().optional(),
  booking_rules: z.array(z.union([
    z.object({ days_before: z.number().int().min(0).max(60), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times are HH:MM.') }).strict(),
    z.object({ hours_before: z.number().int().min(1).max(72) }).strict(),
  ])).max(5, 'Up to five booking reminders.').optional(),
});

function present(invoice, events = [], bookingReminders = []) {
  return { ...invoice, display_status: inv.invoiceStatus(invoice), events, booking_reminders: bookingReminders };
}

/** Amount, line items and file fields shared by create and edit. */
function moneyAndFile(input, workspaceId) {
  const patch = {};
  if (input.line_items && input.line_items.length) patch.amount_cents = inv.lineItemsTotal(input.line_items);
  else if (input.amount !== undefined) patch.amount_cents = Math.round(input.amount * 100);
  if (input.file_path && !input.file_path.startsWith(`${workspaceId}/`)) {
    throw Object.assign(new Error('That invoice file does not belong to this workspace.'), { status: 400 });
  }
  return patch;
}

function withoutAmount({ amount, ...rest }) {
  return rest;
}

async function loadBookingReminders(client, invoiceIds) {
  if (!invoiceIds.length) return [];
  return result(client.from('invoice_booking_reminders').select('id,invoice_id,rule_key,send_at,subject,body,status,sent_at,error').in('invoice_id', invoiceIds).order('send_at'));
}

// Unsent reminders were written for the old booking time, so they are dropped
// when the booking moves and the owner drafts new ones.
async function dropUnsentBookingReminders(client, invoiceId) {
  await result(client.from('invoice_booking_reminders').delete().eq('invoice_id', invoiceId).in('status', ['draft', 'scheduled', 'failed']));
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
  const reminders = await loadBookingReminders(client, invoices.map(i => i.id));
  const list = invoices.map(i => present(i, events.filter(e => e.invoice_id === i.id), reminders.filter(r => r.invoice_id === i.id)));
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
  const money = moneyAndFile(input, req.workspace.id);
  if (money.amount_cents === undefined) throw Object.assign(new Error('Enter the invoice amount.'), { status: 400 });
  const invoice = await result(client.from('invoices').insert({
    ...withoutAmount(input),
    ...money,
    line_items: input.line_items || [],
    workspace_id: req.workspace.id,
    number: input.number || await nextNumber(client, req.workspace.id),
    issue_date: issue,
    payment_link: input.payment_link || null,
  }).select('*').single());
  res.status(201).json({ invoice: present(invoice) });
}));

// Only drafts can be edited; a sent invoice is a record the client already has.
router.patch('/:id', wrap(async (req, res) => {
  const client = db();
  const current = await loadInvoice(client, req.workspace.id, req.params.id);
  // After sending, only the reminder switches and the booking can change: the
  // booking is the customer's appointment, which can move after they have paid.
  const afterSend = z.object({
    reminders_enabled: z.boolean().optional(),
    checkins_enabled: z.boolean().optional(),
    booking_at: invoiceInput.shape.booking_at,
    booking_title: invoiceInput.shape.booking_title,
    booking_notes: invoiceInput.shape.booking_notes,
  }).strict();
  let patch;
  if (current.status === 'draft') {
    const input = invoiceInput.partial().parse(req.body);
    patch = { ...withoutAmount(input), ...moneyAndFile(input, req.workspace.id), ...('payment_link' in input ? { payment_link: input.payment_link || null } : {}) };
  } else if (current.status === 'void') {
    throw Object.assign(new Error('A void invoice cannot be changed.'), { status: 409 });
  } else {
    patch = afterSend.parse(req.body);
  }
  const bookingMoved = 'booking_at' in patch && String(patch.booking_at || '') !== String(current.booking_at || '')
    && new Date(patch.booking_at || 0).getTime() !== new Date(current.booking_at || 0).getTime();
  const invoice = await result(client.from('invoices').update(patch).eq('workspace_id', req.workspace.id).eq('id', current.id).select('*').single());
  if (bookingMoved) await dropUnsentBookingReminders(client, current.id);
  res.json({ invoice: present(invoice, [], await loadBookingReminders(client, [current.id])), booking_reminders_reset: bookingMoved });
}));

router.delete('/:id', wrap(async (req, res) => {
  const client = db();
  const current = await loadInvoice(client, req.workspace.id, req.params.id);
  if (current.status !== 'draft') throw Object.assign(new Error('Only drafts can be deleted. Void a sent invoice instead.'), { status: 409 });
  await result(client.from('invoices').delete().eq('workspace_id', req.workspace.id).eq('id', current.id));
  if (current.file_path) await client.storage.from(inv.INVOICE_BUCKET).remove([current.file_path]).catch(() => {});
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
  await client.from('invoice_booking_reminders').update({ status: 'cancelled', error: 'The invoice was voided.' }).eq('invoice_id', invoice.id).in('status', ['draft', 'scheduled']);
  res.json({ invoice: present(updated) });
}));

// ---------------------------------------------------------------------------
// Uploaded invoices
// ---------------------------------------------------------------------------

const uploadInput = z.object({
  filename: z.string().trim().min(1).max(200),
  mime_type: z.enum(FILE_TYPES, { message: 'Upload a PDF, PNG, JPEG or WebP file.' }),
  size_bytes: z.number().int().positive().max(MAX_FILE_BYTES, 'Invoice files can be up to 10 MB.'),
  content_base64: z.string().min(1),
});

const cleanText = value => (typeof value === 'string' ? value.trim() : '');
const cleanDate = value => (/^\d{4}-\d{2}-\d{2}$/.test(cleanText(value)) ? cleanText(value) : '');

/** What the AI read, reduced to the fields the form uses. Anything doubtful is left blank. */
function extractedFields(raw = {}) {
  const email = cleanText(raw.client_email);
  const total = Number(raw.total);
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(cleanText(raw.booking_time)) ? cleanText(raw.booking_time).padStart(5, '0') : '';
  const items = (Array.isArray(raw.line_items) ? raw.line_items : []).map(item => ({
    description: cleanText(item?.description).slice(0, 300),
    quantity: Number(item?.quantity) > 0 ? Number(item.quantity) : 1,
    unit_cents: Math.round(Number(item?.unit_price || 0) * 100),
  })).filter(item => item.description && Number.isFinite(item.unit_cents) && item.unit_cents >= 0).slice(0, 50);
  const itemsTotal = inv.lineItemsTotal(items);
  const totalCents = Number.isFinite(total) && total > 0 ? Math.round(total * 100) : itemsTotal;
  return {
    client_name: cleanText(raw.client_name).slice(0, 200),
    client_email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 320) : '',
    number: cleanText(raw.invoice_number).slice(0, 40),
    currency: /^[A-Z]{3}$/.test(cleanText(raw.currency).toUpperCase()) ? cleanText(raw.currency).toUpperCase() : 'SGD',
    amount: totalCents ? totalCents / 100 : null,
    issue_date: cleanDate(raw.issue_date),
    due_date: cleanDate(raw.due_date),
    booking_date: cleanDate(raw.booking_date),
    booking_time: time,
    booking_title: cleanText(raw.booking_title).slice(0, 120),
    // Only keep the itemised lines when they add up to the total, so the email
    // never shows a table that disagrees with the amount due.
    line_items: items.length && itemsTotal === totalCents ? items : [],
  };
}

router.post('/extract', wrap(async (req, res) => {
  const client = db();
  const file = uploadInput.parse(req.body);
  const buffer = Buffer.from(file.content_base64, 'base64');
  if (buffer.length !== file.size_bytes) throw Object.assign(new Error('The upload was incomplete. Try again.'), { status: 400 });
  const safe = file.filename.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120);
  const path = `${req.workspace.id}/${crypto.randomUUID()}-${safe}`;
  const { error: uploadError } = await client.storage.from(inv.INVOICE_BUCKET).upload(path, buffer, { contentType: file.mime_type, upsert: false });
  if (uploadError) throw Object.assign(new Error(`Could not store the invoice: ${uploadError.message}`), { status: 500 });
  let fields = null;
  let warning = null;
  try {
    fields = extractedFields(await extractInvoiceFields({ filename: file.filename, mimeType: file.mime_type, contentBase64: file.content_base64 }));
  } catch (error) {
    console.warn('[invoices] could not read uploaded invoice', error.message);
    warning = 'We saved your file but could not read it automatically. Fill in the details below.';
  }
  res.json({ file: { path, name: file.filename, mime: file.mime_type }, fields, warning });
}));

router.get('/:id/file', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  if (!invoice.file_path) throw Object.assign(new Error('This invoice has no uploaded file.'), { status: 404 });
  const { data, error } = await client.storage.from(inv.INVOICE_BUCKET).createSignedUrl(invoice.file_path, 600);
  if (error) throw error;
  res.json({ url: data.signedUrl });
}));

// ---------------------------------------------------------------------------
// Booking reminders
// ---------------------------------------------------------------------------

async function businessNameFor(client, workspace) {
  const { data } = await client.from('connected_accounts').select('from_name').eq('workspace_id', workspace.id).eq('provider', 'smtp').eq('status', 'connected').maybeSingle();
  return data?.from_name || workspace.name || '';
}

router.post('/:id/booking-reminders/draft', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  if (invoice.status === 'void') throw Object.assign(new Error('This invoice is void.'), { status: 409 });
  const input = z.object({ booking_notes: invoiceInput.shape.booking_notes }).parse(req.body || {});
  if ('booking_notes' in input) {
    await result(client.from('invoices').update({ booking_notes: input.booking_notes || null }).eq('id', invoice.id));
    invoice.booking_notes = input.booking_notes || null;
  }
  const settings = await inv.loadSettings(client, req.workspace.id);
  const drafts = await booking.draftReminders(invoice, settings.booking_rules, { businessName: await businessNameFor(client, req.workspace) });
  // Redrafting replaces anything not yet sent; sent reminders stay on record.
  const existing = await loadBookingReminders(client, [invoice.id]);
  const sentKeys = new Set(existing.filter(r => ['sent', 'sending'].includes(r.status)).map(r => r.rule_key));
  await dropUnsentBookingReminders(client, invoice.id);
  const rows = drafts.filter(d => !sentKeys.has(d.rule_key)).map(d => ({ ...d, invoice_id: invoice.id, workspace_id: req.workspace.id, status: 'draft', error: null }));
  if (rows.length) await result(client.from('invoice_booking_reminders').upsert(rows, { onConflict: 'invoice_id,rule_key' }));
  res.json({ booking_reminders: await loadBookingReminders(client, [invoice.id]) });
}));

router.patch('/:id/booking-reminders/:reminderId', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  const input = z.object({
    subject: z.string().trim().min(1, 'Add a subject.').max(140),
    body: z.string().trim().min(20, 'The message is too short.').max(3000),
  }).parse(req.body);
  const updated = await result(client.from('invoice_booking_reminders').update(input)
    .eq('id', req.params.reminderId).eq('invoice_id', invoice.id).in('status', ['draft', 'scheduled', 'failed']).select('id').maybeSingle());
  if (!updated) throw Object.assign(new Error('This reminder has already been sent.'), { status: 409 });
  res.json({ booking_reminders: await loadBookingReminders(client, [invoice.id]) });
}));

router.post('/:id/booking-reminders/approve', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  if (invoice.status === 'void') throw Object.assign(new Error('This invoice is void.'), { status: 409 });
  const now = new Date().toISOString();
  // A draft whose time passed while it waited for approval is not sent late.
  await result(client.from('invoice_booking_reminders').update({ status: 'cancelled', error: 'Its send time passed before it was approved.' })
    .eq('invoice_id', invoice.id).in('status', ['draft', 'failed']).lte('send_at', now));
  await result(client.from('invoice_booking_reminders').update({ status: 'scheduled', error: null })
    .eq('invoice_id', invoice.id).in('status', ['draft', 'failed']).gt('send_at', now));
  res.json({ booking_reminders: await loadBookingReminders(client, [invoice.id]) });
}));

router.post('/:id/booking-reminders/:reminderId/cancel', wrap(async (req, res) => {
  const client = db();
  const invoice = await loadInvoice(client, req.workspace.id, req.params.id);
  await result(client.from('invoice_booking_reminders').update({ status: 'cancelled', error: null })
    .eq('id', req.params.reminderId).eq('invoice_id', invoice.id).in('status', ['draft', 'scheduled', 'failed']));
  res.json({ booking_reminders: await loadBookingReminders(client, [invoice.id]) });
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
