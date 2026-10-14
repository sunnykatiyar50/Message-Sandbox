// Finds the one-time code (OTP) in an email, or returns null.
//
// Candidates are numeric codes (4-8 digits), codes split by a space or dash ("123 456", "123-456"),
// prefixed codes ("G-123456") and alphanumeric codes ("AB12CD"). Each candidate is scored by how
// close it is to an OTP keyword; amounts, dates, times, phone numbers and decimals are skipped.

const KEYWORDS = [
    'otp', 'one[-\\s]?time', 'code', 'passcode', 'pass code', 'password', 'pin', 'verification',
    'verify', 'token', 'security', 'auth', 'login', 'sign[-\\s]?in',
    'código', 'codigo', 'clave', 'contraseña', 'mot de passe', 'kennwort', 'passwort',
    'код', 'пароль', 'ओटीपी', 'कोड', 'पासवर्ड', '验证码', '驗證碼', '认证码', '確認コード', '認証コード', '인증번호',
];
const KEYWORD_RE = new RegExp(KEYWORDS.join('|'), 'giu');

// Text right before a number that marks it as money, e.g. "Rs. 5,000", "$1200", "INR 4500"
const CURRENCY_BEFORE = /(?:rs\.?|inr|usd|eur|gbp|aed|sgd|\$|€|£|₹|¥)\s*$/i;
// Text right before a number that marks it as an identifier, e.g. "order #7788", "txn 5566", "Ref no 9988"
const IDENTIFIER_BEFORE = /(?:#|\b(?:order|txn|transaction|trans|ref(?:erence)?|invoice|inv|ticket|booking|pnr|a\/c|acct|account(?:\s+ending)?|card(?:\s+ending)?|id|no\.?|number|port|pid|uid|gid|line|version|ver|v)\s*(?:no\.?|number|id)?\s*[:#.]?\s*#?)\s*$/i;
// Text right after a number that marks it as something other than a code
const UNIT_AFTER = /^\s*(?:%|rs\b|inr\b|usd\b|eur\b|mins?\b|minutes?\b|hrs?\b|hours?\b|seconds?\b|secs?\b|days?\b|kg\b|km\b|gb\b|mb\b)/i;

const PATTERNS = [
    // "G-123456" (Google style): the digits are the code
    { re: /\b[A-Z]{1,3}-(\d{4,8})(?![\d-])/g, kind: 'prefixed' },
    // Letter-and-digit groups joined by dashes, e.g. "AB12-CD34": copied whole
    { re: /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])([A-Z0-9]{2,6}(?:-[A-Z0-9]{2,6})+)\b/g, kind: 'grouped' },
    // "123 456" / "123-456" / "1234 5678"
    { re: /(?<![\d+\-./:,])(\d{3,4})[ -](\d{3,4})(?![\d\-/:]|[.,]\d)/g, kind: 'split' },
    // Plain 4-8 digit run
    { re: /(?<![\d+\-./:,])(\d{4,8})(?![\d\-/:]|[.,]\d)/g, kind: 'digits' },
    // Alphanumeric, 4-10 characters, at least one digit and one uppercase letter
    { re: /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])([A-Z0-9]{4,10})\b/g, kind: 'alnum' },
];

function findCandidates(text) {
    const candidates = [];
    for (const { re, kind } of PATTERNS) {
        re.lastIndex = 0;
        for (const match of text.matchAll(re)) {
            const start = match.index;
            const end = start + match[0].length;
            // Earlier patterns win where matches overlap (e.g. "123 456" over "123")
            if (candidates.some(c => start < c.end && end > c.start)) continue;
            const value = kind === 'split' ? match[1] + match[2] : match[1];
            candidates.push({ value, kind, start, end });
        }
    }
    return candidates;
}

function isExcluded(text, { start, end, kind, value }) {
    const before = text.slice(Math.max(0, start - 24), start);
    const after = text.slice(end, end + 10);
    if (CURRENCY_BEFORE.test(before) || IDENTIFIER_BEFORE.test(before) || UNIT_AFTER.test(after)) return true;
    // Process IDs and similar bracketed numbers, e.g. "sshd[1234]:"
    if (/\[$/.test(before) && /^\]/.test(after)) return true;
    // A 4-digit year with no other reason to be a code
    if (kind === 'digits' && value.length === 4 && /^(19|20)\d\d$/.test(value)) return 'year';
    return false;
}

function keywordDistance(keywords, { start, end }) {
    let best = Infinity;
    for (const k of keywords) {
        if (k.end <= start) best = Math.min(best, start - k.end); // keyword before the code
        else if (k.start >= end) best = Math.min(best, (k.start - end) * 1.2); // after: slightly weaker
        else best = 0;
    }
    return best;
}

function extractOtp(text) {
    if (typeof text !== 'string' || !text) return null;

    const keywords = [];
    KEYWORD_RE.lastIndex = 0;
    for (const match of text.matchAll(KEYWORD_RE)) {
        keywords.push({ start: match.index, end: match.index + match[0].length });
    }

    const scored = [];
    for (const candidate of findCandidates(text)) {
        const excluded = isExcluded(text, candidate);
        if (excluded === true) continue;

        const distance = keywordDistance(keywords, candidate);
        let score = 0;
        if (distance <= 30) score += 10 - distance / 5;
        else if (distance <= 80) score += 3;
        if (candidate.kind === 'digits' && candidate.value.length === 6) score += 3;
        else if (candidate.kind !== 'alnum' && candidate.kind !== 'grouped') score += 1;
        // Letter codes need a nearby keyword, so words like "COVID19" or "MH12-AB" aren't picked
        if ((candidate.kind === 'alnum' || candidate.kind === 'grouped') && distance > 30) score -= 5;
        if (excluded === 'year') score -= 6;
        scored.push({ ...candidate, score, distance });
    }
    if (scored.length === 0) return null;

    scored.sort((a, b) => b.score - a.score || a.start - b.start);
    const best = scored[0];
    // Without a nearby keyword, only trust a lone 6-digit number
    if (best.distance > 30) {
        const plainSix = scored.filter(c => c.kind === 'digits' && c.value.length === 6);
        return plainSix.length === 1 && scored.length === 1 ? plainSix[0].value : null;
    }
    return best.value;
}

module.exports = { extractOtp };
