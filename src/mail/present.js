const { extractOtp } = require('../utils/otp');
const { extractLinks } = require('../utils/links');
const { analyzeEmail } = require('./analyze');

// The email as the API returns it. A full email (one with its attachment list) gets a download URL per
// attachment, the detected one-time code, the links found in the body, and the deliverability `checks`
// (see analyze.js). Summaries pass through unchanged.
function presentEmail(email) {
    const presented = { ...email };
    if (email.attachments) {
        presented.attachments = email.attachments.map(a => ({
            ...a,
            url: `/api/emails/${email.id}/attachments/${a.id}`,
        }));
        presented.code = extractOtp(email.text || '');
        presented.links = extractLinks(email.text, email.html);
        presented.checks = analyzeEmail(email);
    }
    return presented;
}

module.exports = { presentEmail };
