const CLIENT_GONE = Symbol('client gone');

// The long poll behind GET /api/emails/wait and GET /api/sms/wait. Calls find() (which resolves to a matching
// item or null) and, if there is none yet, again every time `events` emits `name`, until one turns up or
// `seconds` pass. Resolves to the item, to null on timeout, or to CLIENT_GONE if the caller hung up.
// Rejects if find() fails. Listeners and the timer are always cleaned up.
async function waitForMatch({ events, name, find, seconds, res }) {
    const existing = await find();
    if (existing) return existing;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            events.off(name, check);
            res.off('close', onClose);
            if (error) reject(error);
            else resolve(value);
        };
        const check = () =>
            find().then(
                item => item && finish(item),
                error => finish(null, error)
            );
        const onClose = () => finish(CLIENT_GONE);
        const timer = setTimeout(() => finish(null), seconds * 1000);
        events.on(name, check);
        res.on('close', onClose);
    });
}

module.exports = { waitForMatch, CLIENT_GONE };
