const { toIso } = require('../utils/time');
const { generateApiKey, hashApiKey, keyPrefix, createKeyCipher } = require('../utils/apiKeys');
const { parseRules, describeRule } = require('../utils/recipients');

const LAST_USED_INTERVAL_MS = 60 * 1000; // write last_used_at at most once a minute per key
const NAME_MAX_LENGTH = 64; // the api_keys.name and sms_messages.api_key_name columns

// The rules stored for a key, as text ("a@x.com,example.com"), in the form they were written
const rulesText = row => (row.allowed_recipients || '').split(',').map(s => s.trim()).filter(Boolean);

function toKey(row, messageCounts = new Map()) {
    return {
        id: Number(row.id),
        name: row.name,
        scope: row.scope,
        prefix: row.key_prefix,
        source: row.source || 'dashboard',
        createdAt: toIso(row.created_at),
        lastUsedAt: toIso(row.last_used_at),
        revokedAt: toIso(row.revoked_at),
        // Empty: the key can read every inbox. Otherwise only emails sent to these addresses and domains.
        allowedRecipients: rulesText(row),
        // SMS messages submitted with this key (Send keys); the dashboard's own test messages are not counted
        messageCount: messageCounts.get(row.name) || 0,
    };
}

// API keys created in the dashboard. Each key is stored twice: a SHA-256 hash, used to check incoming
// requests, and an AES-256-GCM encrypted copy, used only to show the key in the dashboard again.
class ApiKeyModel {
    constructor(db, { encryptionSecret } = {}) {
        this.db = db;
        this.cipher = createKeyCipher(encryptionSecret);
        this.lastUsedWrites = new Map(); // key id -> time of the last last_used_at write
    }

    async messageCounts() {
        const rows = await this.db.all(
            'SELECT api_key_name AS name, COUNT(*) AS total FROM sms_messages WHERE api_key_name IS NOT NULL GROUP BY api_key_name'
        );
        return new Map(rows.map(r => [r.name, Number(r.total)]));
    }

    // Active keys first (newest first), then revoked ones
    async list() {
        const [rows, counts] = await Promise.all([
            this.db.all('SELECT * FROM api_keys ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END, created_at DESC, id DESC'),
            this.messageCounts(),
        ]);
        return rows.map(row => toKey(row, counts));
    }

    // Only active keys hold a name: a revoked key's name can be used again. exceptId skips the key being renamed.
    async nameExists(name, exceptId = 0) {
        const rows = await this.db.all('SELECT id FROM api_keys WHERE LOWER(name) = LOWER(?) AND revoked_at IS NULL AND id <> ?', [name, exceptId]);
        return rows.length > 0;
    }

    // The name column is UNIQUE, so before a name is reused the revoked key that still holds it is renamed to
    // "name (revoked #id)". Its SMS messages follow, so they stay with the revoked key instead of being
    // counted under the new one.
    async releaseRevokedName(name) {
        const rows = await this.db.all('SELECT id, name FROM api_keys WHERE LOWER(name) = LOWER(?) AND revoked_at IS NOT NULL', [name]);
        for (const row of rows) {
            const suffix = ` (revoked #${row.id})`;
            const renamed = row.name.slice(0, NAME_MAX_LENGTH - suffix.length) + suffix;
            await this.db.run('UPDATE api_keys SET name = ? WHERE id = ?', [renamed, row.id]);
            await this.db.run('UPDATE sms_messages SET api_key_name = ? WHERE api_key_name = ?', [renamed, row.name]);
        }
    }

    // Renames an active key; its SMS messages follow so the "sent" count stays with it.
    // Returns the key, or undefined if there's no such key, or { revoked: true } if it was revoked.
    async rename(id, name) {
        const [row] = await this.db.all('SELECT * FROM api_keys WHERE id = ?', [id]);
        if (!row) return undefined;
        if (row.revoked_at) return { revoked: true };
        if (row.name !== name) {
            await this.releaseRevokedName(name);
            await this.db.run('UPDATE api_keys SET name = ? WHERE id = ?', [name, id]);
            await this.db.run('UPDATE sms_messages SET api_key_name = ? WHERE api_key_name = ?', [name, row.name]);
        }
        const [updated] = await this.db.all('SELECT * FROM api_keys WHERE id = ?', [id]);
        return { key: toKey(updated, await this.messageCounts()), previousName: row.name };
    }

    // Returns the new key's metadata and the full key
    // allowedRecipients: addresses / domains (see utils/recipients.js) the key is limited to; [] means no limit
    async create({ name, scope, secret = generateApiKey(scope), source = 'dashboard', allowedRecipients = [] }) {
        await this.releaseRevokedName(name);
        const createdAt = new Date();
        const rules = parseRules(allowedRecipients.join(',')).map(describeRule);
        const id = await this.db.insert(
            `INSERT INTO api_keys (name, scope, key_hash, key_prefix, key_encrypted, source, created_at, allowed_recipients)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, scope, hashApiKey(secret), keyPrefix(secret), this.cipher.encrypt(secret), source, createdAt, rules.length ? rules.join(',') : null]
        );
        const [row] = await this.db.all('SELECT * FROM api_keys WHERE id = ?', [Number(id)]);
        return { key: toKey(row), secret };
    }

    // The full key for display, or null when it can't be decrypted (SESSION_SECRET changed)
    async reveal(id) {
        const [row] = await this.db.all('SELECT * FROM api_keys WHERE id = ?', [id]);
        if (!row) return undefined;
        return { key: toKey(row), secret: this.cipher.decrypt(row.key_encrypted) };
    }

    // Returns the revoked key's metadata, or undefined if there's no such key
    async revoke(id) {
        const changed = await this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [new Date(), id]);
        const [row] = await this.db.all('SELECT * FROM api_keys WHERE id = ?', [id]);
        if (!row) return undefined;
        return { key: toKey(row), changed: changed > 0 };
    }

    // Permanently removes a revoked key. Returns undefined if there's no such key, { deleted: false } if it is
    // still active (revoke it first). Its SMS messages stay; only their key label is left behind.
    async remove(id) {
        const [row] = await this.db.all('SELECT * FROM api_keys WHERE id = ?', [id]);
        if (!row) return undefined;
        if (!row.revoked_at) return { key: toKey(row), deleted: false };
        await this.db.run('DELETE FROM api_keys WHERE id = ? AND revoked_at IS NOT NULL', [id]);
        return { key: toKey(row), deleted: true };
    }

    // Looks up an active key by its value; returns { id, name, scope, allowedRecipients: [rule] } or null
    async authenticate(presented) {
        if (typeof presented !== 'string' || !presented || presented.length > 512) return null;
        const [row] = await this.db.all(
            'SELECT id, name, scope, allowed_recipients FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
            [hashApiKey(presented)]
        );
        if (!row) return null;
        this.touch(Number(row.id));
        return { id: Number(row.id), name: row.name, scope: row.scope, allowedRecipients: parseRules(row.allowed_recipients || '') };
    }

    // Records when a key was last used, without a database write on every request
    touch(id) {
        const now = Date.now();
        if (now - (this.lastUsedWrites.get(id) || 0) < LAST_USED_INTERVAL_MS) return;
        this.lastUsedWrites.set(id, now);
        this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [new Date(now), id]).catch(() => {
            // best effort: a failed write only means a slightly stale "last used"
        });
    }
}

module.exports = ApiKeyModel;
