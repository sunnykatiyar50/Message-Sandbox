const express = require('express');
const rateLimit = require('express-rate-limit');
const SmsController = require('../controllers/smsController');
const {
    validateNewSms,
    validateSmsQuery,
    validateIdParam,
    validateSmsDelete,
} = require('../middleware/validate');

function createSmsRoutes({ smsModel, ingestSms, events, auth, config }) {
    const router = express.Router();
    const controller = new SmsController(smsModel, ingestSms, events);

    const ingestLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.smsRateLimit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many messages, slow down.' },
    });

    // Submit a message: a Send key, or an admin (the dashboard's test form)
    router.post('/', ingestLimiter, auth.requireIngest, validateNewSms, (req, res) => controller.sendSms(req, res));

    // Reading: a Read key without a recipient limit (those only read email), a viewer, or an admin
    router.get('/', auth.requireRead, auth.forbidRecipientLimit, validateSmsQuery, (req, res) => controller.getMessages(req, res));
    router.get('/latest', auth.requireRead, auth.forbidRecipientLimit, validateSmsQuery, (req, res) => controller.getLatestMessage(req, res));
    router.get('/wait', auth.requireRead, auth.forbidRecipientLimit, validateSmsQuery, (req, res) => controller.waitForMessage(req, res));

    // Deleting: admin only, by id or for one phone number (?phone=)
    router.delete('/', auth.requireAdmin, validateSmsDelete, (req, res) => controller.deleteMessages(req, res));
    router.delete('/:id', auth.requireAdmin, validateIdParam, (req, res) => controller.deleteMessages(req, res));

    return router;
}

module.exports = createSmsRoutes;
