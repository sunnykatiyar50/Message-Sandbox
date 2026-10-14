// Detects the format of a message (JSON, HTML, XML, syslog or plain text) and renders it readably.
//
// Safety: message content is only ever inserted with textContent / text nodes. The HTML preview
// goes into an iframe sandboxed without scripts, which also inherits this page's CSP, so nothing
// in a message can run code or load external resources.
//
// The parsing helpers are plain functions so they can be unit tested in Node (see test/formatters.test.js);
// the render* functions need a browser DOM.
(function (root) {
    'use strict';

    // ---------- Detection ----------

    const HTML_TAG = /<(html|head|body|div|span|p|br|hr|table|thead|tbody|tr|td|th|a|b|i|u|strong|em|small|ul|ol|li|h[1-6]|img|pre|code|blockquote|section|article|header|footer|style|font|center)\b[^>]*>/i;

    function detectFormat(text) {
        const t = (text || '').trim();
        if (!t) return 'text';
        if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) {
            try {
                JSON.parse(t);
                return 'json';
            } catch {
                // not JSON after all
            }
        }
        if (parseSyslog(t)) return 'syslog';
        if (/^<\?xml\b/i.test(t)) return 'xml';
        if (/^<!doctype html/i.test(t) || HTML_TAG.test(t)) return 'html';
        return 'text';
    }

    // ---------- JSON ----------

    // Pretty-prints JSON and splits it into tokens: key, string, number, boolean, null, punct
    function tokenizeJson(text) {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        const tokens = [];
        const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
        let last = 0;
        let m;
        while ((m = re.exec(pretty))) {
            if (m.index > last) tokens.push({ text: pretty.slice(last, m.index), type: 'punct' });
            if (m[1]) {
                tokens.push({ text: m[1], type: m[2] ? 'key' : 'string' });
                if (m[2]) tokens.push({ text: m[2], type: 'punct' });
            } else if (m[3]) tokens.push({ text: m[3], type: 'boolean' });
            else if (m[4]) tokens.push({ text: m[4], type: 'null' });
            else tokens.push({ text: m[5], type: 'number' });
            last = re.lastIndex;
        }
        if (last < pretty.length) tokens.push({ text: pretty.slice(last), type: 'punct' });
        return tokens;
    }

    // ---------- HTML / XML source ----------

    const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
    const INLINE_TAGS = new Set(['a', 'b', 'i', 'u', 'em', 'strong', 'small', 'span', 'code', 'font', 'sup', 'sub', 'br']);

    // Re-indents markup. Block elements go on their own lines; an element holding only text and
    // inline tags stays on one line (<p>Hello <b>you</b></p>); inline tags never break a line.
    function prettyMarkup(text, { xml = false } = {}) {
        const parts = text.replace(/>\s+</g, '><').trim().split(/(<[^>]+>)/).filter(p => p.trim() !== '');
        const lines = [];
        let depth = 0;
        let current = '';
        let pendingOpen = false; // current line starts with an open tag whose children are still inline
        const flush = () => {
            if (current.trim()) lines.push('  '.repeat(Math.max(depth, 0)) + current.trim());
            current = '';
        };
        // The open tag on the current line turns out to have block children: indent them
        const openPending = () => {
            if (!pendingOpen) return;
            flush();
            depth += 1;
            pendingOpen = false;
        };

        for (const part of parts) {
            const tag = part.match(/^<\s*(\/)?\s*([a-zA-Z][\w:.-]*)[^>]*?(\/)?\s*>$/);
            if (!tag) {
                if (part.startsWith('<!') || part.startsWith('<?')) {
                    // Comment, doctype or <?xml ?>: a line of its own
                    openPending();
                    flush();
                    current = part;
                    flush();
                } else {
                    current += part; // text
                }
                continue;
            }
            const name = tag[2].toLowerCase();
            const closing = Boolean(tag[1]);
            const selfClosing = Boolean(tag[3]) || (!xml && VOID_TAGS.has(name));

            if (!xml && INLINE_TAGS.has(name)) {
                current += part;
            } else if (closing) {
                if (pendingOpen) {
                    current += part; // <p>text</p> on one line
                    pendingOpen = false;
                    flush();
                } else {
                    flush();
                    depth -= 1;
                    current = part;
                    flush();
                }
            } else {
                openPending();
                flush();
                current = part;
                if (selfClosing) flush();
                else pendingOpen = true;
            }
        }
        if (pendingOpen) pendingOpen = false;
        flush();
        return lines.join('\n');
    }

    // Splits markup into tag and text tokens for highlighting
    function tokenizeMarkup(text) {
        return text.split(/(<[^>]+>)/).filter(Boolean).map(part => ({ text: part, type: part.startsWith('<') ? 'tag' : 'text' }));
    }

    // ---------- Syslog ----------

    const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
    const FACILITIES = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp',
        'ntp', 'security', 'console', 'solaris-cron', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];

    const PRI = '(?:<(\\d{1,3})>)?';
    const BSD_TIME = '([A-Z][a-z]{2} [ \\d]\\d \\d{2}:\\d{2}:\\d{2})';
    const ISO_TIME = '(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)';
    const TAG = '([^\\s:\\[]+)(?:\\[(\\d+)\\])?:\\s?(.*)';
    const RFC5424 = new RegExp('^<(\\d{1,3})>1 (\\S+) (\\S+) (\\S+) (\\S+) (\\S+) (-|(?:\\[(?:[^\\]\\\\]|\\\\.)*\\])+)(?: (.*))?$');
    const RFC3164 = new RegExp(`^${PRI}${BSD_TIME} (\\S+) ${TAG}$`);
    const ISO_LINE = new RegExp(`^${PRI}${ISO_TIME} (\\S+) ${TAG}$`);

    function decodePri(pri) {
        if (pri === undefined || pri === null || pri === '') return {};
        const n = Number(pri);
        if (!Number.isInteger(n) || n > 191) return {};
        return { facility: FACILITIES[n >> 3] || String(n >> 3), severity: SEVERITIES[n & 7] };
    }

    const nil = value => (value === '-' ? '' : value);

    function parseSyslogLine(line) {
        let m = line.match(RFC5424);
        if (m) {
            return { ...decodePri(m[1]), timestamp: nil(m[2]), host: nil(m[3]), app: nil(m[4]), pid: nil(m[5]),
                msgid: nil(m[6]), structured: nil(m[7]), message: (m[8] || '').replace(/^\uFEFF/, '') };
        }
        m = line.match(RFC3164) || line.match(ISO_LINE);
        if (m) return { ...decodePri(m[1]), timestamp: m[2], host: m[3], app: m[4], pid: m[5] || '', message: m[6] };
        return null;
    }

    // Returns a list of entries if the text is syslog (the first line must be a syslog line;
    // following lines that aren't are treated as continuations, e.g. stack traces), else null
    function parseSyslog(text) {
        const lines = (text || '').split(/\r?\n/).filter(l => l.trim() !== '');
        if (lines.length === 0) return null;
        const entries = [];
        for (const line of lines) {
            const entry = parseSyslogLine(line.trim());
            if (entry) entries.push(entry);
            else if (entries.length) entries[entries.length - 1].message += `\n${line}`;
            else return null;
        }
        return entries;
    }

    // ---------- Plain text ----------

    // Splits text into plain and link (http/https URL) tokens
    function tokenizeText(text) {
        const tokens = [];
        const pattern = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
        let last = 0;
        let m;
        while ((m = pattern.exec(text))) {
            if (m.index > last) tokens.push({ text: text.slice(last, m.index), type: 'text' });
            tokens.push({ text: m[0], type: 'link' });
            last = pattern.lastIndex;
        }
        if (last < text.length) tokens.push({ text: text.slice(last), type: 'text' });
        return tokens;
    }

    // ---------- One-line preview for the message list ----------

    // Readable single-line summary: the text of HTML, the message part of syslog, JSON as-is.
    // `htmlToText` is supplied by the browser caller (DOMParser); in Node tags are stripped crudely.
    function previewText(text, format = detectFormat(text), htmlToText) {
        let out = text || '';
        if (format === 'html' || format === 'xml') {
            // Separate blocks with a space so "<p>a</p><p>b</p>" reads "a b", not "ab".
            // In XML every element is a block.
            const boundary = format === 'xml'
                ? /<\/[^>]+>|<[^>]+\/>/g
                : /<\/(?:p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre)\s*>|<(?:br|hr)\b[^>]*>/gi;
            out = out.replace(boundary, '$& ');
            out = htmlToText ? htmlToText(out) : out.replace(/<[^>]*>/g, '');
        } else if (format === 'syslog') {
            out = (parseSyslog(out.trim()) || []).map(e => [e.app, e.message].filter(Boolean).join(': ')).join(' · ');
        }
        return out.replace(/\s+/g, ' ').trim();
    }

    // ---------- Rendering (browser only) ----------

    const VIEWS = {
        json: ['formatted', 'raw'],
        html: ['preview', 'source', 'raw'],
        xml: ['formatted', 'raw'],
        syslog: ['formatted', 'raw'],
        text: [],
    };
    const LABELS = { json: 'JSON', html: 'HTML', xml: 'XML', syslog: 'Syslog', text: 'Text',
        formatted: 'Formatted', raw: 'Raw', preview: 'Preview', source: 'Source' };

    function span(type, text) {
        const node = document.createElement('span');
        node.className = `tok-${type}`;
        node.textContent = text;
        return node;
    }

    function codeBlock(tokens) {
        const pre = document.createElement('pre');
        pre.className = 'formatted-code';
        for (const t of tokens) pre.appendChild(t.type === 'text' || t.type === 'punct' ? document.createTextNode(t.text) : span(t.type, t.text));
        return pre;
    }

    function renderText(text) {
        const div = document.createElement('div');
        div.className = 'message-text-body';
        for (const t of tokenizeText(text)) {
            if (t.type === 'link') {
                const a = document.createElement('a');
                a.href = t.text;
                a.textContent = t.text;
                a.target = '_blank';
                a.rel = 'noopener noreferrer nofollow';
                div.appendChild(a);
            } else {
                div.appendChild(document.createTextNode(t.text));
            }
        }
        return div;
    }

    function renderSyslog(entries) {
        const table = document.createElement('table');
        table.className = 'syslog-table';
        const head = table.createTHead().insertRow();
        for (const h of ['Time', 'Host', 'App', 'Level', 'Message']) {
            const th = document.createElement('th');
            th.textContent = h;
            head.appendChild(th);
        }
        const body = table.createTBody();
        for (const e of entries) {
            const row = body.insertRow();
            row.insertCell().textContent = e.timestamp || '';
            row.insertCell().textContent = e.host || '';
            const app = row.insertCell();
            app.textContent = e.app || '';
            if (e.pid) app.appendChild(span('pid', `[${e.pid}]`));
            const sev = row.insertCell();
            if (e.severity) {
                const badge = span(`sev-${e.severity}`, e.severity);
                badge.classList.add('sev-badge');
                badge.title = e.facility ? `facility: ${e.facility}` : '';
                sev.appendChild(badge);
            }
            const msg = row.insertCell();
            msg.className = 'syslog-message';
            msg.textContent = e.message || '';
            if (e.msgid || e.structured) {
                const extra = document.createElement('div');
                extra.className = 'syslog-extra';
                extra.textContent = [e.msgid && `msgid ${e.msgid}`, e.structured].filter(Boolean).join('  ');
                msg.appendChild(extra);
            }
        }
        return table;
    }

    function renderHtmlPreview(html) {
        const frame = document.createElement('iframe');
        frame.className = 'html-preview';
        frame.title = 'HTML preview (scripts disabled)';
        // No allow-scripts: nothing in the message can run. allow-same-origin only lets this page
        // read the frame's height to size it.
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = html;
        frame.addEventListener('load', () => {
            try {
                // Shrink first: the document is never shorter than the frame, so measuring at the
                // default height would only ever grow it
                frame.style.height = '0px';
                const height = frame.contentDocument.documentElement.scrollHeight;
                frame.style.height = `${Math.min(Math.max(height, 40), 2000)}px`;
            } catch {
                frame.style.height = '';
            }
        });
        return frame;
    }

    // Renders `text` into `container` and returns { format, views, view } so the caller can
    // show a badge and a view switcher. `view` selects one of `views`; default is the first.
    function renderMessage(container, text, { view } = {}) {
        const format = detectFormat(text);
        const views = VIEWS[format];
        const active = views.includes(view) ? view : views[0] || 'formatted';
        container.replaceChildren();
        container.dataset.format = format;
        container.dataset.view = active;

        try {
            if (active === 'raw') {
                container.appendChild(renderText(text));
            } else if (format === 'json') {
                container.appendChild(codeBlock(tokenizeJson(text.trim())));
            } else if (format === 'html' && active === 'preview') {
                container.appendChild(renderHtmlPreview(text));
            } else if (format === 'html' || format === 'xml') {
                container.appendChild(codeBlock(tokenizeMarkup(prettyMarkup(text, { xml: format === 'xml' }))));
            } else if (format === 'syslog') {
                container.appendChild(renderSyslog(parseSyslog(text.trim())));
            } else {
                container.appendChild(renderText(text));
            }
        } catch {
            // Anything unexpected: fall back to the plain text
            container.replaceChildren(renderText(text));
        }
        return { format, views, view: active, label: (v => LABELS[v] || v) };
    }

    const api = { detectFormat, tokenizeJson, prettyMarkup, tokenizeMarkup, parseSyslog, parseSyslogLine, tokenizeText, previewText, renderMessage, LABELS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MessageFormat = api;
})(typeof window !== 'undefined' ? window : this);
