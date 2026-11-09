// Personalised reminders before a booking ("your yacht charter is tomorrow,
// bring your ID"). The owner sets timing rules once; AI drafts one message per
// rule for each client; the owner edits and approves; the worker sends each
// approved reminder from the workspace mailbox at its time.
//
// Singapore has no daylight saving, so local times are fixed at +08:00.

const { generateJson } = require('./gemini');
const { renderInvoiceEmail } = require('./invoiceEmail');
const { createTransport, sendEmail } = require('./smtp');
const { hasFeature } = require('./entitlements');
const { isActiveSubscription } = require('./billing');

const TIME_ZONE = 'Asia/Singapore';
const DEFAULT_RULES = [{ days_before: 1, time: '09:00' }];
const MAX_RULES = 5;

function normalizeRule(rule) {
  if (rule && Number.isInteger(rule.hours_before) && rule.hours_before >= 1 && rule.hours_before <= 72) {
    return { hours_before: rule.hours_before };
  }
  if (rule && Number.isInteger(rule.days_before) && rule.days_before >= 0 && rule.days_before <= 60
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(rule.time || ''))) {
    return { days_before: rule.days_before, time: rule.time };
  }
  return null;
}

function normalizeRules(rules) {
  const seen = new Set();
  const out = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const clean = normalizeRule(rule);
    if (!clean || seen.has(ruleKey(clean))) continue;
    seen.add(ruleKey(clean));
    out.push(clean);
  }
  return out.slice(0, MAX_RULES);
}

function ruleKey(rule) {
  return rule.hours_before ? `h${rule.hours_before}` : `d${rule.days_before}@${rule.time}`;
}

function localDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** When a rule's reminder goes out for a booking. */
function sendAtFor(bookingAt, rule) {
  const booking = new Date(bookingAt);
  if (rule.hours_before) return new Date(booking.getTime() - rule.hours_before * 3600 * 1000);
  return new Date(`${addDays(localDate(booking), -rule.days_before)}T${rule.time}:00+08:00`);
}

