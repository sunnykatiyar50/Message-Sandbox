const { logToFile } = require('../utils/logger');

// Every driver module exports a connect() function that resolves to the same adapter shape:
// { dialect, all(sql, params), run(sql, params) -> changed rows, insert(sql, params) -> id, close() }
// SQL passed to the adapter always uses "?" placeholders.
async function initializeDatabase() {
    const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase();
    logToFile(`Using database type: ${dbType}`);

    if (dbType === 'postgres') return require('./postgres')();
    if (dbType === 'mysql') return require('./mysql')();
    return require('./sqlite')();
}

module.exports = initializeDatabase;
