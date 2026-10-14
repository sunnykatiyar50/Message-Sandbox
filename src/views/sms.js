// The SMS section of the dashboard: the message list, the detail pane, and the SMS half of "Send test".
// Loaded after scripts.js, whose helpers it uses ($, apiFetch, el, copyText, timeRange, ...).
// Message data is always rendered with textContent, never as HTML.

let smsMessages = [];
let smsPage = 1;
let smsPageSize = 10;
let smsTotalPages = 1;
let smsSelectedId = null;
const smsFresh = new Set(); // ids that just arrived over the live stream; their rows flash once

// --- Utilities ---

// Visible text of an HTML message for the list preview. DOMParser documents are inert:
// scripts don't run and images aren't fetched.
function smsHtmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, head').forEach(node => node.remove());
    return doc.body ? doc.body.textContent : '';
}

function smsTruncate(message, maxLength = 120) {
    if (!message) return '';
    const singleLine = message.replace(/[\r\n]+/g, ' ').trim();
    return singleLine.length <= maxLength ? singleLine : singleLine.slice(0, maxLength - 1) + '…';
}

// --- Loading and rendering ---

function smsCurrentFilters() {
    return {
        search: $('smsSearchInput').value,
        startDate: $('smsStartDate').value,
        endDate: $('smsEndDate').value,
    };
}

async function smsLoad(page = 1, pageSizeParam = smsPageSize, search = '', startDate = '', endDate = '') {
    saveSetting('ms_sms_query', JSON.stringify({ page, pageSize: pageSizeParam, search, startDate, endDate }));
    try {
        const params = new URLSearchParams({ page, pageSize: pageSizeParam });
        if (search) params.set('search', search);
        if (startDate) params.set('after', localDayToIso(startDate));
        if (endDate) params.set('before', localDayToIso(endDate, true));
        // Relative ranges are recalculated on every load, so the window keeps sliding
        if (!startDate && !endDate && RANGES[timeRange]) {
            params.set('after', new Date(Date.now() - RANGES[timeRange].ms).toISOString());
        }

        const response = await apiFetch(`/api/sms?${params.toString()}`);
        if (!response.ok) throw new Error(response.statusText);
        const data = await response.json();
        smsMessages = data.messages || [];
        smsPage = data.currentPage || page;
        smsTotalPages = data.totalPages || 1;
        const filtered = Boolean(search || startDate || endDate || RANGES[timeRange]);
        $('smsInfo').textContent = `${data.totalMessages} ${filtered ? 'matching' : 'total'}`;
        if (!filtered) $('smsNavCount').textContent = data.totalMessages || '';
    } catch (error) {
        smsMessages = [];
        smsTotalPages = 1;
        $('smsInfo').textContent = 'Could not load messages';
    }
    smsRender();
    smsUpdatePagination();
}

async function smsReload() {
    const { search, startDate, endDate } = smsCurrentFilters();
    await smsLoad(smsPage, smsPageSize, search, startDate, endDate);
}

function smsRender() {
    const list = $('smsList');
    list.replaceChildren();
    $('smsSelectAll').checked = false;
    smsUpdateSelectionInfo();

    if (smsMessages.length === 0) {
        const filtered = Object.values(smsCurrentFilters()).some(Boolean) || Boolean(RANGES[timeRange]);
        list.appendChild(el('li', 'empty-state', filtered ? 'No messages match these filters.' : 'No messages yet. Send one from Send test, or call the API.'));
        smsShowDetails(null);
        return;
    }

    if (!smsMessages.some(m => m.id === smsSelectedId)) smsSelectedId = smsMessages[0].id;

    for (const msg of smsMessages) {
        const li = el('li', smsFresh.has(msg.id) ? 'message-row fresh' : 'message-row');
        li.dataset.id = String(msg.id);
        if (msg.id === smsSelectedId) li.classList.add('selected');
        li.addEventListener('click', event => {
            if (event.target.closest('.row-check')) return;
            smsSelect(msg.id);
        });

        const check = el('input', 'message-checkbox');
        check.type = 'checkbox';
        check.dataset.id = String(msg.id);
        check.setAttribute('aria-label', `Select message ${msg.id}`);
        check.addEventListener('change', smsUpdateSelectionInfo);
        const checkWrap = el('label', 'row-check admin-only');
        checkWrap.appendChild(check);

        const top = el('div', 'row-top');
        top.appendChild(el('span', 'row-sender', msg.sender || 'No sender'));
        top.appendChild(el('span', 'row-recipient mono', msg.phone || ''));
        top.appendChild(el('span', 'spacer'));
        const time = el('time', 'row-time', msg.timestamp ? formatMessageTime(msg.timestamp) : '');
        if (msg.timestamp) time.title = new Date(msg.timestamp).toLocaleString();
        top.appendChild(time);

        const body = el('div', 'row-body');
        body.appendChild(top);
        // Readable one-line preview (HTML as text, syslog as "app: message"); the format badge is only in the detail pane
        body.appendChild(el('div', 'row-text', smsTruncate(MessageFormat.previewText(msg.message || '', undefined, smsHtmlToText))));

        li.appendChild(checkWrap);
        li.appendChild(body);
        list.appendChild(li);
    }
    smsFresh.clear();
    smsShowDetails(smsMessages.find(m => m.id === smsSelectedId));
}

