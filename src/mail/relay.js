const nodemailer = require('nodemailer');
const { matchesAny } = require('../utils/recipients');
const { logToFile } = require('../utils/logger');
const { Metrics } = require('../utils/metrics');

// Optionally forwards a stored email to a real mail server, for the recipients on an allowlist only.
// Off unless RELAY_HOST is set, and it refuses to start without RELAY_ALLOW, so a test server can't be
// turned into an open relay. The email is stored either way; relaying is best effort and failures are
// logged. Returns null when no relay is configured.
function createRelay(config, metrics = new Metrics()) {
    if (!config.relayHost) return null;

    const transport = nodemailer.createTransport({
        host: config.relayHost,
        port: config.relayPort,
        secure: config.relaySecure, // true: TLS from the start (port 465); false: STARTTLS when offered
        auth: config.relayUser ? { user: config.relayUser, pass: config.relayPassword } : undefined,
    });

    // raw: the message bytes; envelope: the SMTP envelope as received ({ mailFrom, rcptTo })
    return async function relay(id, raw, envelope = {}) {
        const recipients = (envelope.rcptTo || []).map(r => r.address).filter(address => matchesAny(config.relayAllow, address));
        if (recipients.length === 0) return;
        const from = config.relayFrom || (envelope.mailFrom && envelope.mailFrom.address) || undefined;
        try {
            await transport.sendMail({ envelope: { from, to: recipients }, raw });
            metrics.inc('message_sandbox_relay_total', { result: 'sent' });
            logToFile(`Relayed email id=${id} to ${recipients.length} allowed recipient(s) via ${config.relayHost}`);
        } catch (error) {
            metrics.inc('message_sandbox_relay_total', { result: 'failed' });
            logToFile(`Relay of email id=${id} via ${config.relayHost} failed: ${error.message}`);
        }
    };
}

module.exports = { createRelay };
