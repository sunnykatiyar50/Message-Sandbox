// The settings that can be changed on the dashboard's Settings page instead of in .env.
//
// The database stores each value as text under its environment variable name, exactly as it would be written
// in .env. A value there wins; without one, .env applies, and without that the default. Because the stored text
// goes through the same loadConfig() as .env, parsing and validation are identical.
//
// Left in .env on purpose (see ENV_ONLY): passwords, tokens and secrets, and the things the server needs
// before it can read the database or that decide who may sign in.
//
//   apply: 'live'     takes effect as soon as it is saved
//   apply: 'restart'  is saved, and used the next time the server starts
//   props             the config properties this setting produces (see config.js); used to apply live changes
//                     and to tell when a restart is still needed

const GROUPS = {
    dashboard: 'Dashboard and API',
    smtp: 'Receiving mail (SMTP)',
    tls: 'TLS and certificates',
    relay: 'Relay to a real mail server',
    webhook: 'Webhook',
    data: 'Data retention',
};

const rateLimit = (key, label, route, prop) => ({
    key,
    group: GROUPS.dashboard,
    label,
    help: `Most ${route} requests per minute from one client address.`,
    type: 'int',
    min: 1,
    max: 1000000,
    default: '120',
    props: [prop],
    apply: 'live',
});

