const { toIso } = require('../utils/time');

function toEvent(row) {
    return {
        id: Number(row.id),
        timestamp: toIso(row.timestamp),
        level: row.level,
        category: row.category,
        message: row.message,
        ip: row.ip || null,
        actor: row.actor || null,
    };
}

// "%" and "_" in a search term are matched literally ("!" is the escape character in the queries below)
const likeTerm = value => `%${value.toLowerCase().replace(/[!%_]/g, '!$&')}%`;

// Events shown on the Activity page: sign-ins, API key changes, rejected requests, SMTP and TLS problems,
// failed webhooks and relays, rate-limit hits, and server errors
class ActivityModel {
    constructor(db) {
        this.db = db;
    }

    async create({ level, category, message, ip, actor }) {
        await this.db.insert(
            'INSERT INTO activity_log (timestamp, level, category, message, ip, actor) VALUES (?, ?, ?, ?, ?, ?)',
            [new Date(), level, category, message, ip || null, actor || null]
        );
    }

    // level: info | warn | error, or "problems" for warn and error together
    buildFilters({ level, category, search, ip, after, before } = {}) {
        const clauses = [];
        const params = [];
        if (level === 'problems') clauses.push("level IN ('warn', 'error')");
        else if (level) {
            clauses.push('level = ?');
            params.push(level);
        }
        if (category) {
            clauses.push('category = ?');
            params.push(category);
        }
        if (ip) {
            clauses.push('ip = ?');
            params.push(ip);
        }
        if (search) {
            clauses.push("(LOWER(message) LIKE ? ESCAPE '!' OR LOWER(COALESCE(ip, '')) LIKE ? ESCAPE '!' OR LOWER(COALESCE(actor, '')) LIKE ? ESCAPE '!')");
            const like = likeTerm(search);
            params.push(like, like, like);
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

    // One page of events (newest first) plus the total number of matches
    async list({ limit, offset, ...filters }) {
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
            throw new TypeError('limit and offset must be integers');
        }
        const { where, params } = this.buildFilters(filters);
        const [countRow] = await this.db.all(`SELECT COUNT(*) AS total FROM activity_log ${where}`, params);
        // limit/offset are validated integers, so they are safe to inline (MySQL rejects them as bound params)
        const rows = await this.db.all(
            `SELECT id, timestamp, level, category, message, ip, actor FROM activity_log ${where} ORDER BY timestamp DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
            params
        );
        return { total: Number(countRow.total), events: rows.map(toEvent) };
    }

    // Counts by level since a time, and the addresses behind the most warnings and errors
    async summary(since) {
        const [levelRows, ipRows] = await Promise.all([
            this.db.all('SELECT level, COUNT(*) AS total FROM activity_log WHERE timestamp >= ? GROUP BY level', [since]),
            this.db.all(
                `SELECT ip, COUNT(*) AS total, MAX(timestamp) AS last_seen FROM activity_log
                 WHERE timestamp >= ? AND level IN ('warn', 'error') AND ip IS NOT NULL
                 GROUP BY ip ORDER BY COUNT(*) DESC, MAX(timestamp) DESC LIMIT 10`,
                [since]
            ),
        ]);
        const levels = { info: 0, warn: 0, error: 0 };
        for (const row of levelRows) if (row.level in levels) levels[row.level] = Number(row.total);
        return {
            since: toIso(since),
            levels,
            topIps: ipRows.map(r => ({ ip: r.ip, count: Number(r.total), lastSeen: toIso(r.last_seen) })),
        };
    }

    async deleteOlderThan(cutoff) {
        return this.db.run('DELETE FROM activity_log WHERE timestamp < ?', [cutoff]);
    }

    // Keeps the newest maxRows events, so a flood can't fill the database
    async trimTo(maxRows) {
        const [edge] = await this.db.all(`SELECT id FROM activity_log ORDER BY id DESC LIMIT 1 OFFSET ${Number(maxRows)}`);
        return edge ? this.db.run('DELETE FROM activity_log WHERE id <= ?', [edge.id]) : 0;
    }

    async clear() {
        return this.db.run('DELETE FROM activity_log');
    }

    async count() {
        const [row] = await this.db.all('SELECT COUNT(*) AS total FROM activity_log');
        return Number(row.total);
    }
}

module.exports = ActivityModel;
