const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'email-inspect-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createIngest } = require('../src/mail/ingest');
const { createEvents } = require('../src/mail/events');
const { createSmtpServer, listen } = require('../src/mail/smtpServer');
const { analyzeEmail } = require('../src/mail/analyze');
const { smtpSend } = require('./helpers/smtp');

const ADMIN_TOKEN = 'admin-token-0123456789';
const env = { ADMIN_TOKEN, ADMIN_PASSWORD: 'correct horse battery staple', SESSION_SECRET: 'x'.repeat(48) };

let db;
let smtp;
let smtpPort;
let app;
let appWithoutLinkCheck;
let site;
let siteUrl;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const deliver = (to, lines) => smtpSend(smtpPort, { from: 'app@example.com', to: [to], data: lines.join('\r\n') });
const latest = async to => (await admin(request(app).get('/api/emails/latest')).query({ to })).body;

before(async () => {
    db = await initializeDatabase();
    const config = loadConfig(env);
    const emailModel = new EmailModel(db);
    const events = createEvents();
    const ingest = createIngest({ emailModel, events });
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    app = createApp({ config, emailModel, apiKeyModel, ingest, events });
    appWithoutLinkCheck = createApp({ config: loadConfig({ ...env, LINK_CHECK: 'false' }), emailModel, apiKeyModel, ingest, events });
    smtp = createSmtpServer({ config, ingest });
    smtpPort = await listen(smtp, { port: 0, host: '127.0.0.1' });

    // A site for the link checker: /ok, /gone (404), /no-head (HEAD refused, GET fine), /moved (redirect)
    site = http.createServer((req, res) => {
        if (req.url === '/ok') return res.end('ok');
        if (req.url === '/gone') return res.writeHead(404).end();
        if (req.url === '/no-head') return res.writeHead(req.method === 'HEAD' ? 405 : 200).end();
        if (req.url === '/moved') return res.writeHead(302, { Location: '/ok' }).end();
        res.writeHead(404).end();
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}`;
});

after(async () => {
    await new Promise(resolve => smtp.close(resolve));
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    await db.close();
});

describe('deliverability checks', () => {
    const base = {
        subject: 'Your receipt',
        text: 'hello',
        html: '<p>hello</p>',
        hasTextPart: true,
        headers: [
            { key: 'message-id', value: '<a@x>' },
            { key: 'date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
            { key: 'list-unsubscribe', value: '<mailto:u@x>' },
        ],
        from: { name: '', address: 'app@example.com' },
        envelope: { from: 'app@example.com', to: [] },
    };
    const codes = overrides => analyzeEmail({ ...base, ...overrides }).map(f => f.code);

    test('a well-formed email only gets the viewport note', () => {
        assert.deepEqual(codes({}), ['no-viewport']);
        assert.deepEqual(codes({ html: '<meta name="viewport" content="width=device-width"><p>hi</p>' }), []);
    });

    test('flags the common problems', () => {
        assert.ok(codes({ hasTextPart: false }).includes('no-text-part'));
        assert.ok(!codes({ hasTextPart: null }).includes('no-text-part'), 'unknown for emails stored before this was recorded');
        assert.ok(codes({ subject: '' }).includes('no-subject'));
        assert.ok(codes({ subject: 'LAST CHANCE TO SAVE' }).includes('subject-caps'));
        assert.ok(codes({ subject: 'Act now!!!' }).includes('subject-punctuation'));
        assert.ok(codes({ headers: [] }).includes('no-message-id'));
        assert.ok(codes({ headers: [] }).includes('no-date'));
        assert.ok(codes({ headers: [] }).includes('no-unsubscribe'));
        assert.ok(codes({ text: '', html: '' }).includes('empty-body'));
        assert.ok(codes({ envelope: { from: 'bounce@mailer.example.net', to: [] } }).includes('sender-mismatch'));
        assert.ok(codes({ html: `<p>${'x'.repeat(110 * 1024)}</p>` }).includes('html-large'));
    });

    test('inspects images and links in the HTML', () => {
        const found = codes({
            html: '<img src="http://cdn.example.com/a.png"><img src="https://x/y.png" width="1" height="1" alt=""><a href="http://shop.example.com">buy</a>',
        });
        for (const code of ['img-no-alt', 'img-http', 'tracking-pixel', 'link-http']) assert.ok(found.includes(code), code);
        // local development URLs are not flagged for using http
        assert.ok(!codes({ html: '<a href="http://localhost:3000/verify?t=1">v</a><img src="http://localhost/a.png" alt="">' }).some(c => c === 'link-http' || c === 'img-http'));
        assert.ok(!codes({ html: '<img src="https://x/y.png" width="100" height="10" alt="">' }).includes('tracking-pixel'));
    });
});

describe('API', () => {
    test('a full email carries its checks, and tells HTML-only mail apart', async () => {
        await deliver('htmlonly@example.com', [
            'From: App <app@example.com>', 'To: htmlonly@example.com', 'Subject: Welcome', 'Content-Type: text/html; charset=utf-8', '',
            '<p>Your code is <b>123456</b></p><img src="https://x/y.png">',
        ]);
        const email = await latest('htmlonly@example.com');
        assert.equal(email.hasTextPart, false);
        assert.match(email.text, /Your code is 123456/, 'text is derived from the HTML');
        assert.equal(email.code, '123456');
        assert.match(email.snippet, /Your code is 123456/);
        const codes = email.checks.map(c => c.code);
        assert.ok(codes.includes('no-text-part'));
        assert.ok(codes.includes('no-message-id'));
        assert.ok(codes.includes('img-no-alt'));
        assert.ok(email.checks.every(c => ['warning', 'info'].includes(c.level) && c.message));
    });

    test('a message with a real text part is recognised', async () => {
        await deliver('plain@example.com', ['From: a@example.com', 'To: plain@example.com', 'Subject: Hi', '', 'Just text']);
        const email = await latest('plain@example.com');
        assert.equal(email.hasTextPart, true);
        assert.ok(!email.checks.some(c => c.code === 'no-text-part'));
    });

    test('the preview blocks remote images unless asked', async () => {
        const { id } = await latest('htmlonly@example.com');
        const blocked = await admin(request(app).get(`/api/emails/${id}/preview`));
        assert.match(blocked.headers['content-security-policy'], /img-src data:;/);
        const allowed = await admin(request(app).get(`/api/emails/${id}/preview`)).query({ images: 'true' });
        assert.match(allowed.headers['content-security-policy'], /img-src data: http: https:;/);
        assert.match(allowed.headers['content-security-policy'], /default-src 'none'/);
        assert.match(allowed.headers['content-security-policy'], /sandbox/);
    });
});

describe('threads', () => {
    test('groups replies by Message-ID, In-Reply-To and References', async () => {
        const send = (id, subject, extra = []) =>
            deliver('thread@example.com', ['From: a@example.com', 'To: thread@example.com', `Subject: ${subject}`, `Message-ID: ${id}`, ...extra, '', 'x']);
        await send('<root@example.com>', 'Question');
        await send('<reply1@example.com>', 'Re: Question', ['In-Reply-To: <root@example.com>', 'References: <root@example.com>']);
        await send('<reply2@example.com>', 'Re: Question', ['In-Reply-To: <reply1@example.com>', 'References: <root@example.com> <reply1@example.com>']);
        await deliver('thread@example.com', ['From: a@example.com', 'To: thread@example.com', 'Subject: Unrelated', 'Message-ID: <other@example.com>', '', 'x']);

        const list = (await admin(request(app).get('/api/emails')).query({ to: 'thread@example.com' })).body.emails;
        const byId = Object.fromEntries(list.map(e => [e.messageId, e.id]));

        // the same conversation whichever email you start from, oldest first
        for (const start of ['<root@example.com>', '<reply1@example.com>', '<reply2@example.com>']) {
            const res = await admin(request(app).get(`/api/emails/${byId[start]}/thread`));
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.emails.map(e => e.messageId), ['<root@example.com>', '<reply1@example.com>', '<reply2@example.com>'], start);
        }
        const unrelated = await admin(request(app).get(`/api/emails/${byId['<other@example.com>']}/thread`));
        assert.deepEqual(unrelated.body.emails.map(e => e.messageId), ['<other@example.com>']);
    });

    test('an email with no Message-ID or references has no thread; unknown ids are 404', async () => {
        const { id } = await latest('plain@example.com');
        assert.deepEqual((await admin(request(app).get(`/api/emails/${id}/thread`))).body.emails, []);
        assert.equal((await admin(request(app).get('/api/emails/999999/thread'))).status, 404);
    });
});

describe('link checker', () => {
    test('reports the status of each link, following redirects and retrying GET when HEAD is refused', async () => {
        await deliver('links@example.com', [
            'From: a@example.com', 'To: links@example.com', 'Subject: Links', '',
            `${siteUrl}/ok ${siteUrl}/gone ${siteUrl}/no-head ${siteUrl}/moved http://127.0.0.1:1/nothing-listens`,
        ]);
        const { id } = await latest('links@example.com');
        const res = await admin(request(app).post(`/api/emails/${id}/check-links`));
        assert.equal(res.status, 200);
        const byUrl = Object.fromEntries(res.body.results.map(r => [r.url.replace(siteUrl, '').replace(/^http:\/\/127.0.0.1:1/, 'closed'), r]));
        assert.deepEqual([byUrl['/ok'].ok, byUrl['/ok'].status], [true, 200]);
        assert.deepEqual([byUrl['/gone'].ok, byUrl['/gone'].status], [false, 404]);
        assert.deepEqual([byUrl['/no-head'].ok, byUrl['/no-head'].status], [true, 200]);
        assert.equal(byUrl['/moved'].status, 200);
        assert.equal(byUrl['/moved'].finalUrl, `${siteUrl}/ok`);
        assert.equal(byUrl['closed/nothing-listens'].ok, false);
        assert.ok(byUrl['closed/nothing-listens'].error);
        assert.equal(res.body.skipped, 0);
    });

    test('is admin only and can be turned off', async () => {
        const { id } = await latest('links@example.com');
        const key = (await admin(request(app).post('/api/keys')).send({ name: 'inspector' })).body.secret;
        assert.equal((await request(app).post(`/api/emails/${id}/check-links`).set('X-API-Key', key)).status, 401);
        assert.equal((await request(app).post(`/api/emails/${id}/check-links`)).status, 401);
        const off = await admin(request(appWithoutLinkCheck).post(`/api/emails/${id}/check-links`));
        assert.equal(off.status, 403);
        assert.equal((await admin(request(app).post('/api/emails/999999/check-links'))).status, 404);
    });
});
