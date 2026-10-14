// Normalises a database timestamp (Date from PostgreSQL/MySQL, ISO text from SQLite) to an ISO string
function toIso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

module.exports = { toIso };
