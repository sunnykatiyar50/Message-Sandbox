const crypto = require('crypto');
const { createSessionToken, verifySessionToken, safeEqual, parseCookies } = require('../utils/session');
const { logToFile } = require('../utils/logger');

const SESSION_COOKIE = 'ms_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Who can do what:
//   admin  (ADMIN_USERNAME sign-in, ADMIN_TOKEN, or AUTH_DISABLED)       everything
//   viewer (VIEWER_USERS sign-in)                                        view emails and SMS only
//   Send key (created in the dashboard)                                  POST /api/sms
//   Read key (created in the dashboard)                                  read emails and SMS (GET /api/emails, /api/sms, ...)
//   Read key limited to some recipients                                  read only the emails sent to them; no SMS
// Email itself arrives over SMTP, which has its own optional credentials (SMTP_USERNAME / SMTP_PASSWORD).
function createAuth(config, { apiKeyModel } = {}) {
    const ttlMs = config.sessionTtlHours * 60 * 60 * 1000;

    const accounts = [
        { username: config.adminUsername, password: config.adminPassword, role: 'admin' },
        ...config.viewerUsers.map(u => ({ username: u.username, password: u.password, role: 'viewer' })),
    ];

    // Stored in the session so that changing an account's password in .env signs it out.
    // An HMAC keyed with SESSION_SECRET, so the (readable) cookie reveals nothing about the password.
    const passwordFingerprint = password =>
        crypto.createHmac('sha256', config.sessionSecret).update(`password:${password}`).digest('base64url').slice(0, 22);

    // "Authorization: Bearer <token>"; the scheme name is case-insensitive (RFC 9110)
    const bearerToken = req => {
        const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.get('authorization') || '');
        return match ? match[1] : '';
    };

    // The signed-in dashboard account, if the session cookie is valid and still matches .env:
    // the account must still exist with the same role and password.
    function sessionAccount(req) {
        const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
        const session = token && verifySessionToken(token, config.sessionSecret);
        if (!session) return null;
        const account = accounts.find(a => a.username === session.u && a.role === session.r);
        if (!account || !safeEqual(session.p || '', passwordFingerprint(account.password))) return null;
        return account;
    }

    // Who is making the request (apart from API keys): { role: 'admin' | 'viewer', method, username } or null.
    // method is 'disabled', 'bearer' (ADMIN_TOKEN) or 'cookie' (dashboard session).
    function currentUser(req) {
        if (config.authDisabled) return { role: 'admin', method: 'disabled', username: null };
        const bearer = bearerToken(req);
        if (config.adminToken && bearer && safeEqual(bearer, config.adminToken)) {
            return { role: 'admin', method: 'bearer', username: null };
        }
        const account = sessionAccount(req);
        return account ? { role: account.role, method: 'cookie', username: account.username } : null;
    }

    // Cookie-authenticated writes must carry a custom header. Browsers cannot add it to a
    // cross-site request without a CORS preflight (which this server never approves), so this blocks CSRF.
    function passesCsrfCheck(req, method) {
        return method !== 'cookie' || SAFE_METHODS.has(req.method) || req.get('x-requested-with') === 'fetch';
    }

    // Finds the API key a request presents: X-API-Key, or Authorization: Bearer for clients that can't
    // set custom headers. Returns { name, scope } or null.
    async function findApiKey(req) {
        const presented = req.get('x-api-key') || bearerToken(req);
        if (!presented || !apiKeyModel) return null;
        const stored = await apiKeyModel.authenticate(presented);
        return stored ? { name: stored.name, scope: stored.scope, allowedRecipients: stored.allowedRecipients } : null;
    }

    function requireAdmin(req, res, next) {
        const user = currentUser(req);
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        if (user.role !== 'admin') return res.status(403).json({ error: 'This needs an admin account' });
        if (!passesCsrfCheck(req, user.method)) return res.status(403).json({ error: 'Missing X-Requested-With header' });
        req.auth = { ...user, isAdmin: true };
        next();
    }

    // An admin, a viewer (reading only), or an API key with the given scope
    function requireKeyOrUser(scope) {
        return async (req, res, next) => {
            const user = currentUser(req);
            if (user) {
                if (user.role === 'viewer' && scope !== 'read') {
                    return res.status(403).json({ error: 'Viewer accounts can only view messages' });
                }
                if (!passesCsrfCheck(req, user.method)) return res.status(403).json({ error: 'Missing X-Requested-With header' });
                req.auth = { ...user, apiKeyName: 'dashboard', isAdmin: user.role === 'admin' };
                return next();
            }
            const key = await findApiKey(req);
            if (!key) {
                const presented = req.get('x-api-key') || bearerToken(req);
                return res.status(401).json({ error: presented ? 'Invalid or revoked API key' : 'Missing API key' });
            }
            if (key.scope !== scope) {
                return res.status(403).json({ error: `This key can't be used here (needs a ${scope} key)` });
            }
            // recipientScope: the inboxes this key is limited to (rules from utils/recipients.js), or null for all
            req.auth = {
                method: 'apiKey',
                apiKeyName: key.name,
                scope: key.scope,
                isAdmin: false,
                recipientScope: key.allowedRecipients && key.allowedRecipients.length ? key.allowedRecipients : null,
            };
            next();
        };
    }

    // SMS has no inboxes to limit a key to, so a Read key limited to some email recipients can't read it
    function forbidRecipientLimit(req, res, next) {
        if (req.auth && req.auth.recipientScope) {
            return res.status(403).json({ error: 'This key is limited to some email inboxes and cannot read SMS' });
        }
        return next();
    }

    function cookieOptions(req) {
        return {
            httpOnly: true,
            sameSite: 'strict',
            secure: req.secure,
            path: '/',
        };
    }

    function login(req, res) {
        if (config.authDisabled) return res.json({ success: true, role: 'admin' });
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ error: 'Enter your username and password' });
        }
        // Compare against every account, both fields, so the response time doesn't reveal
        // whether a username exists or which field was wrong
        let match = null;
        for (const account of accounts) {
            const userOk = safeEqual(username.trim(), account.username);
            const passOk = safeEqual(password, account.password);
            if (userOk && passOk && !match) match = account;
        }
        if (!match) {
            logToFile(`Failed dashboard login from ${req.ip}`);
            return res.status(401).json({ error: 'Incorrect username or password' });
        }
        const token = createSessionToken(config.sessionSecret, ttlMs, {
            u: match.username,
            r: match.role,
            p: passwordFingerprint(match.password),
        });
        res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: ttlMs });
        logToFile(`Dashboard login: "${match.username}" (${match.role}) from ${req.ip}`);
        res.json({ success: true, role: match.role });
    }

    function logout(req, res) {
        res.clearCookie(SESSION_COOKIE, cookieOptions(req));
        res.json({ success: true });
    }

    function status(req, res) {
        const user = currentUser(req);
        res.json({
            authenticated: Boolean(user),
            authDisabled: config.authDisabled,
            username: user ? user.username : null,
            role: user ? user.role : null,
        });
    }

    return {
        currentUser,
        requireAdmin,
        requireIngest: requireKeyOrUser('send'),
        forbidRecipientLimit,
        requireRead: requireKeyOrUser('read'),
        login,
        logout,
        status,
    };
}

module.exports = { createAuth, SESSION_COOKIE };
