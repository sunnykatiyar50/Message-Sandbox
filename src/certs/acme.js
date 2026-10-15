// Gets a certificate from Let's Encrypt, proving domain ownership with a DNS TXT record in Cloudflare.
// Returns { key, cert } as PEM strings; storing them is certManager's job.

const fs = require('fs');
const path = require('path');
const acme = require('acme-client');
const { createCloudflare } = require('./cloudflare');
const { waitForTxt } = require('./dnsWait');

// Fallback pause when the record can't be checked on the authoritative servers
const PROPAGATION_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadAccountKey(dir) {
    const file = path.join(dir, 'account.key');
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const key = await acme.crypto.createPrivateKey();
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
}

async function issueCertificate({ domains, email, dir, staging, cloudflareToken, log = () => {} }) {
    fs.mkdirSync(dir, { recursive: true });
    const client = new acme.Client({
        directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
        accountKey: await loadAccountKey(dir),
    });
    const [key, csr] = await acme.crypto.createCsr({ commonName: domains[0], altNames: domains });
    const cloudflare = createCloudflare(cloudflareToken);
    const records = new Map();

    const cert = await client.auto({
        csr,
        email,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        // Let's Encrypt queries Cloudflare's authoritative servers itself; a local lookup would only add cache misses
        skipChallengeVerification: true,
        async challengeCreateFn(authz, challenge, keyAuthorization) {
            const name = `_acme-challenge.${authz.identifier.value}`;
            log(`Adding DNS challenge record ${name}`);
            records.set(`${name}:${keyAuthorization}`, await cloudflare.addTxt(name, keyAuthorization));
            if (!(await waitForTxt(name, keyAuthorization))) {
                log(`Could not confirm ${name} on the authoritative name servers; waiting ${PROPAGATION_MS / 1000}s before validating`);
                await sleep(PROPAGATION_MS);
            }
        },
        async challengeRemoveFn(authz, challenge, keyAuthorization) {
            const name = `_acme-challenge.${authz.identifier.value}`;
            const record = records.get(`${name}:${keyAuthorization}`);
            if (!record) return;
            try {
                await cloudflare.removeRecord(record);
            } catch (error) {
                log(`Could not remove DNS challenge record ${name}: ${error.message}`);
            }
        },
    });
    return { key: key.toString(), cert };
}

module.exports = { issueCertificate };
