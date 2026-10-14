const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'email-test-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createIngest } = require('../src/mail/ingest');
const { createSmtpServer, listen } = require('../src/mail/smtpServer');
const { KEY_PATTERN } = require('../src/utils/apiKeys');
const { smtpSend } = require('./helpers/smtp');

const ADMIN_TOKEN = 'admin-token-0123456789';
const env = {
    ADMIN_TOKEN,
    ADMIN_USERNAME: 'opsadmin',
    ADMIN_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: 'x'.repeat(48),
    MAX_EMAIL_SIZE_MB: '1',
};

let db;
let app;
let smtp;
let smtpPort;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);

const PLAIN_MAIL = [
    'From: Shop <shop@example.com>',
    'To: Alice <alice@example.com>',
    'Subject: Your verification code',
    'Message-ID: <plain-1@example.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your verification code is 482913. Confirm here: https://app.example.com/verify?token=abc123.',
].join('\r\n');

const BOUNDARY = 'BOUNDARY123';
const RICH_MAIL = [
    'From: =?UTF-8?B?w4lsw6h2ZQ==?= <noreply@example.com>',
    'To: bob@example.com',
    'Cc: carol@example.com',
    'Subject: Welcome aboard',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    '',
    `--${BOUNDARY}`,
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p style="color:red">Hello <a href="https://app.example.com/start?a=1&amp;b=2">start</a></p><img src="cid:logo1">',
    '--REL',
    'Content-Type: image/png',
    'Content-ID: <logo1>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--REL--',
    `--${BOUNDARY}`,
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    '',
    'attached notes',
    `--${BOUNDARY}--`,
].join('\r\n');

before(async () => {
    db = await initializeDatabase();
    const config = loadConfig(env);
    const emailModel = new EmailModel(db);
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    const ingest = createIngest({ emailModel });
    app = createApp({ config, emailModel, apiKeyModel, ingest });
    smtp = createSmtpServer({ config, ingest });
    smtpPort = await listen(smtp, { port: 0, host: '127.0.0.1' });
});

after(async () => {
    await new Promise(resolve => smtp.close(resolve));
    await db.close();
});

describe('config', () => {
    test('refuses to start without auth settings', () => {
        assert.throws(() => loadConfig({}), /Invalid auth configuration/);
    });

    test('SMTP credentials must be set together', () => {
        assert.throws(() => loadConfig({ ...env, SMTP_USERNAME: 'mailer' }), /SMTP_USERNAME and SMTP_PASSWORD/);
        assert.equal(loadConfig({ ...env, SMTP_USERNAME: 'mailer', SMTP_PASSWORD: 'a-long-password' }).smtpUsername, 'mailer');
    });

    test('defaults', () => {
        const config = loadConfig(env);
        assert.equal(config.port, 30004);
        assert.equal(config.smtpPort, 1025);
        assert.equal(config.maxEmailBytes, 1048576);
    });
});

