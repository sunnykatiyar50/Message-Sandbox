const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sslOptions } = require('../src/database/ssl');

test('no TLS when unset or disabled', () => {
    for (const value of [undefined, '', 'false', 'disable', 'OFF', '0']) {
        assert.equal(sslOptions(value), undefined, `value ${value}`);
    }
});

test('verified TLS for true / require', () => {
    for (const value of ['true', 'require', 'TRUE', 'verify-full']) {
        assert.deepEqual(sslOptions(value), { rejectUnauthorized: true }, `value ${value}`);
    }
});

test('unverified TLS for no-verify', () => {
    assert.deepEqual(sslOptions('no-verify'), { rejectUnauthorized: false });
});

test('loads a custom CA file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-test-')), 'ca.pem');
    fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    assert.match(sslOptions('true', file).ca, /BEGIN CERTIFICATE/);
});

test('rejects unknown values', () => {
    assert.throws(() => sslOptions('maybe'), /Invalid SSL setting/);
});
