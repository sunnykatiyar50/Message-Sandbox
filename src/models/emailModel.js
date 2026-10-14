const { toIso } = require('../utils/time');
const { visibleTo } = require('../utils/recipients');

const SUMMARY_COLUMNS =
    'id, message_id, from_address, from_name, to_addresses, cc_addresses, envelope_from, envelope_to, ' +
    'subject, snippet, size, attachment_count, smtp_user, timestamp';
const FULL_COLUMNS = `${SUMMARY_COLUMNS}, text_body, html_body, headers, has_text_part`;

function parseJson(value, fallback) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

// Databases return binary columns as Buffer (PostgreSQL, MySQL) or Uint8Array (SQLite)
const toBuffer = value => (value ? Buffer.from(value) : Buffer.alloc(0));

function toSummary(row) {
    return {
        id: Number(row.id),
        messageId: row.message_id || null,
        from: { name: row.from_name || '', address: row.from_address || '' },
        to: parseJson(row.to_addresses, []),
        cc: parseJson(row.cc_addresses, []),
        envelope: { from: row.envelope_from || '', to: parseJson(row.envelope_to, []) },
        subject: row.subject || '',
        snippet: row.snippet || '',
        size: Number(row.size),
        attachmentCount: Number(row.attachment_count),
        smtpUser: row.smtp_user || null,
        timestamp: toIso(row.timestamp),
    };
}

function toAttachment(row) {
    return {
        id: Number(row.id),
        filename: row.filename,
        contentType: row.content_type,
        contentId: row.content_id || null,
        size: Number(row.size),
    };
}

// "%" and "_" in a search term are matched literally ("!" is the escape character in every query below)
const likeTerm = value => `%${value.toLowerCase().replace(/[!%_]/g, '!$&')}%`;

const escapeLike = text => `%${text.replace(/[!%_]/g, '!$&')}%`;
const RECIPIENT_COLUMNS = ['to_addresses', 'cc_addresses', 'envelope_to'];
const anyRecipientColumn = () => `(${RECIPIENT_COLUMNS.map(c => `LOWER(${c}) LIKE ? ESCAPE '!'`).join(' OR ')})`;

// An exact address (case-insensitive) in To, Cc or the SMTP envelope (so Bcc too), not a substring:
// "alice@example.com" must not match "malice@example.com". The columns hold JSON, so the address is
// matched as a whole JSON string.
function addressClause(address) {
    const json = JSON.stringify(String(address).toLowerCase());
    return { sql: anyRecipientColumn(), params: [escapeLike(`"address":${json}`), escapeLike(`"address":${json}`), escapeLike(json)] };
}

// What an API key limited to some recipients may see: emails sent to any of its rules (see utils/recipients.js).
// A domain rule matches addresses ending in @domain" and a subdomain rule ending in .domain", the closing quote
// being the end of the JSON string.
function scopeClause(rules) {
    const parts = [];
    const params = [];
    for (const rule of rules) {
        if (rule.type === 'address') {
            const { sql, params: p } = addressClause(rule.value);
            parts.push(sql);
            params.push(...p);
        } else {
            const suffix = escapeLike(`${rule.type === 'domain' ? '@' : '.'}${rule.value}"`);
            parts.push(anyRecipientColumn());
            params.push(suffix, suffix, suffix);
        }
    }
    return { sql: `(${parts.join(' OR ')})`, params };
}

class EmailModel {
    // db is the adapter returned by database/initDatabase.js
    constructor(db) {
        this.db = db;
    }

    buildFilters({ search, to, from, subject, after, before, scope } = {}) {
        const clauses = [];
        const params = [];
        const matchAny = (columns, term) => {
            clauses.push(`(${columns.map(c => `LOWER(${c}) LIKE ? ESCAPE '!'`).join(' OR ')})`);
            columns.forEach(() => params.push(likeTerm(term)));
        };
        if (search) matchAny(['subject', 'from_address', 'from_name', 'to_addresses', 'envelope_to', 'text_body'], search);
        if (to) {
            const { sql, params: p } = addressClause(to);
            clauses.push(sql);
            params.push(...p);
        }
        if (scope && scope.length) {
            const { sql, params: p } = scopeClause(scope);
            clauses.push(sql);
            params.push(...p);
        }
        if (from) matchAny(['from_address', 'from_name'], from);
        if (subject) matchAny(['subject'], subject);
        if (after) {
            clauses.push('timestamp >= ?');
            params.push(after);
        }
        if (before) {
            clauses.push('timestamp < ?');
            params.push(before);
        }
        return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    }

