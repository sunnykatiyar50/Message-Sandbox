const { DatabaseSync } = require('node:sqlite');
const { logToFile } = require('../utils/logger');

// Uses Node's built-in SQLite driver, so there is no native module to compile and the same
// node_modules works on Windows, WSL/Linux and in Docker.
//
// SQLite stores timestamps as ISO-8601 text, which sorts and compares correctly as strings.
// node:sqlite rejects undefined, so it becomes NULL.
const toParam = value => (value instanceof Date ? value.toISOString() : value === undefined ? null : value);

async function connect() {
    logToFile('Initializing SQLite database connection...');
    const db = new DatabaseSync(process.env.SQLITE_PATH || './messaging-db.sqlite');

    db.exec(
        `CREATE TABLE IF NOT EXISTS emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT,
            from_address TEXT NOT NULL DEFAULT '',
            from_name TEXT NOT NULL DEFAULT '',
            to_addresses TEXT NOT NULL DEFAULT '[]',
            cc_addresses TEXT NOT NULL DEFAULT '[]',
            envelope_from TEXT NOT NULL DEFAULT '',
            envelope_to TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            text_body TEXT,
            html_body TEXT,
            headers TEXT NOT NULL DEFAULT '[]',
            raw BLOB,
            size INTEGER NOT NULL DEFAULT 0,
            attachment_count INTEGER NOT NULL DEFAULT 0,
            has_text_part INTEGER,
            smtp_user TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
    );
    // Added after the table was first introduced
    if (!db.prepare('PRAGMA table_info(emails)').all().some(c => c.name === 'has_text_part')) {
        db.exec('ALTER TABLE emails ADD COLUMN has_text_part INTEGER');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_emails_timestamp ON emails (timestamp)');
    db.exec(
        `CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            content_type TEXT NOT NULL,
            content_id TEXT,
            size INTEGER NOT NULL DEFAULT 0,
            content BLOB
        )`
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments (email_id)');
    db.exec(
        `CREATE TABLE IF NOT EXISTS sms_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            api_key_name TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_sms_timestamp ON sms_messages (timestamp)');
    db.exec(
        `CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            key_prefix TEXT NOT NULL,
            key_encrypted TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'dashboard',
            created_at TEXT NOT NULL,
            last_used_at TEXT,
            revoked_at TEXT,
            allowed_recipients TEXT
        )`
    );

    // Added after the table was first introduced
    if (!db.prepare('PRAGMA table_info(api_keys)').all().some(c => c.name === 'allowed_recipients')) {
        db.exec('ALTER TABLE api_keys ADD COLUMN allowed_recipients TEXT');
    }

    const run = (sql, params) => db.prepare(sql).run(...params.map(toParam));

    return {
        dialect: 'sqlite',
        all: async (sql, params = []) => db.prepare(sql).all(...params.map(toParam)),
        run: async (sql, params = []) => Number(run(sql, params).changes),
        insert: async (sql, params = []) => Number(run(sql, params).lastInsertRowid),
        close: async () => db.close(),
    };
}

module.exports = connect;
