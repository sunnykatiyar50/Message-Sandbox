// Message Sandbox dashboard: the shell, the Emails section, API keys and the setup pages. The SMS section
// is in sms.js. Message content is always rendered with textContent (or in a sandboxed iframe), never
// injected as HTML into this page.

let messages = [];
let currentPage = 1;
let pageSize = 10;
let totalPages = 1;
let selectedId = null;

const $ = id => document.getElementById(id);

// --- Utilities ---

// fetch wrapper: marks requests as same-origin script calls (required by the server for
// cookie-authenticated writes) and sends the user to the login page when the session expires
async function apiFetch(url, options = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(options.headers || {}) };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        window.location.href = '/login.html';
        throw new Error('Not authenticated');
    }
    return response;
}

function readSetting(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch {
        return fallback;
    }
}

function saveSetting(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: the setting just isn't remembered
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatMessageTime(timestamp) {
    const msgDate = new Date(timestamp);
    const diffMin = Math.floor((Date.now() - msgDate) / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);
    if (diffMin < 1) return 'Just now';
    if (diffHr < 1) return `${diffMin} min ago`;
    if (diffDay < 1) return `${diffHr} h ago`;
    if (diffDay < 7) return `${diffDay} d ago`;
    return msgDate.toLocaleDateString();
}

// Converts a YYYY-MM-DD value from a date input to an ISO timestamp for local midnight
// (optionally the following midnight, so the end date is inclusive)
function localDayToIso(value, nextDay = false) {
    if (!value) return '';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d + (nextDay ? 1 : 0)).toISOString();
}

// --- Quick time ranges (sidebar) ---

const MINUTE = 60 * 1000;
const RANGES = {
    '10m': { ms: 10 * MINUTE, label: 'Last 10 minutes' },
    '1h': { ms: 60 * MINUTE, label: 'Last 1 hour' },
    '8h': { ms: 8 * 60 * MINUTE, label: 'Last 8 hours' },
    '24h': { ms: 24 * 60 * MINUTE, label: 'Last 1 day' },
    '7d': { ms: 7 * 24 * 60 * MINUTE, label: 'Last 1 week' },
    '30d': { ms: 30 * 24 * 60 * MINUTE, label: 'Last 1 month' },
};
let timeRange = 'all'; // a RANGES key, 'all', or 'custom' (dates picked in the toolbar)

// Keeps the sidebar dropdown and the header chip in sync with the current range
function renderRange() {
    $('rangeSelect').value = timeRange;
    const range = RANGES[timeRange];
    $('rangeChip').classList.toggle('hidden', !range);
    $('rangeChipText').textContent = range ? range.label : '';
    $('smsRangeChip').classList.toggle('hidden', !range);
    $('smsRangeChipText').textContent = range ? range.label : '';
    $('rangeIconButton').classList.toggle('active', timeRange !== 'all');
}

async function setTimeRange(value) {
    timeRange = RANGES[value] ? value : 'all';
    // A quick range replaces any picked dates
    $('startDate').value = '';
    $('endDate').value = '';
    $('smsStartDate').value = '';
    $('smsEndDate').value = '';
    renderRange();
    // The range belongs to whichever list is showing; from other pages it takes you to the emails
    const view = currentView();
    if (view === 'sms') await smsFilter();
    else if (view !== 'messages') location.hash = '#/messages';
    else await filterMessages();
}

async function copyText(text, button) {
    const original = button.textContent;
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
    } catch {
        button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = original), 1500);
}

// --- Navigation ---

const VIEWS = ['messages', 'sms', 'send', 'keys', 'api'];
const VIEW_TITLES = { messages: 'Emails', sms: 'SMS', send: 'Send test', keys: 'API keys', api: 'Setup & API' };

function currentView() {
    const name = location.hash.replace(/^#\/?/, '');
    if (userRole === 'viewer' && ADMIN_VIEWS.includes(name)) {
        history.replaceState(null, '', '#/messages'); // keep the address bar honest
        return 'messages';
    }
    return VIEWS.includes(name) ? name : 'messages';
}

function showView() {
    const view = currentView();
    document.querySelectorAll('.view').forEach(section => section.classList.toggle('hidden', section.dataset.view !== view));
    document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
        const active = link.dataset.view === view;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
    document.title = `${VIEW_TITLES[view]} · Message Sandbox`;
    if (view === 'messages') reloadWithSavedParams();
    if (view === 'sms') smsShow();
    if (view === 'send') focusSendForm();
    if (view === 'keys') loadKeys();
    else forgetRevealedKeys();
}

function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const button = $('collapseButton');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-label', button.title);
    saveSetting('ms_sidebar_collapsed', collapsed ? 'yes' : 'no');
}

// --- Resizable sidebar ---

const SIDEBAR_DEFAULT = 232;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_COLLAPSE_AT = 120; // dragging narrower than this collapses to icons

function applySidebarWidth(px) {
    document.documentElement.style.setProperty('--sidebar-width', `${px}px`);
    $('sidebarResizer').setAttribute('aria-valuenow', String(px));
    // The message pane's width is a share of the remaining space, so let it re-measure
    window.dispatchEvent(new Event('resize'));
}

// Applied as soon as the script runs, before the first paint, so the sidebar doesn't jump
(function restoreSidebarWidth() {
    const saved = parseInt(readSetting('ms_sidebar_width', ''), 10);
    if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
        document.documentElement.style.setProperty('--sidebar-width', `${saved}px`);
    }
})();

function initSidebarResizer() {
    const handle = $('sidebarResizer');
    // The target width (CSS variable), not the measured one, which lags while the width animates
    const current = () =>
        parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || SIDEBAR_DEFAULT;
    const clamp = px => Math.min(Math.max(Math.round(px), SIDEBAR_MIN), SIDEBAR_MAX);
    handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
    handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX));
    handle.setAttribute('aria-valuenow', String(current()));

    handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const left = $('sidebar').getBoundingClientRect().left;
        let width = current();
        let wantsCollapse = false;
        let frame = 0;
        const onMove = moveEvent => {
            const raw = moveEvent.clientX - left;
            wantsCollapse = raw < SIDEBAR_COLLAPSE_AT;
            handle.classList.toggle('will-collapse', wantsCollapse);
            width = clamp(raw);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => applySidebarWidth(width));
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('resizing');
            handle.classList.remove('will-collapse');
            if (wantsCollapse) {
                // Keep the last expanded width for when the sidebar is expanded again
                applySidebarWidth(clamp(parseInt(readSetting('ms_sidebar_width', ''), 10) || SIDEBAR_DEFAULT));
                setSidebarCollapsed(true);
            } else {
                saveSetting('ms_sidebar_width', String(width));
            }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
    // Keyboard: arrow keys resize in 16px steps
    handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const width = clamp(current() + (event.key === 'ArrowRight' ? 16 : -16));
        applySidebarWidth(width);
        saveSetting('ms_sidebar_width', String(width));
    });
    handle.addEventListener('dblclick', () => {
        applySidebarWidth(SIDEBAR_DEFAULT);
        saveSetting('ms_sidebar_width', String(SIDEBAR_DEFAULT));
    });
}

// The signed-in account's role: 'admin' or 'viewer'. Viewers only see messages; the server
// enforces this too, the dashboard just hides what they can't use.
let userRole = 'admin';
const ADMIN_VIEWS = ['send', 'keys'];

async function loadSession() {
    try {
        const response = await fetch('/auth/status');
        const status = await response.json();
        userRole = status.role === 'viewer' ? 'viewer' : 'admin';
        const name = status.username || (status.authDisabled ? 'No sign-in' : 'admin');
        $('currentUser').textContent = userRole === 'viewer' ? `${name} (viewer)` : name;
        $('authWarning').classList.toggle('hidden', !status.authDisabled);
        $('logoutButton').classList.toggle('hidden', Boolean(status.authDisabled));
    } catch {
        // keep defaults
    }
    document.body.classList.toggle('role-viewer', userRole === 'viewer');
}

