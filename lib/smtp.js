const nodemailer = require('nodemailer');
const { decrypt } = require('./crypto');

function booleanFromPort(port) {
  return Number(port) === 465;
}

function createTransport(account) {
  if (!account) {
    throw new Error('Connected email account is required');
  }

  return nodemailer.createTransport({
    host: account.smtp_host,
    port: Number(account.smtp_port),
    secure: booleanFromPort(account.smtp_port),
    auth: {
      user: account.smtp_username,
      pass: decrypt(account.smtp_password_encrypted),
    },
  });
}

async function testConnection(account) {
  const transport = createTransport(account);
  await transport.verify();
  return true;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtml(body) {
  return escapeHtml(body).replace(/\n/g, '<br>');
}

async function sendEmail({ transport, from, to, subject, body, html, replyTo }) {
  const result = await transport.sendMail({
    from,
    to,
    subject,
    text: body,
    html,
    replyTo,
  });

  return {
    messageId: result.messageId,
    response: result.response,
  };
}

function trackingPixelHtml(messageId) {
  const baseUrl = process.env.APP_PUBLIC_URL || process.env.API_PUBLIC_URL;
  if (!baseUrl || !messageId) return '';

  const url = `${baseUrl.replace(/\/$/, '')}/api/emails/open/${encodeURIComponent(messageId)}`;
  return `<img src="${escapeHtml(url)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
}

function appendTrackingPixel(html, messageId) {
  const pixel = trackingPixelHtml(messageId);
  if (!pixel) return html;
  return `${html}${pixel}`;
}

function appendUnsubscribeFooter(body, unsubscribeUrl, businessAddress = '') {
  const addressLine = businessAddress ? `\n${businessAddress}` : '';
  return `${body}\n\n--\nTo stop receiving these emails, unsubscribe here: ${unsubscribeUrl}${addressLine}`;
}

function publicAccount(account) {
  if (!account) return null;

  return {
    id: account.id,
    workspace_id: account.workspace_id,
    provider: account.provider,
    smtp_host: account.smtp_host,
    smtp_port: account.smtp_port,
    smtp_username: account.smtp_username,
    from_name: account.from_name,
    from_email: account.from_email,
    reply_to_email: account.reply_to_email,
    imap_host: account.imap_host,
    imap_port: account.imap_port,
    imap_username: account.imap_username,
    status: account.status,
    smtp_verified_at: account.smtp_verified_at,
    imap_verified_at: account.imap_verified_at,
    last_tested_at: account.last_tested_at,
    last_error: account.last_error,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

module.exports = {
  appendTrackingPixel,
  appendUnsubscribeFooter,
  createTransport,
  publicAccount,
  sendEmail,
  testConnection,
  textToHtml,
};
