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
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'message-sandbox-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const SmsModel = require('../src/models/smsModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createIngest } = require('../src/mail/ingest');
const { createSmsIngest } = require('../src/sms/ingest');
const { createEvents } = require('../src/mail/events');
const { createWebhook } = require('../src/mail/webhook');
const { createSessionToken } = require('../src/utils/session');
const { createClient, EmailTimeoutError } = require('../client');
const { KEY_PATTERN } = require('../src/utils/apiKeys');

const ADMIN_TOKEN = 'admin-token-0123456789';
const ADMIN_PASSWORD = 'correct horse battery staple';
const WEBHOOK_SECRET = 'webhook-secret-0123456789';
const env = {
    ADMIN_TOKEN,
    ADMIN_USERNAME: 'opsadmin',
    ADMIN_PASSWORD,
    VIEWER_USERS: 'alice:alice-password-1',
    SESSION_SECRET: 'x'.repeat(48),
};

let db;
let smsModel;
let app;
let httpServer;
let baseUrl;
let receiver;
let received = [];
let sendKey;
let readKey;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const send = body => request(app).post('/api/sms').set('X-API-Key', sendKey).send(body);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function createKey(body) {
    const res = await admin(request(app).post('/api/keys')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
}

before(async () => {
    db = await initializeDatabase();
    smsModel = new SmsModel(db);
    const emailModel = new EmailModel(db);

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
    const events = createEvents();
    const webhook = createWebhook({ url: config.webhookUrl, secret: config.webhookSecret });
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    app = createApp({
        config,
        emailModel,
        smsModel,
        apiKeyModel,
        ingest: createIngest({ emailModel, events, webhook }),
        ingestSms: createSmsIngest({ smsModel, events, webhook }),
        events,
    });
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => httpServer.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

    sendKey = (await createKey({ name: 'ci', scope: 'send' })).secret;
    readKey = (await createKey({ name: 'reader', scope: 'read' })).secret;
});

after(async () => {
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
    await new Promise(resolve => receiver.close(resolve));
    await db.close();
});

describe('keys', () => {
    test('Send and Read keys carry their type, and a Send key cannot be limited to inboxes', async () => {
        assert.match(sendKey, KEY_PATTERN);
        assert.ok(sendKey.startsWith('ms_send_'));
        assert.ok(readKey.startsWith('ms_read_'));
        const limited = await admin(request(app).post('/api/keys')).send({ name: 'bad', scope: 'send', allowedRecipients: 'a@example.com' });
        assert.equal(limited.status, 400);
        assert.match(limited.body.details.allowedRecipients, /Read key/);
        assert.equal((await admin(request(app).post('/api/keys')).send({ name: 'bad2', scope: 'admin' })).status, 400);
    });

    test('the key list counts the SMS each key submitted', async () => {
        await send({ phone: '15551110000', message: 'counted' });
        const keys = (await admin(request(app).get('/api/keys'))).body.keys;
        assert.ok(keys.find(k => k.name === 'ci').messageCount >= 1);
        assert.equal(keys.find(k => k.name === 'reader').messageCount, 0);
    });

    test('a revoked key\'s name can be used again, and its SMS stay with the revoked key', async () => {
        const first = await createKey({ name: 'reuse-me', scope: 'send' });
        const sendWith = secret => request(app).post('/api/sms').set('X-API-Key', secret).send({ phone: '15552220000', message: 'hello' });
        assert.equal((await sendWith(first.secret)).status, 201);

        // an active key keeps its name
        const duplicate = await admin(request(app).post('/api/keys')).send({ name: 'REUSE-me', scope: 'send' });
        assert.equal(duplicate.status, 400);
        assert.match(duplicate.body.details.name, /already used/);

        assert.equal((await admin(request(app).delete(`/api/keys/${first.key.id}`))).status, 200);
        const second = await createKey({ name: 'reuse-me', scope: 'send' });
        assert.equal(second.key.name, 'reuse-me');
        assert.equal((await sendWith(first.secret)).status, 401);
        assert.equal((await sendWith(second.secret)).status, 201);

        const keys = (await admin(request(app).get('/api/keys'))).body.keys;
        const old = keys.find(k => k.id === first.key.id);
        assert.equal(old.name, `reuse-me (revoked #${first.key.id})`);
        assert.ok(old.revokedAt);
        assert.equal(old.messageCount, 1);
        assert.equal(keys.find(k => k.id === second.key.id).messageCount, 1);

        // and again: each revoked key keeps its own name
        await admin(request(app).delete(`/api/keys/${second.key.id}`));
        assert.equal((await createKey({ name: 'reuse-me', scope: 'read' })).key.name, 'reuse-me');
    });

    test('an active key can be renamed; its SMS count follows and its secret keeps working', async () => {
        const key = await createKey({ name: 'before-rename', scope: 'send' });
        const other = await createKey({ name: 'rename-taken', scope: 'send' });
        const rename = (id, name) => admin(request(app).patch(`/api/keys/${id}`)).send({ name });
        const sendWith = secret => request(app).post('/api/sms').set('X-API-Key', secret).send({ phone: '15553330000', message: 'hi' });
        assert.equal((await sendWith(key.secret)).status, 201);

        const renamed = await rename(key.key.id, '  after-rename  ');
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.key.name, 'after-rename');
        assert.equal(renamed.body.key.messageCount, 1);
        assert.equal((await sendWith(key.secret)).status, 201);
        const keys = (await admin(request(app).get('/api/keys'))).body.keys;
        assert.equal(keys.find(k => k.id === key.key.id).messageCount, 2);
        assert.ok(!keys.some(k => k.name === 'before-rename'));

        assert.equal((await rename(key.key.id, 'AFTER-rename')).status, 200);       // only the case changes
        assert.equal((await rename(key.key.id, 'RENAME-taken')).status, 400);       // another active key's name
        assert.equal((await rename(key.key.id, 'dashboard')).status, 400);
        assert.equal((await rename(key.key.id, '')).status, 400);
        assert.equal((await rename(999999, 'nobody')).status, 404);

        await admin(request(app).delete(`/api/keys/${other.key.id}`));
        assert.equal((await rename(other.key.id, 'revoked-rename')).status, 409);   // revoked keys keep their name
        assert.equal((await rename(key.key.id, 'rename-taken')).status, 200);       // a revoked key's name is free
    });

    test('only a revoked key can be deleted for good', async () => {
        const key = await createKey({ name: 'to-delete', scope: 'read' });
        const remove = id => admin(request(app).delete(`/api/keys/${id}?permanent=true`));
        assert.equal((await remove(key.key.id)).status, 409);                       // still active
        assert.ok((await admin(request(app).get('/api/keys'))).body.keys.some(k => k.id === key.key.id));
        await admin(request(app).delete(`/api/keys/${key.key.id}`));                // revoke
        assert.equal((await remove(key.key.id)).status, 200);
        assert.ok(!(await admin(request(app).get('/api/keys'))).body.keys.some(k => k.id === key.key.id));
        assert.equal((await remove(key.key.id)).status, 404);
        assert.equal((await remove(999999)).status, 404);
        assert.equal((await createKey({ name: 'to-delete', scope: 'read' })).key.name, 'to-delete');
    });
});

