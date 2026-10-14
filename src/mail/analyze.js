// Static checks on a stored email: the things that make real mail land in spam, render badly, or get clipped.
// Each finding is { level, code, message } with level 'warning' (likely to cause trouble) or 'info' (worth a
// look; may be intentional, e.g. a transactional email doesn't need an unsubscribe header).

const GMAIL_CLIP_BYTES = 102 * 1024;
const LOCAL_HOST = /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0|.*\.(local|localhost|test|internal)$)/i;

const header = (email, name) => {
    const found = (email.headers || []).find(h => h.key.toLowerCase() === name);
    return found ? found.value : null;
};

const hostOf = url => {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
};

const isLocal = url => LOCAL_HOST.test(hostOf(url));

function htmlChecks(html, findings) {
    const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);

    const noAlt = images.filter(tag => !/\balt\s*=/i.test(tag));
    if (noAlt.length) {
        findings.push({
            level: 'warning',
            code: 'img-no-alt',
            message: `${noAlt.length} image${noAlt.length === 1 ? '' : 's'} without alt text: nothing shows in its place when images are blocked`,
        });
    }

    const sources = images.map(tag => (/\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag) || [])[1]).filter(Boolean);
    const insecureImages = sources.filter(src => /^http:\/\//i.test(src) && !isLocal(src));
    if (insecureImages.length) {
        findings.push({
            level: 'warning',
            code: 'img-http',
            message: `${insecureImages.length} image${insecureImages.length === 1 ? ' loads' : 's load'} over http://, which mail clients block or flag`,
        });
    }

    // width="1" / height="0" etc. (not 10 or 100)
    const isOne = (tag, attribute) => new RegExp(String.raw`\b${attribute}\s*=\s*["']?[01](?:px)?["']?(?=[\s/>])`, 'i').test(tag);
    const pixels = images.filter(tag => isOne(tag, 'width') && isOne(tag, 'height'));
    if (pixels.length) {
        findings.push({ level: 'info', code: 'tracking-pixel', message: `${pixels.length} 1×1 image${pixels.length === 1 ? '' : 's'}: looks like a tracking pixel` });
    }

    if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) {
        findings.push({ level: 'info', code: 'no-viewport', message: 'No viewport meta tag, so phones may show the email zoomed out' });
    }

    const httpLinks = [...html.matchAll(/\bhref\s*=\s*["'](http:\/\/[^"']+)["']/gi)].map(m => m[1]).filter(url => !isLocal(url));
    if (httpLinks.length) {
        findings.push({ level: 'info', code: 'link-http', message: `${httpLinks.length} link${httpLinks.length === 1 ? ' uses' : 's use'} http:// instead of https://` });
    }
}

function analyzeEmail(email) {
    const findings = [];
    const add = (level, code, message) => findings.push({ level, code, message });
    const html = email.html || '';
    const text = (email.text || '').trim();

    if (!text && !html.trim()) add('warning', 'empty-body', 'The email has no body');

    // false = HTML only; null = stored before this was recorded, so unknown
    if (email.hasTextPart === false && html) {
        add('warning', 'no-text-part', 'HTML only: add a plain-text alternative (multipart/alternative); spam filters and text-only clients expect one');
    }

    if (!email.subject || !email.subject.trim()) {
        add('warning', 'no-subject', 'The subject is empty');
    } else {
        const letters = email.subject.replace(/[^A-Za-z]/g, '');
        if (letters.length >= 8 && letters === letters.toUpperCase()) add('warning', 'subject-caps', 'The subject is ALL CAPS, a common spam signal');
        if (/[!?]{2,}|!.*!.*!/.test(email.subject)) add('warning', 'subject-punctuation', 'The subject has repeated exclamation or question marks');
        if (email.subject.length > 78) add('info', 'subject-long', `The subject is ${email.subject.length} characters; many clients cut it off after about 60`);
    }

    if (!header(email, 'message-id')) add('warning', 'no-message-id', 'No Message-ID header; mail servers normally add one, and some filters penalize its absence');
    if (!header(email, 'date')) add('warning', 'no-date', 'No Date header');

    if (html) {
        htmlChecks(html, findings);
        const bytes = Buffer.byteLength(html);
        if (bytes > GMAIL_CLIP_BYTES) {
            add('warning', 'html-large', `The HTML is ${Math.round(bytes / 1024)} KB; Gmail clips messages over about 102 KB and hides the rest behind "View entire message"`);
        }
    }

    if (!header(email, 'list-unsubscribe')) {
        add('info', 'no-unsubscribe', 'No List-Unsubscribe header. Bulk or marketing mail should have one; transactional mail (receipts, password resets) does not need it');
    }

    const fromDomain = (email.from && email.from.address ? email.from.address.split('@')[1] : '') || '';
    const envelopeDomain = ((email.envelope && email.envelope.from) || '').split('@')[1] || '';
    if (fromDomain && envelopeDomain && fromDomain.toLowerCase() !== envelopeDomain.toLowerCase()) {
        add('info', 'sender-mismatch', `The envelope sender (${envelopeDomain}) differs from the From domain (${fromDomain}); this can fail SPF/DMARC alignment`);
    }

    return findings;
}

module.exports = { analyzeEmail };
