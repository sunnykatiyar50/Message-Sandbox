const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-logs-'));

const request = require('supertest');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const SmsModel = require('../src/models/smsModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const ActivityModel = require('../src/models/activityModel');
const SettingsModel = require('../src/models/settingsModel');
const { Settings, SettingsError } = require('../src/settings/settings');
const { SETTINGS } = require('../src/settings/definitions');
const { createApp } = require('../src/server');
const { createSmsIngest } = require('../src/sms/ingest');
const { createEvents } = require('../src/mail/events');
const activity = require('../src/utils/activity');

const ADMIN_TOKEN = 'admin-token-0123456789';
const baseEnv = {
    ADMIN_TOKEN,
    ADMIN_PASSWORD: 'correct horse battery staple',
    SESSION_SECRET: 'x'.repeat(48),
    VIEWER_USERS: 'viewer:viewer-password',
    SMS_RATE_LIMIT: '50', // from .env
};
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let db;
let model;

async function fresh(env = baseEnv) {
    await db.run('DELETE FROM app_settings');
    const settings = new Settings({ model, env });
    await settings.load();
    return settings;
}

before(async () => {
    db = await initializeDatabase();
    model = new SettingsModel(db);
});
after(() => db.close());

describe('precedence', () => {
    test('the database wins over .env, which wins over the default', async () => {
        const settings = await fresh();
        const get = key => settings.describe().settings.find(s => s.key === key);
        assert.deepEqual([get('SMS_RATE_LIMIT').value, get('SMS_RATE_LIMIT').source], ['50', 'env']);
        assert.deepEqual([get('API_RATE_LIMIT').value, get('API_RATE_LIMIT').source], ['120', 'default']);
        await settings.set({ SMS_RATE_LIMIT: '75', API_RATE_LIMIT: '10' });
        assert.deepEqual([get('SMS_RATE_LIMIT').value, get('SMS_RATE_LIMIT').source], ['75', 'database']);
        assert.equal(settings.config.smsRateLimit, 75);
        assert.equal(get('SMS_RATE_LIMIT').envValue, '50');
    });

    test('resetting goes back to .env, or to the default when .env has nothing', async () => {
        const settings = await fresh();
        await settings.set({ SMS_RATE_LIMIT: '75', API_RATE_LIMIT: '10' });
        await settings.set({ SMS_RATE_LIMIT: null, API_RATE_LIMIT: null });
        assert.equal(settings.config.smsRateLimit, 50);
        assert.equal(settings.config.apiRateLimit, 120);
        assert.equal(await db.all('SELECT * FROM app_settings').then(rows => rows.length), 0);
    });

    test('saved values survive a restart', async () => {
        const first = await fresh();
        await first.set({ RETENTION_DAYS: '14' }, { actor: 'alice' });
        const second = new Settings({ model, env: baseEnv });
        const config = await second.load();
        assert.equal(config.retentionDays, 14);
        const [row] = await model.all();
        assert.equal(row.updatedBy, 'alice');
    });

    test('a saved value that no longer works with .env is ignored at startup, not fatal', async () => {
        await fresh();
        await model.set('RELAY_HOST', 'mail.example.com'); // a relay with no allowed recipients is invalid
        const logs = [];
        const settings = new Settings({ model, env: baseEnv, log: m => logs.push(m) });
        const config = await settings.load();
        assert.equal(config.relayHost, '');
        assert.match(settings.startupProblem, /RELAY_ALLOW/);
        assert.equal(settings.describe().startupProblem, settings.startupProblem);
        assert.ok(logs.length);
    });
});

describe('validation', () => {
    test('rejects bad values with a message per setting, and saves nothing', async () => {
        const settings = await fresh();
        await assert.rejects(
            settings.set({ SMS_RATE_LIMIT: '0', RETENTION_DAYS: 'soon', METRICS: 'maybe', NOT_A_SETTING: '1', SMTP_HOST: 'ok.example.com' }),
            error => {
                assert.ok(error instanceof SettingsError);
                assert.deepEqual(Object.keys(error.details).sort(), ['METRICS', 'NOT_A_SETTING', 'RETENTION_DAYS', 'SMS_RATE_LIMIT']);
                return true;
            }
        );
        assert.equal((await model.all()).length, 0);
        assert.equal(settings.describe().settings.find(s => s.key === 'SMTP_HOST').source, 'default');
    });

    test('secrets and start-up settings cannot be set here', async () => {
        const settings = await fresh();
        for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'WEBHOOK_SECRET', 'SMTP_PASSWORD', 'AUTH_DISABLED', 'DB_TYPE']) {
            await assert.rejects(settings.set({ [key]: 'x'.repeat(40) }), SettingsError, key);
        }
        assert.ok(!SETTINGS.some(s => /PASSWORD|SECRET|TOKEN|AUTH_DISABLED|DB_|VIEWER/.test(s.key)));
    });

    test('combinations that would not work are rejected as a whole', async () => {
        const settings = await fresh();
        await assert.rejects(settings.set({ RELAY_HOST: 'mail.example.com' }), /RELAY_ALLOW/);
        await assert.rejects(settings.set({ SMTP_ALLOWED_DOMAINS: 'not a domain!!' }), SettingsError);
        assert.equal((await model.all()).length, 0);
        await settings.set({ RELAY_HOST: 'mail.example.com', RELAY_ALLOW: 'example.org' });
        assert.equal((await model.all()).length, 2);
    });

    test('a change that would switch TLS off is rejected', async () => {
        const settings = await fresh();
        await assert.rejects(settings.set({ SMTP_TLS_PORT: '2525' }), /SMTP_TLS_KEY/);
    });
});

