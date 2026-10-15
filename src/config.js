// Reads and validates configuration from environment variables.
// Throws on invalid auth configuration so the server never starts unprotected by accident.

const fs = require('fs');
const path = require('path');
const { parseRules } = require('./utils/recipients');

// VIEWER_USERS=alice:password1,bob:password2 -> [{ username, password }]
// (passwords can contain ':' but not ',')
function parseUsers(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const sep = entry.indexOf(':');
            return sep === -1
                ? { username: entry, password: '' }
                : { username: entry.slice(0, sep).trim(), password: entry.slice(sep + 1) };
        });
}

// A comma separated list of recipient rules (see utils/recipients.js); problems are added to `problems`
function ruleList(name, value, problems) {
    try {
        return parseRules(value);
    } catch (error) {
        problems.push(`${name}: ${error.message}`);
        return [];
    }
}

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Everything wrong with the TLS settings; derives the key/cert paths when ACME_DOMAINS manages them
function tlsProblems(config) {
    const problems = [];
    const managedCert = config.acmeDomains.length > 0;
    if (managedCert) {
        if (config.smtpTlsKey || config.smtpTlsCert) problems.push('ACME_DOMAINS manages the certificate itself: remove SMTP_TLS_KEY and SMTP_TLS_CERT');
        for (const domain of config.acmeDomains) {
            if (!DOMAIN_RE.test(domain)) problems.push(`ACME_DOMAINS: "${domain}" is not a valid domain`);
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.acmeEmail)) problems.push("ACME_DOMAINS needs ACME_EMAIL (Let's Encrypt sends expiry notices there)");
        if (!config.cloudflareToken) problems.push('ACME_DOMAINS needs CLOUDFLARE_API_TOKEN (Zone:Read and DNS:Edit)');
        config.smtpTlsKey = path.join(config.acmeDir, 'key.pem');
        config.smtpTlsCert = path.join(config.acmeDir, 'cert.pem');
    }
    if (Boolean(config.smtpTlsKey) !== Boolean(config.smtpTlsCert)) problems.push('SMTP_TLS_KEY and SMTP_TLS_CERT must be set together');
    for (const [name, file] of [['SMTP_TLS_KEY', config.smtpTlsKey], ['SMTP_TLS_CERT', config.smtpTlsCert]]) {
        if (!managedCert && file && !fs.existsSync(file)) problems.push(`${name}: the file "${file}" does not exist`);
    }
    if (config.smtpTlsPort && !config.smtpTlsKey) problems.push('SMTP_TLS_PORT needs SMTP_TLS_KEY and SMTP_TLS_CERT');
    if (config.smtpTlsPort && config.smtpTlsPort === config.smtpPort) problems.push('SMTP_TLS_PORT must differ from SMTP_PORT');
    return problems;
}

