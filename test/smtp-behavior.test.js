const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'email-smtp-logs-'));

const nodemailer = require('nodemailer');
const selfsigned = require('selfsigned');
const { SMTPServer } = require('smtp-server');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const EmailModel = require('../src/models/emailModel');
const { createIngest } = require('../src/mail/ingest');
const { createRelay } = require('../src/mail/relay');
const { createSmtpServer, listen, simulate } = require('../src/mail/smtpServer');
const { parseRule, parseRules, matchesAny } = require('../src/utils/recipients');
const { smtpSend } = require('./helpers/smtp');

const env = { ADMIN_PASSWORD: 'correct horse battery staple', SESSION_SECRET: 'x'.repeat(48), ADMIN_TOKEN: 'admin-token-0123456789' };
const mail = (to, subject = 'Hello') => ['From: app@example.com', `To: ${to}`, `Subject: ${subject}`, '', 'body'].join('\r\n');

let db;
let model;
const servers = [];

// Starts an SMTP server for one scenario; its port is returned
async function start(overrides = {}, { relay = null, secure = false } = {}) {
    const config = loadConfig({ ...env, ...overrides });
    const ingest = createIngest({ emailModel: model, relay });
    const server = createSmtpServer({ config, ingest, secure });
    servers.push(server);
    return listen(server, { port: 0, host: '127.0.0.1' });
}

const send = (port, to, data = mail(to[0])) => smtpSend(port, { from: 'app@example.com', to, data });
const codes = replies => replies.map(r => r.code);
const stored = async to => (await model.list({ limit: 50, offset: 0, to })).emails;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
    db = await initializeDatabase();
    model = new EmailModel(db);
});

after(async () => {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await db.close();
});

describe('recipient rules', () => {
    test('parse addresses, domains and subdomain wildcards', () => {
        assert.deepEqual(parseRule('Alice@Example.com'), { type: 'address', value: 'alice@example.com' });
        assert.deepEqual(parseRule('example.com'), { type: 'domain', value: 'example.com' });
        assert.deepEqual(parseRule('@example.com'), { type: 'domain', value: 'example.com' });
        assert.deepEqual(parseRule('*@example.com'), { type: 'domain', value: 'example.com' });
        assert.deepEqual(parseRule('*.example.com'), { type: 'subdomains', value: 'example.com' });
        for (const bad of ['', 'not a domain', 'a@b@c', '*.', 'x@', '@']) assert.throws(() => parseRule(bad), /not an address/, bad);
        assert.deepEqual(parseRules(' a@x.com, ,y.org '), [{ type: 'address', value: 'a@x.com' }, { type: 'domain', value: 'y.org' }]);
        assert.deepEqual(parseRules(''), []);
    });

    test('match ignoring case, and keep domains, subdomains and addresses apart', () => {
        const rules = parseRules('boss@corp.com, example.com, *.test.local');
        for (const yes of ['boss@corp.com', 'BOSS@Corp.com', 'anyone@example.com', 'a@x.test.local', 'a@deep.x.test.local']) assert.ok(matchesAny(rules, yes), yes);
        for (const no of ['other@corp.com', 'a@test.local', 'a@sub.example.com', 'a@notexample.com', 'nobody', '']) assert.ok(!matchesAny(rules, no), no);
    });
});

describe('failure simulation', () => {
    test('the special recipients', () => {
        assert.equal(simulate('alice@example.com').error, undefined);
        assert.equal(simulate('reject@example.com').error.responseCode, 550);
        assert.equal(simulate('REJECT+signup@example.com').error.responseCode, 550);
        assert.equal(simulate('tempfail@example.com').error.responseCode, 451);
        assert.equal(simulate('full@example.com').error.responseCode, 452);
        assert.equal(simulate('slow@example.com').delay, 5000);
        assert.equal(simulate('slow10@example.com').delay, 10000);
        assert.equal(simulate('slow999@example.com').delay, 30000, 'capped at 30 seconds');
        assert.equal(simulate('datafail@example.com').dataFail, true);
        // only the exact names, so ordinary addresses are never caught
        for (const normal of ['rejected@example.com', 'fullname@example.com', 'slowpoke@example.com', 'my.reject@example.com']) {
            assert.deepEqual(simulate(normal), {}, normal);
        }
    });

    test('refuse a recipient with the matching reply code, and keep the others', async () => {
        const port = await start();
        const replies = await send(port, ['reject@sim.example.com', 'ok-sim@example.com'], mail('ok-sim@example.com', 'Partly delivered'));
        // EHLO banner pieces first; the RCPT replies are the 550 and the 250, then DATA is accepted for the good one
        assert.ok(codes(replies).includes(550));
        assert.equal(codes(replies).at(-1), 250);
        assert.equal((await stored('ok-sim@example.com')).length, 1);
        assert.equal((await stored('reject@sim.example.com')).length, 0);

        assert.ok(codes(await send(port, ['tempfail@sim.example.com'])).includes(451));
        assert.ok(codes(await send(port, ['full@sim.example.com'])).includes(452));
    });

    test('slow@ answers late, datafail@ fails the message at DATA', async () => {
        const port = await start();
        const started = Date.now();
        const replies = await send(port, ['slow1@sim.example.com'], mail('slow1@sim.example.com', 'Late'));
        assert.ok(Date.now() - started >= 950, 'waited about a second');
        assert.equal(codes(replies).at(-1), 250);
        assert.equal((await stored('slow1@sim.example.com')).length, 1);

        const failed = await send(port, ['datafail@sim.example.com'], mail('datafail@sim.example.com', 'Never stored'));
        assert.equal(codes(failed).at(-1), 554);
        assert.equal((await stored('datafail@sim.example.com')).length, 0);
    });

    test('SMTP_SIMULATE=false treats them as ordinary addresses', async () => {
        const port = await start({ SMTP_SIMULATE: 'false' });
        assert.equal(codes(await send(port, ['reject@plain.example.com'])).at(-1), 250);
        assert.equal((await stored('reject@plain.example.com')).length, 1);
    });
});