function smsSelect(id) {
    smsSelectedId = id;
    document.querySelectorAll('#smsList .message-row').forEach(row => row.classList.toggle('selected', row.dataset.id === String(id)));
    smsShowDetails(smsMessages.find(m => m.id === id));
}

function smsShowDetails(message) {
    $('smsDetailEmpty').classList.toggle('hidden', Boolean(message));
    $('smsDetailBody').classList.toggle('hidden', !message);
    if (!message) return;

    $('smsTitle').textContent = message.sender || 'No sender';
    $('smsKey').textContent = message.apiKeyName ? `via ${message.apiKeyName}` : '';
    $('smsKey').classList.toggle('hidden', !message.apiKeyName);
    $('smsTimestamp').textContent = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
    $('smsPhone').textContent = message.phone || '';
    $('smsLength').textContent = `${(message.message || '').length} characters`;

    // The server detects the code (see src/utils/otp.js) and returns it as `code`
    const code = message.code;
    $('smsCopyCode').classList.toggle('hidden', !code);
    $('smsCopyCode').textContent = code ? `Copy code ${code}` : 'Copy code';
    $('smsCopyCode').dataset.code = code || '';

    smsRenderBody(message);
}

// Renders the message as JSON / HTML / XML / syslog / text (see formatters.js) with a view switcher.
// The chosen view is remembered per format.
function smsRenderBody(message, view) {
    const text = message.message || '';
    const format = MessageFormat.detectFormat(text);
    const chosen = view || readSetting(`ms_sms_view_${format}`, '');
    const result = MessageFormat.renderMessage($('smsBody'), text, { view: chosen });

    $('smsFormatBadge').textContent = MessageFormat.LABELS[result.format];
    $('smsFormatBadge').dataset.format = result.format;
    const switcher = $('smsViewSwitch');
    switcher.replaceChildren();
    for (const name of result.views) {
        const button = el('button', name === result.view ? 'active' : '', MessageFormat.LABELS[name]);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(name === result.view));
        button.addEventListener('click', () => {
            saveSetting(`ms_sms_view_${result.format}`, name);
            smsRenderBody(message, name);
        });
        switcher.appendChild(button);
    }
}