async function logout() {
    try {
        await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
        window.location.href = '/login.html';
    }
}

// --- Live updates ---

// Emails that just arrived over the live stream; their rows flash once when the list reloads
const freshIds = new Set();
let liveSource = null;
let liveTimer = 0;

// The server pushes an event for every stored email (GET /api/emails/stream). A burst of mail is
// collapsed into one reload of the list.
function startLiveUpdates() {
    if (typeof EventSource === 'undefined' || liveSource) return;
    liveSource = new EventSource('/api/events');
    liveSource.addEventListener('open', () => {
        $('liveStatus').classList.remove('hidden');
        $('smsLiveStatus').classList.remove('hidden');
    });
    liveSource.addEventListener('error', () => {
        $('liveStatus').classList.add('hidden');
        $('smsLiveStatus').classList.add('hidden');
        // CLOSED: the server refused the stream (signed out, or too many connections); the browser doesn't retry
        if (liveSource && liveSource.readyState === EventSource.CLOSED) liveSource = null;
    });
    liveSource.addEventListener('email', event => {
        try {
            freshIds.add(JSON.parse(event.data).id);
        } catch {
            // an unreadable event still triggers the reload
        }
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
            if (currentView() === 'messages') reloadCurrentPage();
            else $('navCount').textContent = String((Number($('navCount').textContent) || 0) + freshIds.size);
        }, 250);
    });
    liveSource.addEventListener('sms', smsOnLiveEvent);
}

// --- Emails: loading and rendering ---

function currentFilters() {
    return {
        searchInput: $('searchInput').value,
        startDate: $('startDate').value,
        endDate: $('endDate').value,
    };
}

async function loadMessages(page = 1, pageSizeParam = pageSize, searchInput = '', startDate = '', endDate = '') {
    saveSetting('ms_query_params', JSON.stringify({ page, pageSize: pageSizeParam, searchInput, startDate, endDate, timeRange }));
    try {
        const queryParams = new URLSearchParams({ page, pageSize: pageSizeParam });
        if (searchInput) queryParams.set('search', searchInput);
        if (startDate) queryParams.set('after', localDayToIso(startDate));
        if (endDate) queryParams.set('before', localDayToIso(endDate, true));
        // Relative ranges are recalculated on every load, so the window keeps sliding
        if (!startDate && !endDate && RANGES[timeRange]) {
            queryParams.set('after', new Date(Date.now() - RANGES[timeRange].ms).toISOString());
        }

        const response = await apiFetch(`/api/emails?${queryParams.toString()}`);
        if (!response.ok) throw new Error(response.statusText);
        const data = await response.json();
        messages = data.emails || [];
        currentPage = data.currentPage || page;
        totalPages = data.totalPages || 1;
        const filtered = Boolean(searchInput || startDate || endDate || RANGES[timeRange]);
        $('messageInfo').textContent = `${data.totalEmails} ${filtered ? 'matching' : 'total'}`;
        if (!filtered) $('navCount').textContent = data.totalEmails || '';
    } catch (error) {
        messages = [];
        totalPages = 1;
        $('messageInfo').textContent = 'Could not load emails';
    }
    renderMessages();
    updatePagination();
}

async function reloadCurrentPage() {
    const { searchInput, startDate, endDate } = currentFilters();
    await loadMessages(currentPage, pageSize, searchInput, startDate, endDate);
}

const displayName = person => (person && (person.name || person.address)) || '';

// "alice@example.com", or "alice@example.com +2" when there are more recipients
function recipientSummary(email) {
    const recipients = email.to.length ? email.to.map(r => r.address) : email.envelope.to;
    if (recipients.length === 0) return '';
    return recipients.length > 1 ? `${recipients[0]} +${recipients.length - 1}` : recipients[0];
}

function renderMessages() {
    const list = $('messageList');
    list.replaceChildren();
    $('selectAllCheckbox').checked = false;
    updateSelectionInfo();

    if (messages.length === 0) {
        const filtered = Object.values(currentFilters()).some(Boolean) || Boolean(RANGES[timeRange]);
        list.appendChild(el('li', 'empty-state', filtered ? 'No emails match these filters.' : 'No emails yet. Send one to this server over SMTP, or use Send test.'));
        showDetails(null);
        return;
    }

    if (!messages.some(m => m.id === selectedId)) selectedId = messages[0].id;

    for (const msg of messages) {
        const li = el('li', freshIds.has(msg.id) ? 'message-row fresh' : 'message-row');
        li.dataset.id = String(msg.id);
        if (msg.id === selectedId) li.classList.add('selected');
        li.addEventListener('click', event => {
            if (event.target.closest('.row-check')) return;
            selectMessage(msg.id);
        });

        const check = el('input', 'message-checkbox');
        check.type = 'checkbox';
        check.dataset.id = String(msg.id);
        check.setAttribute('aria-label', `Select email ${msg.id}`);
        check.addEventListener('change', updateSelectionInfo);
        const checkWrap = el('label', 'row-check admin-only');
        checkWrap.appendChild(check);

        const top = el('div', 'row-top');
        top.appendChild(el('span', 'row-sender', displayName(msg.from) || 'Unknown sender'));
        top.appendChild(el('span', 'row-recipient mono', recipientSummary(msg) ? `to ${recipientSummary(msg)}` : ''));
        top.appendChild(el('span', 'spacer'));
        if (msg.attachmentCount) {
            const clip = el('span', 'row-attach');
            clip.title = `${msg.attachmentCount} attachment${msg.attachmentCount === 1 ? '' : 's'}`;
            clip.appendChild(svgIcon('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'));
            top.appendChild(clip);
        }
        const time = el('time', 'row-time', msg.timestamp ? formatMessageTime(msg.timestamp) : '');
        if (msg.timestamp) time.title = new Date(msg.timestamp).toLocaleString();
        top.appendChild(time);

        const body = el('div', 'row-body');
        body.appendChild(top);
        body.appendChild(el('div', 'row-subject', msg.subject || '(no subject)'));
        body.appendChild(el('div', 'row-text', msg.snippet));

        li.appendChild(checkWrap);
        li.appendChild(body);
        list.appendChild(li);
    }
    freshIds.clear();
    showDetails(messages.find(m => m.id === selectedId));
}

function selectMessage(id) {
    selectedId = id;
    document.querySelectorAll('.message-row').forEach(row => row.classList.toggle('selected', row.dataset.id === String(id)));
    showDetails(messages.find(m => m.id === id));
}

// Full emails (bodies, headers, attachments) are fetched when selected. They never change once stored,
// so each is kept for the rest of the page's life.
const fullEmails = new Map();
// Emails in the same conversation, by email id (fetched when an email is selected)
const threads = new Map();
// Link check results ({ results, skipped }), by email id
const linkResults = new Map();
// Remote images are blocked in the preview; "Load images" lifts that for the emails opened this way
const imagesAllowed = new Set();

async function fetchFullEmail(id) {
    if (fullEmails.has(id)) return fullEmails.get(id);
    const response = await apiFetch(`/api/emails/${id}`);
    if (!response.ok) throw new Error(response.statusText);
    const email = await response.json();
    fullEmails.set(id, email);
    return email;
}

