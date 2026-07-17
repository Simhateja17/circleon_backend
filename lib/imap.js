const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { decrypt } = require('./crypto');

function createClient(account) {
  if (!account) throw new Error('Connected email account is required');

  return new ImapFlow({
    host: account.imap_host,
    port: Number(account.imap_port),
    secure: Number(account.imap_port) === 993,
    auth: {
      user: account.imap_username,
      pass: decrypt(account.imap_password_encrypted),
    },
    logger: false,
  });
}

async function testConnection(account) {
  const client = createClient(account);
  await client.connect();
  try {
    await client.mailboxOpen('INBOX', { readOnly: true });
  } finally {
    await client.logout().catch(() => undefined);
  }
  return true;
}

async function parseMessage(source) {
  const parsed = await simpleParser(source);
  const from = parsed.from?.value?.[0] || {};

  return {
    from_email: from.address || '',
    from_name: from.name || '',
    subject: parsed.subject || '',
    body: parsed.text || parsed.html || '',
    message_id_header: parsed.messageId || '',
    in_reply_to_header: parsed.inReplyTo || '',
    references: parsed.references || [],
    date: parsed.date || new Date(),
    raw: {
      headers: Object.fromEntries(parsed.headers || []),
    },
  };
}

async function fetchUnseenMessages(account) {
  const client = createClient(account);
  const messages = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const message of client.fetch({ seen: false }, { uid: true, source: true })) {
        messages.push({
          uid: message.uid,
          parsed: await parseMessage(message.source),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return messages;
}

module.exports = {
  createClient,
  fetchUnseenMessages,
  parseMessage,
  testConnection,
};
