const nodemailer = require('nodemailer');

// Reuses the billing mailbox: support replies are transactional, like billing notices.
async function sendSupportReplyEmail(db, ticket, body) {
  if (!process.env.BILLING_SMTP_URL || !process.env.BILLING_FROM_EMAIL) throw new Error('BILLING_SMTP_URL and BILLING_FROM_EMAIL are required for support emails.');
  const { data, error } = await db.auth.admin.getUserById(ticket.created_by);
  if (error) throw error;
  const link = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/support?ticket=${ticket.id}`;
  await nodemailer.createTransport(process.env.BILLING_SMTP_URL).sendMail({
    from: process.env.BILLING_FROM_EMAIL,
    to: data.user.email,
    subject: `Re: ${ticket.subject}`,
    text: `${body}\n\nView or reply to this conversation: ${link}\n\nCircleOn support`,
  });
}

module.exports = { sendSupportReplyEmail };
