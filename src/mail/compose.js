const crypto = require('crypto');

const base64Lines = value => (Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).toString('base64').replace(/(.{76})/g, '$1\r\n');

// RFC 2047 encoded-word for headers that contain non-ASCII text
const encodeHeader = value => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);

// filename="ascii-fallback"; filename*=UTF-8''percent-encoded (RFC 2231), safe for any name the validation allows
function fileNameParams(name) {
    const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// The message body: text, HTML, or both as multipart/alternative. Returns { headers, body }.
function bodyEntity({ text, html }) {
    if (text.trim() && html.trim()) {
        const boundary = `=_${crypto.randomBytes(12).toString('hex')}`;
        const part = (type, content) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(content)}`;
        return {
            headers: [`Content-Type: multipart/alternative; boundary="${boundary}"`],
            body: [`--${boundary}`, part('text/plain', text), `--${boundary}`, part('text/html', html), `--${boundary}--`, ''].join('\r\n'),
        };
    }
    const isHtml = !text.trim();
    return {
        headers: [`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`, 'Content-Transfer-Encoding: base64'],
        body: base64Lines(isHtml ? html : text),
    };
}

// Builds a small RFC 5322 message for the dashboard's "Send test" form: text, HTML, or both (multipart/alternative),
// with optional Cc and attachments (multipart/mixed). Bcc recipients are not in the message at all; they only
// go in the SMTP envelope, as with real mail. Body parts are base64 so any text survives the round trip.
// attachments: [{ filename, contentType, content: Buffer }]
function buildRawMessage({ from, fromName, to, cc = [], subject, text, html, attachments = [] }) {
    const headers = [
        `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
        `To: ${to.join(', ')}`,
        ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
        `Subject: ${encodeHeader(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@message-sandbox.local>`,
        'MIME-Version: 1.0',
    ];

    const entity = bodyEntity({ text, html });
    let body;
    if (attachments.length === 0) {
        headers.push(...entity.headers);
        body = entity.body;
    } else {
        const boundary = `=_${crypto.randomBytes(12).toString('hex')}`;
        headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
        const parts = [`--${boundary}\r\n${entity.headers.join('\r\n')}\r\n\r\n${entity.body}`];
        for (const attachment of attachments) {
            parts.push(
                `--${boundary}\r\n` +
                `Content-Type: ${attachment.contentType}; name="${attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"\r\n` +
                `Content-Disposition: attachment; ${fileNameParams(attachment.filename)}\r\n` +
                `Content-Transfer-Encoding: base64\r\n\r\n${base64Lines(attachment.content)}`
            );
        }
        body = `${parts.join('\r\n')}\r\n--${boundary}--`;
    }
    return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');
}

module.exports = { buildRawMessage };
