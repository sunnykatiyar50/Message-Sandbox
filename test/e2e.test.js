const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'email-e2e-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createIngest } = require('../src/mail/ingest');
const { createEvents } = require('../src/mail/events');
const { createWebhook } = require('../src/mail/webhook');
const { createSmtpServer, listen } = require('../src/mail/smtpServer');
const { createClient, EmailTimeoutError, EmailTestError } = require('../client');
const { smtpSend } = require('./helpers/smtp');

const ADMIN_TOKEN = 'admin-token-0123456789';
const WEBHOOK_SECRET = 'webhook-secret-0123456789';
const env = {
    ADMIN_TOKEN,
    ADMIN_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: 'x'.repeat(48),
};

let db;
let app;
let smtp;
let smtpPort;
let httpServer;
let baseUrl;
let receiver;
let received = [];
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);

const mail = (to, subject, body) =>
    ['From: App <app@example.com>', `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
const deliver = (to, subject, body) => smtpSend(smtpPort, { from: 'app@example.com', to: [to], data: mail(to, subject, body) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
    db = await initializeDatabase();

    // A webhook receiver that records what it is sent
    receiver = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
            res.end('ok');
        });
    });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));

    const config = loadConfig({ ...env, WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/hook`, WEBHOOK_SECRET });
    const emailModel = new EmailModel(db);
    const events = createEvents();
    const ingest = createIngest({
        emailModel,
        events,
        webhook: createWebhook({ url: config.webhookUrl, secret: config.webhookSecret }),
    });
    app = createApp({ config, emailModel, apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }), ingest, events });
    smtp = createSmtpServer({ config, ingest });
    smtpPort = await listen(smtp, { port: 0, host: '127.0.0.1' });
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => httpServer.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
    await new Promise(resolve => smtp.close(resolve));
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
    await new Promise(resolve => receiver.close(resolve));
    await db.close();
});

describe('recipient filter', () => {
    test('matches the exact address, not a substring, in To, Cc and the envelope', async () => {
        await deliver('malice@example.com', 'For malice', 'x');
        await deliver('alice@example.com', 'For alice', 'x');
        const subjects = async to => (await admin(request(app).get('/api/emails')).query({ to })).body.emails.map(e => e.subject);
        assert.deepEqual(await subjects('alice@example.com'), ['For alice']);
        assert.deepEqual(await subjects('ALICE@Example.com'), ['For alice']);
        assert.deepEqual(await subjects('malice@example.com'), ['For malice']);
        assert.deepEqual(await subjects('lice@example.com'), []);
    });
});

describe('GET /api/emails/wait', () => {
    test('returns an email that is already stored immediately', async () => {
        await deliver('stored@example.com', 'Already here', 'Code 111222');
        const started = Date.now();
        const res = await admin(request(app).get('/api/emails/wait')).query({ to: 'stored@example.com' });
        assert.equal(res.status, 200);
        assert.equal(res.body.subject, 'Already here');
        assert.equal(res.body.code, '111222');
        assert.ok(Date.now() - started < 1000);
    });

    test('waits for an email that arrives later', async () => {
        const waiting = admin(request(app).get('/api/emails/wait')).query({ to: 'later@example.com', timeout: 10 }).then(r => r);
        await delay(300);
        await deliver('other@example.com', 'Not for you', 'x'); // a non-matching email doesn't end the wait
        await delay(100);
        await deliver('later@example.com', 'Finally', 'Open https://app.example.com/go?x=1');
        const res = await waiting;
        assert.equal(res.status, 200);
        assert.equal(res.body.subject, 'Finally');
        assert.deepEqual(res.body.links, ['https://app.example.com/go?x=1']);
    });

    test('answers 408 when nothing arrives in time', async () => {
        const started = Date.now();
        const res = await admin(request(app).get('/api/emails/wait')).query({ to: 'nobody@example.com', timeout: 1 });
        assert.equal(res.status, 408);
        assert.match(res.body.error, /within 1 seconds/);
        assert.ok(Date.now() - started >= 900);
    });

    test('`after` skips older emails', async () => {
        await deliver('stale@example.com', 'Old news', 'x');
        const cutoff = new Date(Date.now() + 5).toISOString();
        await delay(20);
        const missed = await admin(request(app).get('/api/emails/wait')).query({ to: 'stale@example.com', after: cutoff, timeout: 1 });
        assert.equal(missed.status, 408);

        const waiting = admin(request(app).get('/api/emails/wait')).query({ to: 'stale@example.com', after: cutoff, timeout: 10 }).then(r => r);
        await delay(200);
        await deliver('stale@example.com', 'Fresh news', 'x');
        assert.equal((await waiting).body.subject, 'Fresh news');
    });

    test('validates the timeout and requires authentication', async () => {
        assert.equal((await admin(request(app).get('/api/emails/wait')).query({ timeout: 0 })).status, 400);
        assert.equal((await admin(request(app).get('/api/emails/wait')).query({ timeout: 500 })).status, 400);
        assert.equal((await request(app).get('/api/emails/wait')).status, 401);
    });
});

