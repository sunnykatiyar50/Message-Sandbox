const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createEvents } = require('../src/mail/events');

const viewsDir = path.join(__dirname, '..', 'src', 'views');
let db;
let app;

before(async () => {
    db = await initializeDatabase();
    const config = loadConfig({ ADMIN_PASSWORD: 'correct horse battery staple', SESSION_SECRET: 'x'.repeat(48) });
    app = createApp({
        config,
        emailModel: new EmailModel(db),
        apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }),
        ingest: {},
        events: createEvents(),
    });
});
after(() => db.close());

describe('PWA', () => {
    test('the manifest is public, served as a web manifest, and every icon it lists exists', async () => {
        const res = await request(app).get('/manifest.webmanifest');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /manifest\+json|application\/json/);
        const manifest = JSON.parse(res.text);
        assert.equal(manifest.display, 'standalone');
        assert.ok(manifest.start_url);
        const sizes = manifest.icons.map(i => i.sizes);
        assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
        assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
        for (const icon of manifest.icons) {
            assert.equal((await request(app).get(`/${icon.src}`)).status, 200, icon.src);
        }
    });

    test('the service worker and offline page are public, and the worker never caches the API', async () => {
        const sw = await request(app).get('/sw.js');
        assert.equal(sw.status, 200);
        assert.match(sw.headers['content-type'], /javascript/);
        assert.match(sw.text, /NEVER_CACHE/);
        assert.match(sw.text, /api\|auth\|metrics\|health/);
        assert.equal((await request(app).get('/offline.html')).status, 200);
    });

    test('every file the service worker precaches exists', () => {
        const sw = fs.readFileSync(path.join(viewsDir, 'sw.js'), 'utf8');
        const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1];
        const files = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
        assert.ok(files.length > 0);
        for (const file of files) assert.ok(fs.existsSync(path.join(viewsDir, file)), file);
    });

    test('the login page links the manifest and registers the worker without inline script', async () => {
        const res = await request(app).get('/login.html');
        assert.equal(res.status, 200);
        assert.match(res.text, /rel="manifest" href="manifest\.webmanifest"/);
        assert.match(res.text, /<script src="pwa\.js"/);
        assert.doesNotMatch(res.text, /<script>(?!<\/script>)/);
    });
});
