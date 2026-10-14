// Prometheus metrics (text exposition format 0.0.4), kept in memory: counters since the process started, and
// gauges read when /metrics is scraped. Nothing here records addresses, subjects or message content.

const DEFINITIONS = {
    messaging_test_smtp_connections_total: 'SMTP connections accepted.',
    messaging_test_emails_received_total: 'Emails stored (over SMTP or from the dashboard).',
    messaging_test_sms_received_total: 'SMS messages stored (POST /api/sms).',
    messaging_test_received_bytes_total: 'Size in bytes of the stored emails.',
    messaging_test_recipients_rejected_total: 'Recipients refused at RCPT TO, by reason (allowed_domains, simulated).',
    messaging_test_messages_rejected_total: 'Messages refused after DATA, by reason (size, simulated, store_error).',
    messaging_test_webhook_deliveries_total: 'Webhook deliveries, by result (success, failure).',
    messaging_test_relay_total: 'Relayed emails, by result (sent, failed).',
};

const escapeLabel = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

class Metrics {
    constructor() {
        this.counters = new Map(Object.keys(DEFINITIONS).map(name => [name, new Map()]));
        this.gauges = [];
        this.startedAt = Date.now();
    }

    // labels: { reason: 'size' }; counters without labels are listed from the start (at 0)
    inc(name, labels = {}, by = 1) {
        const series = this.counters.get(name);
        if (!series) throw new Error(`Unknown metric ${name}`);
        const key = JSON.stringify(labels);
        const current = series.get(key) || { labels, value: 0 };
        current.value += by;
        series.set(key, current);
    }

    // read: () => number | Promise<number>, called on every scrape
    gauge(name, help, read) {
        this.gauges.push({ name, help, read });
    }

    async render() {
        const lines = [];
        for (const [name, series] of this.counters) {
            lines.push(`# HELP ${name} ${DEFINITIONS[name]}`, `# TYPE ${name} counter`);
            if (series.size === 0) lines.push(`${name} 0`);
            for (const { labels, value } of series.values()) {
                const text = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
                lines.push(`${name}${text ? `{${text}}` : ''} ${value}`);
            }
        }
        const gauges = [
            ...this.gauges,
            { name: 'messaging_test_uptime_seconds', help: 'Seconds since the service started.', read: () => Math.round((Date.now() - this.startedAt) / 1000) },
        ];
        for (const { name, help, read } of gauges) {
            let value;
            try {
                value = await read();
            } catch {
                continue; // a gauge that can't be read (database down) is left out of this scrape
            }
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
        }
        return `${lines.join('\n')}\n`;
    }
}

module.exports = { Metrics };