describe('clearing an inbox', () => {
    test('DELETE /api/emails?to= removes only that address', async () => {
        await deliver('clear-me@example.com', 'One', 'x');
        await deliver('clear-me@example.com', 'Two', 'x');
        await deliver('keep-me@example.com', 'Keep', 'x');
        const res = await admin(request(app).delete('/api/emails')).query({ to: 'clear-me@example.com' });
        assert.equal(res.status, 200);
        assert.equal(res.body.deleted, 2);
        const left = (await admin(request(app).get('/api/emails')).query({ to: 'keep-me@example.com' })).body;
        assert.equal(left.totalEmails, 1);
        assert.equal((await admin(request(app).get('/api/emails')).query({ to: 'clear-me@example.com' })).body.totalEmails, 0);
    });

    test('never deletes everything: ids or a recipient are required, and only admins may delete', async () => {
        const nothing = await admin(request(app).delete('/api/emails'));
        assert.equal(nothing.status, 400);
        const total = (await admin(request(app).get('/api/emails'))).body.totalEmails;
        assert.ok(total > 0);

        const key = (await admin(request(app).post('/api/keys')).send({ name: 'reader' })).body.secret;
        assert.equal((await request(app).delete('/api/emails').query({ to: 'keep-me@example.com' }).set('X-API-Key', key)).status, 401);
    });
});

describe('webhook', () => {
    test('is POSTed a signed summary with the code and links for every stored email', async () => {
        received = [];
        await deliver('hook@example.com', 'Verify', 'Your code is 654321. https://app.example.com/v?t=1');
        for (let i = 0; i < 50 && received.length === 0; i += 1) await delay(50);
        assert.equal(received.length, 1);

        const { headers, body } = received[0];
        assert.equal(headers['x-message-sandbox-event'], 'email.received');
        const expected = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
        assert.equal(headers['x-signature-256'], expected);

        const { event, email } = JSON.parse(body);
        assert.equal(event, 'email.received');
        assert.equal(email.subject, 'Verify');
        assert.equal(email.code, '654321');
        assert.deepEqual(email.links, ['https://app.example.com/v?t=1']);
        assert.equal(email.text, undefined, 'bodies are fetched from the API, not sent');
        assert.deepEqual(email.envelope.to, ['hook@example.com']);
    });

    test('rejects a malformed URL in the config', () => {
        assert.throws(() => loadConfig({ ...env, WEBHOOK_URL: 'ftp://example.com' }), /WEBHOOK_URL/);
        assert.equal(createWebhook({ url: '', secret: '' }), null);
    });
});

describe('client', () => {
    const client = () => createClient({ baseUrl, apiKey: ADMIN_TOKEN });

    test('waitForCode and waitForLink read what the app sent', async () => {
        const mailbox = client();
        const code = mailbox.waitForCode({ to: 'client@example.com', timeout: 10 });
        const link = mailbox.waitForLink({ to: 'client@example.com', timeout: 10, match: /reset/ });
        await delay(200);
        await deliver('client@example.com', 'Reset', 'Your code is 909090. https://app.example.com/other https://app.example.com/reset?t=9');
        assert.equal(await code, '909090');
        assert.equal(await link, 'https://app.example.com/reset?t=9');
    });

    test('waitForEmail throws EmailTimeoutError, and Date filters are accepted', async () => {
        await assert.rejects(client().waitForEmail({ to: 'never@example.com', timeout: 1, after: new Date() }), EmailTimeoutError);
    });

    test('latestEmail, listEmails and clearInbox', async () => {
        const mailbox = client();
        await deliver('tidy@example.com', 'Tidy', 'x');
        assert.equal((await mailbox.latestEmail({ to: 'tidy@example.com' })).subject, 'Tidy');
        assert.equal((await mailbox.listEmails({ to: 'tidy@example.com' })).totalEmails, 1);
        assert.equal(await mailbox.clearInbox('tidy@example.com'), 1);
        assert.equal(await mailbox.latestEmail({ to: 'tidy@example.com' }), null);
    });

    test('reports API errors', async () => {
        const bad = createClient({ baseUrl, apiKey: 'wrong-key' });
        await assert.rejects(bad.listEmails(), err => err instanceof EmailTestError && err.status === 401);
        await assert.rejects(client().waitForCode({ to: 'nocode@example.com', timeout: 1 }), EmailTimeoutError);
    });
});