async function fetchThread(id) {
    if (threads.has(id)) return threads.get(id);
    let emails = [];
    try {
        const response = await apiFetch(`/api/emails/${id}/thread`);
        if (response.ok) emails = (await response.json()).emails || [];
    } catch {
        // no thread tab if it can't be loaded
    }
    threads.set(id, emails);
    return emails;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const formatAddress = person => (person.name ? `${person.name} <${person.address}>` : person.address);

// The header block: who sent it, to whom, when
function renderMeta(email) {
    const rows = [['From', formatAddress(email.from)]];
    if (email.to.length) rows.push(['To', email.to.map(formatAddress).join(', ')]);
    if (email.cc.length) rows.push(['Cc', email.cc.map(formatAddress).join(', ')]);
    // Recipients the mail was delivered to that aren't in the headers (Bcc, lists)
    const listed = new Set([...email.to, ...email.cc].map(r => r.address.toLowerCase()));
    const hidden = email.envelope.to.filter(address => !listed.has(address.toLowerCase()));
    if (hidden.length) rows.push(['Also to', hidden.join(', ')]);
    rows.push(['Received', email.timestamp ? new Date(email.timestamp).toLocaleString() : '']);
    rows.push(['Size', formatBytes(email.size)]);

    const meta = $('selectedMessageMeta');
    meta.replaceChildren();
    for (const [label, value] of rows) {
        meta.appendChild(el('dt', null, label));
        meta.appendChild(el('dd', label === 'Received' || label === 'Size' ? null : 'mono', value));
    }
}

// The email currently shown in the detail pane. Reloading the list (refresh, window focus) re-selects the
// same email; leaving the pane alone then keeps the preview from reloading and the chosen tab from resetting.
let shownEmailId = null;

function showDetails(summary) {
    $('detailEmpty').classList.toggle('hidden', Boolean(summary));
    $('detailBody').classList.toggle('hidden', !summary);
    if (!summary) {
        shownEmailId = null;
        return;
    }
    if (summary.id === shownEmailId) return;
    shownEmailId = summary.id;

    $('selectedMessageTitle').textContent = summary.subject || '(no subject)';
    $('selectedMessageKey').textContent = summary.smtpUser ? `via ${summary.smtpUser}` : '';
    $('selectedMessageKey').classList.toggle('hidden', !summary.smtpUser);
    renderMeta(summary);
    $('downloadEmlLink').href = `/api/emails/${summary.id}/raw?download=true`;
    $('copyCodeButton').classList.add('hidden');
    $('viewSwitch').replaceChildren();
    $('selectedMessageText').replaceChildren(el('div', 'muted', 'Loading…'));
    $('selectedMessageText').dataset.view = 'loading';

    const id = summary.id;
    Promise.all([fetchFullEmail(id), fetchThread(id)])
        .then(([email]) => {
            if (id === selectedId) renderEmailBody(email);
        })
        .catch(() => {
            if (id === selectedId) $('selectedMessageText').replaceChildren(el('div', 'muted', 'Could not load this email.'));
        });
}

// The tabs available for an email, in display order
function emailViews(email) {
    const views = [];
    if (email.html) views.push(['html', 'HTML']);
    views.push(['text', 'Text']);
    if (email.links.length) views.push(['links', `Links (${email.links.length})`]);
    const warnings = email.checks.filter(c => c.level === 'warning').length;
    views.push(['checks', warnings ? `Checks (${warnings})` : 'Checks']);
    views.push(['headers', 'Headers']);
    if (email.attachments.length) views.push(['attachments', `Attachments (${email.attachments.length})`]);
    const thread = threads.get(email.id) || [];
    if (thread.length > 1) views.push(['thread', `Thread (${thread.length})`]);
    views.push(['raw', 'Raw']);
    return views;
}

function renderEmailBody(email, view) {
    const views = emailViews(email);
    const preferred = view || readSetting('ms_view', '');
    const chosen = views.some(([name]) => name === preferred) ? preferred : views[0][0];

    // The detected one-time code, if any (see src/utils/otp.js)
    $('copyCodeButton').classList.toggle('hidden', !email.code);
    $('copyCodeButton').textContent = email.code ? `Copy code ${email.code}` : 'Copy code';
    $('copyCodeButton').dataset.code = email.code || '';
    $('copyMessageButton').classList.toggle('hidden', !email.text);

    const switcher = $('viewSwitch');
    switcher.replaceChildren();
    for (const [name, label] of views) {
        const button = el('button', name === chosen ? 'active' : '', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(name === chosen));
        button.addEventListener('click', () => {
            saveSetting('ms_view', name);
            renderEmailBody(email, name);
        });
        switcher.appendChild(button);
    }

    const body = $('selectedMessageText');
    body.dataset.view = chosen;
    body.replaceChildren();
    if (chosen === 'html') {
        // The page is sandboxed by the server's Content-Security-Policy header (no scripts, no network,
        // opaque origin; see getPreview), so no sandbox attribute is needed here
        body.appendChild(htmlPreview(email));
    } else if (chosen === 'text') {
        body.appendChild(el('pre', 'formatted-code', email.text || '(no text part)'));
    } else if (chosen === 'links') {
        body.appendChild(linkList(email, () => renderEmailBody(email, 'links')));
    } else if (chosen === 'checks') {
        body.appendChild(checkList(email.checks));
    } else if (chosen === 'thread') {
        body.appendChild(threadList(threads.get(email.id) || [], email.id));
    } else if (chosen === 'headers') {
        body.appendChild(headerTable(email.headers));
    } else if (chosen === 'attachments') {
        body.appendChild(attachmentList(email.attachments));
    } else {
        renderRaw(body, email.id);
    }
}

// The device widths the HTML preview can emulate
const PREVIEW_WIDTHS = [
    ['mobile', 'Mobile', '375px'],
    ['tablet', 'Tablet', '768px'],
    ['desktop', 'Desktop', '100%'],
];

// The sandboxed preview, with device width, simulated dark mode and a switch for remote images
function htmlPreview(email) {
    const wrap = el('div', 'preview');
    const frame = el('iframe', 'email-frame');
    frame.title = 'Email preview';
    const holder = el('div', 'frame-holder');
    holder.appendChild(frame);

    const refresh = () => {
        const width = readSetting('ms_preview_width', 'desktop');
        frame.style.width = (PREVIEW_WIDTHS.find(([name]) => name === width) || PREVIEW_WIDTHS[2])[2];
        // Not a real dark mode: inverts the rendered page, which approximates how clients recolor light emails
        frame.classList.toggle('dark-sim', readSetting('ms_preview_dark', 'no') === 'yes');
        const wanted = `/api/emails/${email.id}/preview${imagesAllowed.has(email.id) ? '?images=true' : ''}`;
        if (frame.getAttribute('src') !== wanted) frame.src = wanted;
        for (const button of tools.querySelectorAll('[data-width]')) {
            button.classList.toggle('active', button.dataset.width === width);
        }
        dark.classList.toggle('active', frame.classList.contains('dark-sim'));
        images.classList.toggle('active', imagesAllowed.has(email.id));
        note.textContent = imagesAllowed.has(email.id)
            ? 'Remote images are loading: the sender can see this email was opened.'
            : 'Scripts and remote images are blocked.';
    };

    const tools = el('div', 'preview-tools');
    const widths = el('div', 'segmented');
    for (const [name, label] of PREVIEW_WIDTHS) {
        const button = el('button', null, label);
        button.type = 'button';
        button.dataset.width = name;
        button.addEventListener('click', () => {
            saveSetting('ms_preview_width', name);
            refresh();
        });
        widths.appendChild(button);
    }
    const dark = el('button', 'ghost small toggle', 'Dark');
    dark.type = 'button';
    dark.title = 'Simulate a dark-mode mail client';
    dark.addEventListener('click', () => {
        saveSetting('ms_preview_dark', readSetting('ms_preview_dark', 'no') === 'yes' ? 'no' : 'yes');
        refresh();
    });
    const images = el('button', 'ghost small toggle', 'Load images');
    images.type = 'button';
    images.title = 'Load remote images (tells the sender the email was opened)';
    images.addEventListener('click', () => {
        if (imagesAllowed.has(email.id)) imagesAllowed.delete(email.id);
        else imagesAllowed.add(email.id);
        refresh();
    });
    tools.append(widths, dark, images);

    const note = el('div', 'frame-note');
    wrap.append(tools, holder, note);
    refresh();
    return wrap;
}

// Links with a "Check links" button (admin) that reports whether each one resolves
function linkList(email, rerender) {
    const wrap = el('div');
    const checked = linkResults.get(email.id);
    const byUrl = new Map(checked ? checked.results.map(r => [r.url, r]) : []);

    const bar = el('div', 'link-bar');
    const check = el('button', 'ghost small admin-only', checked ? 'Check again' : 'Check links');
    check.type = 'button';
    check.title = 'The server requests each link and reports the status';
    check.addEventListener('click', async () => {
        check.disabled = true;
        check.textContent = 'Checking…';
        try {
            const { response, data } = await apiJson(`/api/emails/${email.id}/check-links`, { method: 'POST' });
            if (!response.ok) throw new Error(data.error || response.statusText);
            linkResults.set(email.id, data);
        } catch (error) {
            alert(`Could not check the links: ${error.message}`);
        }
        rerender();
    });
    bar.appendChild(check);
    if (checked) {
        const broken = checked.results.filter(r => !r.ok).length;
        bar.appendChild(el('span', broken ? 'check-summary bad' : 'check-summary good', broken ? `${broken} of ${checked.results.length} broken` : `All ${checked.results.length} links work`));
        if (checked.skipped) bar.appendChild(el('span', 'muted', `${checked.skipped} more not checked`));
    }
    wrap.appendChild(bar);

    const list = el('ul', 'link-list');
    for (const url of email.links) {
        const item = el('li');
        const anchor = el('a', null, url);
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        item.appendChild(anchor);
        const result = byUrl.get(url);
        if (result) {
            const label = result.status ? String(result.status) : result.error || 'failed';
            const chip = el('span', `status-chip ${result.ok ? 'good' : 'bad'}`, label);
            chip.title = result.finalUrl ? `Redirects to ${result.finalUrl}` : `${result.ms} ms`;
            item.appendChild(chip);
        }
        const copy = el('button', 'ghost small', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', () => copyText(url, copy));
        item.appendChild(copy);
        list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
}

// Deliverability findings from the server (src/mail/analyze.js)
function checkList(checks) {
    if (checks.length === 0) return el('div', 'check-empty', 'No issues found.');
    const list = el('ul', 'check-list');
    // Warnings first
    for (const check of [...checks].sort((a, b) => (a.level === b.level ? 0 : a.level === 'warning' ? -1 : 1))) {
        const item = el('li', check.level);
        item.appendChild(el('span', `level-tag ${check.level}`, check.level === 'warning' ? 'Warning' : 'Note'));
        item.appendChild(el('span', null, check.message));
        list.appendChild(item);
    }
    return list;
}

// The emails in the same conversation; clicking one opens it
function threadList(emails, currentId) {
    const list = el('ul', 'thread-list');
    for (const email of emails) {
        const item = el('li', email.id === currentId ? 'current' : '');
        const open = el('button', 'thread-open');
        open.type = 'button';
        open.append(
            el('span', 'thread-from', displayName(email.from)),
            el('span', 'thread-subject', email.subject || '(no subject)'),
            el('time', 'muted', email.timestamp ? new Date(email.timestamp).toLocaleString() : '')
        );
        open.addEventListener('click', () => {
            selectedId = email.id;
            shownEmailId = null; // force the detail pane to load it
            document.querySelectorAll('.message-row').forEach(row => row.classList.toggle('selected', row.dataset.id === String(email.id)));
            showDetails(email);
        });
        item.appendChild(open);
        list.appendChild(item);
    }
    return list;
}

function headerTable(headers) {
    const table = el('table', 'ref-table header-table');
    for (const { key, value } of headers) {
        const row = el('tr');
        row.append(el('th', null, key), el('td', 'mono', value));
        table.appendChild(row);
    }
    return table;
}

function attachmentList(attachments) {
    const list = el('ul', 'attachment-list');
    for (const attachment of attachments) {
        const item = el('li');
        const download = el('a', null, attachment.filename);
        download.href = attachment.url;
        download.download = attachment.filename;
        item.append(download, el('span', 'muted', `${attachment.contentType} · ${formatBytes(attachment.size)}`));
        list.appendChild(item);
    }
    return list;
}

const RAW_DISPLAY_LIMIT = 200000;

async function renderRaw(container, id) {
    container.appendChild(el('div', 'muted', 'Loading…'));
    try {
        const response = await apiFetch(`/api/emails/${id}/raw`);
        if (!response.ok) throw new Error(response.statusText);
        const text = await response.text();
        if (id !== selectedId || container.dataset.view !== 'raw') return;
        const shown = text.length > RAW_DISPLAY_LIMIT ? `${text.slice(0, RAW_DISPLAY_LIMIT)}\n\n… truncated; use Download .eml for the full message` : text;
        container.replaceChildren(el('pre', 'formatted-code', shown));
    } catch (error) {
        if (id === selectedId && container.dataset.view === 'raw') container.replaceChildren(el('div', 'muted', 'Could not load the raw message.'));
    }
}

// Up/down arrow keys move through the list
function moveSelection(step) {
    const idx = messages.findIndex(m => m.id === selectedId);
    const next = messages[idx + step];
    if (!next) return;
    selectMessage(next.id);
    const row = document.querySelector(`.message-row[data-id="${next.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
}

// --- Resizable message pane ---

const DEFAULT_DETAIL_RATIO = 0.42;
const MIN_DETAIL_PX = 300;
const MIN_LIST_PX = 360;

// The detail pane width is stored as a share of the layout, so it adapts when the window is resized
function applyDetailRatio(layout, resizer, ratio) {
    const width = layout.getBoundingClientRect().width;
    if (!width) return; // the view is hidden; it is applied again when shown
    const px = Math.min(Math.max(ratio * width, MIN_DETAIL_PX), Math.max(MIN_DETAIL_PX, width - MIN_LIST_PX));
    layout.style.setProperty('--detail-width', `${Math.round(px)}px`);
    resizer.setAttribute('aria-valuenow', String(Math.round((px / width) * 100)));
}

// Makes the pane between a list and its detail draggable; the Emails and SMS lists each have one, and
// they share the saved width
function initPaneResizer(layoutId, resizerId) {
    const layout = $(layoutId);
    const resizer = $(resizerId);
    let ratio = parseFloat(readSetting('ms_detail_ratio', '')) || DEFAULT_DETAIL_RATIO;
    const apply = () => applyDetailRatio(layout, resizer, ratio);
    const save = () => saveSetting('ms_detail_ratio', ratio.toFixed(3));
    resizer.setAttribute('aria-valuemin', '20');
    resizer.setAttribute('aria-valuemax', '75');

    resizer.addEventListener('pointerdown', event => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const onMove = moveEvent => {
            const rect = layout.getBoundingClientRect();
            ratio = Math.min(Math.max((rect.right - moveEvent.clientX) / rect.width, 0.2), 0.75);
            apply();
        };
        const onUp = () => {
            resizer.removeEventListener('pointermove', onMove);
            resizer.removeEventListener('pointerup', onUp);
            resizer.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('resizing');
            save();
        };
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
        resizer.addEventListener('pointercancel', onUp);
    });
    // Keyboard: arrow keys resize in 2% steps
    resizer.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        ratio = Math.min(Math.max(ratio + (event.key === 'ArrowLeft' ? 0.02 : -0.02), 0.2), 0.75);
        apply();
        save();
    });
    resizer.addEventListener('dblclick', () => {
        ratio = DEFAULT_DETAIL_RATIO;
        apply();
        save();
    });
    window.addEventListener('resize', apply);
    window.addEventListener('hashchange', () => requestAnimationFrame(apply));
    apply();
}

// --- Messages: pagination, filters, selection ---

function updatePagination() {
    $('prevPage').disabled = currentPage <= 1;
    $('nextPage').disabled = currentPage >= totalPages;
    $('pageInfo').textContent = `${currentPage} / ${totalPages}`;
}

async function changePage(direction) {
    currentPage = Math.min(Math.max(1, currentPage + direction), totalPages);
    await reloadCurrentPage();
}

async function changePageSize() {
    pageSize = parseInt($('pageSizeSelect').value, 10);
    currentPage = 1;
    await reloadCurrentPage();
}

async function filterMessages() {
    currentPage = 1;
    await reloadCurrentPage();
}

async function resetFilters() {
    $('searchInput').value = '';
    $('startDate').value = '';
    $('endDate').value = '';
    timeRange = 'all';
    renderRange();
    await filterMessages();
}

// Picking dates in the toolbar switches the sidebar range to "Custom dates"
async function onDateChange() {
    const hasDates = Boolean($('startDate').value || $('endDate').value);
    timeRange = hasDates ? 'custom' : 'all';
    renderRange();
    await filterMessages();
}

function reloadWithSavedParams() {
    try {
        const saved = JSON.parse(readSetting('ms_query_params', 'null'));
        if (saved) {
            $('searchInput').value = saved.searchInput || '';
            $('startDate').value = saved.startDate || '';
            $('endDate').value = saved.endDate || '';
            timeRange = RANGES[saved.timeRange] || saved.timeRange === 'custom' ? saved.timeRange : 'all';
            renderRange();
            if (saved.pageSize) {
                pageSize = saved.pageSize;
                $('pageSizeSelect').value = saved.pageSize;
            }
            loadMessages(saved.page || 1, pageSize, saved.searchInput || '', saved.startDate || '', saved.endDate || '');
            return;
        }
    } catch {
        // fall through: load all
    }
    loadMessages(1, pageSize);
}

function selectedIds() {
    return Array.from(document.querySelectorAll('.message-checkbox:checked')).map(c => Number(c.dataset.id));
}

function updateSelectionInfo() {
    const count = selectedIds().length;
    $('selectionInfo').textContent = count ? `${count} selected` : '';
    $('deleteSelectedButton').disabled = count === 0;
    $('exportSelectedButton').disabled = count === 0;
    $('selectAllCheckbox').checked = count > 0 && count === messages.length;
}

function toggleSelectAll(checked) {
    document.querySelectorAll('.message-checkbox').forEach(c => (c.checked = checked));
    updateSelectionInfo();
}

// Downloads the selected emails as a zip of .eml files
async function exportSelectedMessages() {
    const ids = selectedIds();
    if (ids.length === 0) return;
    const button = $('exportSelectedButton');
    button.disabled = true;
    try {
        const response = await apiFetch(`/api/emails/export?ids=${ids.join(',')}`);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await response.blob());
        link.download = 'emails.zip';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
        alert(`Could not export the emails: ${error.message}`);
    } finally {
        button.disabled = selectedIds().length === 0;
    }
}

async function deleteSelectedMessages() {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} email(s)? This can't be undone.`)) return;
    try {
        const response = await apiFetch('/api/emails', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        if (!response.ok) alert('Failed to delete the selected emails.');
        await reloadCurrentPage();
    } catch (error) {
        alert('An error occurred while deleting the emails.');
    }
}

// --- Send test ---

const MAX_BODY = 200000;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const TEST_FIELDS = ['from', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'attachments'];
const MAX_FILES = 5;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_TOTAL_BYTES = 5 * 1024 * 1024;

// The files picked for the test email; they are read and sent when the form is submitted
const attachedFiles = [];

function renderAttachedFiles() {
    const list = $('attachmentList');
    list.replaceChildren();
    attachedFiles.forEach((file, index) => {
        const item = el('li');
        item.appendChild(el('span', null, `${file.name} · ${formatBytes(file.size)}`));
        const remove = el('button', 'ghost small', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
            attachedFiles.splice(index, 1);
            renderAttachedFiles();
            setFieldError('attachments', '');
            onFormInput();
        });
        item.appendChild(remove);
        list.appendChild(item);
    });
}

function addAttachedFiles(files) {
    attachedFiles.push(...files);
    $('attachmentsInput').value = ''; // so the same file can be picked again
    setFieldError('attachments', '');
    renderAttachedFiles();
    onFormInput();
}

const readAsBase64 = file =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

const readAttachments = () =>
    Promise.all(attachedFiles.map(async file => ({ filename: file.name, contentType: file.type || 'application/octet-stream', content: await readAsBase64(file) })));

// The server's SMTP address as seen from this page, filled in from /api/info
let smtpInfo = {
    smtpPort: 1025,
    smtpAuthRequired: false,
    smtpUsername: null,
    smtpStartTls: false,
    smtpTlsPort: null,
    smtpSimulate: true,
    smtpAllowedDomains: [],
};

async function loadServerInfo() {
    try {
        const response = await apiFetch('/api/info');
        if (response.ok) smtpInfo = await response.json();
    } catch {
        // keep the defaults
    }
    renderApiReference();
    updateEquivalentCommand();
}

function formValues() {
    return {
        from: $('fromInput').value.trim(),
        to: $('toInput').value.trim(),
        cc: $('ccInput').value.trim(),
        bcc: $('bccInput').value.trim(),
        subject: $('subjectInput').value.trim(),
        text: $('textInput').value,
        html: $('htmlInput').value,
    };
}

function updateBodyCounter() {
    const length = $('textInput').value.length + $('htmlInput').value.length;
    $('bodyCounter').textContent = length ? `${length.toLocaleString()} characters` : '';
}

// Shows the swaks command that would deliver the same email over SMTP from outside the dashboard
function updateEquivalentCommand() {
    const { from, to, cc, bcc, subject, text } = formValues();
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    // swaks sends to every --to address; Cc is also a header, and Bcc is simply an extra recipient
    const recipients = [to || 'user@example.com', cc, bcc].filter(Boolean).join(',');
    const lines = [
        `swaks --server ${location.hostname}:${smtpInfo.smtpPort} \\`,
        `  --from ${quote(from || 'noreply@example.com')} \\`,
        `  --to ${quote(recipients)} \\`,
        ...(cc ? [`  --header ${quote(`Cc: ${cc}`)} \\`] : []),
        `  --header ${quote(`Subject: ${subject || 'Test email'}`)} \\`,
        ...attachedFiles.map(file => `  --attach ${quote(`@${file.name}`)} \\`),
        `  --body ${quote(text || 'Your verification code is 123456')}`,
    ];
    if (smtpInfo.smtpAuthRequired) lines.splice(1, 0, `  --auth-user ${quote(smtpInfo.smtpUsername || 'USERNAME')} --auth-password "$SMTP_PASSWORD" \\`);
    $('equivalentCommand').textContent = lines.join('\n');
}

function setFieldError(field, message) {
    $(`${field}Error`).textContent = message || '';
    $(`${field}Input`).classList.toggle('invalid', Boolean(message));
}

function clearFieldErrors() {
    TEST_FIELDS.forEach(field => setFieldError(field, ''));
}

// Same rules as the server, so most mistakes are caught before sending
function validateForm({ from, to, cc, bcc, subject, text, html }) {
    const errors = {};
    if (!EMAIL_RE.test(from)) errors.from = 'Enter an email address.';
    const addresses = value => value.split(/[,;\s]+/).filter(Boolean);
    const valid = list => list.length <= 20 && list.every(a => EMAIL_RE.test(a));
    if (addresses(to).length === 0 || !valid(addresses(to))) errors.to = 'Enter 1–20 email addresses separated by commas.';
    if (!valid(addresses(cc))) errors.cc = 'At most 20 email addresses, separated by commas.';
    if (!valid(addresses(bcc))) errors.bcc = 'At most 20 email addresses, separated by commas.';
    if (attachedFiles.length > MAX_FILES) errors.attachments = `At most ${MAX_FILES} files.`;
    else if (attachedFiles.some(file => file.size > MAX_FILE_BYTES)) errors.attachments = `Each file can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
    else if (attachedFiles.reduce((sum, file) => sum + file.size, 0) > MAX_FILES_TOTAL_BYTES) errors.attachments = `The files together can be at most ${MAX_FILES_TOTAL_BYTES / 1024 / 1024} MB.`;
    if (subject.length > 255) errors.subject = 'At most 255 characters.';
    if (!text.trim() && !html.trim()) errors.text = 'Enter a text or an HTML body.';
    if (text.length > MAX_BODY) errors.text = `At most ${MAX_BODY.toLocaleString()} characters.`;
    if (html.length > MAX_BODY) errors.html = `At most ${MAX_BODY.toLocaleString()} characters.`;
    return errors;
}

function setFormStatus(text, kind) {
    $('formStatus').textContent = text;
    $('formStatus').className = `form-status${kind ? ` ${kind}` : ''}`;
}

function fillSampleEmail() {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!$('fromInput').value) $('fromInput').value = 'noreply@example.com';
    if (!$('toInput').value) $('toInput').value = 'user@example.com';
    $('subjectInput').value = 'Verify your email address';
    $('textInput').value = `Your verification code is ${code}.\n\nOr confirm directly: https://app.example.com/verify?token=${code}\n\nThis code expires in 10 minutes.`;
    $('htmlInput').value = `<div style="font-family:sans-serif"><h2>Verify your email</h2><p>Your verification code is <b style="font-size:20px">${code}</b>.</p><p><a href="https://app.example.com/verify?token=${code}">Confirm my email</a></p><p style="color:#888">This code expires in 10 minutes.</p></div>`;
    clearFieldErrors();
    onFormInput();
}

function onFormInput() {
    updateBodyCounter();
    updateEquivalentCommand();
}

function clearForm() {
    $('messageForm').reset();
    attachedFiles.length = 0;
    renderAttachedFiles();
    clearFieldErrors();
    setFormStatus('');
    onFormInput();
}

async function sendMessage(event) {
    event.preventDefault();
    const values = formValues();
    clearFieldErrors();
    const errors = validateForm(values);
    if (Object.keys(errors).length) {
        Object.entries(errors).forEach(([field, msg]) => setFieldError(field, msg));
        setFormStatus('Fix the highlighted fields.', 'error');
        return;
    }

    const button = $('sendButton');
    button.disabled = true;
    setFormStatus('Sending…');
    try {
        const response = await apiFetch('/api/emails/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...values, attachments: await readAttachments() }),
        });
        const data = await response.json().catch(() => ({}));
        $('lastResponse').textContent = `HTTP ${response.status}\n${JSON.stringify(data, null, 2)}`;
        $('lastResponse').classList.remove('muted-code');

        if (response.ok) {
            setFormStatus(`Stored as email #${data.id}.`, 'success');
            $('viewInMessages').classList.remove('hidden');
            selectedId = data.id;
            currentPage = 1;
            // Keep the addresses so several emails can be sent in a row
            $('subjectInput').value = '';
            $('textInput').value = '';
            $('htmlInput').value = '';
            attachedFiles.length = 0;
            renderAttachedFiles();
            onFormInput();
            $('subjectInput').focus();
        } else if (data.details) {
            // Server messages read like "must be ..." / "is required"; prefix the field name
            Object.entries(data.details).forEach(([field, msg]) => {
                if (!TEST_FIELDS.includes(field)) return;
                const label = field.charAt(0).toUpperCase() + field.slice(1);
                setFieldError(field, `${label} ${msg}.`);
            });
            setFormStatus('The server rejected the email. See the highlighted fields.', 'error');
        } else {
            setFormStatus(`Failed to send: ${data.error || response.statusText}`, 'error');
        }
    } catch (error) {
        setFormStatus('Could not reach the server.', 'error');
    } finally {
        button.disabled = false;
    }
}

// --- API keys ---

// Full keys revealed on this page, by key id. Only kept while the page is open, and cleared when
// navigating to another view.
const revealedKeys = new Map();
let keysData = { keys: [], adminTokenConfigured: false };

function forgetRevealedKeys() {
    revealedKeys.clear();
    $('newKeyResult').classList.add('hidden');
    $('newKeySecret').textContent = '';
    $('newKeyExample').textContent = '';
}

async function apiJson(url, options = {}) {
    const headers = options.body ? { 'Content-Type': 'application/json' } : {};
    const response = await apiFetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    return { response, data };
}

async function loadKeys() {
    try {
        const { response, data } = await apiJson('/api/keys');
        if (!response.ok) throw new Error(data.error || response.statusText);
        keysData = data;
    } catch (error) {
        keysData = { keys: [], adminTokenConfigured: false };
        $('keysFootnote').textContent = `Could not load API keys: ${error.message}`;
    }
    renderKeys();
}

function keyExample(scope, secret) {
    if (scope === 'send') {
        return [
            `curl -X POST ${location.origin}/api/sms \\`,
            '  -H "Content-Type: application/json" \\',
            `  -H "X-API-Key: ${secret}" \\`,
            `  -d '{"phone": "+15551234567", "message": "Your OTP is 123456"}'`,
        ].join('\n');
    }
    return [
        `curl -H "Authorization: Bearer ${secret}" \\`,
        `  "${location.origin}/api/emails/latest?to=user%40example.com"`,
    ].join('\n');
}

// Fetches (once) and returns a key's full value
async function revealKey(rowId, url) {
    if (revealedKeys.has(rowId)) return revealedKeys.get(rowId);
    const { response, data } = await apiJson(url, { method: 'POST' });
    if (!response.ok) throw new Error(data.error || response.statusText);
    revealedKeys.set(rowId, data.secret);
    return data.secret;
}

// An inline SVG icon from fixed markup in this file (never from message or key data)
function svgIcon(innerMarkup) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = innerMarkup;
    return svg;
}

