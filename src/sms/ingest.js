const { extractOtp } = require('../utils/otp');
const { logToFile } = require('../utils/logger');
const { Metrics } = require('../utils/metrics');

// How an SMS enters the system (POST /api/sms): store it, wake requests waiting in GET /api/sms/wait and the
// live event stream, and call the webhook if one is configured. The webhook receives the full phone number
// (the API masks it for display); it is configured by the operator, and needs it to match the recipient.
function createSmsIngest({ smsModel, events = null, webhook = null, metrics = new Metrics() }) {
    return async function ingestSms({ sender, phone, message, apiKeyName }) {
        const { id, timestamp } = await smsModel.create({ sender, phone, message, apiKeyName });
        metrics.inc('messaging_test_sms_received_total');
        if (events) events.emit('sms', id);
        if (webhook) {
            // Not awaited: a slow receiver must not delay the API reply
            smsModel
                .getSummary(id)
                .then(stored => webhook('sms.received', { ...stored, code: extractOtp(stored.message) }))
                .catch(error => logToFile(`Webhook preparation failed for SMS id=${id}: ${error.message}`));
        }
        return { id, timestamp };
    };
}

module.exports = { createSmsIngest };