describe('sending SMS', () => {
    test('needs a Send key', async () => {
        const body = { phone: '15551234567', message: 'hi' };
        assert.equal((await request(app).post('/api/sms').send(body)).status, 401);
        assert.equal((await request(app).post('/api/sms').set('X-API-Key', 'wrong-key-0123456789').send(body)).status, 401);
        const readOnly = await request(app).post('/api/sms').set('X-API-Key', readKey).send(body);
        assert.equal(readOnly.status, 403);
        assert.match(readOnly.body.error, /needs a send key/);
    });

    test('accepts the key as a bearer token in any letter case', async () => {
        const res = await request(app).post('/api/sms').set('Authorization', `bEaReR ${sendKey}`).send({ phone: '15551234567', message: 'bearer' });
        assert.equal(res.status, 201);
    });

    test('validates the payload', async () => {
        const res = await send({ phone: 'abc', message: '' });
        assert.equal(res.status, 400);
        assert.ok(res.body.details.phone);
        assert.ok(res.body.details.message);
        assert.equal((await send({ phone: '15551234567', message: 'a'.repeat(1601) })).status, 400);
        assert.equal((await send({ phone: '15551234567', sender: 'x'.repeat(65), message: 'hi' })).status, 400);
    });

    test('rejects malformed JSON with 400', async () => {
        const res = await request(app).post('/api/sms').set('X-API-Key', sendKey).set('Content-Type', 'application/json').send('{"phone":');
        assert.equal(res.status, 400);
    });

    test('stores the message, normalizes the phone number and records the key name', async () => {
        const res = await send({ sender: 'MyApp', phone: '+1 (555) 123-4567', message: 'Your OTP is 123456' });
        assert.equal(res.status, 201);
        assert.ok(res.body.id > 0);
        const stored = (await admin(request(app).get('/api/sms?unmask=true'))).body.messages.find(m => m.id === res.body.id);
        assert.equal(stored.phone, '+15551234567');
        assert.equal(stored.apiKeyName, 'ci');
        assert.equal(stored.code, '123456');
    });

    test('a dashboard session can send through the test form; a viewer cannot', async () => {
        const login = async (username, password) => {
            const res = await request(app).post('/auth/login').send({ username, password });
            return res.headers['set-cookie'][0].split(';')[0];
        };
        const adminCookie = await login('opsadmin', ADMIN_PASSWORD);
        const sent = await request(app).post('/api/sms').set('Cookie', adminCookie).set('X-Requested-With', 'fetch')
            .send({ sender: 'Form', phone: '15550000007', message: 'from dashboard' });
        assert.equal(sent.status, 201);
        const stored = (await admin(request(app).get('/api/sms/latest?phone=15550000007'))).body;
        assert.equal(stored.apiKeyName, 'dashboard');

        const viewerCookie = await login('alice', 'alice-password-1');
        assert.equal((await request(app).get('/api/sms').set('Cookie', viewerCookie)).status, 200);
        assert.equal((await request(app).get('/api/emails').set('Cookie', viewerCookie)).status, 200);
        const refused = await request(app).post('/api/sms').set('Cookie', viewerCookie).set('X-Requested-With', 'fetch').send({ phone: '15550000007', message: 'nope' });
        assert.equal(refused.status, 403);
        assert.equal((await request(app).delete('/api/sms/1').set('Cookie', viewerCookie).set('X-Requested-With', 'fetch')).status, 403);
    });

    test('the rate limit applies per client', async () => {
        const limited = createApp({
            config: loadConfig({ ...env, SMS_RATE_LIMIT: '2' }),
            emailModel: new EmailModel(db),
            smsModel,
            apiKeyModel: new ApiKeyModel(db, { encryptionSecret: 'x'.repeat(48) }),
            ingest: async () => ({}),
            ingestSms: createSmsIngest({ smsModel }),
            events: createEvents(),
        });
        const key = sendKey;
        const post = () => request(limited).post('/api/sms').set('X-API-Key', key).send({ phone: '15553334444', message: 'rate' });
        assert.equal((await post()).status, 201);
        assert.equal((await post()).status, 201);
        assert.equal((await post()).status, 429);
    });
});

