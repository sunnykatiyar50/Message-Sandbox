const fs = require('fs');

// TLS settings for the PostgreSQL and MySQL connections, from PG_SSL / MYSQL_SSL:
//   unset, false, disable  -> no TLS (local or Docker-network databases)
//   true, require          -> TLS, server certificate verified against the system CAs
//   no-verify              -> TLS without verifying the certificate (self-signed servers)
// With PG_SSL_CA / MYSQL_SSL_CA set to a PEM file path, that CA is trusted as well
// (e.g. the AWS RDS certificate bundle).
function sslOptions(mode, caPath) {
    const value = (mode || '').trim().toLowerCase();
    if (!value || ['false', 'disable', 'off', '0'].includes(value)) return undefined;
    if (value === 'no-verify') return { rejectUnauthorized: false };
    if (!['true', 'require', 'on', '1', 'verify-full'].includes(value)) {
        throw new Error(`Invalid SSL setting "${mode}": use true, false, or no-verify`);
    }
    const options = { rejectUnauthorized: true };
    if (caPath) options.ca = fs.readFileSync(caPath, 'utf8');
    return options;
}

module.exports = { sslOptions };
