const express = require('express');
const rateLimit = require('express-rate-limit');
const EmailController = require('../controllers/emailController');
const {
    validateListQuery,
    validateIdParam,
    validateBulkDelete,
    validateAttachmentParams,
    validateExportQuery,
    validateTestEmail,
} = require('../middleware/validate');

function createEmailRoutes({ emailModel, ingest, events, auth, config }) {
    const router = express.Router();
    const controller = new EmailController(emailModel, ingest, events, config);

    const testLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.apiRateLimit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down.' },
    });

    // Reading: a Read key, a viewer, or an admin
    router.get('/', auth.requireRead, validateListQuery, (req, res) => controller.getEmails(req, res));
    router.get('/latest', auth.requireRead, validateListQuery, (req, res) => controller.getLatestEmail(req, res));
    // A zip of .eml files, before /:id
    router.get('/export', auth.requireRead, validateExportQuery, (req, res) => controller.exportEmails(req, res));
    router.get('/wait', auth.requireRead, validateListQuery, (req, res) => controller.waitForEmail(req, res));
    router.get('/:id', auth.requireRead, validateIdParam, (req, res) => controller.getEmail(req, res));
    router.get('/:id/preview', auth.requireRead, validateIdParam, (req, res) => controller.getPreview(req, res));
    router.get('/:id/thread', auth.requireRead, validateIdParam, (req, res) => controller.getThread(req, res));
    router.get('/:id/raw', auth.requireRead, validateIdParam, (req, res) => controller.getRaw(req, res));
    router.get('/:id/attachments/:attachmentId', auth.requireRead, validateAttachmentParams, (req, res) =>
        controller.getAttachment(req, res)
    );

    // Adding a test email, deleting, and checking links (the server requests them): admin only
    router.post('/:id/check-links', auth.requireAdmin, validateIdParam, (req, res) => controller.checkEmailLinks(req, res));
    // The body may carry attachments, so it gets a bigger limit than the rest of the API, and only after the
    // caller is known to be an admin (server.js skips its small JSON parser for this path)
    router.post('/test', testLimiter, auth.requireAdmin, express.json({ limit: '8mb' }), validateTestEmail, (req, res) => controller.sendTest(req, res));
    router.delete('/', auth.requireAdmin, validateBulkDelete, (req, res) => controller.deleteEmails(req, res));
    router.delete('/:id', auth.requireAdmin, validateIdParam, (req, res) => controller.deleteEmails(req, res));

    return router;
}

module.exports = createEmailRoutes;
