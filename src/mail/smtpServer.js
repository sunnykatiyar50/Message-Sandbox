const fs = require('fs');
const { SMTPServer } = require('smtp-server');
const { safeEqual } = require('../utils/session');
const { matchesAny, describeRule } = require('../utils/recipients');
const { logToFile } = require('../utils/logger');
const { Metrics } = require('../utils/metrics');

// Accepts every message, from anyone to anyone, and stores it. Nothing is relayed unless the optional relay
// is configured (see relay.js).
//
// TLS is optional. Without SMTP_TLS_KEY / SMTP_TLS_CERT the server has no certificate, so STARTTLS is not
// offered (clients told TLS is available would reject a self-signed one); point your app at it with TLS off.
// With them, STARTTLS is offered, and SMTP_TLS_PORT adds a second listener that is TLS from the first byte.

// Special recipients that make delivery fail on purpose, to test how an app handles it. The local part
// (before any +tag) picks the behaviour: reject@, tempfail@, full@, slow@ / slow10@, datafail@.
const SIMULATIONS = /^(reject|tempfail|full|slow|datafail)(\d*)(?:[+._-].*)?$/;
const DEFAULT_SLOW_SECONDS = 5;
const MAX_SLOW_SECONDS = 30;

function failure(code, message) {
    const error = new Error(message);
    error.responseCode = code;
    return error;
}

// What to do with a recipient: { error } to refuse it, { delay } (ms) to answer late, { dataFail: true } to
// accept it but fail the message at DATA, or {} for a normal recipient
function simulate(address) {
    const local = String(address || '').split('@')[0].toLowerCase();
    const match = SIMULATIONS.exec(local);
    if (!match) return {};
    switch (match[1]) {
        case 'reject':
            return { error: failure(550, 'Mailbox unavailable (simulated)') };
        case 'tempfail':
            return { error: failure(451, 'Temporary failure, try again later (simulated)') };
        case 'full':
            return { error: failure(452, 'Mailbox full (simulated)') };
        case 'datafail':
            return { dataFail: true };
        default: {
            const seconds = match[2] ? Math.min(Number(match[2]), MAX_SLOW_SECONDS) : DEFAULT_SLOW_SECONDS;
            return { delay: seconds * 1000 };
        }
    }
}

// secure: TLS from the first byte (the SMTP_TLS_PORT listener); otherwise plain, with STARTTLS if there is a certificate
function createSmtpServer({ config, ingest, secure = false, metrics = new Metrics() }) {
    const authRequired = Boolean(config.smtpUsername);
    const tls = config.smtpTlsKey && config.smtpTlsCert
        ? { key: fs.readFileSync(config.smtpTlsKey), cert: fs.readFileSync(config.smtpTlsCert) }
        : null;
    if (secure && !tls) throw new Error('A TLS listener needs SMTP_TLS_KEY and SMTP_TLS_CERT');

    const server = new SMTPServer({
        banner: 'Message Sandbox',
        authOptional: !authRequired,
        allowInsecureAuth: true,
        secure,
        ...tls,
        disabledCommands: tls ? [] : ['STARTTLS'],
        size: config.maxEmailBytes,
        logger: false,

        onConnect(session, callback) {
            metrics.inc('message_sandbox_smtp_connections_total');
            callback();
        },

        onAuth(auth, session, callback) {
            if (!authRequired) return callback(null, { user: auth.username || 'anonymous' });
            // Evaluate both so timing doesn't reveal which one was wrong
            const userOk = safeEqual(auth.username || '', config.smtpUsername);
            const passOk = safeEqual(auth.password || '', config.smtpPassword);
            if (userOk && passOk) return callback(null, { user: auth.username });
            logToFile(`SMTP login failed from ${session.remoteAddress}`);
            callback(new Error('Invalid username or password'));
        },

        onRcptTo(address, session, callback) {
            // Only mail for the listed domains, so a mistyped address in an app's config is caught
            if (config.smtpAllowedDomains.length && !matchesAny(config.smtpAllowedDomains, address.address)) {
                const allowed = config.smtpAllowedDomains.map(describeRule).join(', ');
                metrics.inc('message_sandbox_recipients_rejected_total', { reason: 'allowed_domains' });
                return callback(failure(550, `Relay access denied: this server only accepts mail for ${allowed}`));
            }
            if (!config.smtpSimulate) return callback();
            const { error, delay, dataFail } = simulate(address.address);
            if (error) {
                metrics.inc('message_sandbox_recipients_rejected_total', { reason: 'simulated' });
                return callback(error);
            }
            if (dataFail) session.simulateDataFailure = true;
            if (delay) return setTimeout(callback, delay);
            callback();
        },

        onData(stream, session, callback) {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('error', callback);
            stream.on('end', async () => {
                if (stream.sizeExceeded) {
                    const error = new Error(`Message exceeds the ${Math.round(config.maxEmailBytes / 1048576)} MB limit`);
                    error.responseCode = 552;
                    metrics.inc('message_sandbox_messages_rejected_total', { reason: 'size' });
                    return callback(error);
                }
                if (session.simulateDataFailure) {
                    metrics.inc('message_sandbox_messages_rejected_total', { reason: 'simulated' });
                    return callback(failure(554, 'Transaction failed (simulated)'));
                }
                try {
                    const { id, size, recipients } = await ingest(Buffer.concat(chunks), {
                        envelope: session.envelope,
                        smtpUser: session.user || null,
                    });
                    // Only metadata is logged; subjects and bodies (often reset links or codes) never reach the log file
                    logToFile(`Stored email id=${id} size=${size} recipients=${recipients} from=${session.remoteAddress}`);
                    callback();
                } catch (error) {
                    metrics.inc('message_sandbox_messages_rejected_total', { reason: 'store_error' });
                    logToFile(`Failed to store email: ${error.stack || error}`);
                    callback(failure(451, 'Could not store the message, try again'));
                }
            });
        },
    });

    server.on('error', error => {
        const from = error.remote || error.remoteAddress;
        if (/while initiating TLS/i.test(error.message)) {
            // The client dropped the connection during the handshake: usually it doesn't trust the certificate
            // (self-signed, or a Let's Encrypt staging one), or it is a port scanner. Not a server fault.
            logToFile(`TLS handshake did not complete${from ? ` from ${from}` : ''}: the client closed the connection (it may not trust the certificate)`);
            return;
        }
        logToFile(`SMTP server error: ${error.message}`);
    });
    return server;
}

// Resolves with the bound port once listening; rejects if the port is taken
function listen(server, { port, host }) {
    return new Promise((resolve, reject) => {
        server.server.once('error', reject);
        server.listen(port, host, () => {
            server.server.removeListener('error', reject);
            resolve(server.server.address().port);
        });
    });
}

module.exports = { createSmtpServer, listen, simulate };
