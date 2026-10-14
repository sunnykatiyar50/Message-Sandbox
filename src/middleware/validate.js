// Request validation. Each validator either stores the cleaned values on req or responds with 400.

const MAX_PAGE_SIZE = 100;
const MAX_BULK_DELETE = 500;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 120;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 255;
const MAX_BODY = 200000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 5 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SENDER = 64;
const MAX_SMS = 1600; // 10 concatenated SMS segments
const PHONE_RE = /^\+?[0-9]{6,15}$/;

// Strips the formatting characters people commonly put in phone numbers: spaces, dashes, dots, brackets
function normalizePhone(value) {
    return typeof value === 'string' ? value.replace(/[\s\-.()]/g, '') : value;
}

function badRequest(res, errors) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
}

// Parses a date-only value as the start of that day in UTC
function parseDay(value) {
    if (!DATE_RE.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// The paging, wait timeout and time window shared by the email and SMS list endpoints. The window is given
// either as after/before (ISO date-times, e.g. local midnight from the browser) or startDate/endDate
// (YYYY-MM-DD in UTC, endDate inclusive). Problems are collected in `errors`.
function readListQuery(req) {
    const q = req.query;
    const errors = {};
    const str = name => (typeof q[name] === 'string' ? q[name].trim() : '');

    const page = str('page') ? parseInt(str('page'), 10) : 1;
    if (!Number.isInteger(page) || page < 1) errors.page = 'must be a positive integer';

    const pageSize = str('pageSize') ? parseInt(str('pageSize'), 10) : 10;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        errors.pageSize = `must be between 1 and ${MAX_PAGE_SIZE}`;
    }

    // Only the /wait endpoints use it: how long to wait for a matching message
    const timeout = str('timeout') ? Number(str('timeout')) : DEFAULT_WAIT_SECONDS;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > MAX_WAIT_SECONDS) {
        errors.timeout = `must be between 1 and ${MAX_WAIT_SECONDS} seconds`;
    }

    let after = null;
    let before = null;
    if (str('after')) {
        after = parseDateTime(str('after'));
        if (!after) errors.after = 'must be an ISO date-time';
    } else if (str('startDate')) {
        after = parseDay(str('startDate'));
        if (!after) errors.startDate = 'must be YYYY-MM-DD';
    }
    if (str('before')) {
        before = parseDateTime(str('before'));
        if (!before) errors.before = 'must be an ISO date-time';
    } else if (str('endDate')) {
        before = parseDay(str('endDate'));
        if (!before) errors.endDate = 'must be YYYY-MM-DD';
        else before = new Date(before.getTime() + 24 * 60 * 60 * 1000); // inclusive end day
    }

    return { errors, str, page, pageSize, timeout, after, before };
}

// Email filters: search (anywhere in the email), to, from, subject, and the time window
function validateListQuery(req, res, next) {
    const { errors, str, page, pageSize, timeout, after, before } = readListQuery(req);
    if (Object.keys(errors).length) return badRequest(res, errors);
    req.listQuery = {
        page,
        pageSize,
        timeout,
        filters: {
            search: str('search').slice(0, 200),
            to: str('to').slice(0, 320),
            from: str('from').slice(0, 320),
            subject: str('subject').slice(0, 200),
            after,
            before,
        },
    };
    return next();
}

// SMS filters: search (text, phone number or sender), phone (exactly), the time window, and unmask=true for
// full phone numbers
function validateSmsQuery(req, res, next) {
    const { errors, str, page, pageSize, timeout, after, before } = readListQuery(req);
    if (Object.keys(errors).length) return badRequest(res, errors);
    req.listQuery = {
        page,
        pageSize,
        timeout,
        filters: {
            search: str('search').slice(0, 200),
            phone: str('phone') ? normalizePhone(str('phone')) : '',
            after,
            before,
        },
        unmask: str('unmask') === 'true',
    };
    return next();
}

