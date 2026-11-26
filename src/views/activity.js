// The Activity page (admin only): the audit trail and error list from GET /api/activity, so the log file
// doesn't have to be opened. Loaded after scripts.js, whose helpers it uses ($, el, apiJson, formatMessageTime,
// currentView, userRole). Everything is rendered with textContent, never as HTML.

const ACTIVITY_REFRESH_MS = 15 * 1000;
const ACTIVITY_BADGE_MS = 60 * 1000;
const ACTIVITY_CATEGORY_LABELS = {
    auth: 'Sign-in',
    keys: 'API keys',
    smtp: 'SMTP',
    tls: 'TLS',
    ratelimit: 'Rate limit',
    webhook: 'Webhook',
    relay: 'Relay',
    settings: 'Settings',
    system: 'Server',
};

let activityPage = 1;
let activityTotalPages = 1;
let activityIp = ''; // set by clicking an address
let activityTimer = null;

function activityParams(page) {
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    const filters = {
        level: $('activityLevel').value,
        category: $('activityCategory').value,
        search: $('activitySearch').value.trim(),
        ip: activityIp,
    };
    for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
    return params;
}

function activityRow(event) {
    const tr = el('tr', 'activity-row');
    const time = el('td', 'muted', formatMessageTime(event.timestamp));
    time.title = new Date(event.timestamp).toLocaleString();
    tr.appendChild(time);

    const level = el('td');
    level.appendChild(el('span', `level-badge level-${event.level}`, event.level));
    tr.appendChild(level);

    tr.appendChild(el('td', 'muted', ACTIVITY_CATEGORY_LABELS[event.category] || event.category));

    // Long messages (stack traces) show their first line; a click opens the whole text
    const lines = event.message.split('\n');
    const first = lines[0].length > 240 ? `${lines[0].slice(0, 239)}…` : lines[0];
    const message = el('td', 'activity-message', first);
    if (lines.length > 1 || first !== lines[0]) {
        message.classList.add('expandable');
        message.title = 'Click to show the whole message';
        message.addEventListener('click', () => {
            const open = message.classList.toggle('open');
            message.textContent = open ? event.message : first;
        });
    }
    tr.appendChild(message);

    const ip = el('td');
    if (event.ip) {
        const button = el('button', 'ip-link', event.ip);
        button.type = 'button';
        button.title = 'Show only this address';
        button.addEventListener('click', () => activityFilterIp(event.ip));
        ip.appendChild(button);
    }
    tr.appendChild(ip);
    tr.appendChild(el('td', 'muted', event.actor || ''));
    return tr;
}

async function activityLoad(page = 1) {
    try {
        const { response, data } = await apiJson(`/api/activity?${activityParams(page)}`);
        if (!response.ok) throw new Error(data.error || response.statusText);
        activityPage = data.currentPage;
        activityTotalPages = data.totalPages;
        const body = $('activityBody');
        body.replaceChildren(...data.events.map(activityRow));
        $('activityEmpty').classList.toggle('hidden', data.events.length > 0);
        document.querySelector('.activity-table').classList.toggle('hidden', data.events.length === 0);
        $('activityPageInfo').textContent = `Page ${activityPage} of ${activityTotalPages} · ${data.totalEvents} event${data.totalEvents === 1 ? '' : 's'}`;
        $('activityPrev').disabled = activityPage <= 1;
        $('activityNext').disabled = activityPage >= activityTotalPages;
        $('activityFootnote').textContent = '';
    } catch (error) {
        $('activityFootnote').textContent = `Could not load activity: ${error.message}`;
    }
}

