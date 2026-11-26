const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-read-logs-'));

const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const SmsModel = require('../src/models/smsModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createIngest } = require('../src/mail/ingest');
const { createSmsIngest } = require('../src/sms/ingest');
const { createEvents } = require('../src/mail/events');
const { createSmtpServer, listen } = require('../src/mail/smtpServer');
const { KEY_PATTERN } = require('../src/utils/apiKeys');
const { smtpSend } = require('./helpers/smtp');

const ADMIN_TOKEN = 'admin-token-0123456789';
const ADMIN_PASSWORD = 'correct horse battery staple';
const env = {
    ADMIN_TOKEN,
    ADMIN_USERNAME: 'opsadmin',
    ADMIN_PASSWORD,
    VIEWER_USERS: 'viewer:viewer-password-1',
    SESSION_SECRET: 'x'.repeat(48),
};
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const mail = to => `From: App <app@example.com>\r\nTo: ${to}\r\nSubject: Hello ${to}\r\nMessage-ID: <${crypto.randomUUID()}@test>\r\n\r\nBody`;

let db;
let emailModel;
let smsModel;
let apiKeyModel;
let app;
let events;
let ingest;
let smtp;
const readEvents = [];

async function login(username = 'opsadmin', password = ADMIN_PASSWORD) {
    const res = await request(app).post('/auth/login').send({ username, password });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
}

async function createKey(body) {
    const res = await admin(request(app).post('/api/keys')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
}

const keyByName = async name => (await admin(request(app).get('/api/keys'))).body.keys.find(k => k.name === name);
const smtpMail = (port, to, auth) => smtpSend(port, { from: 'app@example.com', to: [to], data: mail(to), auth });
const lastCode = replies => replies[replies.length - 1].code;

before(async () => {
    db = await initializeDatabase();
    const config = loadConfig(env);
    emailModel = new EmailModel(db);
    smsModel = new SmsModel(db);
    apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    events = createEvents();
    events.on('read', event => readEvents.push(event));
    ingest = createIngest({ emailModel, events });
    app = createApp({
        config,
        emailModel,
        smsModel,
        apiKeyModel,
        ingest,
        ingestSms: createSmsIngest({ smsModel, events }),
        events,
    });
    smtp = createSmtpServer({ config, ingest, apiKeyModel });
    smtp.port = await listen(smtp, { port: 0, host: '127.0.0.1' });
});

after(async () => {
    await new Promise(resolve => smtp.close(resolve));
    await db.close();
});

describe('SMTP before any Email key exists', () => {
    test('stays open: any credentials, or none, are accepted', async () => {
        assert.equal(lastCode(await smtpMail(smtp.port, 'open@example.com')), 250);
        assert.equal(lastCode(await smtpMail(smtp.port, 'open2@example.com', { user: 'whoever', pass: 'whatever' })), 250);
    });

    test('an SMS or Read key does not close it', async () => {
        await createKey({ name: 'sms-only', scope: 'send' });
        await createKey({ name: 'reader-only', scope: 'read' });
        assert.equal(lastCode(await smtpMail(smtp.port, 'open3@example.com')), 250);
    });
});

describe('Email keys', () => {
    test('are created with their own key format, and record who created them', async () => {
        const cookie = await login();
        const res = await request(app).post('/api/keys').set('Cookie', cookie).set('X-Requested-With', 'fetch').send({ name: 'mailer-app', scope: 'email' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.match(res.body.secret, KEY_PATTERN);
        assert.ok(res.body.secret.startsWith('ms_email_'));
        assert.equal(res.body.key.scope, 'email');
        assert.equal(res.body.key.createdBy, 'opsadmin');
        assert.equal(res.body.key.messageCount, 0);

        const byToken = await createKey({ name: 'token-made', scope: 'email' });
        assert.equal(byToken.key.createdBy, null);
    });

    test('cannot be limited to recipients, and unknown types are refused', async () => {
        const limited = await admin(request(app).post('/api/keys')).send({ name: 'limited-mailer', scope: 'email', allowedRecipients: 'a@example.com' });
        assert.equal(limited.status, 400);
        assert.ok(limited.body.details.allowedRecipients);
        const unknown = await admin(request(app).post('/api/keys')).send({ name: 'weird', scope: 'both' });
        assert.equal(unknown.status, 400);
        assert.ok(unknown.body.details.scope);
    });

    test('do not work as SMS or Read keys', async () => {
        const { secret } = await createKey({ name: 'mail-only', scope: 'email' });
        const sms = await request(app).post('/api/sms').set('X-API-Key', secret).send({ phone: '+15551234567', message: 'hi' });
        assert.equal(sms.status, 403);
        assert.equal((await request(app).get('/api/emails').set('X-API-Key', secret)).status, 403);
    });
});

describe('SMTP login with Email keys', () => {
    let secret;

    test('once an Email key exists, a login is required', async () => {
        secret = (await createKey({ name: 'smtp-app', scope: 'email' })).secret;
        const anonymous = await smtpMail(smtp.port, 'a@example.com');
        assert.equal(anonymous.find(r => r.code >= 500).code, 530);
    });

    test('the key name is the username and the key is the password', async () => {
        assert.equal(lastCode(await smtpMail(smtp.port, 'b@example.com', { user: 'smtp-app', pass: secret })), 250);
        // names are matched without regard to case, and the email is attributed to the key's own name
        assert.equal(lastCode(await smtpMail(smtp.port, 'c@example.com', { user: 'SMTP-APP', pass: secret })), 250);
        const { emails } = await emailModel.list({ limit: 10, offset: 0, to: 'c@example.com' });
        assert.equal(emails[0].smtpUser, 'smtp-app');
    });

    test('a wrong password, a wrong name, or another type of key is refused', async () => {
        assert.equal(lastCode(await smtpMail(smtp.port, 'x@example.com', { user: 'smtp-app', pass: 'nope' })), 535);
        assert.equal(lastCode(await smtpMail(smtp.port, 'x@example.com', { user: 'someone-else', pass: secret })), 535);
        const sms = await createKey({ name: 'sms-login', scope: 'send' });
        const read = await createKey({ name: 'read-login', scope: 'read' });
        assert.equal(lastCode(await smtpMail(smtp.port, 'x@example.com', { user: 'sms-login', pass: sms.secret })), 535);
        assert.equal(lastCode(await smtpMail(smtp.port, 'x@example.com', { user: 'read-login', pass: read.secret })), 535);
    });

    test('the table counts the key\'s emails, and they follow a rename', async () => {
        assert.equal((await keyByName('smtp-app')).messageCount, 2);
        const key = await keyByName('smtp-app');
        const renamed = await admin(request(app).patch(`/api/keys/${key.id}`)).send({ name: 'smtp-renamed' });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.key.messageCount, 2);
        assert.equal(lastCode(await smtpMail(smtp.port, 'x@example.com', { user: 'smtp-app', pass: secret })), 535);
        assert.equal(lastCode(await smtpMail(smtp.port, 'd@example.com', { user: 'smtp-renamed', pass: secret })), 250);
        assert.equal((await keyByName('smtp-renamed')).messageCount, 3);
    });

    test('a revoked key stops working at once', async () => {
        const key = await keyByName('smtp-renamed');
        assert.equal((await admin(request(app).delete(`/api/keys/${key.id}`))).status, 200);
        assert.equal(lastCode(await smtpMail(smtp.port, 'x@example.com', { user: 'smtp-renamed', pass: secret })), 535);
    });

    test('SMTP_USERNAME and SMTP_PASSWORD keep working next to Email keys', async () => {
        const config = loadConfig({ ...env, SMTP_USERNAME: 'mailer', SMTP_PASSWORD: 'a-long-password' });
        const both = createSmtpServer({ config, ingest, apiKeyModel });
        both.port = await listen(both, { port: 0, host: '127.0.0.1' });
        try {
            const { secret: keySecret } = await createKey({ name: 'with-legacy', scope: 'email' });
            assert.equal(lastCode(await smtpMail(both.port, 'l1@example.com', { user: 'mailer', pass: 'a-long-password' })), 250);
            assert.equal(lastCode(await smtpMail(both.port, 'l2@example.com', { user: 'with-legacy', pass: keySecret })), 250);
            assert.equal(lastCode(await smtpMail(both.port, 'l3@example.com', { user: 'mailer', pass: 'wrong' })), 535);
            assert.equal((await smtpMail(both.port, 'l4@example.com')).find(r => r.code >= 500).code, 530);
        } finally {
            await new Promise(resolve => both.close(resolve));
        }
    });

    test('the dashboard is told that SMTP needs a login, and that a key is how', async () => {
        const info = await admin(request(app).get('/api/info'));
        assert.equal(info.body.smtpAuthRequired, true);
        assert.equal(info.body.smtpKeyLogin, true);
    });
});

describe('read and unread', () => {
    const list = async (path = '/api/emails?pageSize=100') => (await admin(request(app).get(path))).body;
    const mark = (base, body, query = '') => admin(request(app).post(`${base}/read${query}`)).send(body);
    let ids;

    before(async () => {
        await db.run('DELETE FROM attachments');
        await db.run('DELETE FROM emails');
        await db.run('DELETE FROM sms_messages');
        ids = [];
        for (const to of ['a@example.com', 'b@example.com', 'a@example.com']) {
            ids.push((await ingest(Buffer.from(mail(to)), { envelope: { mailFrom: { address: 'app@example.com' }, rcptTo: [{ address: to }] }, smtpUser: null })).id);
        }
        for (const message of ['one', 'two', 'three']) await smsModel.create({ sender: 'App', phone: '+15551234567', message, apiKeyName: null });
    });

    test('new emails are unread, and the list says how many', async () => {
        const body = await list();
        assert.equal(body.emails.length, 3);
        assert.ok(body.emails.every(e => e.read === false));
        assert.equal(body.unreadCount, 3);
    });

    test('marks emails read and unread, by id', async () => {
        const first = await mark('/api/emails', { ids: [ids[0]], read: true });
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.deepEqual([first.body.changed, first.body.unreadCount], [1, 2]);
        assert.equal((await mark('/api/emails', { ids: [ids[0]], read: true })).body.changed, 0); // already read

        const unread = await list('/api/emails?unread=true&pageSize=100');
        assert.deepEqual(unread.emails.map(e => e.id).sort(), [ids[1], ids[2]].sort());
        assert.equal(unread.totalEmails, 2);

        const several = await mark('/api/emails', { ids: [ids[1], ids[2]], read: true });
        assert.deepEqual([several.body.changed, several.body.unreadCount], [2, 0]);
        const back = await mark('/api/emails', { ids: ids.slice(0, 2), read: false });
        assert.deepEqual([back.body.changed, back.body.unreadCount], [2, 2]);
        assert.deepEqual((await list()).emails.map(e => [e.id, e.read]).sort((a, b) => a[0] - b[0]), [[ids[0], false], [ids[1], false], [ids[2], true]]);
    });

    test('marks everything matching the filters', async () => {
        const res = await mark('/api/emails', { matching: true, read: true }, '?to=a@example.com');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.unreadCount, 1); // only b@ is left
        assert.deepEqual((await list('/api/emails?unread=true')).emails.map(e => e.id), [ids[1]]);
        await mark('/api/emails', { matching: true, read: false });
        assert.equal((await list()).unreadCount, 3);
    });

    test('is announced to other dashboards, only when something changed', async () => {
        readEvents.length = 0;
        await mark('/api/emails', { ids: [ids[0]], read: true });
        await mark('/api/emails', { ids: [ids[0]], read: true });
        await mark('/api/emails', { matching: true, read: false });
        assert.deepEqual(readEvents, [
            { kind: 'email', read: true, ids: [ids[0]] },
            { kind: 'email', read: false, ids: null },
        ]);
    });

    test('is for dashboard users: viewers can, API keys and strangers cannot', async () => {
        const viewer = await login('viewer', 'viewer-password-1');
        const asViewer = request(app).post('/api/emails/read').set('Cookie', viewer).set('X-Requested-With', 'fetch');
        assert.equal((await asViewer.send({ ids: [ids[1]], read: true })).status, 200);
        await mark('/api/emails', { ids: [ids[1]], read: false });

        assert.equal((await request(app).post('/api/emails/read').set('Cookie', viewer).send({ ids: [ids[1]], read: true })).status, 403); // no CSRF header
        assert.equal((await request(app).post('/api/emails/read').send({ ids: [ids[1]], read: true })).status, 401);
        const reader = await createKey({ name: 'cannot-mark', scope: 'read' });
        assert.equal((await request(app).post('/api/emails/read').set('X-API-Key', reader.secret).send({ ids: [ids[1]], read: true })).status, 401);
    });

    test('rejects invalid requests', async () => {
        assert.equal((await mark('/api/emails', { ids: [ids[0]] })).status, 400);
        assert.equal((await mark('/api/emails', { ids: [ids[0]], read: 'yes' })).status, 400);
        assert.equal((await mark('/api/emails', { read: true })).status, 400);
        assert.equal((await mark('/api/emails', { ids: [], read: true })).status, 400);
        assert.equal((await mark('/api/emails', { ids: ['x'], read: true })).status, 400);
        assert.equal((await mark('/api/emails', { matching: 'true', read: true })).status, 400); // not the boolean true, so ids are required
    });

    test('reading through the API never marks anything read', async () => {
        const reader = await createKey({ name: 'just-reading', scope: 'read' });
        const key = r => r.set('X-API-Key', reader.secret);
        await key(request(app).get(`/api/emails/${ids[1]}`));
        await key(request(app).get(`/api/emails/${ids[1]}/raw`));
        await key(request(app).get('/api/emails/latest?to=b@example.com'));
        await admin(request(app).get(`/api/emails/${ids[1]}`));
        const body = await list('/api/emails?pageSize=100');
        assert.equal(body.unreadCount, 3);
        assert.ok(body.emails.every(e => !e.read));
    });

    test('an email shows read in its own response too', async () => {
        await mark('/api/emails', { ids: [ids[2]], read: true });
        const one = await admin(request(app).get(`/api/emails/${ids[2]}`));
        assert.equal(one.body.read, true);
    });

    test('works the same for SMS', async () => {
        const body = (await admin(request(app).get('/api/sms?pageSize=100'))).body;
        assert.equal(body.unreadCount, 3);
        assert.ok(body.messages.every(m => m.read === false));
        const smsIds = body.messages.map(m => m.id);

        const one = await mark('/api/sms', { ids: [smsIds[0]], read: true });
        assert.deepEqual([one.body.changed, one.body.unreadCount], [1, 2]);
        const unread = (await admin(request(app).get('/api/sms?unread=true&pageSize=100'))).body;
        assert.equal(unread.totalMessages, 2);
        assert.ok(!unread.messages.some(m => m.id === smsIds[0]));

        readEvents.length = 0;
        const all = await mark('/api/sms', { matching: true, read: true }, '?search=o'); // "one" and "two"; "three" is already read
        assert.equal(all.body.changed, 2);
        assert.deepEqual(readEvents, [{ kind: 'sms', read: true, ids: null }]);
        assert.equal((await mark('/api/sms', { ids: smsIds, read: false })).body.unreadCount, 3);

        const viewer = await login('viewer', 'viewer-password-1');
        assert.equal((await request(app).post('/api/sms/read').set('Cookie', viewer).set('X-Requested-With', 'fetch').send({ ids: [smsIds[0]], read: true })).status, 200);
        assert.equal((await request(app).post('/api/sms/read').send({ ids: [smsIds[0]], read: true })).status, 401);
        assert.equal((await mark('/api/sms', { ids: [smsIds[0]] })).status, 400);
    });
});

describe('upgrading an existing database', () => {
    test('messages stored before read state existed count as read, and new ones do not', async () => {
        const file = path.join(os.tmpdir(), `message-sandbox-old-${process.pid}-${Date.now()}.sqlite`);
        const old = new DatabaseSync(file);
        old.exec("CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
        old.exec("CREATE TABLE sms_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, phone TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
        old.exec("CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, scope TEXT, key_hash TEXT)");
        old.exec("INSERT INTO emails (subject) VALUES ('old')");
        old.exec("INSERT INTO sms_messages (sender, phone, message) VALUES ('App', '+15551234567', 'old')");
        old.close();

        const previous = process.env.SQLITE_PATH;
        process.env.SQLITE_PATH = file;
        let upgraded;
        try {
            upgraded = await require('../src/database/sqlite')();
        } finally {
            process.env.SQLITE_PATH = previous;
        }
        try {
            const [email] = await upgraded.all('SELECT read_at FROM emails');
            const [sms] = await upgraded.all('SELECT read_at FROM sms_messages');
            assert.ok(email.read_at && sms.read_at);
            const key = (await upgraded.all('PRAGMA table_info(api_keys)')).map(c => c.name);
            assert.ok(key.includes('created_by') && key.includes('allowed_recipients'));
            await upgraded.run("INSERT INTO emails (subject) VALUES ('new')");
            const rows = await upgraded.all("SELECT subject, read_at FROM emails ORDER BY id");
            assert.deepEqual(rows.map(r => [r.subject, Boolean(r.read_at)]), [['old', true], ['new', false]]);
        } finally {
            await upgraded.close();
            fs.rmSync(file, { force: true });
        }
    });
});