const ICONS = {
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.9 17.9A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9"/><path d="M9.9 4.2A10.7 10.7 0 0 1 12 5c7 0 11 7 11 7a18.6 18.6 0 0 1-2.2 3.2"/><line x1="1" y1="1" x2="23" y2="23"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    cross: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
};

// An icon-only button whose label shows as a tooltip on hover or keyboard focus
function iconButton(icon, label, onClick, extraClass = '') {
    const button = el('button', `icon-action ${extraClass}`.trim());
    button.type = 'button';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.appendChild(svgIcon(ICONS[icon]));
    button.addEventListener('click', onClick);
    return button;
}

// Copies text from getText() and shows a check (or a cross) on the button for a moment
async function copyWithIcon(button, getText) {
    let text;
    try {
        text = await getText();
    } catch (error) {
        return alert(error.message);
    }
    const icon = button.firstChild;
    const label = button.dataset.tooltip;
    let copied = true;
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        copied = false;
    }
    button.replaceChildren(svgIcon(copied ? ICONS.check : ICONS.cross));
    button.dataset.tooltip = copied ? 'Copied' : 'Copy failed';
    setTimeout(() => {
        button.replaceChildren(icon);
        button.dataset.tooltip = label;
    }, 1500);
}

// Swaps a key's name for an input; Enter or the check saves, Escape or the cross cancels
function startRename(nameCell, id, currentName) {
    const input = el('input', 'key-name-input');
    input.type = 'text';
    input.value = currentName;
    input.maxLength = 64;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Key name');
    const error = el('small', 'field-error');

    const save = async () => {
        const name = input.value.trim();
        if (name === currentName) return renderKeys();
        const { response, data } = await apiJson(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        if (response.ok) return loadKeys();
        error.textContent = data.details && data.details.name ? `Name ${data.details.name}` : data.error || 'Could not rename the key.';
        input.classList.add('invalid');
    };
    input.addEventListener('input', () => {
        error.textContent = '';
        input.classList.remove('invalid');
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            save();
        } else if (event.key === 'Escape') {
            renderKeys();
        }
    });

    const row = el('div', 'key-name-edit');
    row.append(input, iconButton('check', 'Save name', save), iconButton('cross', 'Cancel', renderKeys));
    nameCell.replaceChildren(row, error);
    input.focus();
    input.select();
}