function describeRule(rule) {
  if (rule.hours_before) return `${rule.hours_before} hour${rule.hours_before === 1 ? '' : 's'} before`;
  const [h, m] = rule.time.split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  if (rule.days_before === 0) return `On the day at ${time}`;
  return `${rule.days_before} day${rule.days_before === 1 ? '' : 's'} before at ${time}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat('en-SG', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value)).replace(/\s?([ap])m$/i, (_, x) => ` ${x.toUpperCase()}M`);
}

function formatBooking(value) {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));
  return `${day}, ${formatTime(value)}`;
}

/** How the booking reads from the moment the reminder arrives: "tomorrow at 9:00 AM". */
function relativeWhen(bookingAt, sendAt) {
  const from = localDate(sendAt);
  const to = localDate(bookingAt);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  const time = formatTime(bookingAt);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'long' }).format(new Date(bookingAt));
  if (days < 7) return `this ${weekday} at ${time}`;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(bookingAt));
  return `on ${date} at ${time}`;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

/** Plain reminder used when AI drafting is unavailable. Still uses every fact given. */
function fallbackReminder(invoice, businessName, sendAt) {
  const title = invoice.booking_title || 'booking';
  const when = relativeWhen(invoice.booking_at, sendAt);
  const notes = String(invoice.booking_notes || '').trim();
  return {
    subject: `Reminder: your ${title} is ${when}`,
    body: [
      `Hi ${firstName(invoice.client_name)},`,
      `Just a reminder that your ${title} is ${when}. We are looking forward to seeing you.`,
      notes ? `A few things to know before you come:\n${notes}` : null,
      'If anything has changed or you have a question, just reply to this email.',
      businessName ? `See you soon,\n${businessName}` : 'See you soon',
    ].filter(Boolean).join('\n\n'),
  };
}

const DRAFT_SYSTEM = [
  'You write short, warm reminder emails from a small business to one of its customers about their upcoming booking.',
  'Each email is personal: greet the customer by first name, name their booking, say when it is in the relative form given, and turn the owner notes into practical, specific guidance (what to bring, where to meet, what to wear, when to arrive).',
  'Use only the facts provided. Never invent a location, time, price, item or policy. Do not mention payment or invoices.',
  'Plain text, no markdown or emoji, no em dashes. 50 to 120 words. Short paragraphs. If there are three or more things to bring, put them on separate lines starting with "- ".',
  'When there are several reminders for the same booking, vary them: the earlier one helps the customer prepare, the last one is brief and practical.',
  'Start the body with "Hi <first name>," and end with a short sign-off and the business name on its own line.',
  'Subjects are under 70 characters, friendly and specific, e.g. "See you tomorrow for your sunset charter".',
  'Return {"reminders":[{"rule_key":"","subject":"","body":""}]} with one entry per reminder requested, keeping each rule_key.',
].join('\n');

/**
 * Drafts one message per rule whose send time is still ahead. Returns
 * [{ rule_key, send_at, subject, body }], soonest first.
 */
async function draftReminders(invoice, rules, { businessName = '', now = new Date(), generate = generateJson } = {}) {
  if (!invoice.booking_at) throw Object.assign(new Error('Add the booking date and time first.'), { status: 400 });
  const slots = normalizeRules(rules)
    .map(rule => ({ rule, rule_key: ruleKey(rule), send_at: sendAtFor(invoice.booking_at, rule) }))
    .filter(slot => slot.send_at > now && slot.send_at < new Date(invoice.booking_at))
    .sort((a, b) => a.send_at - b.send_at);
  if (!slots.length) {
    throw Object.assign(new Error('Every reminder time for this booking has already passed. Add a rule closer to the booking, like "3 hours before".'), { status: 400 });
  }

  let drafted = {};
  try {
    const result = await generate({
      systemInstruction: DRAFT_SYSTEM,
      temperature: 0.6,
      prompt: JSON.stringify({
        business_name: businessName || null,
        customer_first_name: firstName(invoice.client_name),
        booking: invoice.booking_title || null,
        booking_starts: formatBooking(invoice.booking_at),
        owner_notes: invoice.booking_notes || null,
        reminders: slots.map(slot => ({
          rule_key: slot.rule_key,
          sent: describeRule(slot.rule),
          booking_is: relativeWhen(invoice.booking_at, slot.send_at),
        })),
      }),
    });
    for (const item of Array.isArray(result?.reminders) ? result.reminders : []) {
      const subject = String(item?.subject || '').trim();
      const body = String(item?.body || '').trim();
      if (item?.rule_key && subject && subject.length <= 140 && body.length >= 20 && body.length <= 3000) {
        drafted[item.rule_key] = { subject, body: body.replace(/—/g, ', ') };
      }
    }
  } catch (error) {
    console.warn('[booking-reminders] AI draft failed, using the plain template:', error.message);
    drafted = {};
  }

  return slots.map(slot => ({
    rule_key: slot.rule_key,
    send_at: slot.send_at.toISOString(),
    ...(drafted[slot.rule_key] || fallbackReminder(invoice, businessName, slot.send_at)),
  }));
}

/** The email for one reminder, in the CircleOn invoice email design. */
function composeBookingEmail(reminder, invoice, businessName) {
  const paragraphs = String(reminder.body).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  // The booking card sits between the message and the sign-off.
  const greeting = /^(hi|hello|dear|hey)\b/i.test(paragraphs[0] || '') ? paragraphs.shift() : '';
  const signoff = paragraphs.length > 1 ? paragraphs.pop() : '';
  return {
    subject: reminder.subject,
    body: reminder.body,
    html: renderInvoiceEmail({
      title: reminder.subject,
      kicker: 'Booking reminder',
      businessName,
      greeting,
      paragraphs,
      signoff,
      items: [],
      booking: { title: invoice.booking_title || 'Your booking', when: formatBooking(invoice.booking_at) },
    }),
  };
}

function fromHeader(account) {
  return account.from_name ? `"${account.from_name.replace(/"/g, '\\"')}" <${account.from_email}>` : account.from_email;
}