describe('allowed domains', () => {
    test('only mail for the listed domains is accepted', async () => {
        const port = await start({ SMTP_ALLOWED_DOMAINS: 'example.com, *.test.local' });
        for (const yes of ['a@example.com', 'a@x.test.local']) {
            assert.equal(codes(await send(port, [yes])).at(-1), 250, yes);
        }
        for (const no of ['a@other.org', 'a@test.local', 'a@sub.example.com']) {
            const replies = await send(port, [no]);
            const refusal = replies.find(r => r.code === 550);
            assert.ok(refusal, no);
            assert.match(refusal.text, /only accepts mail for example\.com, \*\.test\.local/);
        }
        assert.equal((await stored('a@other.org')).length, 0);
    });
});

describe('TLS', () => {
    let files;
    before(async () => {
        const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 2, keySize: 2048, algorithm: 'sha256' });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-smtp-tls-'));
        files = { SMTP_TLS_KEY: path.join(dir, 'key.pem'), SMTP_TLS_CERT: path.join(dir, 'cert.pem') };
        fs.writeFileSync(files.SMTP_TLS_KEY, pems.private);
        fs.writeFileSync(files.SMTP_TLS_CERT, pems.cert);
    });

    const client = (port, options) =>
        nodemailer.createTransport({ host: '127.0.0.1', port, tls: { rejectUnauthorized: false }, ...options });
    const message = to => ({ from: 'app@example.com', to, subject: 'Encrypted', text: 'secret' });

    test('without a certificate STARTTLS is not offered', async () => {
        const port = await start();
        await assert.rejects(client(port, { secure: false, requireTLS: true }).sendMail(message('plain-tls@example.com')), /STARTTLS|TLS/i);
        await client(port, { secure: false, ignoreTLS: true }).sendMail(message('plain-tls@example.com'));
        assert.equal((await stored('plain-tls@example.com')).length, 1);
    });

    test('with a certificate STARTTLS works', async () => {
        const port = await start(files);
        const info = await client(port, { secure: false, requireTLS: true }).sendMail(message('starttls@example.com'));
        assert.deepEqual(info.accepted, ['starttls@example.com']);
        assert.equal((await stored('starttls@example.com')).length, 1);
    });

    test('the TLS listener is encrypted from the first byte', async () => {
        const port = await start(files, { secure: true });
        await client(port, { secure: true }).sendMail(message('implicit@example.com'));
        assert.equal((await stored('implicit@example.com')).length, 1);
    });

    test('a TLS listener without a certificate is refused', async () => {
        assert.throws(() => createSmtpServer({ config: loadConfig(env), ingest: () => {}, secure: true }), /SMTP_TLS_KEY/);
    });
});