function parseId(value) {
    const s = String(value);
    if (!/^[1-9][0-9]{0,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

function validateIdParam(req, res, next) {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(res, { id: 'must be a positive integer' });
    req.validated = { ids: [id], id };
    next();
}

// POST /api/sms: sender (optional), phone and message
function validateNewSms(req, res, next) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const errors = {};

    const sender = body.sender === undefined || body.sender === null ? '' : body.sender;
    if (typeof sender !== 'string' || sender.length > MAX_SENDER) {
        errors.sender = `must be a string of at most ${MAX_SENDER} characters`;
    }

    const phone = normalizePhone(body.phone);
    if (typeof phone !== 'string' || !PHONE_RE.test(phone)) {
        errors.phone = 'must be a phone number with 6-15 digits and an optional leading +';
    }

    const message = body.message;
    if (typeof message !== 'string' || message.trim() === '') {
        errors.message = 'is required';
    } else if (message.length > MAX_SMS) {
        errors.message = `must be at most ${MAX_SMS} characters`;
    }

    if (Object.keys(errors).length) return badRequest(res, errors);
    req.validated = { sender: sender.trim(), phone, message };
    return next();
}

// DELETE /api/sms: { "ids": [...] } in the body, or ?phone=... to empty one phone number's messages. Like the
// email equivalent, one of the two is required, so a bare DELETE never deletes everything.
function validateSmsDelete(req, res, next) {
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    if (!phone) return validateIdList(req, res, next);
    return validateSmsQuery(req, res, () => {
        req.validated = { filters: req.listQuery.filters };
        next();
    });
}

// GET /api/emails/export?ids=1,2,3
const MAX_EXPORT = 100;
function validateExportQuery(req, res, next) {
    const raw = typeof req.query.ids === 'string' ? req.query.ids.split(',').map(s => s.trim()).filter(Boolean) : [];
    const ids = raw.map(parseId);
    if (raw.length === 0 || raw.length > MAX_EXPORT || ids.includes(null)) {
        return badRequest(res, { ids: `must be 1-${MAX_EXPORT} email ids separated by commas` });
    }
    req.validated = { ids: [...new Set(ids)] };
    next();
}

function validateAttachmentParams(req, res, next) {
    const id = parseId(req.params.id);
    const attachmentId = parseId(req.params.attachmentId);
    if (id === null || attachmentId === null) return badRequest(res, { id: 'must be positive integers' });
    req.validated = { id, attachmentId };
    next();
}

function validateIdList(req, res, next) {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE) {
        return badRequest(res, { ids: `must be an array of 1-${MAX_BULK_DELETE} ids` });
    }
    const parsed = ids.map(parseId);
    if (parsed.includes(null)) return badRequest(res, { ids: 'must contain only positive integers' });
    req.validated = { ids: [...new Set(parsed)] };
    next();
}

// DELETE /api/emails: either { "ids": [...] } in the body, or a recipient in the query (?to=user@example.com,
// optionally narrowed by the other filters) to empty one inbox. Never "delete everything": without ids,
// a `to` address is required.
function validateBulkDelete(req, res, next) {
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    if (!to) return validateIdList(req, res, next);
    validateListQuery(req, res, () => {
        req.validated = { filters: req.listQuery.filters };
        next();
    });
}

// "a@x.com, b@x.com" -> ['a@x.com', 'b@x.com'] (duplicates removed)
const addressList = value => [...new Set((typeof value === 'string' ? value : '').split(/[,;\s]+/).map(a => a.trim()).filter(Boolean))];
const validAddresses = list => list.length <= MAX_RECIPIENTS && list.every(a => EMAIL_RE.test(a));

// Attachments arrive as [{ filename, contentType?, content: base64 }]; returns { attachments } or { error }
function parseAttachments(value) {
    if (value === undefined || value === null) return { attachments: [] };
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return { error: `must be a list of at most ${MAX_ATTACHMENTS} files` };
    const attachments = [];
    let total = 0;
    for (const item of value) {
        const filename = item && typeof item.filename === 'string' ? item.filename.trim() : '';
        // No path separators or control characters: the name ends up in message headers
        if (!filename || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename)) {
            return { error: 'every file needs a name of at most 255 characters, without slashes or control characters' };
        }
        const encoded = item && typeof item.content === 'string' ? item.content.replace(/\s+/g, '') : null;
        if (encoded === null || !BASE64.test(encoded)) return { error: `"${filename}" must be sent as base64` };
        const content = Buffer.from(encoded, 'base64');
        if (content.length > MAX_ATTACHMENT_BYTES) return { error: `"${filename}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` };
        total += content.length;
        const contentType = typeof item.contentType === 'string' && MEDIA_TYPE.test(item.contentType) ? item.contentType : 'application/octet-stream';
        attachments.push({ filename, contentType, content });
    }
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) return { error: `the files together are larger than ${MAX_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024} MB` };
    return { attachments };
}

// The dashboard's "Send test" form: from, to / cc / bcc (comma separated), subject, text and/or html, attachments
function validateTestEmail(req, res, next) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const errors = {};
    const text = typeof body.text === 'string' ? body.text : '';
    const html = typeof body.html === 'string' ? body.html : '';
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const fromName = typeof body.fromName === 'string' ? body.fromName.trim() : '';

    if (!EMAIL_RE.test(from)) errors.from = 'must be an email address';
    // Control characters would let a value inject extra headers
    if (fromName.length > 64 || /[\r\n"<>]/.test(fromName)) errors.fromName = 'must be at most 64 characters, without quotes, < > or line breaks';

    const to = addressList(body.to);
    const cc = addressList(body.cc);
    const bcc = addressList(body.bcc);
    if (to.length === 0 || !validAddresses(to)) errors.to = `must be 1-${MAX_RECIPIENTS} email addresses separated by commas`;
    if (!validAddresses(cc)) errors.cc = `must be at most ${MAX_RECIPIENTS} email addresses separated by commas`;
    if (!validAddresses(bcc)) errors.bcc = `must be at most ${MAX_RECIPIENTS} email addresses separated by commas`;

    if (subject.length > MAX_SUBJECT || /[\r\n]/.test(subject)) errors.subject = `must be one line of at most ${MAX_SUBJECT} characters`;
    if (!text.trim() && !html.trim()) errors.text = 'or html is required';
    if (text.length > MAX_BODY) errors.text = `must be at most ${MAX_BODY} characters`;
    if (html.length > MAX_BODY) errors.html = `must be at most ${MAX_BODY} characters`;

    const { attachments, error } = parseAttachments(body.attachments);
    if (error) errors.attachments = error;

    if (Object.keys(errors).length) return badRequest(res, errors);
    req.validated = { from, fromName, to, cc, bcc, subject, text, html, attachments };
    next();
}

module.exports = {
    validateListQuery,
    validateSmsQuery,
    validateNewSms,
    validateSmsDelete,
    normalizePhone,
    validateIdParam,
    validateIdList,
    validateBulkDelete,
    validateAttachmentParams,
    validateExportQuery,
    validateTestEmail,
};
