require('dotenv').config();

const { loadConfig } = require('./config');
const initializeDatabase = require('./database/initDatabase');
const EmailModel = require('./models/emailModel');
const SmsModel = require('./models/smsModel');
const ApiKeyModel = require('./models/apiKeyModel');
const ActivityModel = require('./models/activityModel');
const { createApp } = require('./server');
const { createIngest } = require('./mail/ingest');
const { createSmsIngest } = require('./sms/ingest');
const { createEvents } = require('./mail/events');
const { createWebhook } = require('./mail/webhook');
const { createRelay } = require('./mail/relay');
const { createSmtpServer, listen: listenSmtp } = require('./mail/smtpServer');
const { createCertManager, readCertInfo } = require('./certs/certManager');
const { setupTls } = require('./certs/tlsSetup');
const { logToFile } = require('./utils/logger');
const activity = require('./utils/activity');
const { Metrics } = require('./utils/metrics');

const fs = require('fs');

const HOUR_MS = 60 * 60 * 1000;

function scheduleRetention({ emailModel, smsModel }, retentionDays) {
    if (!retentionDays) return;
    const purge = async () => {
        try {
            const cutoff = new Date(Date.now() - retentionDays * 24 * HOUR_MS);
            const emails = await emailModel.deleteOlderThan(cutoff);
            const messages = await smsModel.deleteOlderThan(cutoff);
            if (emails || messages) {
                activity.record({ category: 'system', message: `Retention: deleted ${emails} email(s) and ${messages} SMS message(s) older than ${retentionDays} day(s)` });
            }
        } catch (error) {
            activity.record({ level: 'error', category: 'system', message: `Retention cleanup failed: ${error.message}` });
        }
    };
    purge();
    setInterval(purge, HOUR_MS).unref();
}

// Keeps the Activity page's table within ACTIVITY_RETENTION_DAYS and ACTIVITY_MAX_ROWS (hourly)
function scheduleActivityCleanup(activityModel, { activityRetentionDays, activityMaxRows }) {
    if (!activityRetentionDays && !activityMaxRows) return;
    const prune = async () => {
        try {
            if (activityRetentionDays) await activityModel.deleteOlderThan(new Date(Date.now() - activityRetentionDays * 24 * HOUR_MS));
            if (activityMaxRows) await activityModel.trimTo(activityMaxRows);
        } catch (error) {
            logToFile(`Activity cleanup failed: ${error.message}`);
        }
    };
    prune();
    setInterval(prune, HOUR_MS).unref();
}

