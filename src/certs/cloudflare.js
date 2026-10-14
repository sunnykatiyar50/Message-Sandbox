// Minimal Cloudflare DNS client: adds and removes the TXT records Let's Encrypt checks (DNS-01 challenge).
// The API token needs Zone:Read and DNS:Edit for the zone.

const API = 'https://api.cloudflare.com/client/v4';

function createCloudflare(token, fetchImpl = fetch) {
    async function call(method, resource, body) {
        const response = await fetchImpl(`${API}${resource}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.success === false) {
            const detail = (json.errors || []).map(e => e.message).join('; ') || `HTTP ${response.status}`;
            throw new Error(`Cloudflare ${method} ${resource} failed: ${detail}`);
        }
        return json.result;
    }

    // sub.example.com -> tries sub.example.com, then example.com
    async function findZoneId(hostname) {
        const labels = hostname.split('.');
        for (let i = 0; i < labels.length - 1; i++) {
            const zones = await call('GET', `/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}`);
            if (zones.length) return zones[0].id;
        }
        throw new Error(`No Cloudflare zone found for ${hostname} (check the domain and that the API token can read the zone)`);
    }

    async function addTxt(name, content) {
        const zoneId = await findZoneId(name);
        const record = await call('POST', `/zones/${zoneId}/dns_records`, { type: 'TXT', name, content, ttl: 60 });
        return { zoneId, id: record.id };
    }

    async function removeRecord({ zoneId, id }) {
        await call('DELETE', `/zones/${zoneId}/dns_records/${id}`);
    }

    return { addTxt, removeRecord };
}

module.exports = { createCloudflare };