function loadConfig(env = process.env) {
    const config = {
        port: toInt(env.PORT, 30005),
        authDisabled: env.AUTH_DISABLED === 'true',
        // The SMTP server your apps send mail to. With SMTP_USERNAME/SMTP_PASSWORD set, clients must
        // authenticate; without them any (or no) credentials are accepted.
        smtpPort: toInt(env.SMTP_PORT, 1025),
        smtpHost: env.SMTP_HOST || '0.0.0.0',
        smtpUsername: env.SMTP_USERNAME || '',
        smtpPassword: env.SMTP_PASSWORD || '',
        maxEmailBytes: toInt(env.MAX_EMAIL_SIZE_MB, 10) * 1024 * 1024,
        // Failures on purpose for special recipients (reject@, tempfail@, full@, slow@, datafail@)
        smtpSimulate: env.SMTP_SIMULATE !== 'false',
        // Logs each SMTP connection and its TLS details (never message content), to debug clients that can't connect
        smtpDebug: env.SMTP_DEBUG === 'true',
        smtpAllowedDomains: [], // filled in below
        // STARTTLS on SMTP_PORT, and optionally a second listener that is TLS from the first byte
        smtpTlsKey: (env.SMTP_TLS_KEY || '').trim(),
        smtpTlsCert: (env.SMTP_TLS_CERT || '').trim(),
        smtpTlsPort: toInt(env.SMTP_TLS_PORT, 0),
        // Let's Encrypt certificate for the SMTP TLS listeners, requested and renewed automatically (see certs/)
        acmeDomains: [...new Set((env.ACME_DOMAINS || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean))],
        acmeEmail: (env.ACME_EMAIL || '').trim(),
        cloudflareToken: (env.CLOUDFLARE_API_TOKEN || '').trim(),
        acmeDir: env.ACME_DIR || './data/certs',
        acmeStaging: env.ACME_STAGING === 'true',
        acmeRenewDays: toInt(env.ACME_RENEW_DAYS, 30) || 30,
        // Optional relay of mail for allowlisted recipients to a real mail server (see mail/relay.js)
        relayHost: (env.RELAY_HOST || '').trim(),
        relayPort: toInt(env.RELAY_PORT, 587),
        relaySecure: env.RELAY_SECURE === 'true',
        relayUser: env.RELAY_USER || '',
        relayPassword: env.RELAY_PASSWORD || '',
        relayFrom: (env.RELAY_FROM || '').trim(),
        relayAllow: [], // filled in below
        // GET /metrics (Prometheus)
        metricsEnabled: env.METRICS !== 'false',
        // Lets an admin check an email's links from the dashboard (the server then requests those URLs)
        linkCheck: env.LINK_CHECK !== 'false',
        // POSTed to for every stored email (see src/mail/webhook.js); signed when a secret is set
        webhookUrl: (env.WEBHOOK_URL || '').trim(),
        webhookSecret: env.WEBHOOK_SECRET || '',
        adminToken: env.ADMIN_TOKEN || '',
        adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
        adminPassword: env.ADMIN_PASSWORD || '',
        // Read-only dashboard accounts: can view messages, can't send, delete or manage API keys
        viewerUsers: parseUsers(env.VIEWER_USERS),
        sessionSecret: env.SESSION_SECRET || '',
        sessionTtlHours: toInt(env.SESSION_TTL_HOURS, 12),
        trustProxy: env.TRUST_PROXY || '',
        apiRateLimit: toInt(env.API_RATE_LIMIT, 120),
        smsRateLimit: toInt(env.SMS_RATE_LIMIT, 120),
        retentionDays: toInt(env.RETENTION_DAYS, 0),
    };

    if (config.webhookUrl && !/^https?:\/\/[^\s/]+/i.test(config.webhookUrl)) {
        throw new Error('WEBHOOK_URL must be an http:// or https:// URL');
    }

    const setup = [];
    config.smtpAllowedDomains = ruleList('SMTP_ALLOWED_DOMAINS', env.SMTP_ALLOWED_DOMAINS, setup);
    config.relayAllow = ruleList('RELAY_ALLOW', env.RELAY_ALLOW, setup);
    // TLS problems never stop the server: TLS is switched off and the reasons are logged at startup (see
    // certs/tlsSetup.js), so a missing certificate can't leave the container in a restart loop.
    config.tlsErrors = tlsProblems(config);
    if (config.tlsErrors.length) {
        config.smtpTlsKey = '';
        config.smtpTlsCert = '';
        config.smtpTlsPort = 0;
        config.acmeDomains = [];
    }
    if (config.relayHost && config.relayAllow.length === 0) {
        setup.push('RELAY_HOST needs RELAY_ALLOW: the recipients (addresses or domains) that may be forwarded to a real mail server');
    }
    if (Boolean(config.relayUser) !== Boolean(config.relayPassword)) setup.push('RELAY_USER and RELAY_PASSWORD must be set together');
    if (setup.length) throw new Error(`Invalid configuration: ${setup.join('; ')}.`);

    if (!config.authDisabled) {
        const problems = [];
        if (!config.adminPassword) problems.push('ADMIN_PASSWORD is not set');
        if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
        if (config.adminToken && config.adminToken.length < 16) problems.push('ADMIN_TOKEN must be at least 16 characters');
        if (Boolean(config.smtpUsername) !== Boolean(config.smtpPassword)) {
            problems.push('SMTP_USERNAME and SMTP_PASSWORD must be set together');
        }
        const seen = new Set([config.adminUsername.toLowerCase()]);
        for (const { username, password } of config.viewerUsers) {
            if (!USERNAME_RE.test(username)) {
                problems.push(`VIEWER_USERS: "${username}" is not a valid username (letters, digits, . _ @ -)`);
            } else if (seen.has(username.toLowerCase())) {
                problems.push(`VIEWER_USERS: "${username}" is used twice, or is the admin username`);
            }
            seen.add(username.toLowerCase());
            if (password.length < 8) problems.push(`VIEWER_USERS: the password for "${username}" must be at least 8 characters`);
        }
        const secrets = [config.adminPassword, config.sessionSecret, config.adminToken,
            config.smtpPassword, ...config.viewerUsers.map(u => u.password)];
        if (secrets.some(s => s.startsWith('change-me'))) problems.push('replace the change-me placeholder values from sample.env');
        if (problems.length) {
            throw new Error(
                `Invalid auth configuration: ${problems.join('; ')}. ` +
                'Set these in .env (see sample.env), or set AUTH_DISABLED=true for local development only.'
            );
        }
    }

    return config;
}

module.exports = { loadConfig, parseUsers };