describe('applying', () => {
    test('live settings change the running config at once, restart settings wait', async () => {
        const settings = await fresh();
        const seen = [];
        settings.onChange(keys => seen.push(...keys));
        await settings.set({ MAX_EMAIL_SIZE_MB: '25', SMTP_SIMULATE: 'false', SMTP_ALLOWED_DOMAINS: 'example.org, *.test.local', PORT: '4000' });
        assert.equal(settings.config.maxEmailBytes, 25 * 1024 * 1024);
        assert.equal(settings.config.smtpSimulate, false);
        assert.equal(settings.config.smtpAllowedDomains.length, 2);
        assert.equal(settings.config.port, 30005); // still what the server started with
        const described = settings.describe();
        assert.equal(described.restartPending, true);
        assert.deepEqual(described.settings.filter(s => s.restartPending).map(s => s.key), ['PORT']);
        assert.deepEqual(seen.sort(), ['MAX_EMAIL_SIZE_MB', 'PORT', 'SMTP_ALLOWED_DOMAINS', 'SMTP_SIMULATE']);
    });

    test('saving the value that is already running does not ask for a restart', async () => {
        const settings = await fresh();
        await settings.set({ PORT: '30005' });
        assert.equal(settings.describe().restartPending, false);
    });
});

describe('the API', () => {
    let app;
    let activityModel;

    before(async () => {
        await db.run('DELETE FROM app_settings');
        const settings = new Settings({ model, env: baseEnv });
        const config = await settings.load();
        activityModel = new ActivityModel(db);
        activity.attach(activityModel);
        const smsModel = new SmsModel(db);
        app = createApp({
            config,
            emailModel: new EmailModel(db),
            smsModel,
            apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }),
            activityModel,
            settings,
            ingest: {},
            ingestSms: createSmsIngest({ smsModel }),
            events: createEvents(),
        });
    });
    after(() => activity.attach(null));

    test('is admin only', async () => {
        assert.equal((await request(app).get('/api/settings')).status, 401);
        const login = await request(app).post('/auth/login').send({ username: 'viewer', password: 'viewer-password' });
        const cookie = login.headers['set-cookie'];
        assert.equal((await request(app).get('/api/settings').set('Cookie', cookie)).status, 403);
        assert.equal((await request(app).put('/api/settings').set('Cookie', cookie).set('X-Requested-With', 'fetch').send({ changes: {} })).status, 403);
    });

    test('lists every setting with its source, and what stays in .env', async () => {
        const res = await admin(request(app).get('/api/settings'));
        assert.equal(res.status, 200);
        assert.equal(res.body.settings.length, SETTINGS.length);
        const sms = res.body.settings.find(s => s.key === 'SMS_RATE_LIMIT');
        assert.deepEqual([sms.value, sms.source, sms.apply], ['50', 'env', 'live']);
        assert.ok(res.body.envOnly.length > 0);
    });

    test('a saved rate limit applies to the next request', async () => {
        const key = await new ApiKeyModel(db, { encryptionSecret: 'x'.repeat(48) }).create({ name: 'sender', scope: 'send' });
        const send = () => request(app).post('/api/sms').set('X-API-Key', key.secret).send({ sender: 'App', phone: '+15551234567', message: 'hi' });
        assert.equal((await send()).status, 201);
        const saved = await admin(request(app).put('/api/settings').send({ changes: { SMS_RATE_LIMIT: '1' } }));
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.body.changed, ['SMS_RATE_LIMIT']);
        assert.equal(saved.body.settings.find(s => s.key === 'SMS_RATE_LIMIT').source, 'database');
        // the first request in this window is already counted (limit 50 then); the new limit is 1
        assert.equal((await send()).status, 429);
    });

    test('rejects invalid input with details', async () => {
        const res = await admin(request(app).put('/api/settings').send({ changes: { RETENTION_DAYS: 'x', SMTP_PORT: '99999' } }));
        assert.equal(res.status, 400);
        assert.ok(res.body.details.RETENTION_DAYS && res.body.details.SMTP_PORT);
        assert.equal((await admin(request(app).put('/api/settings').send({}))).status, 400);
        assert.equal((await admin(request(app).put('/api/settings').send({ changes: [] }))).status, 400);
    });

    test('changes are recorded on the Activity page, and a webhook URL is not', async () => {
        await admin(request(app).put('/api/settings').send({ changes: { RETENTION_DAYS: '9', WEBHOOK_URL: 'https://hooks.example.com/secret-token-123' } }));
        let events = [];
        for (let i = 0; i < 50 && events.length < 3; i++) {
            events = (await activityModel.list({ category: 'settings', limit: 50, offset: 0 })).events;
            await delay(20);
        }
        const messages = events.map(e => e.message);
        assert.ok(messages.some(m => /Setting RETENTION_DAYS changed from "0" to "9" by admin token/.test(m)));
        assert.ok(messages.some(m => /Setting WEBHOOK_URL changed by/.test(m)));
        assert.ok(!messages.some(m => m.includes('secret-token-123')));
        assert.ok(events.every(e => e.actor === 'admin token'));
    });

    test('resetting a setting is recorded too', async () => {
        const res = await admin(request(app).put('/api/settings').send({ changes: { RETENTION_DAYS: null } }));
        assert.equal(res.body.settings.find(s => s.key === 'RETENTION_DAYS').source, 'default');
        let found;
        for (let i = 0; i < 50 && !found; i++) {
            found = (await activityModel.list({ search: 'RETENTION_DAYS reset', limit: 5, offset: 0 })).events[0];
            await delay(20);
        }
        assert.match(found.message, /reset to the default/);
    });
});