describe('reading SMS', () => {
    test('needs authentication', async () => {
        assert.equal((await request(app).get('/api/sms')).status, 401);
        assert.equal((await request(app).get('/api/sms/latest')).status, 401);
        assert.equal((await request(app).get('/api/sms/wait')).status, 401);
        assert.equal((await request(app).delete('/api/sms/1')).status, 401);
        // a Send key cannot read
        assert.equal((await request(app).get('/api/sms').set('X-API-Key', sendKey)).status, 403);
    });

    test('a Read key reads, masks phone numbers by default, and cannot delete', async () => {
        await send({ phone: '919876543210', message: 'mask me' });
        const res = await request(app).get('/api/sms?search=mask%20me').set('X-API-Key', readKey);
        assert.equal(res.status, 200);
        assert.equal(res.body.messages[0].phone, '********3210');
        assert.equal((await request(app).delete(`/api/sms/${res.body.messages[0].id}`).set('X-API-Key', readKey)).status, 401);
    });

    test('returns XSS payloads as inert data', async () => {
        const payload = '<img src=x onerror=alert(1)>';
        await send({ sender: '<script>x</script>', phone: '15550000001', message: payload });
        const res = await admin(request(app).get('/api/sms/latest?phone=15550000001'));
        assert.equal(res.body.message, payload);
        assert.ok(res.headers['content-type'].startsWith('application/json'));
    });

    test('latest returns the newest message for a phone number, with its code', async () => {
        await send({ phone: '15550000002', message: 'Your code is 111111' });
        await send({ phone: '15550000002', message: 'Your code is 222222' });
        const res = await admin(request(app).get('/api/sms/latest?phone=15550000002'));
        assert.equal(res.body.message, 'Your code is 222222');
        assert.equal(res.body.code, '222222');
        assert.equal((await admin(request(app).get('/api/sms/latest?phone=15559999999'))).status, 404);
    });

    test('paginates, searches and filters by date', async () => {
        for (let i = 0; i < 12; i += 1) await send({ phone: '15550000003', message: `page test ${i}` });
        const page1 = (await admin(request(app).get('/api/sms?phone=15550000003&pageSize=5'))).body;
        assert.equal(page1.messages.length, 5);
        assert.equal(page1.totalMessages, 12);
        assert.equal(page1.totalPages, 3);
        assert.equal(page1.messages[0].message, 'page test 11');
        assert.equal((await admin(request(app).get('/api/sms?phone=15550000003&pageSize=5&page=3'))).body.messages.length, 2);

        await send({ sender: 'UniqueSenderName', phone: '15550000004', message: 'abc' });
        assert.equal((await admin(request(app).get('/api/sms?search=uniquesender'))).body.totalMessages, 1);
        assert.equal((await admin(request(app).get('/api/sms?search=15550000004'))).body.totalMessages, 1);
        assert.equal((await admin(request(app).get('/api/sms?search=50%25'))).body.totalMessages, 0, 'wildcards are matched literally');

        const today = new Date().toISOString().slice(0, 10);
        assert.ok((await admin(request(app).get(`/api/sms?startDate=${today}&endDate=${today}`))).body.totalMessages > 0);
        assert.equal((await admin(request(app).get('/api/sms?startDate=2000-01-01&endDate=2000-01-02'))).body.totalMessages, 0);
        assert.equal((await admin(request(app).get('/api/sms?after=2000-01-01T00:00:00Z&before=2000-01-02T00:00:00Z'))).body.totalMessages, 0);
    });

    test('validates the query', async () => {
        assert.equal((await admin(request(app).get('/api/sms?pageSize=1000'))).status, 400);
        assert.equal((await admin(request(app).get('/api/sms?startDate=yesterday'))).status, 400);
        assert.equal((await admin(request(app).get('/api/sms/wait?timeout=500'))).status, 400);
    });

    test('a Read key limited to some email inboxes cannot read SMS', async () => {
        const limited = await createKey({ name: 'email-only', scope: 'read', allowedRecipients: 'someone@example.com' });
        for (const url of ['/api/sms', '/api/sms/latest', '/api/sms/wait?timeout=1']) {
            const res = await request(app).get(url).set('X-API-Key', limited.secret);
            assert.equal(res.status, 403, url);
            assert.match(res.body.error, /cannot read SMS/);
        }
        assert.equal((await request(app).get('/api/emails').set('X-API-Key', limited.secret)).status, 200);
    });
});