const SETTINGS = [
    // --- Dashboard and API ---
    { key: 'PORT', group: GROUPS.dashboard, label: 'Dashboard and API port', help: 'The port the dashboard and API listen on.', type: 'int', min: 1, max: 65535, default: '30005', props: ['port'], apply: 'restart' },
    { key: 'SESSION_TTL_HOURS', group: GROUPS.dashboard, label: 'Sign-in lasts (hours)', help: 'How long a dashboard sign-in stays valid. People who are already signed in keep their current expiry.', type: 'int', min: 1, max: 720, default: '12', props: ['sessionTtlHours'], apply: 'live' },
    rateLimit('SMS_RATE_LIMIT', 'SMS rate limit', 'POST /api/sms', 'smsRateLimit'),
    rateLimit('API_RATE_LIMIT', '"Send test" email rate limit', 'POST /api/emails/test', 'apiRateLimit'),
    { key: 'METRICS', group: GROUPS.dashboard, label: 'Prometheus metrics', help: 'Serve GET /metrics.', type: 'bool', default: 'true', props: ['metricsEnabled'], apply: 'live' },
    { key: 'LINK_CHECK', group: GROUPS.dashboard, label: 'Link checking', help: "Let an admin check an email's links from the dashboard. The server then requests those URLs, so turn it off if that is a concern.", type: 'bool', default: 'true', props: ['linkCheck'], apply: 'live' },

    // --- Receiving mail ---
    { key: 'SMTP_PORT', group: GROUPS.smtp, label: 'SMTP port', help: 'The port your apps send mail to.', type: 'int', min: 1, max: 65535, default: '1025', props: ['smtpPort'], apply: 'restart' },
    { key: 'SMTP_HOST', group: GROUPS.smtp, label: 'SMTP listen address', help: '0.0.0.0 listens on every network interface.', type: 'text', default: '0.0.0.0', props: ['smtpHost'], apply: 'restart' },
    { key: 'MAX_EMAIL_SIZE_MB', group: GROUPS.smtp, label: 'Largest email (MB)', help: 'Bigger messages are rejected.', type: 'int', min: 1, max: 1024, default: '10', props: ['maxEmailBytes'], apply: 'live' },
    { key: 'SMTP_SIMULATE', group: GROUPS.smtp, label: 'Simulate delivery failures', help: 'Special recipients (reject@, tempfail@, full@, slow@, datafail@) fail on purpose.', type: 'bool', default: 'true', props: ['smtpSimulate'], apply: 'live' },
    { key: 'SMTP_DEBUG', group: GROUPS.smtp, label: 'Log every SMTP connection', help: 'Logs each connection and its TLS details (never message content), to debug clients that cannot connect.', type: 'bool', default: 'false', props: ['smtpDebug'], apply: 'live' },
    { key: 'SMTP_ALLOWED_DOMAINS', group: GROUPS.smtp, label: 'Accept mail only for', help: 'Comma separated domains (example.org) and subdomain wildcards (*.test.local). Empty accepts every recipient.', type: 'list', default: '', props: ['smtpAllowedDomains'], apply: 'live' },

    // --- TLS ---
    { key: 'SMTP_TLS_PORT', group: GROUPS.tls, label: 'TLS-only port', help: 'A second SMTP port that is TLS from the first byte (0 = none). Needs a certificate.', type: 'int', min: 0, max: 65535, default: '0', props: ['smtpTlsPort'], apply: 'restart' },
    { key: 'SMTP_TLS_KEY', group: GROUPS.tls, label: 'TLS key file', help: 'Path of the private key (PEM). Not used with ACME_DOMAINS.', type: 'text', default: '', props: ['smtpTlsKey'], apply: 'restart' },
    { key: 'SMTP_TLS_CERT', group: GROUPS.tls, label: 'TLS certificate file', help: 'Path of the certificate (PEM). Not used with ACME_DOMAINS.', type: 'text', default: '', props: ['smtpTlsCert'], apply: 'restart' },
    { key: 'ACME_DOMAINS', group: GROUPS.tls, label: "Let's Encrypt domains", help: 'Comma separated. The certificate is requested and renewed automatically. Needs the contact email below and CLOUDFLARE_API_TOKEN (in .env).', type: 'list', default: '', props: ['acmeDomains', 'smtpTlsKey', 'smtpTlsCert'], apply: 'restart' },
    { key: 'ACME_EMAIL', group: GROUPS.tls, label: "Let's Encrypt contact email", help: 'Expiry notices are sent here.', type: 'text', default: '', props: ['acmeEmail'], apply: 'restart' },
    { key: 'ACME_STAGING', group: GROUPS.tls, label: "Use Let's Encrypt staging", help: 'For testing: certificates are not trusted by clients.', type: 'bool', default: 'false', props: ['acmeStaging'], apply: 'restart' },
    { key: 'ACME_RENEW_DAYS', group: GROUPS.tls, label: 'Renew this many days before expiry', help: '', type: 'int', min: 1, max: 89, default: '30', props: ['acmeRenewDays'], apply: 'restart' },
    { key: 'ACME_DIR', group: GROUPS.tls, label: 'Certificate folder', help: "Where the Let's Encrypt account and certificate are kept.", type: 'text', default: './data/certs', props: ['acmeDir', 'smtpTlsKey', 'smtpTlsCert'], apply: 'restart' },

    // --- Relay ---
    { key: 'RELAY_HOST', group: GROUPS.relay, label: 'Relay server', help: 'Forward mail for the allowed recipients to this real mail server (empty = off). Needs the allowed recipients below.', type: 'text', default: '', props: ['relayHost'], apply: 'restart' },
    { key: 'RELAY_PORT', group: GROUPS.relay, label: 'Relay port', help: '', type: 'int', min: 1, max: 65535, default: '587', props: ['relayPort'], apply: 'restart' },
    { key: 'RELAY_SECURE', group: GROUPS.relay, label: 'Relay uses TLS from the start', help: 'Turn on for port 465. Off uses STARTTLS when the server offers it.', type: 'bool', default: 'false', props: ['relaySecure'], apply: 'restart' },
    { key: 'RELAY_FROM', group: GROUPS.relay, label: 'Relay sender address', help: 'Replaces the envelope sender of relayed mail (empty keeps the original).', type: 'text', default: '', props: ['relayFrom'], apply: 'restart' },
    { key: 'RELAY_ALLOW', group: GROUPS.relay, label: 'Relay only to', help: 'Comma separated addresses, domains or *.wildcards that may be forwarded. Required with a relay server, so this can never become an open relay.', type: 'list', default: '', props: ['relayAllow'], apply: 'restart' },

    // --- Webhook ---
    { key: 'WEBHOOK_URL', group: GROUPS.webhook, label: 'Webhook URL', help: 'Every received email and SMS is POSTed here. Its value is never written to the Activity page or the log, since it can carry a token. The signing secret stays in .env.', type: 'text', default: '', props: ['webhookUrl'], apply: 'restart', sensitive: true },

    // --- Data retention ---
    { key: 'RETENTION_DAYS', group: GROUPS.data, label: 'Delete emails and SMS after (days)', help: '0 keeps everything. Checked hourly.', type: 'int', min: 0, max: 36500, default: '0', props: ['retentionDays'], apply: 'live' },
    { key: 'ACTIVITY_RETENTION_DAYS', group: GROUPS.data, label: 'Keep Activity events (days)', help: '0 has no age limit.', type: 'int', min: 0, max: 36500, default: '30', props: ['activityRetentionDays'], apply: 'live' },
    { key: 'ACTIVITY_MAX_ROWS', group: GROUPS.data, label: 'Keep at most this many Activity events', help: '0 has no cap.', type: 'int', min: 0, max: 100000000, default: '20000', props: ['activityMaxRows'], apply: 'live' },
];

// Not editable here: secrets, and settings that decide who may sign in or how the server starts
const ENV_ONLY = [
    { names: 'ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_TOKEN, VIEWER_USERS, SESSION_SECRET, AUTH_DISABLED', why: 'who can sign in, and the key that protects sessions' },
    { names: 'SMTP_USERNAME, SMTP_PASSWORD, RELAY_USER, RELAY_PASSWORD, WEBHOOK_SECRET, CLOUDFLARE_API_TOKEN', why: 'passwords and tokens' },
    { names: 'DB_TYPE, SQLITE_PATH and the database connection settings', why: 'needed to open the database that holds these settings' },
    { names: 'TRUST_PROXY, LOG_DIR, LOG_TO_FILE', why: 'how the server is deployed' },
];

module.exports = { SETTINGS, ENV_ONLY, GROUPS };
