// HTML for invoice, reminder and check-in emails, in the CircleOn workspace
// theme (frontend circleon.css, "Dashboard redesign" tokens): violet and gold
// on paper, Cormorant Garamond headings, DM Sans text, DM Mono kickers,
// 20px cards, pill buttons, and the dark ink-to-violet card from the sidebar.
//
// Email clients ignore CSS variables and most <style> rules, so every style is
// inline and the layout is tables. Web fonts load where the client allows it
// (Apple Mail, iOS); elsewhere the stacks fall back to Georgia and Arial.
// The business sending the invoice leads; CircleOn only appears in the footer.

const T = {
  brand: '#7447C8',
  brandDeep: '#5B32A8',
  brandInk: '#471E86',
  brandWash: '#F1EAFF',
  ink: '#1A172C',
  inkSoft: '#423F54',
  inkMute: '#5E5A72',
  rule: '#E3DFF0',
  ruleSoft: '#EEEAF8',
  paper: '#F7F5FC',
  surface: '#FFFFFF',
  gold: '#DBB557',
  goldInk: '#805F2B',
  goldWash: '#F6EBD3',
  greenWash: '#DCFCE7',
  green: '#15803D',
  redWash: '#FDECEC',
  red: '#B44C4C',
  darkFrom: '#1A172C',
  darkTo: '#33245A',
};
const SANS = "'DM Sans',Arial,Helvetica,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
const MONO = "'DM Mono',ui-monospace,Menlo,Consolas,monospace";
const FONTS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=DM+Mono:wght@500&family=DM+Sans:wght@400;500;700&display=swap';

