const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const SmsModel = require('../src/models/smsModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const ActivityModel = require('../src/models/activityModel');
const { createApp } = require('../src/server');
const { createSmsIngest } = require('../src/sms/ingest');
const { createEvents } = require('../src/mail/events');
const activity = require('../src/utils/activity');

const ADMIN_TOKEN = 'admin-token-0123456789';
const env = {
    ADMIN_TOKEN,
    ADMIN_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: 'x'.repeat(48),
    VIEWER_USERS: 'viewer:viewer-password',
    SMS_RATE_LIMIT: '2',
};
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let db;
let model;
let apiKeyModel;
let app;

// record() stores events without waiting, so wait until the table has what the test expects
async function waitForEvents(filters, count = 1) {
    for (let i = 0; i < 50; i++) {
        const { events, total } = await model.list({ ...filters, limit: 50, offset: 0 });
        if (total >= count) return events;
        await delay(20);
    }
    throw new Error(`expected ${count} event(s) for ${JSON.stringify(filters)}`);
}

before(async () => {
    db = await initializeDatabase();
    model = new ActivityModel(db);
    activity.attach(model);
    const config = loadConfig(env);
    const smsModel = new SmsModel(db);
    apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    app = createApp({
        config,
        emailModel: new EmailModel(db),
        smsModel,
        apiKeyModel,
        activityModel: model,
        ingest: {},
        ingestSms: createSmsIngest({ smsModel }),
        events: createEvents(),
    });
});

after(async () => {
    activity.attach(null);
    await db.close();
});

describe('recording events', () => {
    test('stores level, category, address and user, and fixes unknown values', async () => {
        activity.record({ level: 'error', category: 'smtp', message: 'boom one', ip: '203.0.113.5', actor: 'alice' });
        activity.record({ level: 'loud', category: 'nonsense', message: 'boom two' });
        const [first] = await waitForEvents({ search: 'boom one' });
        assert.deepEqual(
            { level: first.level, category: first.category, ip: first.ip, actor: first.actor },
            { level: 'error', category: 'smtp', ip: '203.0.113.5', actor: 'alice' }
        );
        const [second] = await waitForEvents({ search: 'boom two' });
        assert.equal(second.level, 'info');
        assert.equal(second.category, 'system');
    });

    test('a throttled event is recorded once per window', async () => {
        for (let i = 0; i < 5; i++) {
            activity.record({ level: 'warn', category: 'auth', message: 'flood event', ip: '198.51.100.9', throttleMs: 60000 });
        }
        activity.record({ level: 'warn', category: 'auth', message: 'flood event', ip: '198.51.100.10', throttleMs: 60000 });
        await waitForEvents({ search: 'flood event' }, 2);
        await delay(100);
        assert.equal((await model.list({ search: 'flood event', limit: 50, offset: 0 })).total, 2);
    });

    test('nothing breaks without a model attached', () => {
        activity.attach(null);
        assert.doesNotThrow(() => activity.record({ message: 'only logged' }));
        activity.attach(model);
    });
});

describe('the model', () => {
    before(async () => {
        await model.clear();
        await model.create({ level: 'info', category: 'keys', message: 'API key created: "ci"', ip: '10.0.0.1', actor: 'admin' });
        await model.create({ level: 'warn', category: 'auth', message: 'Failed dashboard login', ip: '10.0.0.2' });
        await model.create({ level: 'warn', category: 'auth', message: 'Failed dashboard login', ip: '10.0.0.2' });
        await model.create({ level: 'error', category: 'smtp', message: '100% broken_pipe', ip: '10.0.0.3' });
    });

    test('filters by level, category, address and text', async () => {
        const list = async filters => (await model.list({ ...filters, limit: 50, offset: 0 })).events;
        assert.equal((await list({ level: 'problems' })).length, 3);
        assert.equal((await list({ level: 'error' })).length, 1);
        assert.equal((await list({ category: 'keys' })).length, 1);
        assert.equal((await list({ ip: '10.0.0.2' })).length, 2);
        assert.equal((await list({ search: 'ADMIN' })).length, 1); // matches the user, case-insensitive
        assert.equal((await list({ search: '100%' })).length, 1); // % is literal
        assert.equal((await list({ search: '1_0' })).length, 0); // _ is literal
    });

    test('lists the newest first and pages', async () => {
        const page = await model.list({ limit: 2, offset: 0 });
        assert.equal(page.total, 4);
        assert.equal(page.events.length, 2);
        assert.equal(page.events[0].message, '100% broken_pipe');
    });

    test('summarises levels and the addresses behind most problems', async () => {
        const summary = await model.summary(new Date(Date.now() - 60000));
        assert.deepEqual(summary.levels, { info: 1, warn: 2, error: 1 });
        assert.deepEqual(summary.topIps.map(i => [i.ip, i.count]), [['10.0.0.2', 2], ['10.0.0.3', 1]]);
    });

    test('trims to a maximum and deletes by age', async () => {
        assert.equal(await model.trimTo(2), 2);
        assert.equal(await model.count(), 2);
        assert.equal(await model.deleteOlderThan(new Date(Date.now() + 60000)), 2);
        assert.equal(await model.count(), 0);
    });
});

describe('GET /api/activity', () => {
    // Rejected requests in the other tests are recorded too, so every test starts from a known table
    beforeEach(async () => {
        await delay(100);
        await model.clear();
        await model.create({ level: 'error', category: 'relay', message: 'relay failed', ip: '10.1.1.1' });
        await model.create({ level: 'info', category: 'system', message: 'started' });
    });

    test('is admin only', async () => {
        assert.equal((await request(app).get('/api/activity')).status, 401);
        const { secret } = await apiKeyModel.create({ name: 'reader', scope: 'read' });
        assert.equal((await request(app).get('/api/activity').set('X-API-Key', secret)).status, 401);
        const login = await request(app).post('/auth/login').send({ username: 'viewer', password: 'viewer-password' });
        assert.equal(login.status, 200);
        const cookie = login.headers['set-cookie'];
        assert.equal((await request(app).get('/api/activity').set('Cookie', cookie)).status, 403);
        assert.equal((await request(app).get('/api/activity/summary').set('Cookie', cookie)).status, 403);
    });

    test('lists events with paging and filters', async () => {
        const all = await admin(request(app).get('/api/activity?level='));
        assert.equal(all.status, 200);
        assert.equal(all.body.totalEvents, 2);
        const problems = await admin(request(app).get('/api/activity?level=problems&category=relay'));
        assert.deepEqual(problems.body.events.map(e => e.message), ['relay failed']);
        assert.equal(problems.body.events[0].ip, '10.1.1.1');
        const paged = await admin(request(app).get('/api/activity?level=&pageSize=1&page=2'));
        assert.equal(paged.body.totalPages, 2);
        assert.equal(paged.body.currentPage, 2);
    });

    test('rejects unknown levels and categories', async () => {
        const bad = await admin(request(app).get('/api/activity?level=loud&category=nope'));
        assert.equal(bad.status, 400);
        assert.ok(bad.body.details.level && bad.body.details.category);
    });

    test('serves a summary, and clearing is itself recorded', async () => {
        const summary = await admin(request(app).get('/api/activity/summary'));
        assert.equal(summary.body.levels.error, 1);
        assert.equal(summary.body.retentionDays, 30);
        const cleared = await admin(request(app).delete('/api/activity'));
        assert.equal(cleared.status, 200);
        assert.equal(cleared.body.deleted, 2);
        const [entry] = await waitForEvents({ search: 'Activity log cleared' });
        assert.equal(entry.category, 'system');
    });
});

describe('events the server records', () => {
    test('a failed dashboard login, with the address', async () => {
        await request(app).post('/auth/login').send({ username: 'admin', password: 'wrong' });
        const [event] = await waitForEvents({ search: 'Failed dashboard login' });
        assert.equal(event.level, 'warn');
        assert.equal(event.category, 'auth');
        assert.ok(event.ip);
    });

    test('a successful login names the user', async () => {
        await request(app).post('/auth/login').send({ username: 'admin', password: env.ADMIN_PASSWORD });
        const [event] = await waitForEvents({ search: 'Dashboard login:' });
        assert.equal(event.level, 'info');
        assert.equal(event.actor, 'admin');
    });

    test('a wrong API key, without ever storing the key', async () => {
        await request(app).get('/api/emails').set('X-API-Key', 'ms_read_notarealkey0123456789');
        const [event] = await waitForEvents({ search: 'Invalid or revoked API key' });
        assert.equal(event.level, 'warn');
        assert.ok(!event.message.includes('notarealkey'));
    });

    test('API key changes, by whoever made them', async () => {
        const created = await admin(request(app).post('/api/keys').send({ name: 'audit-me', scope: 'read' }));
        assert.equal(created.status, 201);
        const [event] = await waitForEvents({ category: 'keys', search: 'audit-me' });
        assert.equal(event.actor, 'admin token');
        assert.match(event.message, /API key created/);
    });

    test('a rate-limit hit', async () => {
        const { secret } = await apiKeyModel.create({ name: 'sender', scope: 'send' });
        const send = () => request(app).post('/api/sms').set('X-API-Key', secret).send({ sender: 'App', phone: '+15551234567', message: 'hi' });
        assert.equal((await send()).status, 201);
        assert.equal((await send()).status, 201);
        const limited = await send();
        assert.equal(limited.status, 429);
        assert.equal(limited.body.error, 'Too many messages, slow down.');
        const [event] = await waitForEvents({ category: 'ratelimit' });
        assert.equal(event.level, 'warn');
        assert.match(event.message, /POST \/api\/sms/);
    });
});