    // One page of emails (newest first, without bodies) plus the total number of matches
    async list({ limit, offset, ...filters }) {
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
            throw new TypeError('limit and offset must be integers');
        }
        const { where, params } = this.buildFilters(filters);
        const [countRow] = await this.db.all(`SELECT COUNT(*) AS total FROM emails ${where}`, params);
        // limit/offset are validated integers, so they are safe to inline (MySQL rejects them as bound params)
        const rows = await this.db.all(
            `SELECT ${SUMMARY_COLUMNS} FROM emails ${where} ORDER BY timestamp DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
            params
        );
        return { total: Number(countRow.total), emails: rows.map(toSummary) };
    }

    // The newest matching email with its body, or null
    async latest(filters) {
        const { emails } = await this.list({ ...filters, limit: 1, offset: 0 });
        return emails.length ? this.get(emails[0].id) : null;
    }

    // One email with its text, HTML, headers and attachment list (not the attachment contents)
    async get(id) {
        const [row] = await this.db.all(`SELECT ${FULL_COLUMNS} FROM emails WHERE id = ?`, [id]);
        if (!row) return null;
        const attachments = await this.db.all(
            'SELECT id, filename, content_type, content_id, size FROM attachments WHERE email_id = ? ORDER BY id',
            [id]
        );
        return {
            ...toSummary(row),
            text: row.text_body ?? null,
            html: row.html_body ?? null,
            // true: has a real text/plain part, false: HTML only, null: stored before this was recorded
            hasTextPart: row.has_text_part === null || row.has_text_part === undefined ? null : Number(row.has_text_part) === 1,
            headers: parseJson(row.headers, []),
            attachments: attachments.map(toAttachment),
        };
    }

    // The emails in the same conversation as `email` (a full email, with its headers): those whose Message-ID
    // is one it references, and those that mention its Message-ID or the ones it references, oldest first.
    // Empty when it has no Message-ID, In-Reply-To or References to go by.
    async thread(email, limit = 50) {
        const header = name => (email.headers.find(h => h.key.toLowerCase() === name) || {}).value || '';
        const ids = [
            ...new Set([email.messageId, ...header('in-reply-to').split(/\s+/), ...header('references').split(/\s+/)].filter(id => /^<[^<>\s]+>$/.test(id || ''))),
        ].slice(0, 10);
        if (ids.length === 0) return [];
        const clauses = [`message_id IN (${ids.map(() => '?').join(', ')})`];
        const params = [...ids];
        for (const id of ids) {
            clauses.push("LOWER(headers) LIKE ? ESCAPE '!'");
            params.push(likeTerm(id));
        }
        const rows = await this.db.all(
            `SELECT ${SUMMARY_COLUMNS} FROM emails WHERE ${clauses.join(' OR ')} ORDER BY timestamp ASC, id ASC LIMIT ${Number(limit)}`,
            params
        );
        return rows.map(toSummary);
    }

    // One email's summary (no body), or null
    async getSummary(id) {
        const [row] = await this.db.all(`SELECT ${SUMMARY_COLUMNS} FROM emails WHERE id = ?`, [id]);
        return row ? toSummary(row) : null;
    }

    // Whether the email exists and an API key limited to `rules` may see it (no rules: any existing email)
    async isVisible(id, rules) {
        const [row] = await this.db.all('SELECT to_addresses, cc_addresses, envelope_to FROM emails WHERE id = ?', [id]);
        if (!row) return false;
        return visibleTo(
            { to: parseJson(row.to_addresses, []), cc: parseJson(row.cc_addresses, []), envelope: { to: parseJson(row.envelope_to, []) } },
            rules
        );
    }

    // id, subject, size and time of the given emails, for sizing an export before reading the messages
    async describe(ids) {
        if (ids.length === 0) return [];
        const rows = await this.db.all(
            `SELECT id, subject, size, timestamp FROM emails WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY timestamp ASC, id ASC`,
            ids
        );
        return rows.map(row => ({ id: Number(row.id), subject: row.subject || '', size: Number(row.size), timestamp: toIso(row.timestamp) }));
    }

    async count() {
        const [row] = await this.db.all('SELECT COUNT(*) AS total FROM emails');
        return Number(row.total);
    }

    async getRaw(id) {
        const [row] = await this.db.all('SELECT raw FROM emails WHERE id = ?', [id]);
        return row ? toBuffer(row.raw) : null;
    }

    async getAttachment(emailId, attachmentId) {
        const [row] = await this.db.all(
            'SELECT id, filename, content_type, content_id, size, content FROM attachments WHERE email_id = ? AND id = ?',
            [emailId, attachmentId]
        );
        return row ? { ...toAttachment(row), content: toBuffer(row.content) } : null;
    }

    // Attachments referenced from the HTML as cid:... (inline images), with their contents
    async getInlineAttachments(emailId) {
        const rows = await this.db.all(
            'SELECT id, filename, content_type, content_id, size, content FROM attachments WHERE email_id = ? AND content_id IS NOT NULL',
            [emailId]
        );
        return rows.map(row => ({ ...toAttachment(row), content: toBuffer(row.content) }));
    }

    // record: the object produced by mail/parse.js
    async create(record) {
        const timestamp = new Date();
        const id = Number(
            await this.db.insert(
                `INSERT INTO emails (message_id, from_address, from_name, to_addresses, cc_addresses, envelope_from, envelope_to,
                                     subject, snippet, text_body, html_body, headers, raw, size, attachment_count, has_text_part, smtp_user, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    record.messageId,
                    record.from.address,
                    record.from.name,
                    JSON.stringify(record.to),
                    JSON.stringify(record.cc),
                    record.envelopeFrom,
                    JSON.stringify(record.envelopeTo),
                    record.subject,
                    record.snippet,
                    record.text,
                    record.html,
                    JSON.stringify(record.headers),
                    record.raw,
                    record.size,
                    record.attachments.length,
                    record.textPart === null || record.textPart === undefined ? null : record.textPart ? 1 : 0,
                    record.smtpUser,
                    timestamp,
                ]
            )
        );
        for (const attachment of record.attachments) {
            await this.db.insert(
                'INSERT INTO attachments (email_id, filename, content_type, content_id, size, content) VALUES (?, ?, ?, ?, ?, ?)',
                [id, attachment.filename, attachment.contentType, attachment.contentId, attachment.size, attachment.content]
            );
        }
        return { id, timestamp: timestamp.toISOString() };
    }

    // Deletes the given ids (and their attachments); returns the number of emails removed
    async deleteMany(ids) {
        if (ids.length === 0) return 0;
        const placeholders = ids.map(() => '?').join(', ');
        await this.db.run(`DELETE FROM attachments WHERE email_id IN (${placeholders})`, ids);
        return this.db.run(`DELETE FROM emails WHERE id IN (${placeholders})`, ids);
    }

    // Deletes every email matching the filters (and their attachments); returns how many were removed
    async deleteMatching(filters) {
        const { where, params } = this.buildFilters(filters);
        const rows = await this.db.all(`SELECT id FROM emails ${where}`, params);
        const ids = rows.map(row => Number(row.id));
        let deleted = 0;
        for (let i = 0; i < ids.length; i += 500) deleted += await this.deleteMany(ids.slice(i, i + 500));
        return deleted;
    }

    async deleteOlderThan(date) {
        await this.db.run('DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE timestamp < ?)', [date]);
        return this.db.run('DELETE FROM emails WHERE timestamp < ?', [date]);
    }

    async ping() {
        await this.db.all('SELECT 1 AS ok');
    }
}

module.exports = EmailModel;
