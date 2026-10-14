const { Pool } = require('pg');
const { logToFile } = require('../utils/logger');
const { sslOptions } = require('./ssl');

// The model writes SQL with "?" placeholders; Postgres expects $1, $2, ...
function toPgPlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
}

async function connect() {
    logToFile('Initializing PostgreSQL database connection...');
    const pool = new Pool({
        host: process.env.PG_HOST,
        port: process.env.PG_PORT,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
        ssl: sslOptions(process.env.PG_SSL, process.env.PG_SSL_CA),
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS emails (
            id SERIAL PRIMARY KEY,
            message_id TEXT,
            from_address VARCHAR(320) NOT NULL DEFAULT '',
            from_name VARCHAR(255) NOT NULL DEFAULT '',
            to_addresses TEXT NOT NULL DEFAULT '[]',
            cc_addresses TEXT NOT NULL DEFAULT '[]',
            envelope_from VARCHAR(320) NOT NULL DEFAULT '',
            envelope_to TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '',
            snippet VARCHAR(255) NOT NULL DEFAULT '',
            text_body TEXT,
            html_body TEXT,
            headers TEXT NOT NULL DEFAULT '[]',
            raw BYTEA,
            size INTEGER NOT NULL DEFAULT 0,
            attachment_count INTEGER NOT NULL DEFAULT 0,
            has_text_part SMALLINT,
            smtp_user VARCHAR(255),
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE emails ADD COLUMN IF NOT EXISTS has_text_part SMALLINT');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_emails_timestamp ON emails (timestamp)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS attachments (
            id SERIAL PRIMARY KEY,
            email_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            content_type VARCHAR(255) NOT NULL,
            content_id TEXT,
            size INTEGER NOT NULL DEFAULT 0,
            content BYTEA
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments (email_id)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_messages (
            id SERIAL PRIMARY KEY,
            sender VARCHAR(255) NOT NULL DEFAULT '',
            phone VARCHAR(32) NOT NULL,
            message TEXT NOT NULL,
            api_key_name VARCHAR(64),
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_timestamp ON sms_messages (timestamp)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id SERIAL PRIMARY KEY,
            name VARCHAR(64) NOT NULL UNIQUE,
            scope VARCHAR(16) NOT NULL,
            key_hash CHAR(64) NOT NULL UNIQUE,
            key_prefix VARCHAR(32) NOT NULL,
            key_encrypted TEXT NOT NULL,
            source VARCHAR(16) NOT NULL DEFAULT 'dashboard',
            created_at TIMESTAMPTZ NOT NULL,
            last_used_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            allowed_recipients TEXT
        )
    `);
    await pool.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_recipients TEXT');

    return {
        dialect: 'postgres',
        all: async (sql, params = []) => (await pool.query(toPgPlaceholders(sql), params)).rows,
        run: async (sql, params = []) => (await pool.query(toPgPlaceholders(sql), params)).rowCount,
        insert: async (sql, params = []) =>
            (await pool.query(`${toPgPlaceholders(sql)} RETURNING id`, params)).rows[0].id,
        close: () => pool.end(),
    };
}

module.exports = connect;
