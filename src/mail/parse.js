const { simpleParser } = require('mailparser');
const { convert: htmlToText } = require('html-to-text');

const SNIPPET_LENGTH = 200;

// mailparser gives a single address object or an array of them (one per header); flatten to [{ name, address }]
function addressList(field) {
    if (!field) return [];
    return []
        .concat(field)
        .flatMap(entry => entry.value || [])
        .filter(entry => entry && entry.address)
        .map(entry => ({ name: entry.name || '', address: entry.address }));
}

// "Subject: a\r\n b" -> { key: 'Subject', value: 'a b' } (unfolds continuation lines)
function headerList(headerLines) {
    return (headerLines || []).map(({ key, line }) => ({
        key,
        value: line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim(),
    }));
}

function snippetOf(text) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

// Turns raw RFC 5322 bytes (plus the SMTP envelope) into the record stored by EmailModel.
// Parsing problems never lose the mail: the raw message is stored with a placeholder subject.
async function parseEmail(raw, { envelope = {}, smtpUser = null } = {}) {
    const envelopeFrom = (envelope.mailFrom && envelope.mailFrom.address) || '';
    const envelopeTo = (envelope.rcptTo || []).map(r => r.address).filter(Boolean);
    const base = { raw, size: raw.length, envelopeFrom, envelopeTo, smtpUser };

    let parsed;
    try {
        // keepCidLinks: leave cid: references in the HTML alone; the dashboard resolves them when previewing.
        // skipHtmlToText: `text` is then only ever a real text/plain part, which is how an HTML-only message
        // is told apart (the text shown for those is derived from the HTML below).
        parsed = await simpleParser(raw, { keepCidLinks: true, skipHtmlToText: true });
    } catch {
        return {
            ...base,
            messageId: null,
            from: { name: '', address: envelopeFrom },
            to: envelopeTo.map(address => ({ name: '', address })),
            cc: [],
            subject: '(could not parse message)',
            snippet: '',
            text: null,
            textPart: null,
            html: null,
            headers: [],
            attachments: [],
        };
    }

    const [from = { name: '', address: envelopeFrom }] = addressList(parsed.from);
    const html = typeof parsed.html === 'string' ? parsed.html : null;
    const textPart = typeof parsed.text === 'string' && parsed.text.trim() !== '';
    let text = textPart ? parsed.text : null;
    if (!textPart && html) {
        try {
            text = htmlToText(html);
        } catch {
            text = null; // unusable HTML: the HTML tab still shows what there is
        }
    }
    return {
        ...base,
        messageId: parsed.messageId || null,
        from,
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        subject: parsed.subject || '',
        snippet: snippetOf(text),
        text,
        textPart,
        html,
        headers: headerList(parsed.headerLines),
        attachments: (parsed.attachments || []).map((a, index) => ({
            filename: a.filename || `attachment-${index + 1}`,
            contentType: a.contentType || 'application/octet-stream',
            contentId: a.cid || null,
            size: a.size || (a.content ? a.content.length : 0),
            content: a.content,
        })),
    };
}

module.exports = { parseEmail, addressList };