async function main() {
    const config = loadConfig();

    const db = await initializeDatabase();
    const emailModel = new EmailModel(db);
    const smsModel = new SmsModel(db);
    // Dashboard-created API keys are encrypted with a key derived from SESSION_SECRET
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    // Audit trail and errors for the Activity page: events are recorded from here on
    const activityModel = new ActivityModel(db);
    activity.attach(activityModel);
    scheduleActivityCleanup(activityModel, config);
    const activeKeys = (await apiKeyModel.list()).filter(k => !k.revokedAt).length;
    if (!config.authDisabled && activeKeys === 0) {
        logToFile('No API keys yet: sign in to the dashboard and create one on the API keys page');
    }
    scheduleRetention({ emailModel, smsModel }, config.retentionDays);

    // TLS is optional: if it can't be set up the server starts without it (the reason is logged). With
    // ACME_DOMAINS the Let's Encrypt certificate has to exist before the TLS listeners start.
    // Certificate messages also go to the Activity page; failures count as errors, problems as warnings
    const certLog = message => activity.record({ level: /error|fail/i.test(message) ? 'error' : /warning|could not|cannot|unable/i.test(message) ? 'warn' : 'info', category: 'tls', message });
    const certManager = config.acmeDomains.length ? createCertManager(config, { log: certLog }) : null;
    const tlsReady = await setupTls(config, { certManager, log: certLog });
    if (tlsReady && certManager) certManager.markLoaded();
    if (tlsReady) {
        // What clients will be shown, so a name or issuer mismatch is visible without a debugger
        const cert = readCertInfo(config.smtpTlsCert);
        if (cert) logToFile(`SMTP TLS certificate: ${cert.names.join(', ') || 'no DNS names'}; issued by ${cert.issuer}${cert.staging ? ' (Let\'s Encrypt staging, not trusted by clients)' : ''}; valid until ${cert.expires.toISOString().slice(0, 10)}`);
    }

    const events = createEvents();
    const metrics = new Metrics();
    const webhook = createWebhook({ url: config.webhookUrl, secret: config.webhookSecret, metrics });
    if (webhook) logToFile(`Webhook enabled: new emails are POSTed to ${new URL(config.webhookUrl).host}`);
    const relay = createRelay(config, metrics);
    if (relay) logToFile(`Relay enabled: mail for ${config.relayAllow.length} allowed recipient rule(s) is forwarded via ${config.relayHost}`);
    const ingest = createIngest({ emailModel, events, webhook, relay, metrics });
    const ingestSms = createSmsIngest({ smsModel, events, webhook, metrics });
    const app = createApp({ config, emailModel, smsModel, apiKeyModel, activityModel, ingest, ingestSms, events, metrics });
    const server = app.listen(config.port, () => {
        activity.record({ category: 'system', message: `Dashboard and API are running on http://localhost:${config.port} (version ${require('../package.json').version})` });
        if (config.authDisabled) {
            activity.record({ level: 'warn', category: 'system', message: 'AUTH_DISABLED=true: the API and dashboard are open to anyone who can reach this server' });
        }
    });

    const smtp = createSmtpServer({ config, ingest, metrics });
    const smtpPort = await listenSmtp(smtp, { port: config.smtpPort, host: config.smtpHost });
    const tlsNote = config.smtpTlsKey ? ', STARTTLS available' : '';
    logToFile(
        `SMTP server is listening on ${config.smtpHost}:${smtpPort} ` +
        `(${config.smtpUsername ? 'login required' : 'any or no login accepted'}${tlsNote})`
    );
    const smtpServers = [smtp];
    if (config.smtpTlsPort) {
        const smtpTls = createSmtpServer({ config, ingest, secure: true, metrics });
        const tlsPort = await listenSmtp(smtpTls, { port: config.smtpTlsPort, host: config.smtpHost });
        logToFile(`SMTP over TLS is listening on ${config.smtpHost}:${tlsPort}`);
        smtpServers.push(smtpTls);
    }
    if (certManager && tlsReady) {
        // Renewals (this process or `node src/certs/cli.js renew`) are picked up without a restart
        certManager.schedule(() => {
            const tls = { key: fs.readFileSync(config.smtpTlsKey), cert: fs.readFileSync(config.smtpTlsCert) };
            for (const server of smtpServers) server.updateSecureContext(tls);
        });
    }
    if (config.smtpAllowedDomains.length) logToFile(`SMTP accepts mail only for ${config.smtpAllowedDomains.length} allowed domain rule(s)`);

    handleShutdown({ server, smtpServers, db });
}

// Stop accepting connections, let in-flight requests finish, then close the database.
// Without this, `docker stop` waits its full timeout and then kills the process.
function handleShutdown({ server, smtpServers, db }) {
    let shuttingDown = false;
    const shutdown = signal => {
        if (shuttingDown) return;
        shuttingDown = true;
        activity.record({ category: 'system', message: `${signal} received, shutting down` });
        setTimeout(() => {
            activity.record({ level: 'error', category: 'system', message: 'Shutdown timed out, exiting' });
            process.exit(1);
        }, 8000).unref();
        const closing = [...smtpServers.map(smtp => new Promise(resolve => smtp.close(resolve))), new Promise(resolve => server.close(resolve))];
        server.closeIdleConnections();
        Promise.all(closing).then(async () => {
            try {
                await db.close();
            } catch (error) {
                logToFile(`Error closing database: ${error.message}`);
            }
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
    logToFile(`Startup failed: ${error.stack || error}`);
    process.exit(1);
});
