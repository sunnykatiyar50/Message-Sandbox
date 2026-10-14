const { logToFile } = require('../utils/logger');
const { maskPhoneNumber } = require('../utils/mask');
const { extractOtp } = require('../utils/otp');
const { waitForMatch, CLIENT_GONE } = require('../utils/longPoll');

// Only metadata is logged; message bodies (often OTPs) never reach the log file
const describe = ({ phone, message }) => `phone=${maskPhoneNumber(phone)} length=${message.length}`;

class SmsController {
    constructor(smsModel, ingestSms, events) {
        this.smsModel = smsModel;
        this.ingestSms = ingestSms;
        this.events = events;
    }

    // Adds the detected one-time code and masks the phone number unless asked not to
    present(message, unmask) {
        return {
            ...message,
            phone: unmask ? message.phone : maskPhoneNumber(message.phone),
            code: extractOtp(message.message),
        };
    }

    async sendSms(req, res) {
        const { sender, phone, message } = req.validated;
        const apiKeyName = req.auth.apiKeyName;
        const { id, timestamp } = await this.ingestSms({ sender, phone, message, apiKeyName });
        logToFile(`Stored SMS id=${id} key=${apiKeyName} ${describe({ phone, message })}`);
        res.status(201).json({ success: true, id, timestamp, message: 'Message sent successfully' });
    }

    async getMessages(req, res) {
        const { page, pageSize, filters, unmask } = req.listQuery;
        const { total, messages } = await this.smsModel.list({
            ...filters,
            limit: pageSize,
            offset: (page - 1) * pageSize,
        });
        res.status(200).json({
            messages: messages.map(m => this.present(m, unmask)),
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            totalMessages: total,
            currentPage: page,
        });
    }

    async getLatestMessage(req, res) {
        const { filters, unmask } = req.listQuery;
        const message = await this.smsModel.latest(filters);
        if (!message) return res.status(404).json({ error: 'No matching message found.' });
        return res.status(200).json(this.present(message, unmask));
    }

    // Long poll for E2E tests: answers as soon as a message matching the filters exists (including one that is
    // already stored), or with 408 after `timeout` seconds. Use `after`, or a unique phone number per test, so
    // an older message isn't picked up.
    async waitForMessage(req, res) {
        const { filters, unmask, timeout } = req.listQuery;
        const result = await waitForMatch({
            events: this.events,
            name: 'sms',
            find: () => this.smsModel.latest(filters),
            seconds: timeout,
            res,
        });
        if (result === CLIENT_GONE) return undefined;
        if (!result) return res.status(408).json({ error: `No matching message arrived within ${timeout} seconds.` });
        return res.status(200).json(this.present(result, unmask));
    }

    async deleteMessages(req, res) {
        const { ids, filters } = req.validated;
        if (filters) {
            const deleted = await this.smsModel.deleteMatching(filters);
            logToFile(`Cleared ${deleted} SMS message(s) for one phone number`);
            return res.status(200).json({ message: 'Messages deleted successfully.', deleted });
        }
        const deleted = await this.smsModel.deleteMany(ids);
        logToFile(`Deleted ${deleted} SMS message(s): ${ids.join(', ')}`);
        if (req.params.id !== undefined && deleted === 0) {
            return res.status(404).json({ error: 'Message not found.' });
        }
        return res.status(200).json({ message: 'Messages deleted successfully.', deleted });
    }
}

module.exports = SmsController;