// Up/down arrow keys move through the list
function smsMoveSelection(step) {
    const idx = smsMessages.findIndex(m => m.id === smsSelectedId);
    const next = smsMessages[idx + step];
    if (!next) return;
    smsSelect(next.id);
    const row = document.querySelector(`#smsList .message-row[data-id="${next.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
}

// --- Pagination, filters, selection ---

function smsUpdatePagination() {
    $('smsPrev').disabled = smsPage <= 1;
    $('smsNext').disabled = smsPage >= smsTotalPages;
    $('smsPageInfo').textContent = `${smsPage} / ${smsTotalPages}`;
}

async function smsChangePage(direction) {
    smsPage = Math.min(Math.max(1, smsPage + direction), smsTotalPages);
    await smsReload();
}

async function smsChangePageSize() {
    smsPageSize = parseInt($('smsPageSize').value, 10);
    smsPage = 1;
    await smsReload();
}

async function smsFilter() {
    smsPage = 1;
    await smsReload();
}

async function smsResetFilters() {
    $('smsSearchInput').value = '';
    $('smsStartDate').value = '';
    $('smsEndDate').value = '';
    timeRange = 'all';
    renderRange();
    await smsFilter();
}

// Picking dates in the toolbar switches the sidebar range to "Custom dates"
async function smsOnDateChange() {
    const hasDates = Boolean($('smsStartDate').value || $('smsEndDate').value);
    timeRange = hasDates ? 'custom' : 'all';
    renderRange();
    await smsFilter();
}

// Called when the SMS view is opened
function smsShow() {
    try {
        const saved = JSON.parse(readSetting('ms_sms_query', 'null'));
        if (saved) {
            $('smsSearchInput').value = saved.search || '';
            $('smsStartDate').value = saved.startDate || '';
            $('smsEndDate').value = saved.endDate || '';
            if (saved.pageSize) {
                smsPageSize = saved.pageSize;
                $('smsPageSize').value = saved.pageSize;
            }
            smsLoad(saved.page || 1, smsPageSize, saved.search || '', saved.startDate || '', saved.endDate || '');
            return;
        }
    } catch {
        // fall through: load all
    }
    smsLoad(1, smsPageSize);
}

function smsSelectedIds() {
    return Array.from(document.querySelectorAll('#smsList .message-checkbox:checked')).map(c => Number(c.dataset.id));
}

function smsUpdateSelectionInfo() {
    const count = smsSelectedIds().length;
    $('smsSelectionInfo').textContent = count ? `${count} selected` : '';
    $('smsDeleteSelected').disabled = count === 0;
    $('smsSelectAll').checked = count > 0 && count === smsMessages.length;
}

function smsToggleSelectAll(checked) {
    document.querySelectorAll('#smsList .message-checkbox').forEach(c => (c.checked = checked));
    smsUpdateSelectionInfo();
}

async function smsDeleteSelected() {
    const ids = smsSelectedIds();
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} message(s)? This can't be undone.`)) return;
    try {
        const response = await apiFetch('/api/sms', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        if (!response.ok) alert('Failed to delete the selected messages.');
        await smsReload();
    } catch (error) {
        alert('An error occurred while deleting the messages.');
    }
}

// A message arrived over the live stream (see startLiveUpdates in scripts.js)
let smsLiveTimer = 0;
function smsOnLiveEvent(event) {
    try {
        smsFresh.add(JSON.parse(event.data).id);
    } catch {
        // an unreadable event still triggers the reload
    }
    clearTimeout(smsLiveTimer);
    smsLiveTimer = setTimeout(() => {
        if (currentView() === 'sms') smsReload();
        else $('smsNavCount').textContent = String((Number($('smsNavCount').textContent) || 0) + smsFresh.size);
    }, 250);
}

// --- Send test (SMS) ---

const SMS_MAX_MESSAGE = 1600;
const SMS_PHONE_RE = /^\+?[0-9]{6,15}$/;
const SMS_FIELDS = ['sender', 'phone', 'message'];