const TONES = {
  neutral: [T.brandWash, T.brandInk],
  warn: [T.goldWash, T.goldInk],
  danger: [T.redWash, T.red],
  success: [T.greenWash, T.green],
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function kicker(text, color = T.goldInk) {
  return `<div style="font-family:${MONO};font-size:11px;font-weight:500;line-height:16px;letter-spacing:.14em;text-transform:uppercase;color:${color};">${esc(text)}</div>`;
}

function paragraphs(list) {
  return list.filter(Boolean).map(text =>
    `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:25px;color:${T.inkSoft};">${esc(text).replace(/\n/g, '<br>')}</p>`).join('');
}

function pill(text, tone) {
  const [bg, fg] = TONES[tone] || TONES.neutral;
  return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:99px;padding:5px 12px;font-family:${SANS};font-size:12px;font-weight:700;line-height:16px;">${esc(text)}</span>`;
}

function button(text, url) {
  const href = safeUrl(url);
  if (!href) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 28px;"><tr><td style="background:${T.brand};border-radius:99px;box-shadow:0 10px 26px rgba(116,71,200,.3);"><a href="${esc(href)}" style="display:inline-block;padding:13px 24px;font-family:${SANS};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:99px;">${esc(text)}&nbsp; &rarr;</a></td></tr></table>`;
}

/** The amount, status and key dates, on the dark card from the workspace sidebar. */
function summaryCard(view) {
  const facts = [
    ['Invoice', view.number],
    ['Issued', view.issued],
    [view.paid ? 'Paid on' : 'Due', view.paid || view.due],
  ].filter(([, value]) => value);
  const cells = facts.map(([name, value]) =>
    `<td valign="top" style="padding:18px 14px 0 0;">${kicker(name, T.gold)}<div style="font-family:${SANS};font-size:14px;font-weight:500;line-height:22px;color:#FFFFFF;margin-top:2px;">${esc(value)}</div></td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:${T.darkFrom};background-image:linear-gradient(140deg,${T.darkFrom},${T.darkTo});border-radius:20px;margin:6px 0 24px;">
    <tr><td style="padding:24px 26px 24px;">
      ${kicker(view.amountLabel, T.gold)}
      <div style="font-family:${SERIF};font-size:44px;font-weight:500;line-height:50px;letter-spacing:-.02em;color:#FFFFFF;margin:6px 0 12px;">${esc(view.amount)}</div>
      ${view.status ? pill(view.status.text, view.status.tone) : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>
    </td></tr>
  </table>`;
}

function lineItemsTable(view) {
  if (!view.items.length) return '';
  const head = (text, align) => `<td align="${align}" style="padding:0 0 10px;border-bottom:1px solid ${T.rule};font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:${T.inkMute};">${text}</td>`;
  const cell = (text, align, extra = '') => `<td align="${align}" valign="top" style="padding:13px 0;border-bottom:1px solid ${T.ruleSoft};font-family:${SANS};font-size:14px;line-height:21px;color:${T.ink};${extra}">${esc(text)}</td>`;
  const rows = view.items.map(item =>
    `<tr>${cell(item.description, 'left', 'padding-right:12px;')}${cell(item.quantity, 'right', `color:${T.inkMute};padding-right:16px;white-space:nowrap;`)}${cell(item.amount, 'right', 'font-weight:500;white-space:nowrap;')}</tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:${T.surface};border:1px solid ${T.rule};border-radius:20px;margin:0 0 24px;">
    <tr><td style="padding:20px 22px 18px;">
      <div style="font-family:${SERIF};font-size:24px;font-weight:500;line-height:30px;color:${T.ink};margin:0 0 14px;">Summary</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>${head('Item', 'left')}${head('Qty', 'right')}${head('Amount', 'right')}</tr>
        ${rows}
        <tr>
          <td colspan="2" align="right" style="padding:16px 16px 0 0;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:${T.inkMute};">Total</td>
          <td align="right" style="padding:12px 0 0;font-family:${SERIF};font-size:26px;font-weight:600;line-height:30px;color:${T.brandInk};white-space:nowrap;">${esc(view.total || (view.card && view.card.amount))}</td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}

function infoBox(title, content) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:${T.paper};border:1px solid ${T.ruleSoft};border-radius:14px;margin:0 0 16px;"><tr><td style="padding:14px 18px;">
    ${kicker(title, T.inkMute)}
    <div style="font-family:${SANS};font-size:14px;line-height:22px;color:${T.ink};margin-top:4px;">${content}</div>
  </td></tr></table>`;
}

/**
 * view: { title, kicker, businessName, greeting, paragraphs[], signoff,
 *   card?: { amount, amountLabel, status, number, issued, due, paid },
 *   items[], notes, cta?: { text, url }, billedTo? }
 */
function renderInvoiceEmail(view) {
  const business = view.businessName || 'Your invoice';
  const initial = (view.businessName || '').trim().charAt(0).toUpperCase();
  const billedTo = view.billedTo
    ? infoBox('Billed to', `${esc(view.billedTo.name)}${view.billedTo.email ? `<br><span style="color:${T.inkMute};">${esc(view.billedTo.email)}</span>` : ''}`)
    : '';
  const notes = view.notes ? infoBox('Note', esc(view.notes).replace(/\n/g, '<br>')) : '';
  const monogram = initial
    ? `<td width="56" valign="middle"><div style="width:44px;height:44px;border-radius:13px;background:${T.brandDeep};background-image:linear-gradient(135deg,${T.brand},${T.brandInk});text-align:center;font-family:${SERIF};font-size:24px;font-weight:600;line-height:44px;color:#FFFFFF;">${esc(initial)}</div></td>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(view.title)}</title><link href="${FONTS}" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${T.paper};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${T.paper};"><tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background:${T.surface};border:1px solid ${T.rule};border-radius:24px;">
    <tr><td style="padding:30px 32px 22px;border-bottom:1px solid ${T.ruleSoft};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${monogram}
        <td valign="middle">
          ${kicker(view.kicker)}
          <div style="font-family:${SERIF};font-size:32px;font-weight:500;line-height:36px;letter-spacing:-.02em;color:${T.ink};margin-top:4px;">${esc(business)}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 10px;">
      ${paragraphs([view.greeting])}
      ${paragraphs(view.paragraphs)}
      ${view.card ? summaryCard(view.card) : ''}
      ${view.cta ? button(view.cta.text, view.cta.url) : ''}
      ${lineItemsTable(view)}
      ${billedTo}
      ${notes}
      <div style="height:8px;line-height:8px;font-size:8px;">&nbsp;</div>
      ${paragraphs([view.signoff])}
    </td></tr>
    <tr><td style="padding:18px 32px 22px;background:${T.paper};border-top:1px solid ${T.ruleSoft};border-radius:0 0 24px 24px;">
      <div style="font-family:${SANS};font-size:12px;line-height:19px;color:${T.inkMute};">Questions about this ${view.card ? 'invoice' : 'email'}? Just reply and ${esc(view.businessName || 'we')} will get back to you.</div>
      <div style="font-family:${MONO};font-size:10.5px;font-weight:500;line-height:18px;letter-spacing:.12em;text-transform:uppercase;color:${T.inkMute};margin-top:10px;">Sent with <span style="color:${T.brandInk};font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0;text-transform:none;">CircleOn</span></div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

module.exports = { renderInvoiceEmail, safeUrl };
