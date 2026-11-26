const express = require('express');
const { validateActivityQuery } = require('../middleware/validate');
const record = require('../utils/activity').record;

const DAY_MS = 24 * 60 * 60 * 1000;

// The audit trail and error list for the dashboard's Activity page. Admin only: it holds addresses and user
// names, and an admin token works for scripts as well as the signed-in dashboard.
function createActivityRoutes({ activityModel, auth, config }) {
    const router = express.Router();

    router.get('/', auth.requireAdmin, validateActivityQuery, async (req, res) => {
        const { page, pageSize, filters } = req.listQuery;
        const { total, events } = await activityModel.list({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
        res.json({
            events,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            totalEvents: total,
            currentPage: page,
        });
    });

    // Counts by level and the addresses behind the most warnings and errors, for the last 24 hours
    router.get('/summary', auth.requireAdmin, async (req, res) => {
        // ?since=<ISO date-time> narrows the window (never wider than 24 hours); the sidebar badge uses it
        let from = new Date(Date.now() - DAY_MS);
        const since = new Date(String(req.query.since || ''));
        if (!Number.isNaN(since.getTime()) && since > from) from = since;
        res.json({ ...(await activityModel.summary(from)), retentionDays: config.activityRetentionDays });
    });

    router.delete('/', auth.requireAdmin, async (req, res) => {
        const deleted = await activityModel.clear();
        record({ category: 'system', message: `Activity log cleared (${deleted} event(s)) by ${req.auth.username || 'admin'} from ${req.ip}`, ip: req.ip, actor: req.auth.username });
        res.json({ deleted });
    });

    return router;
}

module.exports = createActivityRoutes;
