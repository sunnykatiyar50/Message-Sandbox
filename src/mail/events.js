const { EventEmitter } = require('events');

// In-process notifications: the ingest emits 'email' (with the new email's id) after storing a message,
// which wakes up requests waiting in GET /api/emails/wait.
function createEvents() {
    const events = new EventEmitter();
    events.setMaxListeners(0); // one listener per waiting request
    return events;
}

module.exports = { createEvents };
