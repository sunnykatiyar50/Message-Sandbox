// Recipient rules, written the same way wherever they are configured (SMTP_ALLOWED_DOMAINS, RELAY_ALLOW):
//
//   user@example.com   exactly this address
//   example.com        every address at this domain (also written @example.com or *@example.com)
//   *.example.com      every address at any subdomain of example.com (not example.com itself)
//
// All comparisons ignore case.

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LOCAL = /^[^\s@,;<>"]+$/;

// One rule: { type: 'address' | 'domain' | 'subdomains', value }. Throws on anything else.
function parseRule(text) {
    const entry = String(text).trim().toLowerCase();
    const bad = () => new Error(`"${text}" is not an address, a domain (example.com) or a subdomain wildcard (*.example.com)`);

    if (entry.startsWith('*.')) {
        const domain = entry.slice(2);
        if (!DOMAIN.test(domain)) throw bad();
        return { type: 'subdomains', value: domain };
    }
    const at = entry.lastIndexOf('@');
    if (at === -1) {
        if (!DOMAIN.test(entry)) throw bad();
        return { type: 'domain', value: entry };
    }
    const local = entry.slice(0, at);
    const domain = entry.slice(at + 1);
    if (!DOMAIN.test(domain)) throw bad();
    if (local === '' || local === '*') return { type: 'domain', value: domain };
    if (!LOCAL.test(local)) throw bad();
    return { type: 'address', value: entry };
}

// "a@x.com, example.org" -> [rule, ...]; an empty or missing list is []
function parseRules(list) {
    return String(list || '')
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(parseRule);
}

function matchesRule(rule, address) {
    const lower = String(address || '').toLowerCase();
    const at = lower.lastIndexOf('@');
    if (at === -1) return false;
    const domain = lower.slice(at + 1);
    if (rule.type === 'address') return lower === rule.value;
    if (rule.type === 'domain') return domain === rule.value;
    return domain.endsWith(`.${rule.value}`);
}

const matchesAny = (rules, address) => rules.some(rule => matchesRule(rule, address));

// Every address an email was sent to: To, Cc and the SMTP envelope (so Bcc too)
const recipientsOf = email => [
    ...(email.to || []).map(r => r.address),
    ...(email.cc || []).map(r => r.address),
    ...((email.envelope && email.envelope.to) || []),
];

// Whether an API key limited to `rules` may see the email; no rules means no limit
const visibleTo = (email, rules) => !rules || rules.length === 0 || recipientsOf(email).some(address => matchesAny(rules, address));

// The rule as it was written, for messages
const describeRule = rule => (rule.type === 'subdomains' ? `*.${rule.value}` : rule.value);

module.exports = { parseRule, parseRules, matchesRule, matchesAny, describeRule, recipientsOf, visibleTo };