// Rough SMS segment count: GSM-7 text fits 160 characters (153 per part when split),
// anything outside ASCII forces UCS-2 with 70 (67 per part)
function smsSegments(text) {
    if (!text) return 0;
    const unicode = /[^\x00-\x7F]/.test(text);
    const single = unicode ? 70 : 160;
    const multi = unicode ? 67 : 153;
    return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function smsFormValues() {
    return {
        sender: $('smsSenderInput').value.trim(),
        phone: $('smsPhoneInput').value.trim(),
        message: $('smsMessageInput').value,
    };
}

function smsUpdateCounter() {
    const text = $('smsMessageInput').value;
    const segments = smsSegments(text);
    $('smsMessageCounter').textContent = `${text.length} / ${SMS_MAX_MESSAGE}` + (segments ? ` · ${segments} SMS` : '');
}

// Shows the cURL command that would store the same message from outside the dashboard
function smsUpdateCurl() {
    const { sender, phone, message } = smsFormValues();
    const body = JSON.stringify({ sender: sender || undefined, phone: phone || '+15551234567', message: message || 'Your OTP is 123456' }, null, 2)
        .replace(/'/g, `'\\''`)
        .split('\n')
        .map((line, i) => (i === 0 ? line : `  ${line}`))
        .join('\n');
    $('smsEquivalentCurl').textContent = [
        `curl -X POST ${location.origin}/api/sms \\`,
        '  -H "Content-Type: application/json" \\',
        '  -H "X-API-Key: $SEND_KEY" \\',
        `  -d '${body}'`,
    ].join('\n');
}

function smsSetFieldError(field, message) {
    const name = field.charAt(0).toUpperCase() + field.slice(1);
    $(`sms${name}Error`).textContent = message || '';
    $(`sms${name}Input`).classList.toggle('invalid', Boolean(message));
}

function smsClearFieldErrors() {
    SMS_FIELDS.forEach(field => smsSetFieldError(field, ''));
}

// Same rules as the server, so most mistakes are caught before sending
function smsValidate({ sender, phone, message }) {
    const errors = {};
    if (sender.length > 64) errors.sender = 'At most 64 characters.';
    if (!SMS_PHONE_RE.test(phone.replace(/[\s\-.()]/g, ''))) errors.phone = '6–15 digits, optional leading +.';
    if (!message.trim()) errors.message = 'Enter a message.';
    else if (message.length > SMS_MAX_MESSAGE) errors.message = `At most ${SMS_MAX_MESSAGE} characters.`;
    return errors;
}

function smsSetFormStatus(text, kind) {
    $('smsFormStatus').textContent = text;
    $('smsFormStatus').className = `form-status${kind ? ` ${kind}` : ''}`;
}

function smsFillSample() {
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    if (!$('smsSenderInput').value) $('smsSenderInput').value = 'MyApp';
    if (!$('smsPhoneInput').value) $('smsPhoneInput').value = '+15551234567';
    $('smsMessageInput').value = `Your verification code is ${otp}. It expires in 10 minutes.`;
    smsClearFieldErrors();
    smsOnFormInput();
}

function smsOnFormInput() {
    smsUpdateCounter();
    smsUpdateCurl();
}

function smsClearForm() {
    $('smsForm').reset();
    smsClearFieldErrors();
    smsSetFormStatus('');
    smsOnFormInput();
}

async function smsSend(event) {
    event.preventDefault();
    const values = smsFormValues();
    smsClearFieldErrors();
    const errors = smsValidate(values);
    if (Object.keys(errors).length) {
        Object.entries(errors).forEach(([field, msg]) => smsSetFieldError(field, msg));
        smsSetFormStatus('Fix the highlighted fields.', 'error');
        return;
    }

    const button = $('smsSendButton');
    button.disabled = true;
    smsSetFormStatus('Sending…');
    try {
        const response = await apiFetch('/api/sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
        });
        const data = await response.json().catch(() => ({}));
        $('smsLastResponse').textContent = `HTTP ${response.status}\n${JSON.stringify(data, null, 2)}`;
        $('smsLastResponse').classList.remove('muted-code');

        if (response.ok) {
            smsSetFormStatus(`Stored as message #${data.id}.`, 'success');
            $('smsViewInMessages').classList.remove('hidden');
            smsSelectedId = data.id;
            smsPage = 1;
            // Keep sender and phone so several messages can be sent in a row
            $('smsMessageInput').value = '';
            smsOnFormInput();
            $('smsMessageInput').focus();
        } else if (data.details) {
            // Server messages read like "must be ..." / "is required"; prefix the field name
            Object.entries(data.details).forEach(([field, msg]) => {
                const label = field.charAt(0).toUpperCase() + field.slice(1);
                smsSetFieldError(field, `${label} ${msg}.`);
            });
            smsSetFormStatus('The server rejected the message. See the highlighted fields.', 'error');
        } else {
            smsSetFormStatus(`Failed to send: ${data.error || response.statusText}`, 'error');
        }
    } catch (error) {
        smsSetFormStatus('Could not reach the server.', 'error');
    } finally {
        button.disabled = false;
    }
}

