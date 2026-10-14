// Masks every character except the last 4 digits, e.g. +15551234567 -> ********4567
function maskPhoneNumber(phone) {
    if (typeof phone !== 'string' || phone.length <= 4) return phone;
    return '*'.repeat(phone.length - 4) + phone.slice(-4);
}

module.exports = { maskPhoneNumber };
