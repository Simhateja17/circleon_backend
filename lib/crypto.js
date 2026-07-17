const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY is required');
  }

  if (/^[0-9a-f]{64}$/i.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  return crypto.createHash('sha256').update(rawKey).digest();
}

function encrypt(text) {
  if (typeof text !== 'string' || !text.length) {
    throw new Error('Text is required for encryption');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function decrypt(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('v1.')) {
    throw new Error('Invalid encrypted payload');
  }

  const [, encodedIv, encodedAuthTag, encodedEncrypted] = payload.split('.');
  if (!encodedIv || !encodedAuthTag || !encodedEncrypted) {
    throw new Error('Invalid encrypted payload');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(encodedIv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(encodedAuthTag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encodedEncrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = {
  decrypt,
  encrypt,
};
