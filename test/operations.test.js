const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

process.env.NODE_ENV = 'test';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'email-ops-logs-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { createIngest } = require('../src/mail/ingest');
const { createEvents } = require('../src/mail/events');
const { createSmtpServer, listen } = require('../src/mail/smtpServer');
const { Metrics } = require('../src/utils/metrics');
const { createZip } = require('../src/utils/zip');
const { visibleTo, parseRules } = require('../src/utils/recipients');
const { smtpSend } = require('./helpers/smtp');

const ADMIN_TOKEN = 'admin-token-0123456789';
const env = { ADMIN_TOKEN, ADMIN_PASSWORD: 'correct horse battery staple', SESSION_SECRET: 'x'.repeat(48) };

let db;
let model;
let app;
let appNoMetrics;
let smtp;
let smtpPort;
let httpServer;
let baseUrl;
let metrics;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const mail = (to, subject, { cc, extra = [] } = {}) =>
    ['From: app@example.com', `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, ...extra, '', `body of ${subject}`].join('\r\n');
const deliver = (to, subject, options) => smtpSend(smtpPort, { from: 'app@example.com', to: [].concat(to), data: mail([].concat(to)[0], subject, options) });

async function createKey(name, allowedRecipients) {
    const res = await admin(request(app).post('/api/keys')).send({ name, allowedRecipients });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
}

// Reads a zip back: [{ name, data, crcOk }]
function readZip(buffer) {
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buffer.readUInt16LE(end + 10);
    let cursor = buffer.readUInt32LE(end + 16);
    const files = [];
    for (let i = 0; i < count; i += 1) {
        const crc = buffer.readUInt32LE(cursor + 16);
        const size = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const data = buffer.subarray(dataStart, dataStart + size);
        files.push({ name, data, crcOk: zlib.crc32(data) === crc });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

before(async () => {
    db = await initializeDatabase();
    model = new EmailModel(db);
    metrics = new Metrics();
    const config = loadConfig(env);
    const events = createEvents();
    const ingest = createIngest({ emailModel: model, events, metrics });
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    app = createApp({ config, emailModel: model, apiKeyModel, ingest, events, metrics });
    appNoMetrics = createApp({ config: loadConfig({ ...env, METRICS: 'false' }), emailModel: model, apiKeyModel, ingest, events });
    smtp = createSmtpServer({ config, ingest, metrics });
    smtpPort = await listen(smtp, { port: 0, host: '127.0.0.1' });
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => httpServer.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
    await new Promise(resolve => smtp.close(resolve));
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
    await db.close();
});

describe('keys limited to some recipients', () => {
    let scoped;

    before(async () => {
        await deliver('alice@example.com', 'For Alice');
        await deliver('bob@example.com', 'For Bob');
        await deliver('dev@team.test', 'For the team');
        await deliver('qa@eu.team.test', 'For a subdomain');
        // Alice is only in the envelope (a Bcc): the headers name someone else
        await smtpSend(smtpPort, { from: 'app@example.com', to: ['carol@example.com', 'alice@example.com'], data: mail('carol@example.com', 'Bcc to Alice') });
        scoped = await createKey('alice-and-team', 'alice@example.com, team.test');
    });

    const get = (key, url) => request(app).get(url).set('X-API-Key', key.secret);

    test('the key is created with its limit, and the list shows it', async () => {
        assert.deepEqual(scoped.key.allowedRecipients, ['alice@example.com', 'team.test']);
        const listed = (await admin(request(app).get('/api/keys'))).body.keys.find(k => k.name === 'alice-and-team');
        assert.deepEqual(listed.allowedRecipients, ['alice@example.com', 'team.test']);
        assert.deepEqual((await createKey('unlimited')).key.allowedRecipients, []);
    });

    test('rejects limits that are not addresses or domains', async () => {
        const res = await admin(request(app).post('/api/keys')).send({ name: 'bad-limit', allowedRecipients: 'alice@example.com, not valid' });
        assert.equal(res.status, 400);
        assert.match(res.body.details.allowedRecipients, /not valid/);
    });

    test('lists and counts only the emails sent to its inboxes (Bcc included)', async () => {
        const list = (await get(scoped, '/api/emails')).body;
        assert.deepEqual(list.emails.map(e => e.subject).sort(), ['Bcc to Alice', 'For Alice', 'For the team']);
        assert.equal(list.totalEmails, 3);
        // an unlimited key and the admin still see everything
        const all = await createKey('sees-all');
        assert.ok((await get(all, '/api/emails')).body.totalEmails >= 5);
        // filters narrow within the limit, never beyond it
        assert.equal((await get(scoped, '/api/emails?to=bob@example.com')).body.totalEmails, 0);
        assert.equal((await get(scoped, '/api/emails?search=Bob')).body.totalEmails, 0);
    });

    test('domains do not match subdomains; subdomain wildcards do', async () => {
        const subs = await createKey('subdomains-only', '*.team.test');
        assert.deepEqual((await get(subs, '/api/emails')).body.emails.map(e => e.subject), ['For a subdomain']);
    });

    test('latest, wait and single emails outside the limit do not exist for the key', async () => {
        assert.equal((await get(scoped, '/api/emails/latest?to=bob@example.com')).status, 404);
        assert.equal((await get(scoped, '/api/emails/wait?to=bob@example.com&timeout=1')).status, 408);
        assert.equal((await get(scoped, '/api/emails/latest?to=alice@example.com')).body.subject, 'Bcc to Alice');

        const bob = (await admin(request(app).get('/api/emails')).query({ to: 'bob@example.com' })).body.emails[0];
        for (const url of [`/api/emails/${bob.id}`, `/api/emails/${bob.id}/raw`, `/api/emails/${bob.id}/preview`, `/api/emails/${bob.id}/thread`, `/api/emails/${bob.id}/attachments/1`]) {
            assert.equal((await get(scoped, url)).status, 404, url);
        }
        const alice = (await admin(request(app).get('/api/emails')).query({ to: 'alice@example.com' })).body.emails.find(e => e.subject === 'For Alice');
        assert.equal((await get(scoped, `/api/emails/${alice.id}`)).status, 200);
        assert.equal((await get(scoped, `/api/emails/${alice.id}/raw`)).status, 200);
    });

    test('the SQL limit and the JavaScript check agree', async () => {
        const rules = parseRules('alice@example.com, team.test');
        const everything = (await model.list({ limit: 100, offset: 0 })).emails;
        const bySql = (await model.list({ limit: 100, offset: 0, scope: rules })).emails.map(e => e.id).sort();
        const byJs = everything.filter(e => visibleTo(e, rules)).map(e => e.id).sort();
        assert.deepEqual(bySql, byJs);
        assert.ok(byJs.length > 0 && byJs.length < everything.length);
    });

    test('a limited key cannot delete or add, and revoking still works', async () => {
        assert.equal((await request(app).delete('/api/emails').query({ to: 'alice@example.com' }).set('X-API-Key', scoped.secret)).status, 401);
        const revoked = await admin(request(app).delete(`/api/keys/${scoped.key.id}`));
        assert.equal(revoked.status, 200);
        assert.equal((await get(scoped, '/api/emails')).status, 401);
    });
});

describe('migrating an older database', () => {
    test('adds the columns introduced since, keeping existing rows', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'email-migrate-')), 'old.sqlite');
        // The tables as the first release created them: no api_keys.allowed_recipients, no emails.has_text_part
        const old = new DatabaseSync(file);
        old.exec(`CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, from_address TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
            to_addresses TEXT NOT NULL DEFAULT '[]', cc_addresses TEXT NOT NULL DEFAULT '[]', envelope_from TEXT NOT NULL DEFAULT '', envelope_to TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', text_body TEXT, html_body TEXT, headers TEXT NOT NULL DEFAULT '[]', raw BLOB,
            size INTEGER NOT NULL DEFAULT 0, attachment_count INTEGER NOT NULL DEFAULT 0, smtp_user TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        old.exec(`CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
            key_encrypted TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'dashboard', created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)`);
        old.exec(`INSERT INTO emails (subject, to_addresses) VALUES ('Kept', '[{"name":"","address":"old@example.com"}]')`);
        old.close();

        const previous = process.env.SQLITE_PATH;
        process.env.SQLITE_PATH = file;
        let migrated;
        try {
            migrated = await initializeDatabase();
        } finally {
            process.env.SQLITE_PATH = previous;
        }
        const emailModel = new EmailModel(migrated);
        const keys = new ApiKeyModel(migrated, { encryptionSecret: 'x'.repeat(48) });
        try {
            const kept = (await emailModel.list({ limit: 5, offset: 0, to: 'old@example.com' })).emails;
            assert.equal(kept.length, 1);
            assert.equal((await emailModel.get(kept[0].id)).hasTextPart, null, 'unknown for emails stored before it was recorded');
            const { key, secret } = await keys.create({ name: 'after-migration', scope: 'read', allowedRecipients: ['old@example.com'] });
            assert.deepEqual(key.allowedRecipients, ['old@example.com']);
            assert.equal((await keys.authenticate(secret)).allowedRecipients[0].value, 'old@example.com');
        } finally {
            await migrated.close();
        }
    });
});

