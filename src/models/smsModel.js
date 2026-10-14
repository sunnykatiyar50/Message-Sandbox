const { toIso } = require('../utils/time');

const COLUMNS = 'id, sender, phone, message, timestamp, api_key_name';

function toMessage(row) {
    return {
        id: Number(row.id),
        sender: row.sender,
        phone: row.phone,
        message: row.message,
        timestamp: toIso(row.timestamp),
        apiKeyName: row.api_key_name || null,
    };
}

// "%" and "_" in a search term are matched literally ("!" is the escape character in the queries below)
const likeTerm = value => `%${value.toLowerCase().replace(/[!%_]/g, '!$&')}%`;

// SMS messages submitted to POST /api/sms (the mock SMS gateway)
class SmsModel {
    // db is the adapter returned by database/initDatabase.js
    constructor(db) {
        this.db = db;
    }

    buildFilters({ search, phone, after, before } = {}) {
        const clauses = [];
        const params = [];
        if (search) {
            clauses.push("(LOWER(message) LIKE ? ESCAPE '!' OR LOWER(phone) LIKE ? ESCAPE '!' OR LOWER(sender) LIKE ? ESCAPE '!')");
            const like = likeTerm(search);
            params.push(like, like, like);
        }
        if (phone) {
            clauses.push('phone = ?');
            params.push(phone);
        }
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

    // Returns one page of messages (newest first) plus the total number of matches
    async list({ limit, offset, ...filters }) {
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
            throw new TypeError('limit and offset must be integers');
        }
        const { where, params } = this.buildFilters(filters);
        const [countRow] = await this.db.all(`SELECT COUNT(*) AS total FROM sms_messages ${where}`, params);
        // limit/offset are validated integers, so they are safe to inline (MySQL rejects them as bound params)
        const rows = await this.db.all(
            `SELECT ${COLUMNS} FROM sms_messages ${where} ORDER BY timestamp DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
            params
        );
        return { total: Number(countRow.total), messages: rows.map(toMessage) };
    }

    async latest(filters) {
        const { messages } = await this.list({ ...filters, limit: 1, offset: 0 });
        return messages[0] || null;
    }

    async getSummary(id) {
        const [row] = await this.db.all(`SELECT ${COLUMNS} FROM sms_messages WHERE id = ?`, [id]);
        return row ? toMessage(row) : null;
    }

    async create({ sender, phone, message, apiKeyName }) {
        const timestamp = new Date();
        const id = await this.db.insert(
            'INSERT INTO sms_messages (sender, phone, message, timestamp, api_key_name) VALUES (?, ?, ?, ?, ?)',
            [sender, phone, message, timestamp, apiKeyName || null]
        );
        return { id: Number(id), timestamp: timestamp.toISOString() };
    }

    // Deletes the given ids; returns the number of rows removed
    async deleteMany(ids) {
        if (ids.length === 0) return 0;
        const placeholders = ids.map(() => '?').join(', ');
        return this.db.run(`DELETE FROM sms_messages WHERE id IN (${placeholders})`, ids);
    }

    // Deletes every message matching the filters (for emptying one phone number's inbox); returns how many
    async deleteMatching(filters) {
        const { where, params } = this.buildFilters(filters);
        const rows = await this.db.all(`SELECT id FROM sms_messages ${where}`, params);
        const ids = rows.map(row => Number(row.id));
        let deleted = 0;
        for (let i = 0; i < ids.length; i += 500) deleted += await this.deleteMany(ids.slice(i, i + 500));
        return deleted;
    }

    async deleteOlderThan(date) {
        return this.db.run('DELETE FROM sms_messages WHERE timestamp < ?', [date]);
    }

    async count() {
        const [row] = await this.db.all('SELECT COUNT(*) AS total FROM sms_messages');
        return Number(row.total);
    }
}

module.exports = SmsModel;
