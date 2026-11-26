const express = require('express');
const { SettingsError } = require('../settings/settings');
const { record } = require('../utils/activity');

// The Settings page's API. Admin only, so an admin token works for scripts as well as the dashboard.
function createSettingsRoutes({ settings, auth }) {
    const router = express.Router();

    router.get('/', auth.requireAdmin, (req, res) => {
        res.json(settings.describe());
    });

    // { "changes": { "SMS_RATE_LIMIT": "200", "RETENTION_DAYS": null } }: a value stores it, null goes back to
    // .env (or the default). All or nothing: one invalid value rejects the whole request.
    router.put('/', auth.requireAdmin, async (req, res) => {
        const changes = req.body && req.body.changes;
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
            return res.status(400).json({ error: 'Send { "changes": { "SETTING_NAME": "value" } }; null resets a setting' });
        }
        const actor = req.auth.username || (req.auth.method === 'bearer' ? 'admin token' : null);
        try {
            const changed = await settings.set(changes, { actor });
            for (const { key, from, to, source, sensitive } of changed) {
                const what = source === 'database' ? (sensitive ? 'changed' : `changed from "${from}" to "${to}"`) : `reset to ${source === 'env' ? '.env' : 'the default'}${sensitive ? '' : ` ("${to}")`}`;
                record({ category: 'settings', ip: req.ip, actor, message: `Setting ${key} ${what} by ${actor || 'admin'} from ${req.ip}` });
            }
            res.json({ ...settings.describe(), changed: changed.map(c => c.key) });
        } catch (error) {
            if (error instanceof SettingsError) return res.status(400).json({ error: error.message, details: error.details });
            throw error;
        }
    });

    return router;
}

module.exports = createSettingsRoutes;
