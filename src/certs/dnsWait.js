// Waits until a DNS challenge record is visible on the zone's authoritative name servers, so Let's Encrypt
// doesn't validate before it exists (a failed lookup can also be cached, which makes a quick retry fail too).
// Asking the authoritative servers directly avoids stale answers from a local resolver.

const dns = require('dns').promises;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// IP addresses of the name servers for the closest enclosing zone: sub.example.com -> example.com's servers
async function authoritativeServers(name) {
    const labels = name.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
        try {
            const hosts = await dns.resolveNs(labels.slice(i).join('.'));
            const ips = (await Promise.all(hosts.map(host => dns.resolve4(host).catch(() => [])))).flat();
            if (ips.length) return ips;
        } catch {
            // not a zone apex: try the parent
        }
    }
    return [];
}

async function lookupTxt(name, server) {
    const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers([server]);
    try {
        return (await resolver.resolveTxt(name)).map(parts => parts.join(''));
    } catch {
        return [];
    }
}

// True once every authoritative server returns `value` for the TXT record `name`; false if that never
// happens in time (or the servers can't be found), in which case the caller falls back to a fixed wait.
async function waitForTxt(name, value, { timeoutMs = 90000, intervalMs = 3000, getServers = authoritativeServers, lookup = lookupTxt } = {}) {
    const servers = await getServers(name);
    if (!servers.length) return false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = await Promise.all(servers.map(async server => (await lookup(name, server)).includes(value)));
        if (found.every(Boolean)) return true;
        if (Date.now() + intervalMs > deadline) return false;
        await sleep(intervalMs);
    }
}

module.exports = { waitForTxt };
