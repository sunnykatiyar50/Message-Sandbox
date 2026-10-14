// Decides at startup whether TLS can be offered. Anything wrong (bad settings, missing or unreadable files,
// a failed Let's Encrypt request with no usable certificate) switches TLS off, logs why, and lets the server
// start with plain SMTP instead of failing and being restarted in a loop.

const fs = require('fs');
const tls = require('tls');

function disable(config) {
    config.smtpTlsKey = '';
    config.smtpTlsCert = '';
    config.smtpTlsPort = 0;
}

// Returns true when TLS is ready. `certManager` is null unless ACME_DOMAINS is set.
async function setupTls(config, { certManager = null, log = () => {} } = {}) {
    const problems = [...(config.tlsErrors || [])];

    if (!problems.length && certManager) {
        try {
            await certManager.ensure();
        } catch (error) {
            const current = certManager.status();
            if (current && current.expires > new Date()) {
                log(`WARNING: ${error.message}. Using the existing certificate (valid until ${current.expires.toISOString().slice(0, 10)}).`);
            } else {
                problems.push(error.message);
            }
        }
    }

    if (!problems.length && config.smtpTlsKey) {
        try {
            tls.createSecureContext({ key: fs.readFileSync(config.smtpTlsKey), cert: fs.readFileSync(config.smtpTlsCert) });
        } catch (error) {
            problems.push(`the certificate or key could not be loaded: ${error.message}`);
        }
    }

    if (problems.length) {
        log(`ERROR: TLS is disabled, so the server is starting with plain SMTP only (no STARTTLS, no TLS port). ${problems.join('; ')}. Fix this and restart to enable TLS.`);
        disable(config);
        return false;
    }
    return Boolean(config.smtpTlsKey);
}

module.exports = { setupTls };
