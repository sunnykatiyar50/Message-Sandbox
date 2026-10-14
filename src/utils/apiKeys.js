const crypto = require('crypto');

// API key format: ms_<scope>_<43 random base64url characters> (32 random bytes), e.g.
//   ms_send_3f9aK2...   ms_read_Q8xw1L...
// The scope in the key makes it obvious what a leaked key can do. Send keys let an app submit SMS messages
// (POST /api/sms); Read keys list and read emails and SMS. Email arrives over SMTP, so it needs no key.
const SCOPES = ['send', 'read'];
const KEY_PATTERN = /^ms_(send|read)_[A-Za-z0-9_-]{43}$/;

function generateApiKey(scope) {
    if (!SCOPES.includes(scope)) throw new Error(`Unknown API key scope: ${scope}`);
    return `ms_${scope}_${crypto.randomBytes(32).toString('base64url')}`;
}

// Keys are 256-bit random values, so a plain SHA-256 is a safe lookup hash (no salt or slow hash needed)
function hashApiKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// What the dashboard shows for a key without revealing it: "ms_send_3f9aK2"
function keyPrefix(key) {
    const typed = key.match(/^ms_(?:send|read)_/);
    return typed ? key.slice(0, typed[0].length + 6) : key.slice(0, 6);
}

// Encrypts keys so the dashboard can show them again. The AES-256-GCM key is derived from a
// server secret (SESSION_SECRET); if that secret changes, stored keys still authenticate (that only
// uses the hash) but can no longer be decrypted for display.
function createKeyCipher(secret) {
    const material = secret || crypto.randomBytes(32).toString('hex'); // no secret: works until restart
    const aesKey = Buffer.from(crypto.hkdfSync('sha256', material, 'message-sandbox', 'api-key-encryption', 32));

    return {
        encrypt(plain) {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
            const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
            return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
        },
        // Returns null if the value can't be decrypted (e.g. the secret changed)
        decrypt(stored) {
            try {
                const [version, iv, tag, data] = String(stored).split('.');
                if (version !== 'v1') return null;
                const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'base64url'));
                decipher.setAuthTag(Buffer.from(tag, 'base64url'));
                return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
            } catch {
                return null;
            }
        },
    };
}

module.exports = { SCOPES, KEY_PATTERN, generateApiKey, hashApiKey, keyPrefix, createKeyCipher };
