const crypto = require('crypto');
const { logToFile } = require('../utils/logger');
const { Metrics } = require('../utils/metrics');

const TIMEOUT_MS = 5000;

// POSTs { event: 'email.received', email } for every stored email and { event: 'sms.received', sms } for every
// SMS to WEBHOOK_URL, so a CI job or another service can react without polling. An email carries its summary,
// the detected `code` and `links` (fetch GET /api/emails/:id for the bodies); an SMS carries everything,
// including its `code`. Failures are logged and never affect receiving messages; there are no retries.
// With WEBHOOK_SECRET set, the body is signed: X-Signature-256: sha256=<hex HMAC of the raw body>.
// Returns null when no URL is configured.
function createWebhook({ url, secret, metrics = new Metrics() }) {
    if (!url) return null;
    const host = new URL(url).host; // logged instead of the URL, which may carry a token

    // event: 'email.received' or 'sms.received'; the data goes under "email" / "sms"
    return async function notify(event, data) {
        const body = JSON.stringify({ event, [event.split('.')[0]]: data });
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'message-sandbox',
            'X-Message-Sandbox-Event': event,
        };
        if (secret) headers['X-Signature-256'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
        try {
            const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
            metrics.inc('message_sandbox_webhook_deliveries_total', { result: response.ok ? 'success' : 'failure' });
            logToFile(`Webhook to ${host} for ${event} id=${data.id}: HTTP ${response.status}`);
        } catch (error) {
            metrics.inc('message_sandbox_webhook_deliveries_total', { result: 'failure' });
            logToFile(`Webhook to ${host} for ${event} id=${data.id} failed: ${error.message}`);
        }
    };
}

module.exports = { createWebhook };
