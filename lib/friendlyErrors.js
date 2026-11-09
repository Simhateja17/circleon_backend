// Turns raw provider, network and database errors into messages a customer can act on.
// The raw text is still logged by lib/logger.js; only the response shown in the app changes.
// Messages that are already written for people (validation, billing, limits) pass through untouched.

const SUPPORT_HINT = 'If it keeps happening, contact support';

function withReference(message, requestId) {
  return requestId ? `${message} ${SUPPORT_HINT} and quote reference ${requestId.slice(0, 8)}.` : `${message} ${SUPPORT_HINT}.`;
}

function mailProvider(text) {
  if (/gsmtp|google|gmail/i.test(text)) return 'gmail';
  if (/outlook|office365|microsoft|hotmail/i.test(text)) return 'outlook';
  return 'other';
}

const RULES = [
  // Mailbox sign-in rejected (SMTP 535 / 534, IMAP AUTHENTICATIONFAILED).
  {
    test: /invalid login|\b53[45][- ]5\.7\.\d|username and password not accepted|authenticationfailed|authentication failed|invalid credentials|\bEAUTH\b|application-specific password required/i,
    message: text => {
      const provider = mailProvider(text);
      if (provider === 'gmail') {
        return 'Gmail did not accept that username and app password. Use your full email address as the username, and a 16-character app password from myaccount.google.com/apppasswords, not your normal Google password. App passwords need two-step verification turned on.';
      }
      if (provider === 'outlook') {
        return 'Outlook did not accept that username and password. Use your full email address as the username. If two-step verification is on, create an app password and use that instead.';
      }
      return 'Your mail server did not accept that username and password. Check both, and use an app password if your provider requires one.';
    },
  },
  {
    test: /getaddrinfo|ENOTFOUND|EAI_AGAIN/i,
    message: () => 'We could not find that server. Check the host name for typos, for example smtp.gmail.com.',
  },
  {
    test: /wrong version number|ssl routines|tls.*handshake|self[- ]signed certificate|certificate has expired/i,
    message: () => 'The secure connection to your mail server failed. Check the port: use 587 for SMTP with TLS, 465 for SMTP with SSL, and 993 for IMAP.',
  },
  {
    test: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKET|greeting never received|connection timeout|timed out|socket hang up/i,
    message: () => 'We could not connect to that server. Check the host and port, then try again.',
  },
  {
    test: /jwt expired|invalid jwt|invalid refresh token|refresh token not found/i,
    message: () => 'Your session has expired. Please sign in again.',
  },
  {
    test: /duplicate key value violates unique constraint/i,
    message: () => 'This already exists, so it was not saved again.',
  },
  {
    test: /violates foreign key constraint/i,
    message: () => 'This is linked to something that no longer exists. Refresh the page and try again.',
  },
  {
    test: /row-level security/i,
    message: () => 'You do not have access to change this.',
  },
  {
    test: /rate limit|too many requests|\b429\b/i,
    message: () => 'Too many requests right now. Please wait a minute and try again.',
  },
];

// Signs of a bug or internal failure rather than something the user can fix.
const INTERNAL = /is not defined|is not a function|cannot read propert|cannot set propert|undefined is not|unexpected token|maximum call stack|relation ".*" does not exist|column ".*" does not exist|syntax error at or near|null value in column|invalid input syntax|PGRST\d+|fetch failed|ECONNRESET|internal server error/i;

function friendlyError(raw, { status, requestId } = {}) {
  const text = String(raw || '').trim();
  if (!text) return withReference('Something went wrong. Please try again.', requestId);

  const rule = RULES.find(item => item.test.test(text));
  if (rule) return rule.message(text);

  if (INTERNAL.test(text)) {
    return withReference('Something went wrong on our side. Please try again.', requestId);
  }

  if (status >= 500 && text.length > 200) {
    return withReference('Something went wrong on our side. Please try again.', requestId);
  }

  return text;
}

module.exports = { friendlyError };