async function activityLoadSummary() {
    try {
        const { response, data } = await apiJson('/api/activity/summary');
        if (!response.ok) throw new Error(data.error || response.statusText);
        $('activityRetention').textContent = data.retentionDays ? `Kept for ${data.retentionDays} day${data.retentionDays === 1 ? '' : 's'}.` : 'Kept until cleared.';
        $('activityErrors').textContent = data.levels.error;
        $('activityWarnings').textContent = data.levels.warn;
        $('activityNoIps').classList.toggle('hidden', data.topIps.length > 0);
        $('activityTopIps').replaceChildren(
            ...data.topIps.map(entry => {
                const li = el('li');
                const button = el('button', 'ip-link', entry.ip);
                button.type = 'button';
                button.title = `Last seen ${new Date(entry.lastSeen).toLocaleString()}`;
                button.addEventListener('click', () => activityFilterIp(entry.ip));
                li.append(button, el('span', 'muted', ` ×${entry.count}`));
                return li;
            })
        );
        activityMarkSeen();
    } catch {
        // the page stays as it was; the list shows its own error
    }
}

// The sidebar badge counts errors since Activity was last opened (in this browser), so it clears once you have looked
const ACTIVITY_SEEN_KEY = 'activitySeenAt';

function activityMarkSeen() {
    try {
        localStorage.setItem(ACTIVITY_SEEN_KEY, new Date().toISOString());
    } catch {
        // storage unavailable: the badge falls back to the last 24 hours
    }
    activityUpdateBadge(0);
}

function activitySeenAt() {
    try {
        return localStorage.getItem(ACTIVITY_SEEN_KEY) || '';
    } catch {
        return '';
    }
}

function activityUpdateBadge(errors) {
    const badge = $('activityBadge');
    badge.textContent = errors > 99 ? '99+' : String(errors);
    badge.classList.toggle('hidden', !errors);
}

// The sidebar badge counts errors from the last 24 hours, so a problem shows even when this page isn't open
async function activityRefreshBadge() {
    if (userRole !== 'admin' || document.hidden) return;
    if (currentView() === 'activity') return activityMarkSeen();
    try {
        const since = activitySeenAt();
        const { response, data } = await apiJson(`/api/activity/summary${since ? `?since=${encodeURIComponent(since)}` : ''}`);
        if (response.ok) activityUpdateBadge(data.levels.error);
    } catch {
        // ignore: the badge keeps its last value
    }
}

function activityFilterIp(ip) {
    activityIp = ip;
    $('activityIpChipText').textContent = ip;
    $('activityIpFilter').classList.remove('hidden');
    activityLoad(1);
}

function activityClearIp() {
    activityIp = '';
    $('activityIpFilter').classList.add('hidden');
    activityLoad(1);
}

async function activityClear() {
    if (!window.confirm('Delete all recorded activity? This cannot be undone.')) return;
    const { response, data } = await apiJson('/api/activity', { method: 'DELETE' });
    if (!response.ok) {
        $('activityFootnote').textContent = `Could not clear activity: ${data.error || response.statusText}`;
        return;
    }
    activityLoad(1);
    activityLoadSummary();
}

// Called by showView() each time the page opens. It refreshes itself while it stays open.
function activityShow() {
    activityMarkSeen();
    activityLoad(1);
    activityLoadSummary();
    if (activityTimer) return;
    activityTimer = setInterval(() => {
        if (currentView() !== 'activity' || document.hidden) return;
        activityLoad(activityPage);
        activityLoadSummary();
    }, ACTIVITY_REFRESH_MS);
}

window.addEventListener('DOMContentLoaded', () => {
    $('activitySearchButton').addEventListener('click', () => activityLoad(1));
    $('activitySearch').addEventListener('keydown', event => {
        if (event.key === 'Enter') activityLoad(1);
    });
    $('activityLevel').addEventListener('change', () => activityLoad(1));
    $('activityCategory').addEventListener('change', () => activityLoad(1));
    $('activityRefreshButton').addEventListener('click', () => {
        activityLoad(activityPage);
        activityLoadSummary();
    });
    $('activityIpChip').addEventListener('click', activityClearIp);
    $('activityPrev').addEventListener('click', () => activityLoad(activityPage - 1));
    $('activityNext').addEventListener('click', () => activityLoad(activityPage + 1));
    $('activityClearButton').addEventListener('click', activityClear);
    setTimeout(activityRefreshBadge, 2000);
    setInterval(activityRefreshBadge, ACTIVITY_BADGE_MS);
});
