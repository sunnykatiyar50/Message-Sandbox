const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/views/formatters');

describe('detectFormat', () => {
    const cases = [
        ['{"otp":"123456","to":"+15551234567"}', 'json'],
        ['  [1, 2, {"a": null}]  ', 'json'],
        ['{not json}', 'text'],
        ['<html><body><p>Your code is <b>123456</b></p></body></html>', 'html'],
        ['<!DOCTYPE html><html></html>', 'html'],
        ['Hello <b>there</b>', 'html'],
        ['<img src=x onerror=alert(1)> OTP 4242', 'html'],
        ['<?xml version="1.0"?><sms><to>+1555</to></sms>', 'xml'],
        ['<34>Oct 11 22:14:15 mymachine su: \'su root\' failed for lonvick on /dev/pts/8', 'syslog'],
        ['<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut="3"] An application event', 'syslog'],
        ['Oct  6 12:00:01 web01 sshd[1234]: Accepted publickey for sunny', 'syslog'],
        ['2026-10-06T12:00:01+05:30 web01 nginx[88]: GET /health 200', 'syslog'],
        ['<#> 482913 is your Uber code. abcDEF12xyz', 'text'],
        ['Your OTP is 123456', 'text'],
        ['a < b and c > d', 'text'],
        ['', 'text'],
    ];
    for (const [input, expected] of cases) {
        test(`${JSON.stringify(input.slice(0, 50))} -> ${expected}`, () => assert.equal(F.detectFormat(input), expected));
    }
});

describe('JSON', () => {
    test('pretty-prints and classifies tokens', () => {
        const tokens = F.tokenizeJson('{"to":"+1555","n":3,"ok":true,"x":null}');
        assert.equal(tokens.map(t => t.text).join(''), JSON.stringify({ to: '+1555', n: 3, ok: true, x: null }, null, 2));
        const types = Object.fromEntries(tokens.filter(t => t.type !== 'punct').map(t => [t.text, t.type]));
        assert.equal(types['"to"'], 'key');
        assert.equal(types['"+1555"'], 'string');
        assert.equal(types['3'], 'number');
        assert.equal(types['true'], 'boolean');
        assert.equal(types['null'], 'null');
    });

    test('strings containing colons and quotes stay strings', () => {
        const tokens = F.tokenizeJson('{"msg":"a \\"quoted\\": value"}');
        assert.deepEqual(tokens.filter(t => t.type === 'string').map(t => t.text), ['"a \\"quoted\\": value"']);
    });
});

describe('prettyMarkup', () => {
    test('indents blocks and keeps text-only elements on one line', () => {
        const out = F.prettyMarkup('<html><body><div><p>Your code is <b>123456</b></p><p>Thanks</p></div></body></html>');
        assert.equal(out, [
            '<html>',
            '  <body>',
            '    <div>',
            '      <p>Your code is <b>123456</b></p>',
            '      <p>Thanks</p>',
            '    </div>',
            '  </body>',
            '</html>',
        ].join('\n'));
    });

    test('handles void tags, doctype and comments', () => {
        const out = F.prettyMarkup('<!DOCTYPE html><div><img src="a.png"><!-- note --><p>x</p></div>');
        assert.equal(out, ['<!DOCTYPE html>', '<div>', '  <img src="a.png">', '  <!-- note -->', '  <p>x</p>', '</div>'].join('\n'));
    });

    test('formats XML', () => {
        const out = F.prettyMarkup('<?xml version="1.0"?><sms><to>+1555</to><body>Code 1234</body></sms>', { xml: true });
        assert.equal(out, ['<?xml version="1.0"?>', '<sms>', '  <to>+1555</to>', '  <body>Code 1234</body>', '</sms>'].join('\n'));
    });
});

describe('syslog', () => {
    test('RFC 3164 with priority', () => {
        const [e] = F.parseSyslog('<34>Oct 11 22:14:15 mymachine su: \'su root\' failed for lonvick on /dev/pts/8');
        assert.equal(e.facility, 'auth');
        assert.equal(e.severity, 'crit');
        assert.equal(e.host, 'mymachine');
        assert.equal(e.app, 'su');
        assert.equal(e.message, "'su root' failed for lonvick on /dev/pts/8");
    });

    test('RFC 5424 with structured data', () => {
        const [e] = F.parseSyslog('<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut="3" eventSource="Application"] An application event');
        assert.equal(e.facility, 'local4');
        assert.equal(e.severity, 'notice');
        assert.equal(e.app, 'evntslog');
        assert.equal(e.pid, '');
        assert.equal(e.msgid, 'ID47');
        assert.equal(e.structured, '[exampleSDID@32473 iut="3" eventSource="Application"]');
        assert.equal(e.message, 'An application event');
    });

    test('several lines, with a continuation line', () => {
        const entries = F.parseSyslog([
            'Oct  6 12:00:01 web01 sshd[1234]: Accepted publickey for sunny',
            'Oct  6 12:00:02 web01 app[77]: Error: boom',
            '    at handler (app.js:10)',
        ].join('\n'));
        assert.equal(entries.length, 2);
        assert.equal(entries[0].pid, '1234');
        assert.equal(entries[1].message, 'Error: boom\n    at handler (app.js:10)');
    });

    test('not syslog', () => {
        assert.equal(F.parseSyslog('Your OTP is 123456'), null);
        assert.equal(F.parseSyslog('Meeting: Oct 6 at 10:00'), null);
    });
});

describe('previewText', () => {
    test('HTML becomes its text, with blocks separated and inline tags kept tight', () => {
        assert.equal(F.previewText('<h2>Verify</h2><p>Your code is <b>246810</b>.</p><p>Thanks</p>'), 'Verify Your code is 246810. Thanks');
    });

    test('XML elements are separated', () => {
        assert.equal(F.previewText('<?xml version="1.0"?><sms><to>+1555</to><from>MyApp</from></sms>'), '+1555 MyApp');
    });

    test('syslog shows app and message per line', () => {
        const text = 'Oct  6 12:00:01 web01 sshd[1234]: Accepted key\nOct  6 12:00:02 web01 cron: job done';
        assert.equal(F.previewText(text), 'sshd: Accepted key · cron: job done');
    });

    test('text and JSON are unchanged apart from whitespace', () => {
        assert.equal(F.previewText('Your  OTP\nis 1'), 'Your OTP is 1');
        assert.equal(F.previewText('{"a":1}'), '{"a":1}');
    });
});

describe('tokenizeText', () => {
    test('finds links and leaves everything else, including codes, as plain text', () => {
        const tokens = F.tokenizeText('Code 482913. Open https://example.com/verify?x=1.');
        assert.deepEqual(tokens.filter(t => t.type !== 'text'), [{ text: 'https://example.com/verify?x=1', type: 'link' }]);
        assert.equal(tokens.map(t => t.text).join(''), 'Code 482913. Open https://example.com/verify?x=1.');
    });

    test('ignores non-http schemes', () => {
        assert.equal(F.tokenizeText('javascript:alert(1)').every(t => t.type === 'text'), true);
    });
});