describe('live updates', () => {
    // Reads the event stream until `until(text)` is true, or fails after a few seconds
    async function readStream(response, until) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        const deadline = Date.now() + 5000;
        while (!until(text)) {
            const remaining = deadline - Date.now();
            assert.ok(remaining > 0, `timed out waiting for the stream; got: ${JSON.stringify(text)}`);
            const chunk = await Promise.race([reader.read(), delay(remaining).then(() => ({ timeout: true }))]);
            if (chunk.timeout || chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
        }
        return { text, reader };
    }

    test('pushes each new email, and only the ones a limited key may see', async () => {
        const limited = await createKey('stream-limited', 'live-a@example.com');
        const open = key => {
            const controller = new AbortController();
            return fetch(`${baseUrl}/api/events`, { headers: key ? { 'X-API-Key': key } : { Authorization: `Bearer ${ADMIN_TOKEN}` }, signal: controller.signal }).then(response => ({ response, controller }));
        };

        const everyone = await open();
        const mine = await open(limited.secret);
        assert.equal(everyone.response.status, 200);
        assert.match(everyone.response.headers.get('content-type'), /text\/event-stream/);

        await deliver('live-b@example.com', 'Not for the limited key');
        await deliver('live-a@example.com', 'For the limited key');

        const seenByAll = await readStream(everyone.response, text => text.includes('For the limited key'));
        const eventData = text => [...text.matchAll(/event: email\ndata: (.+)\n\n/g)].map(m => JSON.parse(m[1]).subject);
        assert.deepEqual(eventData(seenByAll.text), ['Not for the limited key', 'For the limited key']);

        const seenByLimited = await readStream(mine.response, text => text.includes('For the limited key'));
        assert.deepEqual(eventData(seenByLimited.text), ['For the limited key']);

        everyone.controller.abort();
        mine.controller.abort();
        await delay(200);
        assert.match(await metrics.render(), /message_sandbox_event_streams 0/);
    });

    test('requires authentication', async () => {
        assert.equal((await fetch(`${baseUrl}/api/events`)).status, 401);
    });
});