function keyRow({ id, name, scope, prefix, allowedRecipients = [], messageCount = 0, lastUsedAt, createdAt, revokedAt }) {
    const rowId = id;
    const revealUrl = `/api/keys/${id}/reveal`;
    const tr = el('tr', revokedAt ? 'key-revoked' : '');

    const nameCell = el('td', 'key-name');
    nameCell.appendChild(el('span', null, name));
    tr.appendChild(nameCell);

    const typeCell = el('td');
    typeCell.appendChild(el('span', `scope-badge scope-${scope}`, scope === 'send' ? 'Send' : 'Read'));
    tr.appendChild(typeCell);

    // What the key can reach: a Send key submits SMS (counted); a Read key reads every inbox and SMS, or only
    // the email inboxes it is limited to
    const inboxCell = el('td');
    if (scope === 'send') {
        inboxCell.appendChild(el('span', 'muted', `${messageCount} sent`));
    } else if (allowedRecipients.length) {
        const chips = el('span', 'key-inboxes');
        allowedRecipients.forEach(rule => chips.appendChild(el('span', 'chip', rule)));
        inboxCell.appendChild(chips);
    } else {
        inboxCell.appendChild(el('span', 'muted', 'All emails and SMS'));
    }

    const keyCell = el('td', 'key-value');
    const shown = revealedKeys.get(rowId);
    keyCell.appendChild(el('code', null, shown || `${prefix}…`));
    if (!revokedAt) {
        const actions = el('span', 'key-actions');
        const toggle = iconButton(shown ? 'eyeOff' : 'eye', shown ? 'Hide key' : 'Show key', async () => {
            if (revealedKeys.has(rowId)) {
                revealedKeys.delete(rowId);
                return renderKeys();
            }
            try {
                await revealKey(rowId, revealUrl);
                renderKeys();
            } catch (error) {
                alert(error.message);
            }
        });
        const copy = iconButton('copy', 'Copy key', () => copyWithIcon(copy, () => revealKey(rowId, revealUrl)));
        actions.append(toggle, copy);
        keyCell.appendChild(actions);
    }
    tr.appendChild(keyCell);
    tr.appendChild(inboxCell);

    tr.appendChild(el('td', 'muted', lastUsedAt ? formatMessageTime(lastUsedAt) : 'Never'));
    tr.appendChild(el('td', 'muted', new Date(createdAt).toLocaleDateString()));

    const actionCell = el('td', 'key-row-action');
    if (revokedAt) {
        const revoked = el('span', 'revoked-tag', 'Revoked');
        revoked.tabIndex = 0;
        revoked.dataset.tooltip = `Revoked ${new Date(revokedAt).toLocaleString()}`;
        actionCell.appendChild(revoked);
        const remove = el('button', 'icon-action danger-icon');
        remove.type = 'button';
        remove.dataset.tooltip = 'Delete key';
        remove.setAttribute('aria-label', `Delete revoked key "${name}"`);
        remove.appendChild(svgIcon('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4h6v2"/>'));
        remove.addEventListener('click', () => deleteKey(id, name));
        actionCell.appendChild(remove);
    } else {
        actionCell.appendChild(iconButton('pencil', 'Rename key', () => startRename(nameCell, id, name)));
        // Icon button; "Revoke key" appears as a tooltip on hover or keyboard focus
        const revoke = el('button', 'icon-action danger-icon');
        revoke.type = 'button';
        revoke.dataset.tooltip = 'Revoke key';
        revoke.setAttribute('aria-label', `Revoke key "${name}"`);
        revoke.appendChild(svgIcon('<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>'));
        revoke.addEventListener('click', () => revokeKey(id, name));
        actionCell.appendChild(revoke);
    }
    tr.appendChild(actionCell);
    return tr;
}

