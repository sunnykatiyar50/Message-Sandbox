// Checks that the links in an email resolve: a HEAD request per link (a GET when the server refuses HEAD),
// following redirects. Only the status is kept; response bodies are never read or returned.
//
// This makes the server request URLs taken from the email, so it only runs on an explicit request from an
// admin and can be turned off with LINK_CHECK=false.

const TIMEOUT_MS = 5000;
const MAX_LINKS = 25;
const CONCURRENCY = 5;

async function checkLink(url) {
    const started = Date.now();
    const attempt = async method => {
        const response = await fetch(url, {
            method,
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'User-Agent': 'messaging-test-service link check' },
        });
        response.body?.cancel().catch(() => {});
        return response;
    };

    try {
        let response = await attempt('HEAD');
        // Some servers don't implement HEAD, or answer it differently
        if ([403, 405, 501].includes(response.status)) response = await attempt('GET');
        return {
            url,
            ok: response.status < 400,
            status: response.status,
            finalUrl: response.url && response.url !== url ? response.url : null,
            ms: Date.now() - started,
        };
    } catch (error) {
        const reason = error.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : (error.cause && error.cause.code) || error.message;
        return { url, ok: false, status: null, finalUrl: null, error: String(reason), ms: Date.now() - started };
    }
}

// Results come back in the order of `urls`; anything beyond MAX_LINKS is left out (`skipped` says how many)
async function checkLinks(urls) {
    const wanted = urls.filter(url => /^https?:\/\//i.test(url)).slice(0, MAX_LINKS);
    const results = new Array(wanted.length);
    let next = 0;
    const worker = async () => {
        while (next < wanted.length) {
            const index = next;
            next += 1;
            results[index] = await checkLink(wanted[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
    return { results, skipped: Math.max(0, urls.length - wanted.length) };
}

module.exports = { checkLinks, MAX_LINKS };
