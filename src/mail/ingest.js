const { parseEmail } = require('./parse');
const { presentEmail } = require('./present');
const { logToFile } = require('../utils/logger');
const { Metrics } = require('../utils/metrics');

// The one way mail enters the system: raw message bytes in, stored email id out.
// Used by the SMTP server and by the dashboard's "Send test" form. After storing, it wakes requests waiting
// in GET /api/emails/wait (events), calls the webhook, and forwards to the relay, if those are configured.
function createIngest({ emailModel, events = null, webhook = null, relay = null, metrics = new Metrics() }) {
    return async function ingest(raw, options) {
        const record = await parseEmail(raw, options);
        const { id, timestamp } = await emailModel.create(record);
        metrics.inc('message_sandbox_emails_received_total');
        metrics.inc('message_sandbox_received_bytes_total', {}, record.size);
        if (events) events.emit('email', id);
        if (webhook) {
            // Not awaited: a slow receiver must not delay the SMTP reply
            emailModel
                .get(id)
                .then(email => {
                    const { text, html, headers, ...summary } = presentEmail(email);
                    return webhook('email.received', summary);
                })
                .catch(error => logToFile(`Webhook preparation failed for email id=${id}: ${error.message}`));
        }
        // Forwards to the allowlisted recipients, if a relay is configured. Not awaited, like the webhook.
        if (relay) relay(id, raw, options && options.envelope).catch(error => logToFile(`Relay failed for email id=${id}: ${error.message}`));
        return { id, timestamp, size: record.size, recipients: record.envelopeTo.length || record.to.length };
    };
}

module.exports = { createIngest };