// The Email | SMS switch on the Send test page
function setSendChannel(channel) {
    const sms = channel === 'sms';
    $('sendEmail').classList.toggle('hidden', sms);
    $('sendSms').classList.toggle('hidden', !sms);
    document.querySelectorAll('#sendChannel button').forEach(button => {
        const active = button.dataset.channel === (sms ? 'sms' : 'email');
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    saveSetting('ms_send_channel', sms ? 'sms' : 'email');
}

// Focus the first useful field of whichever form is showing
function focusSendForm() {
    if (readSetting('ms_send_channel', 'email') === 'sms') {
        ($('smsPhoneInput').value ? $('smsMessageInput') : $('smsSenderInput')).focus();
    } else {
        ($('toInput').value ? $('subjectInput') : $('toInput')).focus();
    }
}

// --- SMS API reference ---

function renderSmsApiReference() {
    const base = location.origin;
    $('smsEndpoint').textContent = `${base}/api/sms`;
    $('curlSmsSend').textContent = [
        `curl -X POST ${base}/api/sms \\`,
        '  -H "Content-Type: application/json" \\',
        '  -H "X-API-Key: $SEND_KEY" \\',
        "  -d '{",
        '    "sender": "MyApp",',
        '    "phone": "+15551234567",',
        '    "message": "Your OTP is 123456"',
        "  }'",
    ].join('\n');
    $('curlSmsLatest').textContent = [
        'curl -H "Authorization: Bearer $READ_KEY" \\',
        `  "${base}/api/sms/wait?phone=%2B15551234567&timeout=15"`,
    ].join('\n');
    $('jsSmsLatest').textContent = [
        `const res = await fetch('${base}/api/sms/wait?phone=%2B15551234567', {`,
        '  headers: { Authorization: `Bearer ${process.env.READ_KEY}` },',
        '});',
        'const { code, message } = await res.json(); // code: the detected OTP, or null',
    ].join('\n');
}

// --- Wiring ---

window.addEventListener('DOMContentLoaded', () => {
    renderSmsApiReference();
    smsOnFormInput();
    setSendChannel(readSetting('ms_send_channel', 'email'));
    document.querySelectorAll('#sendChannel button').forEach(button =>
        button.addEventListener('click', () => {
            setSendChannel(button.dataset.channel);
            focusSendForm();
        })
    );

    // List
    initPaneResizer('smsLayout', 'smsPaneResizer');
    $('smsSearchButton').addEventListener('click', smsFilter);
    $('smsSearchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') smsFilter();
    });
    $('smsStartDate').addEventListener('change', smsOnDateChange);
    $('smsEndDate').addEventListener('change', smsOnDateChange);
    $('smsResetButton').addEventListener('click', smsResetFilters);
    $('smsRefreshButton').addEventListener('click', smsReload);
    $('smsRangeChip').addEventListener('click', () => setTimeRange('all'));
    $('smsPrev').addEventListener('click', () => smsChangePage(-1));
    $('smsNext').addEventListener('click', () => smsChangePage(1));
    $('smsPageSize').addEventListener('change', smsChangePageSize);
    $('smsSelectAll').addEventListener('change', event => smsToggleSelectAll(event.target.checked));
    $('smsDeleteSelected').addEventListener('click', smsDeleteSelected);
    // Always copies the original text, whatever view is showing
    $('smsCopyMessage').addEventListener('click', event => {
        const message = smsMessages.find(m => m.id === smsSelectedId);
        if (message) copyText(message.message || '', event.target);
    });
    $('smsCopyCode').addEventListener('click', event => copyText(event.target.dataset.code, event.target));
    document.addEventListener('keydown', event => {
        if (currentView() !== 'sms' || event.target.matches('input, textarea, select')) return;
        if (event.key === 'ArrowDown' || event.key === 'j') {
            event.preventDefault();
            smsMoveSelection(1);
        } else if (event.key === 'ArrowUp' || event.key === 'k') {
            event.preventDefault();
            smsMoveSelection(-1);
        }
    });

    // Send test
    $('smsForm').addEventListener('submit', smsSend);
    $('smsClearButton').addEventListener('click', smsClearForm);
    $('smsSampleButton').addEventListener('click', smsFillSample);
    SMS_FIELDS.forEach(field => {
        const name = field.charAt(0).toUpperCase() + field.slice(1);
        $(`sms${name}Input`).addEventListener('input', () => {
            smsSetFieldError(field, '');
            smsOnFormInput();
        });
    });

    // Refresh the list when the tab regains focus
    window.addEventListener('focus', () => {
        if (currentView() === 'sms') smsReload();
    });
});