/** Sends every approved reminder that is due. Returns { sent }. */
async function runBookingReminders(db, { now = new Date(), log = console } = {}) {
  const { data: due, error } = await db.from('invoice_booking_reminders').select('*')
    .eq('status', 'scheduled').lte('send_at', now.toISOString()).order('send_at').limit(200);
  if (error) throw error;
  if (!due?.length) return { sent: 0 };

  const ids = [...new Set(due.map(r => r.invoice_id))];
  const { data: invoices, error: invoiceError } = await db.from('invoices').select('*').in('id', ids);
  if (invoiceError) throw invoiceError;
  const invoiceById = new Map((invoices || []).map(i => [i.id, i]));
  const workspaces = new Map();
  let sent = 0;

  for (const reminder of due) {
    const invoice = invoiceById.get(reminder.invoice_id);
    const cancel = reason => db.from('invoice_booking_reminders').update({ status: 'cancelled', error: reason }).eq('id', reminder.id).eq('status', 'scheduled');
    if (!invoice || invoice.status === 'void' || !invoice.booking_at) { await cancel('The invoice was voided or has no booking.'); continue; }
    if (new Date(invoice.booking_at) <= now) { await cancel('The booking had already started.'); continue; }

    let ws = workspaces.get(reminder.workspace_id);
    if (!ws) {
      ws = { ok: false };
      try {
        const { data: billing } = await db.from('workspace_billing').select('*').eq('workspace_id', reminder.workspace_id).maybeSingle();
        const { data: settings } = await db.from('invoice_settings').select('booking_reminders_enabled').eq('workspace_id', reminder.workspace_id).maybeSingle();
        if (isActiveSubscription(billing) && hasFeature(billing.plan, 'invoices') && settings?.booking_reminders_enabled !== false) {
          const { data: account } = await db.from('connected_accounts').select('*')
            .eq('workspace_id', reminder.workspace_id).eq('provider', 'smtp').eq('status', 'connected')
            .not('smtp_verified_at', 'is', null).maybeSingle();
          const { data: workspace } = await db.from('workspaces').select('name').eq('id', reminder.workspace_id).maybeSingle();
          if (account) ws = { ok: true, account, transport: createTransport(account), businessName: account.from_name || workspace?.name || '' };
        }
      } catch (lookupError) {
        log.error('[booking-reminders] workspace lookup failed', reminder.workspace_id, lookupError.message);
      }
      workspaces.set(reminder.workspace_id, ws);
    }
    // No active plan or mailbox: leave it scheduled so it goes out once fixed.
    if (!ws.ok) continue;

    const { data: claimed } = await db.from('invoice_booking_reminders').update({ status: 'sending' })
      .eq('id', reminder.id).eq('status', 'scheduled').select('id').maybeSingle();
    if (!claimed) continue;
    try {
      const content = composeBookingEmail(reminder, invoice, ws.businessName);
      const result = await sendEmail({ transport: ws.transport, from: fromHeader(ws.account), to: invoice.client_email, subject: content.subject, body: content.body, html: content.html });
      await db.from('invoice_booking_reminders').update({ status: 'sent', sent_at: new Date().toISOString(), message_id: result.messageId, error: null }).eq('id', reminder.id);
      await db.from('invoice_events').insert({ invoice_id: invoice.id, workspace_id: invoice.workspace_id, kind: 'booking', step: reminder.rule_key, subject: content.subject, message_id: result.messageId });
      sent++;
    } catch (sendError) {
      await db.from('invoice_booking_reminders').update({ status: 'failed', error: String(sendError.message || sendError).slice(0, 500) }).eq('id', reminder.id);
      log.error('[booking-reminders] send failed', reminder.id, sendError.message);
    }
  }
  return { sent };
}

module.exports = {
  DEFAULT_RULES,
  normalizeRules,
  ruleKey,
  sendAtFor,
  describeRule,
  relativeWhen,
  formatBooking,
  draftReminders,
  composeBookingEmail,
  runBookingReminders,
};