describe('receiving mail over SMTP', () => {
    test('stores a plain-text email and exposes its code and links', async () => {
        const replies = await smtpSend(smtpPort, { from: 'shop@example.com', to: ['alice@example.com', 'hidden-bcc@example.com'], data: PLAIN_MAIL });
        assert.equal(replies[replies.length - 1].code, 250, replies[replies.length - 1].text);

        const res = await admin(request(app).get('/api/emails/latest')).query({ to: 'ALICE@example.com' });
        assert.equal(res.status, 200);
        assert.equal(res.body.subject, 'Your verification code');
        assert.deepEqual(res.body.from, { name: 'Shop', address: 'shop@example.com' });
        assert.deepEqual(res.body.to, [{ name: 'Alice', address: 'alice@example.com' }]);
        assert.deepEqual(res.body.envelope.to, ['alice@example.com', 'hidden-bcc@example.com']);
        assert.equal(res.body.code, '482913');
        assert.deepEqual(res.body.links, ['https://app.example.com/verify?token=abc123']);
        assert.match(res.body.text, /verification code is 482913/);
        assert.equal(res.body.html, null);
        assert.ok(res.body.headers.some(h => h.key === 'message-id' || h.key === 'Message-ID'));
    });

    test('a BCC recipient is found by the envelope', async () => {
        const res = await admin(request(app).get('/api/emails/latest')).query({ to: 'hidden-bcc@example.com' });
        assert.equal(res.status, 200);
        assert.equal(res.body.subject, 'Your verification code');
    });

    test('parses HTML, inline images and attachments', async () => {
        const replies = await smtpSend(smtpPort, { from: 'noreply@example.com', to: ['bob@example.com'], data: RICH_MAIL });
        assert.equal(replies[replies.length - 1].code, 250);

        const list = await admin(request(app).get('/api/emails')).query({ subject: 'welcome' });
        assert.equal(list.body.totalEmails, 1);
        const summary = list.body.emails[0];
        assert.equal(summary.attachmentCount, 2);
        assert.equal(summary.text, undefined, 'the list does not carry bodies');
        assert.equal(summary.from.name, 'Élève');

        const email = (await admin(request(app).get(`/api/emails/${summary.id}`))).body;
        assert.deepEqual(email.cc, [{ name: '', address: 'carol@example.com' }]);
        assert.match(email.html, /cid:logo1/, 'cid references are kept as received');
        assert.deepEqual(email.links, ['https://app.example.com/start?a=1&b=2']);
        const file = email.attachments.find(a => a.filename === 'notes.txt');
        assert.ok(file);

        const download = await admin(request(app).get(file.url));
        assert.equal(download.status, 200);
        assert.match(download.headers['content-disposition'], /attachment/);
        assert.equal(download.text, 'attached notes');

        const raw = await admin(request(app).get(`/api/emails/${summary.id}/raw`));
        assert.equal(raw.status, 200);
        assert.match(raw.text, /Subject: Welcome aboard/);
    });

    test('the preview inlines cid images and locks the page down', async () => {
        const list = await admin(request(app).get('/api/emails')).query({ subject: 'welcome' });
        const res = await admin(request(app).get(`/api/emails/${list.body.emails[0].id}/preview`));
        assert.equal(res.status, 200);
        assert.match(res.text, /src="data:image\/png;base64,/);
        assert.doesNotMatch(res.text, /cid:logo1/);
        const csp = res.headers['content-security-policy'];
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /sandbox/);
        assert.doesNotMatch(csp, /script-src/);
    });

    test('search covers subject, sender and body', async () => {
        const count = async search => (await admin(request(app).get('/api/emails')).query({ search })).body.totalEmails;
        assert.equal(await count('verification'), 1);
        assert.equal(await count('shop@example'), 1);
        assert.equal(await count('attached notes'), 0, 'attachments are not searched');
        assert.equal(await count('50%'), 0, 'wildcards are matched literally');
        assert.equal(await count('welcome'), 1);
    });

    test('rejects a message over the size limit', async () => {
        const line = 'x'.repeat(78);
        const filler = Array(14000).fill(line).join('\r\n'); // about 1.1 MB, over the 1 MB test limit
        const big = [PLAIN_MAIL, filler].join('\r\n');
        const replies = await smtpSend(smtpPort, { from: 'a@example.com', to: ['b@example.com'], data: big });
        assert.equal(replies[replies.length - 1].code, 552);
    });
});

describe('SMTP login', () => {
    let secured;
    before(async () => {
        const config = loadConfig({ ...env, SMTP_USERNAME: 'mailer', SMTP_PASSWORD: 'a-long-password' });
        const emailModel = new EmailModel(db);
        secured = createSmtpServer({ config, ingest: createIngest({ emailModel }) });
        secured.port = await listen(secured, { port: 0, host: '127.0.0.1' });
    });
    after(() => new Promise(resolve => secured.close(resolve)));

    test('requires the configured credentials', async () => {
        const mail = { from: 'a@example.com', to: ['b@example.com'], data: PLAIN_MAIL };
        const anonymous = await smtpSend(secured.port, mail);
        assert.equal(anonymous.find(r => r.code >= 500).code, 530);

        const wrong = await smtpSend(secured.port, { ...mail, auth: { user: 'mailer', pass: 'nope' } });
        assert.equal(wrong[wrong.length - 1].code, 535);

        const right = await smtpSend(secured.port, { ...mail, auth: { user: 'mailer', pass: 'a-long-password' } });
        assert.equal(right[right.length - 1].code, 250);
    });
});