function renderKeys() {
    const body = $('keysBody');
    body.replaceChildren();
    const rows = keysData.keys; // active first, then revoked (sorted by the server)
    rows.forEach(row => body.appendChild(keyRow(row)));
    $('keysEmpty').classList.toggle('hidden', rows.length > 0);
    document.querySelector('.keys-table').classList.toggle('hidden', rows.length === 0);
    $('keysFootnote').textContent = keysData.adminTokenConfigured
        ? 'ADMIN_TOKEN from .env also gives full API access (including deleting messages). It is not shown here.'
        : '';
}

function showKeyForm(visible) {
    $('newKeyForm').classList.toggle('hidden', !visible);
    $('newKeyButton').classList.toggle('hidden', visible);
    $('keyNameError').textContent = '';
    $('keyNameInput').classList.remove('invalid');
    $('keyRecipientsError').textContent = '';
    $('keyRecipientsInput').classList.remove('invalid');
    if (visible) {
        $('newKeyResult').classList.add('hidden');
        $('keyNameInput').focus();
    } else {
        $('newKeyForm').reset();
        $('keyRecipientsField').classList.remove('hidden');
    }
}

async function createKey(event) {
    event.preventDefault();
    const name = $('keyNameInput').value.trim();
    if (!name) {
        $('keyNameError').textContent = 'Give the key a name, e.g. the app that will use it.';
        $('keyNameInput').classList.add('invalid');
        return;
    }
    $('createKeyButton').disabled = true;
    try {
        const scope = $('keyScopeInput').value;
        const allowedRecipients = scope === 'read' ? $('keyRecipientsInput').value.trim() : '';
        const { response, data } = await apiJson('/api/keys', { method: 'POST', body: JSON.stringify({ name, scope, allowedRecipients }) });
        if (!response.ok) {
            const details = data.details || {};
            $('keyNameError').textContent = details.name ? `Name ${details.name}.` : details.allowedRecipients ? '' : data.error || 'Could not create the key.';
            $('keyNameInput').classList.toggle('invalid', Boolean(details.name) || !data.details);
            $('keyRecipientsError').textContent = details.allowedRecipients ? `Recipients: ${details.allowedRecipients}.` : '';
            $('keyRecipientsInput').classList.toggle('invalid', Boolean(details.allowedRecipients));
            return;
        }
        revealedKeys.set(data.key.id, data.secret);
        showKeyForm(false);
        $('newKeyName').textContent = data.key.name;
        $('newKeySecret').textContent = data.secret;
        $('newKeyExample').textContent = keyExample(data.key.scope, data.secret);
        $('newKeyResult').classList.remove('hidden');
        await loadKeys();
    } catch (error) {
        $('keyNameError').textContent = 'Could not reach the server.';
    } finally {
        $('createKeyButton').disabled = false;
    }
}