describe('waiting for an SMS', () => {
    test('returns one that is already stored immediately', async () => {
        await send({ phone: '15551230001', message: 'Code 313131' });
        const started = Date.now();
        const res = await admin(request(app).get('/api/sms/wait?phone=15551230001'));
        assert.equal(res.status, 200);
        assert.equal(res.body.code, '313131');
        assert.ok(Date.now() - started < 1000);
    });

    test('waits for one that arrives later, ignoring other numbers', async () => {
        const waiting = admin(request(app).get('/api/sms/wait?phone=15551230002&timeout=10')).then(r => r);
        await delay(300);
        await send({ phone: '15551230099', message: 'not for you' });
        await delay(100);
        await send({ phone: '15551230002', message: 'Code 424242' });
        const res = await waiting;
        assert.equal(res.status, 200);
        assert.equal(res.body.code, '424242');
        assert.equal(res.body.phone, '*******0002');
    });

    test('answers 408 when nothing arrives, and `after` skips older messages', async () => {
        const res = await admin(request(app).get('/api/sms/wait?phone=15551230003&timeout=1'));
        assert.equal(res.status, 408);
        assert.match(res.body.error, /within 1 seconds/);

        await send({ phone: '15551230004', message: 'old' });
        const cutoff = new Date(Date.now() + 5).toISOString();
        await delay(20);
        assert.equal((await admin(request(app).get('/api/sms/wait')).query({ phone: '15551230004', after: cutoff, timeout: 1 })).status, 408);
    });
});