describe('export', () => {
    test('downloads the selected emails as a zip of .eml files', async () => {
        await deliver('export@example.com', 'Quarterly report: Q3 / final!');
        await deliver('export@example.com', 'Second one');
        const ids = (await admin(request(app).get('/api/emails')).query({ to: 'export@example.com' })).body.emails.map(e => e.id);
        assert.equal(ids.length, 2);

        const res = await admin(request(app).get('/api/emails/export')).query({ ids: ids.join(',') }).buffer(true).parse((r, cb) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-type'], 'application/zip');
        assert.match(res.headers['content-disposition'], /emails\.zip/);

        const files = readZip(res.body);
        assert.equal(files.length, 2);
        assert.ok(files.every(f => f.crcOk));
        const byName = Object.fromEntries(files.map(f => [f.name, f.data.toString()]));
        const quarterly = Object.keys(byName).find(name => name.includes('quarterly-report-q3-final'));
        assert.ok(quarterly, Object.keys(byName).join(', '));
        assert.match(quarterly, /^email-\d+-quarterly-report-q3-final\.eml$/);
        assert.match(byName[quarterly], /Subject: Quarterly report: Q3 \/ final!/);
        // the originals, byte for byte (the zip lists them oldest first)
        const originals = (await Promise.all(ids.map(id => model.getRaw(id)))).map(raw => raw.toString('base64')).sort();
        assert.deepEqual(files.map(f => f.data.toString('base64')).sort(), originals);
    });

    test('leaves out emails outside a key\'s limit, and validates the ids', async () => {
        const limited = await createKey('export-limited', 'export@example.com');
        const mine = (await admin(request(app).get('/api/emails')).query({ to: 'export@example.com' })).body.emails[0].id;
        const bob = (await admin(request(app).get('/api/emails')).query({ to: 'bob@example.com' })).body.emails[0].id;
        const bytes = (r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
        const res = await request(app).get('/api/emails/export').query({ ids: `${mine},${bob}` }).set('X-API-Key', limited.secret).buffer(true).parse(bytes);
        assert.equal(readZip(res.body).length, 1);
        assert.equal((await request(app).get('/api/emails/export').query({ ids: String(bob) }).set('X-API-Key', limited.secret)).status, 404);

        assert.equal((await admin(request(app).get('/api/emails/export'))).status, 400);
        assert.equal((await admin(request(app).get('/api/emails/export')).query({ ids: '1,abc' })).status, 400);
        assert.equal((await admin(request(app).get('/api/emails/export')).query({ ids: Array.from({ length: 101 }, (_, i) => i + 1).join(',') })).status, 400);
        assert.equal((await request(app).get('/api/emails/export').query({ ids: '1' })).status, 401);
    });

    test('the zip writer produces a valid archive', () => {
        const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/ünï.txt', data: Buffer.alloc(0), date: new Date('2026-01-02T03:04:06') }]);
        const files = readZip(zip);
        assert.deepEqual(files.map(f => [f.name, f.data.toString(), f.crcOk]), [['a.txt', 'hello', true], ['dir/ünï.txt', '', true]]);
    });
});

describe('metrics', () => {
    test('exposes counters and gauges in the Prometheus format, for authorized callers', async () => {
        await deliver('reject@example.com', 'Refused');
        await deliver('metrics@example.com', 'Counted');
        const res = await admin(request(app).get('/metrics'));
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /text\/plain; version=0\.0\.4/);
        assert.match(res.text, /# TYPE message_sandbox_emails_received_total counter/);
        const value = name => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(res.text)[1]);
        assert.ok(value('message_sandbox_emails_received_total') >= 5);
        assert.ok(value('message_sandbox_smtp_connections_total') >= 5);
        assert.ok(value('message_sandbox_received_bytes_total') > 0);
        assert.match(res.text, /message_sandbox_recipients_rejected_total\{reason="simulated"\} [1-9]/);
        assert.match(res.text, /# TYPE message_sandbox_emails_stored gauge\nmessage_sandbox_emails_stored [1-9]/);
        assert.match(res.text, /message_sandbox_uptime_seconds \d+/);
        assert.doesNotMatch(res.text, /metrics@example\.com|Counted/, 'no addresses or subjects');
    });

    test('needs authentication and can be turned off', async () => {
        assert.equal((await request(app).get('/metrics')).status, 401);
        const key = await createKey('prometheus');
        assert.equal((await request(app).get('/metrics').set('Authorization', `Bearer ${key.secret}`)).status, 200);
        assert.equal((await admin(request(appNoMetrics).get('/metrics'))).status, 404);
    });
});

describe('"Send test" with Cc, Bcc and attachments', () => {
    const file = (filename, content) => ({ filename, contentType: 'text/plain', content: Buffer.from(content).toString('base64') });

    test('stores Cc in the headers, Bcc only in the envelope, and the attachments', async () => {
        const res = await admin(request(app).post('/api/emails/test')).send({
            from: 'tester@example.com',
            to: 'to@example.com',
            cc: 'cc@example.com',
            bcc: 'hidden@example.com',
            subject: 'With files',
            text: 'see attached',
            attachments: [file('notes.txt', 'attached notes'), { filename: 'résumé "v2".txt', content: Buffer.from('cv').toString('base64') }],
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const email = (await admin(request(app).get(`/api/emails/${res.body.id}`))).body;
        assert.deepEqual(email.to.map(a => a.address), ['to@example.com']);
        assert.deepEqual(email.cc.map(a => a.address), ['cc@example.com']);
        assert.deepEqual(email.envelope.to.sort(), ['cc@example.com', 'hidden@example.com', 'to@example.com']);
        assert.ok(!email.headers.some(h => /hidden@example\.com/.test(h.value)), 'Bcc is not in any header');
        assert.deepEqual(email.attachments.map(a => a.filename), ['notes.txt', 'résumé "v2".txt']);
        const download = await admin(request(app).get(email.attachments[0].url));
        assert.equal(download.text, 'attached notes');
        // found by the hidden recipient
        assert.equal((await admin(request(app).get('/api/emails/latest')).query({ to: 'hidden@example.com' })).body.id, res.body.id);
    });

    test('validates recipients and attachments', async () => {
        const post = body => admin(request(app).post('/api/emails/test')).send({ from: 'a@example.com', to: 'b@example.com', text: 'x', ...body });
        assert.match((await post({ cc: 'nope' })).body.details.cc, /email addresses/);
        assert.match((await post({ bcc: 'nope' })).body.details.bcc, /email addresses/);
        assert.match((await post({ attachments: [{ filename: '../etc/passwd', content: 'aGk=' }] })).body.details.attachments, /slashes/);
        assert.match((await post({ attachments: [{ filename: 'a.txt', content: '***' }] })).body.details.attachments, /base64/);
        assert.match((await post({ attachments: Array.from({ length: 6 }, () => file('a.txt', 'x')) })).body.details.attachments, /at most 5/);
        const big = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');
        assert.match((await post({ attachments: [{ filename: 'big.bin', content: big }] })).body.details.attachments, /larger than 2 MB/);
    });

    test('a big body is only parsed for admins, and only on this route', async () => {
        const huge = { from: 'a@example.com', to: 'b@example.com', text: 'x', attachments: [{ filename: 'pad.bin', content: 'A'.repeat(700 * 1024) }] };
        // A server that refuses a big body early may close the connection before the client has finished
        // sending it, which shows up as a reset instead of a status; both mean it was refused.
        const refusal = pending => pending.then(res => res.status, error => (['ECONNRESET', 'EPIPE'].includes(error.code) ? 'reset' : Promise.reject(error)));
        assert.ok([401, 'reset'].includes(await refusal(request(app).post('/api/emails/test').send(huge))));
        // the rest of the API keeps its small limit
        assert.ok([413, 'reset'].includes(await refusal(admin(request(app).post('/api/keys')).send({ name: 'x'.repeat(700 * 1024) }))));
        // the test route accepts it (it is just not valid base64 content here, so 400, not 413)
        assert.notEqual((await admin(request(app).post('/api/emails/test')).send(huge)).status, 413);
    });
});