async function revokeKey(id, name) {
    if (!confirm(`Revoke "${name}"?\n\nAnything using this key stops working immediately. This can't be undone.`)) return;
    const { response, data } = await apiJson(`/api/keys/${id}`, { method: 'DELETE' });
    if (!response.ok) alert(data.error || 'Could not revoke the key.');
    revealedKeys.delete(id);
    await loadKeys();
}

async function deleteKey(id, name) {
    if (!confirm(`Delete "${name}"?\n\nIt is already revoked; this removes it from the list for good. Its SMS messages are kept.`)) return;
    const { response, data } = await apiJson(`/api/keys/${id}?permanent=true`, { method: 'DELETE' });
    if (!response.ok) alert(data.error || 'Could not delete the key.');
    await loadKeys();
}

// --- API reference ---

function renderApiReference() {
    const base = location.origin;
    const host = location.hostname;
    const port = smtpInfo.smtpPort;
    $('smtpAddress').textContent = `${host}:${port}`;
    $('smtpAuthNote').textContent = smtpInfo.smtpAuthRequired
        ? `Login required${smtpInfo.smtpUsername ? ` (user "${smtpInfo.smtpUsername}", password from SMTP_PASSWORD in .env)` : ''}`
        : 'No login needed (any credentials are accepted)';
    $('smtpEncryptionNote').textContent = smtpInfo.smtpStartTls
        ? `STARTTLS is available on this port${smtpInfo.smtpTlsPort ? `, and TLS from the first byte on port ${smtpInfo.smtpTlsPort}` : ''}. With a self-signed certificate your client must skip verification (Nodemailer: tls: { rejectUnauthorized: false }). Plain SMTP works too.`
        : 'None. Use plain SMTP: secure: false and no STARTTLS (for Nodemailer, ignoreTLS: true). Set SMTP_TLS_KEY and SMTP_TLS_CERT on the server to offer TLS.';
    $('smtpRecipientsNote').textContent = smtpInfo.smtpAllowedDomains.length
        ? `Only mail for ${smtpInfo.smtpAllowedDomains.join(', ')}; any other recipient is refused with 550 (SMTP_ALLOWED_DOMAINS). Bcc recipients are recorded too (see "Also to")`
        : 'Any address is accepted, including ones that don\'t exist. Bcc recipients are recorded too (see "Also to")';
    $('simulateCard').classList.toggle('hidden', !smtpInfo.smtpSimulate);
    renderQuickSetup(base, host, port);
    $('nodemailerExample').textContent = [
        "const nodemailer = require('nodemailer');",
        '',
        'const transport = nodemailer.createTransport({',
        `  host: '${host}',`,
        `  port: ${port},`,
        '  secure: false,',
        ...(smtpInfo.smtpStartTls ? ['  tls: { rejectUnauthorized: false }, // self-signed certificate'] : ['  ignoreTLS: true,']),
        ...(smtpInfo.smtpAuthRequired ? ["  auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },"] : []),
        '});',
        "await transport.sendMail({ from: 'noreply@example.com', to: 'user@example.com', subject: 'Hello', text: 'Your code is 123456' });",
    ].join('\n');
    $('envExample').textContent = [
        `SMTP_HOST=${host}`,
        `SMTP_PORT=${port}`,
        'SMTP_SECURE=false   # plain SMTP, no TLS',
    ].join('\n');
    $('curlLatest').textContent = [
        'curl -H "Authorization: Bearer $API_KEY" \\',
        `  "${base}/api/emails/latest?to=user%40example.com"`,
    ].join('\n');
    $('jsLatest').textContent = [
        `const res = await fetch('${base}/api/emails/latest?to=user%40example.com', {`,
        '  headers: { Authorization: `Bearer ${process.env.API_KEY}` },',
        '});',
        'const { subject, code, links, text, html } = await res.json();',
        '// code: the detected one-time code, or null; links: every http(s) link in the email',
    ].join('\n');
}

