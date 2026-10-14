// node src/certs/cli.js status | renew [--force]
// In Docker: docker compose exec message-sandbox node src/certs/cli.js status

require('dotenv').config();
const { loadConfig } = require('../config');
const { createCertManager, renewalReason } = require('./certManager');

async function main() {
    const [command, flag] = process.argv.slice(2);
    if (!['status', 'renew'].includes(command)) {
        console.error('Usage: node src/certs/cli.js status | renew [--force]');
        process.exit(1);
    }
    const config = loadConfig();
    if (!config.acmeDomains.length) {
        console.error('ACME_DOMAINS is not set, so there is no managed certificate.');
        process.exit(1);
    }
    const manager = createCertManager(config, { log: message => console.log(message) });

    if (command === 'status') {
        const info = manager.status();
        if (!info) return console.log(`No certificate in ${config.acmeDir} yet.`);
        const days = Math.floor((info.expires - Date.now()) / 86400000);
        const due = renewalReason(info, config.acmeDomains, config.acmeRenewDays);
        console.log(`Domains:  ${info.names.join(', ')}`);
        console.log(`Expires:  ${info.expires.toISOString().slice(0, 10)} (${days} day(s) left)`);
        console.log(due ? `Renewal:  due now (${due})` : `Renewal:  not due until ${config.acmeRenewDays} day(s) before expiry`);
        return;
    }

    const { renewed } = await manager.ensure({ force: flag === '--force' });
    console.log(renewed ? 'Done. A running server picks up the new certificate within 12 hours or on restart.' : 'The certificate is still valid; use --force to renew anyway.');
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
