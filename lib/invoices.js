// Invoice sending, payment reminders and post-sale check-ins.
//
// Reminders run off the due date (negative offsets are "due in N days"), and
// check-ins off the payment date. Every email is recorded in invoice_events
// under a unique (invoice, kind, step) key before it is sent, so a step goes
// out at most once even if two workers overlap.
const { createTransport, sendEmail, textToHtml } = require('./smtp');
const { hasFeature } = require('./entitlements');
const { isActiveSubscription } = require('./billing');

const TIME_ZONE = 'Asia/Singapore';
const DEFAULT_SETTINGS = {
  reminder_offsets: [-3, 0, 3, 7, 14],
  checkin_offsets: [0, 7, 30],
  reminders_enabled: true,
  checkins_enabled: true,
  review_link: null,
};
// Two follow-up emails about one invoice never go out within this gap.
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

function localDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function daysBetween(fromDate, toDate) {
  const [a, b] = [fromDate, toDate].map(d => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day); });
  return Math.round((b - a) / 86400000);
}

/** draft | sent | overdue | paid | void. Overdue is a sent invoice past its due date. */
function invoiceStatus(invoice, now = new Date()) {
  if (invoice.status === 'sent' && daysBetween(invoice.due_date, localDate(now)) > 0) return 'overdue';
  return invoice.status;
}

function formatMoney(cents, currency = 'SGD') {
  return new Intl.NumberFormat('en-SG', { style: 'currency', currency }).format(Number(cents || 0) / 100);
}

function lineItemsTotal(items) {
  return items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * Number(item.unit_cents)), 0);
}

function stepKey(offset) {
  return `d${offset}`;
}

/**
 * The follow-up email this invoice needs now, or null. Only the latest due step
 * is sent: if a workspace turns reminders on late, the customer gets one
 * reminder, not every reminder they missed.
 */
function nextFollowUp(invoice, settings, events, now = new Date()) {
  const config = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const today = localDate(now);
  const recent = events.some(e => ['invoice', 'reminder', 'checkin'].includes(e.kind) && now - new Date(e.created_at) < MIN_GAP_MS);
  if (recent) return null;

  let kind, anchor, offsets;
  if (invoice.status === 'sent' && config.reminders_enabled && invoice.reminders_enabled) {
    kind = 'reminder'; anchor = invoice.due_date; offsets = config.reminder_offsets;
  } else if (invoice.status === 'paid' && invoice.paid_at && config.checkins_enabled && invoice.checkins_enabled) {
    kind = 'checkin'; anchor = localDate(invoice.paid_at); offsets = config.checkin_offsets;
  } else {
    return null;
  }

  const elapsed = daysBetween(anchor, today);
  const due = [...offsets].filter(o => o <= elapsed).sort((a, b) => a - b);
  if (!due.length) return null;
  const latest = due[due.length - 1];
  const sentOffsets = events.filter(e => e.kind === kind).map(e => Number(e.step.slice(1)));
  if (sentOffsets.some(o => o >= latest)) return null;
  // A reminder dated before the invoice went out is pointless; skip it.
  if (kind === 'reminder' && invoice.sent_at && daysBetween(localDate(invoice.sent_at), addDays(anchor, latest)) < 0) return null;
  return { kind, offset: latest, step: stepKey(latest) };
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function invoiceSummary(invoice) {
  const lines = (invoice.line_items || []).map(item => `- ${item.description}: ${item.quantity} x ${formatMoney(item.unit_cents, invoice.currency)}`);
  return [
    `Invoice ${invoice.number}`,
    ...lines,
    `Total: ${formatMoney(invoice.amount_cents, invoice.currency)}`,
    `Due: ${invoice.due_date}`,
    invoice.payment_link ? `Pay here: ${invoice.payment_link}` : null,
  ].filter(Boolean).join('\n');
}

/** Subject and plain-text body for every email this feature sends. */
function composeEmail(kind, invoice, { offset = 0, businessName = '', reviewLink = null } = {}) {
  const hi = `Hi ${firstName(invoice.client_name)},`;
  const sign = businessName ? `\n\nThanks,\n${businessName}` : '\n\nThanks';
  const amount = formatMoney(invoice.amount_cents, invoice.currency);

  if (kind === 'invoice') {
    return {
      subject: `Invoice ${invoice.number} from ${businessName || 'us'}: ${amount} due ${invoice.due_date}`,
      body: `${hi}\n\nThank you for your business. Your invoice is below.\n\n${invoiceSummary(invoice)}${invoice.notes ? `\n\n${invoice.notes}` : ''}${sign}`,
    };
  }
  if (kind === 'reminder') {
    const when = offset < 0 ? `is due in ${-offset} day${offset === -1 ? '' : 's'}` : offset === 0 ? 'is due today' : `was due ${offset} day${offset === 1 ? '' : 's'} ago`;
    const ask = offset <= 0 ? 'This is a friendly reminder.' : 'We have not received payment yet. If you have already paid, please ignore this email and accept our thanks.';
    return {
      subject: offset > 0 ? `Overdue: invoice ${invoice.number} (${amount})` : `Reminder: invoice ${invoice.number} ${when}`,
      body: `${hi}\n\nInvoice ${invoice.number} for ${amount} ${when}. ${ask}\n\n${invoiceSummary(invoice)}${sign}`,
    };
  }
  // Post-sale check-ins: thank-you on payment, then onboarding, then feedback.
  if (offset <= 0) {
    return {
      subject: `Payment received for invoice ${invoice.number}, thank you`,
      body: `${hi}\n\nWe have received your payment of ${amount} for invoice ${invoice.number}. Thank you.\n\nIf there is anything you need from us to get started, just reply to this email.${sign}`,
    };
  }
  if (offset <= 14) {
    return {
      subject: 'Checking in: how is everything going?',
      body: `${hi}\n\nIt has been about ${offset} days since you got started with us. How is everything going so far? If you have any questions or anything is not working as expected, reply here and we will help.${sign}`,
    };
  }
  return {
    subject: 'Quick question about your experience',
    body: `${hi}\n\nWe hope you are happy with the work. Would you share how it has gone for you?${reviewLink ? `\n\nIf you have a minute, a short review would mean a lot: ${reviewLink}` : ''}\n\nAnd if you know someone who could use the same help, we would be grateful for an introduction.${sign}`,
  };
}

async function loadSmtpAccount(db, workspaceId) {
  const { data, error } = await db.from('connected_accounts').select('*')
    .eq('workspace_id', workspaceId).eq('provider', 'smtp').eq('status', 'connected')
    .not('smtp_verified_at', 'is', null).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Connect a verified mailbox before sending invoices.'), { status: 409 });
  return data;
}

function fromHeader(account) {
  return account.from_name ? `"${account.from_name.replace(/"/g, '\\"')}" <${account.from_email}>` : account.from_email;
}

/**
 * Claims the event key, sends, and records the result. Returns false when the
 * step was already claimed. A failed send releases the claim so it retries.
 */
async function sendInvoiceEmail(db, invoice, kind, step, content, { transport, account }) {
  const { data: claimed, error: claimError } = await db.from('invoice_events')
    .insert({ invoice_id: invoice.id, workspace_id: invoice.workspace_id, kind, step, subject: content.subject })
    .select('id').maybeSingle();
  if (claimError) {
    if (claimError.code === '23505') return false;
    throw claimError;
  }
  try {
    const result = await sendEmail({
      transport,
      from: fromHeader(account),
      to: invoice.client_email,
      subject: content.subject,
      body: content.body,
      html: textToHtml(content.body),
    });
    await db.from('invoice_events').update({ message_id: result.messageId }).eq('id', claimed.id);
    if (invoice.last_error) await db.from('invoices').update({ last_error: null }).eq('id', invoice.id);
    return true;
  } catch (error) {
    await db.from('invoice_events').delete().eq('id', claimed.id);
    await db.from('invoices').update({ last_error: String(error.message || error).slice(0, 500) }).eq('id', invoice.id);
    throw error;
  }
}

async function loadSettings(db, workspaceId) {
  const { data, error } = await db.from('invoice_settings').select('*').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...(data || {}) };
}