describe('relay', () => {
    let upstream;
    let upstreamPort;
    let delivered = [];

    before(async () => {
        // A stand-in for the real mail server the relay forwards to
        upstream = new SMTPServer({
            authOptional: true,
            disabledCommands: ['STARTTLS'],
            logger: false,
            onData(stream, session, callback) {
                const chunks = [];
                stream.on('data', c => chunks.push(c));
                stream.on('end', () => {
                    delivered.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map(r => r.address), message: Buffer.concat(chunks).toString() });
                    callback();
                });
            },
        });
        upstreamPort = await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(upstream.server.address().port)));
        servers.push(upstream);
    });

    const relayEnv = () => ({ RELAY_HOST: '127.0.0.1', RELAY_PORT: String(upstreamPort), RELAY_ALLOW: 'real@example.net, @allowed.test' });
    const waitFor = async condition => {
        for (let i = 0; i < 60 && !condition(); i += 1) await delay(50);
    };

    test('forwards only the allowlisted recipients, and still stores the email', async () => {
        delivered = [];
        const config = loadConfig({ ...env, ...relayEnv() });
        const port = await start(relayEnv(), { relay: createRelay(config) });
        const replies = await send(port, ['real@example.net', 'someone@allowed.test', 'blocked@example.org'], mail('real@example.net', 'Forward me'));
        assert.equal(codes(replies).at(-1), 250);

        await waitFor(() => delivered.length > 0);
        assert.equal(delivered.length, 1);
        assert.deepEqual(delivered[0].to.sort(), ['real@example.net', 'someone@allowed.test']);
        assert.equal(delivered[0].from, 'app@example.com');
        assert.match(delivered[0].message, /Subject: Forward me/);
        assert.equal((await stored('blocked@example.org')).length, 1, 'stored for every recipient');
    });

    test('does not forward when no recipient is on the list', async () => {
        delivered = [];
        const config = loadConfig({ ...env, ...relayEnv() });
        const port = await start(relayEnv(), { relay: createRelay(config) });
        await send(port, ['nobody@example.org'], mail('nobody@example.org', 'Stay local'));
        await delay(400);
        assert.equal(delivered.length, 0);
    });

    test('RELAY_FROM replaces the envelope sender', async () => {
        delivered = [];
        const overrides = { ...relayEnv(), RELAY_FROM: 'service@mydomain.test' };
        const port = await start(overrides, { relay: createRelay(loadConfig({ ...env, ...overrides })) });
        await send(port, ['real@example.net'], mail('real@example.net', 'From override'));
        await waitFor(() => delivered.length > 0);
        assert.equal(delivered[0].from, 'service@mydomain.test');
    });

    test('a relay that is down never affects receiving mail', async () => {
        const overrides = { ...relayEnv(), RELAY_PORT: '1' };
        const port = await start(overrides, { relay: createRelay(loadConfig({ ...env, ...overrides })) });
        const replies = await send(port, ['real@example.net'], mail('real@example.net', 'Relay is down'));
        assert.equal(codes(replies).at(-1), 250);
        assert.equal((await model.list({ limit: 5, offset: 0, subject: 'Relay is down' })).total, 1);
        await delay(300);
    });

    test('no relay without RELAY_HOST', () => {
        assert.equal(createRelay(loadConfig(env)), null);
    });
});

describe('configuration', () => {
    const invalid = (overrides, pattern) => assert.throws(() => loadConfig({ ...env, ...overrides }), pattern);

    test('rejects settings that would be unsafe or can not work', () => {
        invalid({ RELAY_HOST: 'smtp.example.com' }, /RELAY_HOST needs RELAY_ALLOW/);
        invalid({ RELAY_HOST: 'smtp.example.com', RELAY_ALLOW: 'a@b.com', RELAY_USER: 'u' }, /RELAY_USER and RELAY_PASSWORD/);
        invalid({ RELAY_ALLOW: 'not an address' }, /RELAY_ALLOW: "not an address"/);
        invalid({ SMTP_ALLOWED_DOMAINS: 'ok.com, bad domain' }, /SMTP_ALLOWED_DOMAINS/);
    });

    test('TLS problems switch TLS off instead of failing', () => {
        const tlsOff = (overrides, pattern) => {
            const config = loadConfig({ ...env, ...overrides });
            assert.match(config.tlsErrors.join('; '), pattern);
            assert.equal(config.smtpTlsKey, '');
            assert.equal(config.smtpTlsPort, 0);
        };
        tlsOff({ SMTP_TLS_KEY: __filename }, /SMTP_TLS_KEY and SMTP_TLS_CERT must be set together/);
        tlsOff({ SMTP_TLS_KEY: '/nope/key.pem', SMTP_TLS_CERT: '/nope/cert.pem' }, /does not exist/);
        tlsOff({ SMTP_TLS_PORT: '1465' }, /SMTP_TLS_PORT needs/);
        tlsOff({ SMTP_TLS_KEY: __filename, SMTP_TLS_CERT: __filename, SMTP_TLS_PORT: '1025' }, /must differ from SMTP_PORT/);
    });

    test('defaults', () => {
        const config = loadConfig(env);
        assert.equal(config.smtpSimulate, true);
        assert.deepEqual(config.smtpAllowedDomains, []);
        assert.equal(config.smtpTlsPort, 0);
        assert.equal(config.relayHost, '');
        assert.equal(loadConfig({ ...env, SMTP_SIMULATE: 'false' }).smtpSimulate, false);
    });
});
