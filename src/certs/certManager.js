// Keeps the SMTP TLS certificate current: issues it when missing, renews it before it expires, and tells
// the caller when the files on disk changed so the running SMTP servers can reload them.

const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const { issueCertificate } = require('./acme');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
// Let's Encrypt limits failed validations (5 per hour per hostname), so a crash loop must not retry at once
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;

// { serial, expires, names, staging } for a PEM file, or null when it is missing or unreadable
function readCertInfo(file) {
    try {
        const cert = new X509Certificate(fs.readFileSync(file));
        const names = (cert.subjectAltName || '').split(',').map(s => s.trim()).filter(s => s.startsWith('DNS:')).map(s => s.slice(4).toLowerCase());
        // Let's Encrypt staging intermediates are named "(STAGING) ...", so the issuer tells which server issued it
        return { serial: cert.serialNumber, expires: new Date(cert.validTo), names, staging: /\(STAGING\)/i.test(cert.issuer || '') };
    } catch {
        return null;
    }
}

function renewalReason(info, domains, renewDays, now = Date.now(), staging = false) {
    if (!info) return 'no certificate yet';
    if (info.staging !== staging) return staging ? 'it was issued by the production server and ACME_STAGING is now on' : 'it was issued by the staging server and ACME_STAGING is now off';
    if (domains.some(domain => !info.names.includes(domain))) return 'the domain list changed';
    if (info.expires.getTime() - now < renewDays * DAY_MS) return `it expires ${info.expires.toISOString().slice(0, 10)}`;
    return null;
}

function writeAtomic(file, content, mode) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, content, { mode });
    fs.renameSync(temp, file);
}

function createCertManager(config, { issue = issueCertificate, log = () => {} } = {}) {
    const keyFile = config.smtpTlsKey;
    const certFile = config.smtpTlsCert;
    const failureFile = path.join(config.acmeDir, 'last-failure');
    let loadedSerial = null;

    function recentFailure(now) {
        try {
            const age = now - fs.statSync(failureFile).mtimeMs;
            return age < RETRY_AFTER_FAILURE_MS ? { minutes: Math.ceil((RETRY_AFTER_FAILURE_MS - age) / 60000), message: fs.readFileSync(failureFile, 'utf8') } : null;
        } catch {
            return null;
        }
    }

    // Issues or renews when due (or when forced). Throws if that is needed and fails.
    async function ensure({ force = false, now = Date.now() } = {}) {
        const info = readCertInfo(certFile);
        const reason = force ? 'forced' : renewalReason(info, config.acmeDomains, config.acmeRenewDays, now, config.acmeStaging);
        if (!reason) return { renewed: false, info };

        const failure = !force && recentFailure(now);
        if (failure) throw new Error(`The last certificate attempt failed (${failure.message}); not retrying for ${failure.minutes} more minute(s)`);

        log(`Requesting a certificate for ${config.acmeDomains.join(', ')} (${reason})${config.acmeStaging ? ' from the Let\'s Encrypt staging server' : ''}`);
        fs.mkdirSync(config.acmeDir, { recursive: true });
        try {
            const { key, cert } = await issue({
                domains: config.acmeDomains,
                email: config.acmeEmail,
                dir: config.acmeDir,
                staging: config.acmeStaging,
                cloudflareToken: config.cloudflareToken,
                log,
            });
            writeAtomic(keyFile, key, 0o600);
            writeAtomic(certFile, cert, 0o644);
            fs.rmSync(failureFile, { force: true });
        } catch (error) {
            fs.mkdirSync(config.acmeDir, { recursive: true });
            fs.writeFileSync(failureFile, error.message);
            throw new Error(`Certificate request failed: ${error.message}`);
        }
        const issued = readCertInfo(certFile);
        log(`Certificate issued, valid until ${issued.expires.toISOString().slice(0, 10)}`);
        return { renewed: true, info: issued };
    }

    // Call once the certificate is in use, so later changes can be detected
    function markLoaded() {
        const info = readCertInfo(certFile);
        loadedSerial = info && info.serial;
    }

    // Checks (and renews if due), then calls onChange when the certificate on disk differs from the one in use.
    // That also covers a renewal done by `node src/certs/cli.js renew` in another process.
    async function check(onChange) {
        await ensure();
        const info = readCertInfo(certFile);
        if (info && info.serial !== loadedSerial) {
            loadedSerial = info.serial;
            onChange();
            log(`Reloaded the SMTP certificate (valid until ${info.expires.toISOString().slice(0, 10)})`);
        }
    }

    function schedule(onChange) {
        const run = () => check(onChange).catch(error => log(`Certificate check failed: ${error.message}`));
        setInterval(run, CHECK_INTERVAL_MS).unref();
    }

    return { ensure, markLoaded, check, schedule, status: () => readCertInfo(certFile) };
}

module.exports = { createCertManager, readCertInfo, renewalReason };