/** Sends whatever follow-up one invoice needs now. Returns the step sent, or null. */
async function followUpInvoice(db, invoice, { settings, events, account, transport, businessName, now = new Date() }) {
  const next = nextFollowUp(invoice, settings, events, now);
  if (!next) return null;
  const content = composeEmail(next.kind, invoice, { offset: next.offset, businessName, reviewLink: settings.review_link });
  const sent = await sendInvoiceEmail(db, invoice, next.kind, next.step, content, { account, transport });
  return sent ? next : null;
}

/** One pass over every sent or paid invoice in workspaces whose plan includes invoicing. */
async function runInvoiceFollowUps(db, { now = new Date(), log = console } = {}) {
  const since = new Date(now.getTime() - 400 * 86400000).toISOString();
  const { data: invoices, error } = await db.from('invoices').select('*')
    .or(`status.eq.sent,and(status.eq.paid,paid_at.gte.${since})`).limit(5000);
  if (error) throw error;
  const byWorkspace = new Map();
  for (const invoice of invoices || []) {
    if (!byWorkspace.has(invoice.workspace_id)) byWorkspace.set(invoice.workspace_id, []);
    byWorkspace.get(invoice.workspace_id).push(invoice);
  }

  let sent = 0;
  for (const [workspaceId, list] of byWorkspace) {
    try {
      const { data: billing } = await db.from('workspace_billing').select('*').eq('workspace_id', workspaceId).maybeSingle();
      if (!isActiveSubscription(billing) || !hasFeature(billing.plan, 'invoices')) continue;
      const settings = await loadSettings(db, workspaceId);
      const { data: workspace } = await db.from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
      const { data: events } = await db.from('invoice_events').select('invoice_id,kind,step,created_at').in('invoice_id', list.map(i => i.id));
      let account = null, transport = null;
      for (const invoice of list) {
        const invoiceEvents = (events || []).filter(e => e.invoice_id === invoice.id);
        if (!nextFollowUp(invoice, settings, invoiceEvents, now)) continue;
        if (!account) { account = await loadSmtpAccount(db, workspaceId); transport = createTransport(account); }
        try {
          if (await followUpInvoice(db, invoice, { settings, events: invoiceEvents, account, transport, businessName: account.from_name || workspace?.name, now })) sent++;
        } catch (sendError) {
          log.error('[invoice-followups] send failed', invoice.id, sendError.message);
        }
      }
    } catch (workspaceError) {
      log.error('[invoice-followups] workspace failed', workspaceId, workspaceError.message);
    }
  }
  return { sent };
}

module.exports = {
  DEFAULT_SETTINGS,
  localDate,
  daysBetween,
  invoiceStatus,
  formatMoney,
  lineItemsTotal,
  nextFollowUp,
  composeEmail,
  loadSmtpAccount,
  loadSettings,
  sendInvoiceEmail,
  followUpInvoice,
  runInvoiceFollowUps,
};