describe('deleting SMS', () => {
    test('deletes one message and returns 404 afterwards; rejects invalid ids', async () => {
        const { body } = await send({ phone: '15550000005', message: 'delete me' });
        assert.equal((await admin(request(app).delete(`/api/sms/${body.id}`))).status, 200);
        assert.equal((await admin(request(app).delete(`/api/sms/${body.id}`))).status, 404);
        assert.equal((await admin(request(app).delete('/api/sms/abc'))).status, 400);
    });

    test('deletes several at once', async () => {
        const a = await send({ phone: '15550000006', message: 'bulk 1' });
        const b = await send({ phone: '15550000006', message: 'bulk 2' });
        const res = await admin(request(app).delete('/api/sms')).send({ ids: [a.body.id, b.body.id] });
        assert.equal(res.body.deleted, 2);
    });

    test('empties one phone number, and never everything', async () => {
        await send({ phone: '+15557770001', message: 'one' });
        await send({ phone: '+15557770001', message: 'two' });
        await send({ phone: '+15557770002', message: 'keep' });
        const res = await admin(request(app).delete('/api/sms')).query({ phone: '+1 555 777 0001' });
        assert.equal(res.body.deleted, 2);
        assert.equal((await admin(request(app).get('/api/sms?phone=%2B15557770002'))).body.totalMessages, 1);
        // the number is matched exactly as stored: with or without the +
        assert.equal((await admin(request(app).delete('/api/sms')).query({ phone: '15557770002' })).body.deleted, 0);
        assert.equal((await admin(request(app).delete('/api/sms'))).status, 400);
    });

    test('retention removes old messages', async () => {
        const before = (await smsModel.list({ limit: 1, offset: 0 })).total;
        assert.ok(before > 0);
        assert.equal(await smsModel.deleteOlderThan(new Date(Date.now() + 1000)), before);
        assert.equal(await smsModel.count(), 0);
    });
});

describe('live events', () => {
    const open = (key, controller) =>
        fetch(`${baseUrl}/api/events`, { headers: key ? { 'X-API-Key': key } : { Authorization: `Bearer ${ADMIN_TOKEN}` }, signal: controller.signal });

    async function readUntil(response, until) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        const deadline = Date.now() + 5000;
        while (!until(text) && Date.now() < deadline) {
            const chunk = await Promise.race([reader.read(), delay(Math.max(1, deadline - Date.now())).then(() => ({ done: true }))]);
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text;
    }

    test('one stream carries emails and SMS; the phone number is masked', async () => {
        const controller = new AbortController();
        const response = await open(null, controller);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);

        await send({ phone: '15558880001', message: 'Your code is 777888' });
        const text = await readUntil(response, t => t.includes('event: sms'));
        controller.abort();
        const data = JSON.parse(/event: sms\ndata: (.+)\n\n/.exec(text)[1]);
        assert.equal(data.phone, '*******0001');
        assert.equal(data.code, '777888');
    });

    test('a key limited to some inboxes gets no SMS events', async () => {
        const limited = await createKey({ name: 'events-limited', scope: 'read', allowedRecipients: 'x@example.com' });
        const controller = new AbortController();
        const response = await open(limited.secret, controller);
        await send({ phone: '15558880002', message: 'private' });
        const text = await readUntil(response, t => t.includes('event: sms'));
        controller.abort();
        assert.doesNotMatch(text, /event: sms/);
    });

    test('requires authentication', async () => {
        assert.equal((await fetch(`${baseUrl}/api/events`)).status, 401);
    });
});

