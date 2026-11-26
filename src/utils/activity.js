const { logToFile } = require('./logger');

const LEVELS = ['info', 'warn', 'error'];
const CATEGORIES = ['auth', 'keys', 'smtp', 'tls', 'ratelimit', 'webhook', 'relay', 'system'];
const MAX_FIELD = { message: 1000, ip: 64, actor: 64 };
const THROTTLE_MAP_LIMIT = 1000;

const clip = (value, max) => (value == null || value === '' ? null : String(value).slice(0, max));

// The audit trail and error list behind the dashboard's Activity page. record() writes the usual log line
// (so the log file and stdout stay complete) and, once a model is attached, a row in the database.
//
// A module-level recorder, because the places that report events (login, SMTP, key routes, webhook, relay,
// rate limiters) are spread over the code base. Until attach() is called (tests, early startup) it only logs.
// It never throws and never waits: a database problem must not break the request that triggered the event.
let sink = null;
const lastSeen = new Map(); // throttle key -> time of the last recorded event

function attach(model) {
    sink = model;
}

// level: info | warn | error. category: one of CATEGORIES. ip and actor (a username or API key name) are optional.
// throttleMs: record the same event (same category, ip and message) at most once in that time, for events that
// a client can repeat in a flood, such as rate-limit hits and wrong API keys.
function record({ level = 'info', category = 'system', message, ip, actor, throttleMs = 0 }) {
    if (throttleMs > 0) {
        const key = `${category}|${ip || ''}|${message}`;
        const now = Date.now();
        if (now - (lastSeen.get(key) || 0) < throttleMs) return;
        if (lastSeen.size >= THROTTLE_MAP_LIMIT) lastSeen.clear();
        lastSeen.set(key, now);
    }
    logToFile(message);
    if (!sink) return;
    sink
        .create({
            level: LEVELS.includes(level) ? level : 'info',
            category: CATEGORIES.includes(category) ? category : 'system',
            message: clip(message, MAX_FIELD.message) || '',
            ip: clip(ip, MAX_FIELD.ip),
            actor: clip(actor, MAX_FIELD.actor),
        })
        .catch(error => logToFile(`Could not store an activity event: ${error.message}`));
}

module.exports = { record, attach, LEVELS, CATEGORIES };

// For express-rate-limit's `handler` option: records the hit (once a minute per client and limiter), then
// answers like the default handler does
function rateLimitHandler(label) {
    return (req, res, next, options) => {
        record({
            level: 'warn',
            category: 'ratelimit',
            message: `Rate limit reached on ${label} from ${req.ip}`,
            ip: req.ip,
            throttleMs: 60 * 1000,
        });
        res.status(options.statusCode).send(options.message);
    };
}

module.exports.rateLimitHandler = rateLimitHandler;
