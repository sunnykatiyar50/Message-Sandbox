const { visibleTo } = require('../utils/recipients');
const { maskPhoneNumber } = require('../utils/mask');
const { extractOtp } = require('../utils/otp');

const MAX_EVENT_STREAMS = 100;
const HEARTBEAT_MS = 25000;

// GET /api/events, Server-Sent Events: `event: email` (the email's summary) for every email stored from now
// on, and `event: sms` (the message, phone masked, with its code) for every SMS, so a dashboard or script can
// react without polling. A key limited to some email inboxes only receives events for those, and none for SMS.
class EventsController {
    constructor({ emailModel, smsModel, events, metrics }) {
        this.emailModel = emailModel;
        this.smsModel = smsModel;
        this.events = events;
        this.streams = 0;
        metrics.gauge('messaging_test_event_streams', 'Open live-update connections (GET /api/events).', () => this.streams);
    }

    stream(req, res) {
        if (this.streams >= MAX_EVENT_STREAMS) return res.status(503).json({ error: 'Too many live connections.' });
        this.streams += 1;

        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no', // tells nginx not to buffer the stream
        });
        res.flushHeaders();
        res.write('retry: 3000\n\n');

        const scope = req.auth.recipientScope || null;
        const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

        const onEmail = async id => {
            try {
                const summary = await this.emailModel.getSummary(id);
                if (summary && visibleTo(summary, scope)) send('email', summary);
            } catch {
                // the next one will still arrive
            }
        };
        const onSms = async id => {
            if (scope) return; // limited keys only see their email inboxes
            try {
                const message = await this.smsModel.getSummary(id);
                if (message) send('sms', { ...message, phone: maskPhoneNumber(message.phone), code: extractOtp(message.message) });
            } catch {
                // the next one will still arrive
            }
        };
        // A comment line keeps proxies and browsers from closing an idle connection
        const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
        this.events.on('email', onEmail);
        this.events.on('sms', onSms);
        res.on('close', () => {
            clearInterval(heartbeat);
            this.events.off('email', onEmail);
            this.events.off('sms', onSms);
            this.streams -= 1;
        });
        return undefined;
    }
}

module.exports = EventsController;