describe('webhook', () => {
    test('is POSTed every SMS, signed, with the full phone number and the code', async () => {
        received = [];
        await send({ sender: 'Bank', phone: '15556660001', message: 'Your code is 135790' });
        for (let i = 0; i < 50 && received.length === 0; i += 1) await delay(50);
        assert.equal(received.length, 1);
        const { headers, body } = received[0];
        assert.equal(headers['x-message-sandbox-event'], 'sms.received');
        assert.equal(headers['x-signature-256'], `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`);
        const { event, sms } = JSON.parse(body);
        assert.equal(event, 'sms.received');
        assert.equal(sms.phone, '15556660001');
        assert.equal(sms.code, '135790');
        assert.equal(sms.sender, 'Bank');
    });
});

describe('client', () => {
    const client = () => createClient({ baseUrl, apiKey: ADMIN_TOKEN });

    test('waitForSms, waitForSmsCode and clearSms', async () => {
        const mailbox = client();
        const code = mailbox.waitForSmsCode({ phone: '+15551239999', timeout: 10 });
        await delay(200);
        await send({ phone: '+1 (555) 123-9999', message: 'Your code is 565656' }); // stored as +15551239999
        assert.equal(await code, '565656');
        assert.equal((await mailbox.latestSms({ phone: '+15551239999' })).message, 'Your code is 565656');
        assert.equal(await mailbox.clearSms('+15551239999'), 1);
        assert.equal(await mailbox.latestSms({ phone: '+15551239999' }), null);
        await assert.rejects(mailbox.waitForSms({ phone: '15550001234', timeout: 1 }), EmailTimeoutError);
    });
});

describe('dashboard session', () => {
    async function login() {
        const res = await request(app).post('/auth/login').send({ username: 'opsadmin', password: ADMIN_PASSWORD });
        assert.equal(res.status, 200);
        const cookie = res.headers['set-cookie'][0];
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        assert.match(cookie, /^ms_session=/);
        return cookie.split(';')[0];
    }

    test('rejects a wrong password or username, and requires both fields', async () => {
        assert.equal((await request(app).post('/auth/login').send({ username: 'opsadmin', password: 'nope' })).status, 401);
        assert.equal((await request(app).post('/auth/login').send({ username: 'admin', password: ADMIN_PASSWORD })).status, 401);
        assert.equal((await request(app).post('/auth/login').send({ password: ADMIN_PASSWORD })).status, 400);
    });

    test('reports the signed-in user, and redirects around the login page', async () => {
        const cookie = await login();
        const status = await request(app).get('/auth/status').set('Cookie', cookie);
        assert.deepEqual(status.body, { authenticated: true, authDisabled: false, username: 'opsadmin', role: 'admin' });
        const loginPage = await request(app).get('/login.html').set('Cookie', cookie);
        assert.equal(loginPage.status, 302);
        assert.equal(loginPage.headers.location, '/');
        const dashboard = await request(app).get('/');
        assert.equal(dashboard.status, 302);
        assert.equal(dashboard.headers.location, '/login.html');
        assert.match((await request(app).get('/').set('Cookie', cookie)).text, /Message Sandbox/);
    });

    test('refuses a forged or tampered session, and cookie writes without the CSRF header', async () => {
        const forged = createSessionToken(env.SESSION_SECRET, 60000, { u: 'someone-else' });
        assert.equal((await request(app).get('/api/sms').set('Cookie', `ms_session=${forged}`)).status, 401);
        const cookie = await login();
        const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
        assert.equal((await request(app).get('/api/sms').set('Cookie', tampered)).status, 401);
        assert.equal((await request(app).delete('/api/sms/1').set('Cookie', cookie)).status, 403);
    });
});

describe('server', () => {
    test('health check is public; security headers are set; unknown API routes are JSON 404', async () => {
        assert.equal((await request(app).get('/health')).body.status, 'ok');
        const page = await request(app).get('/login.html');
        assert.match(page.headers['content-security-policy'], /script-src 'self'/);
        assert.equal(page.headers['x-powered-by'], undefined);
        const missing = await request(app).get('/api/nope');
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, 'Not found');
    });

    test('message bodies are not written to the log', async () => {
        await send({ phone: '15550000008', message: 'secret-otp-987654' });
        const log = fs.readFileSync(path.join(process.env.LOG_DIR, 'app.log'), 'utf8');
        assert.equal(log.includes('secret-otp-987654'), false);
    });
});