describe('API access', () => {
    test('requires authentication', async () => {
        assert.equal((await request(app).get('/api/emails')).status, 401);
        assert.equal((await request(app).get('/api/emails/1/preview')).status, 401);
    });

    test('a Read key can read but not delete or add emails', async () => {
        const created = await admin(request(app).post('/api/keys')).send({ name: 'ci-reader' });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const key = created.body.secret;
        assert.match(key, KEY_PATTERN);
        assert.ok(key.startsWith('ms_read_'));

        assert.equal((await request(app).get('/api/emails').set('X-API-Key', key)).status, 200);
        assert.equal((await request(app).get('/api/emails').set('Authorization', `bearer ${key}`)).status, 200);
        assert.equal((await request(app).delete('/api/emails/1').set('X-API-Key', key)).status, 401);
        assert.equal((await request(app).post('/api/emails/test').set('X-API-Key', key).send({})).status, 401);

        // Revoked keys stop working
        await admin(request(app).delete(`/api/keys/${created.body.key.id}`));
        assert.equal((await request(app).get('/api/emails').set('X-API-Key', key)).status, 401);
    });

    test('validates list filters', async () => {
        const res = await admin(request(app).get('/api/emails')).query({ pageSize: 1000, startDate: 'yesterday' });
        assert.equal(res.status, 400);
        assert.ok(res.body.details.pageSize && res.body.details.startDate);
    });

    test('"Send test" stores an email like SMTP does', async () => {
        const res = await admin(request(app).post('/api/emails/test')).send({
            from: 'tester@example.com',
            fromName: 'Tester',
            to: 'dave@example.com, erin@example.com',
            subject: 'Prüfung ✓',
            text: 'Plain version, code 135790',
            html: '<b>HTML version</b>',
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const email = (await admin(request(app).get(`/api/emails/${res.body.id}`))).body;
        assert.equal(email.subject, 'Prüfung ✓');
        assert.equal(email.from.name, 'Tester');
        assert.deepEqual(email.envelope.to, ['dave@example.com', 'erin@example.com']);
        assert.match(email.text, /Plain version/);
        assert.match(email.html, /<b>HTML version<\/b>/);
        assert.equal(email.code, '135790');
    });

    test('"Send test" rejects bad input, including header injection', async () => {
        const res = await admin(request(app).post('/api/emails/test')).send({
            from: 'not-an-address',
            to: '',
            subject: 'Hi\r\nBcc: evil@example.com',
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.details.from && res.body.details.to && res.body.details.subject && res.body.details.text);
    });

    test('deleting an email removes its attachments too', async () => {
        const list = await admin(request(app).get('/api/emails')).query({ subject: 'welcome' });
        const { id } = list.body.emails[0];
        assert.equal((await admin(request(app).delete('/api/emails')).send({ ids: [id] })).body.deleted, 1);
        assert.equal((await admin(request(app).get(`/api/emails/${id}`))).status, 404);
        const orphans = await db.all('SELECT id FROM attachments WHERE email_id = ?', [id]);
        assert.equal(orphans.length, 0);
        assert.equal((await admin(request(app).delete(`/api/emails/${id}`))).status, 404);
    });

    test('retention deletes old emails', async () => {
        const model = new EmailModel(db);
        const before = (await model.list({ limit: 100, offset: 0 })).total;
        const removed = await model.deleteOlderThan(new Date(Date.now() + 1000));
        assert.equal(removed, before);
        assert.equal((await model.list({ limit: 100, offset: 0 })).total, 0);
    });
});