// The "Quick setup" card: the values to paste into an app's SMS and SMTP configuration
function renderQuickSetup(base, host, port) {
    const smsBody = JSON.stringify({ sender: 'MyApp', phone: '+15551234567', message: 'Your OTP is 123456' });
    $('qsSmsUrl').textContent = `${base}/api/sms`;
    $('qsSmsBody').textContent = smsBody;
    $('qsSmsAll').textContent = [
        `URL: ${base}/api/sms`,
        'Method: POST',
        'Header: X-API-Key: <a Send key from the API keys page>',
        'Header: Content-Type: application/json',
        `Body: ${smsBody}`,
    ].join('\n');

    const security = smtpInfo.smtpStartTls
        ? `STARTTLS${smtpInfo.smtpTlsPort ? ` (or TLS on port ${smtpInfo.smtpTlsPort})` : ''}`
        : 'None (plain SMTP)';
    const username = smtpInfo.smtpUsername || '';
    $('qsSmtpHost').textContent = host;
    $('qsSmtpPort').textContent = String(port);
    $('qsSmtpSecurity').textContent = security;
    $('qsSmtpUserRow').classList.toggle('hidden', !smtpInfo.smtpAuthRequired || !username);
    $('qsSmtpPassRow').classList.toggle('hidden', !smtpInfo.smtpAuthRequired);
    $('qsSmtpUser').textContent = username;
    $('qsSmtpNote').textContent = smtpInfo.smtpAuthRequired
        ? ''
        : 'No login needed: any username and password (or none) is accepted.';
    $('qsSmtpNote').classList.toggle('hidden', smtpInfo.smtpAuthRequired);
    $('qsMailAll').textContent = [
        `Host: ${host}`,
        `Port: ${port}`,
        `Encryption: ${security}`,
        ...(smtpInfo.smtpAuthRequired ? [`Username: ${username || '<SMTP_USERNAME>'}`, 'Password: <SMTP_PASSWORD from the server .env>'] : ['Login: none needed']),
    ].join('\n');
}

// --- Wiring ---

window.addEventListener('DOMContentLoaded', () => {
    setSidebarCollapsed(readSetting('ms_sidebar_collapsed', 'no') === 'yes');
    renderApiReference();
    onFormInput();
    loadServerInfo();

    $('collapseButton').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
    $('logoutButton').addEventListener('click', logout);

    // Messages
    $('searchButton').addEventListener('click', filterMessages);
    $('searchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') filterMessages();
    });
    $('startDate').addEventListener('change', onDateChange);
    $('endDate').addEventListener('change', onDateChange);
    $('rangeSelect').addEventListener('change', event => setTimeRange(event.target.value));
    $('rangeChip').addEventListener('click', () => setTimeRange('all'));
    initPaneResizer('emailLayout', 'paneResizer');
    initSidebarResizer();
    $('resetFiltersButton').addEventListener('click', resetFilters);
    $('refreshButton').addEventListener('click', reloadCurrentPage);
    $('prevPage').addEventListener('click', () => changePage(-1));
    $('nextPage').addEventListener('click', () => changePage(1));
    $('pageSizeSelect').addEventListener('change', changePageSize);
    $('selectAllCheckbox').addEventListener('change', event => toggleSelectAll(event.target.checked));
    $('deleteSelectedButton').addEventListener('click', deleteSelectedMessages);
    $('exportSelectedButton').addEventListener('click', exportSelectedMessages);
    $('attachmentsInput').addEventListener('change', event => addAttachedFiles(Array.from(event.target.files)));
    // Copies the plain-text body, whatever view is showing
    $('copyMessageButton').addEventListener('click', event => {
        const email = fullEmails.get(selectedId);
        if (email) copyText(email.text || '', event.target);
    });
    $('copyCodeButton').addEventListener('click', event => copyText(event.target.dataset.code, event.target));
    document.addEventListener('keydown', event => {
        if (currentView() !== 'messages' || event.target.matches('input, textarea, select')) return;
        if (event.key === 'ArrowDown' || event.key === 'j') {
            event.preventDefault();
            moveSelection(1);
        } else if (event.key === 'ArrowUp' || event.key === 'k') {
            event.preventDefault();
            moveSelection(-1);
        }
    });

    // Send test
    $('messageForm').addEventListener('submit', sendMessage);
    $('clearFormButton').addEventListener('click', clearForm);
    $('sampleEmailButton').addEventListener('click', fillSampleEmail);
    TEST_FIELDS.forEach(field =>
        $(`${field}Input`).addEventListener('input', () => {
            setFieldError(field, '');
            onFormInput();
        })
    );

    // API keys
    $('newKeyButton').addEventListener('click', () => showKeyForm(true));
    $('cancelKeyButton').addEventListener('click', () => showKeyForm(false));
    $('newKeyForm').addEventListener('submit', createKey);
    // Only a Read key can be limited to some inboxes
    $('keyScopeInput').addEventListener('change', () => $('keyRecipientsField').classList.toggle('hidden', $('keyScopeInput').value !== 'read'));
    $('keyRecipientsInput').addEventListener('input', () => {
        $('keyRecipientsError').textContent = '';
        $('keyRecipientsInput').classList.remove('invalid');
    });
    $('keyNameInput').addEventListener('input', () => {
        $('keyNameError').textContent = '';
        $('keyNameInput').classList.remove('invalid');
    });
    $('copyNewKey').addEventListener('click', event => copyText($('newKeySecret').textContent, event.target));
    $('dismissKeyResult').addEventListener('click', () => $('newKeyResult').classList.add('hidden'));

    // API reference
    document.querySelectorAll('.copy-button').forEach(button =>
        button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button))
    );

    // Refresh the list when the tab regains focus
    window.addEventListener('focus', () => {
        if (currentView() === 'messages') reloadCurrentPage();
    });

    window.addEventListener('hashchange', showView);
    // Know the role before showing a view, so a viewer never lands on an admin-only page
    loadSession().then(() => {
        showView();
        startLiveUpdates();
    });
});
