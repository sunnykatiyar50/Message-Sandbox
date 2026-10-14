// Finds the http(s) links in an email: href attributes in the HTML part first, then bare URLs in the text.
// Handy for tests that need the "verify your email" or "reset your password" link.

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/;

const decodeEntities = value =>
    value
        .replace(/&amp;/gi, '&')
        .replace(/&#38;/g, '&')
        .replace(/&#x26;/gi, '&')
        .replace(/&quot;/gi, '"');

function extractLinks(text, html) {
    const seen = new Set();
    const links = [];
    const add = candidate => {
        const url = candidate.trim().replace(TRAILING_PUNCTUATION, '');
        if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
        seen.add(url);
        links.push(url);
    };

    if (html) {
        for (const match of html.matchAll(HREF_RE)) add(decodeEntities(match[1] ?? match[2] ?? ''));
    }
    if (text) {
        for (const match of text.matchAll(URL_RE)) add(match[0]);
    }
    return links;
}

module.exports = { extractLinks };
