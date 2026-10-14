const fs = require('fs');
const path = require('path');

const logDir = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const logFile = path.join(logDir, 'app.log');
const logToConsole = process.env.NODE_ENV !== 'test';

// File logging switches itself off (with one warning) if the directory or file can't be written,
// e.g. a read-only or root-owned mount; everything still goes to stdout.
let fileLogging = process.env.LOG_TO_FILE !== 'false';

function disableFileLogging(error) {
    fileLogging = false;
    console.error(
        `Logging to stdout only: cannot write ${logFile} (${error.code || error.message}). ` +
        'Check that the log directory is writable, or set LOG_TO_FILE=false to silence this.'
    );
}

if (fileLogging) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (error) {
        disableFileLogging(error);
    }
}

// Rotate log file daily: move previous log to logs/app-YYYY-MM-DD.log if date changed
function rotateLogFileIfNeeded() {
    if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        const lastModified = new Date(stats.mtime);
        const today = new Date();
        const lastDate = lastModified.toISOString().slice(0, 10);
        const todayDate = today.toISOString().slice(0, 10);
        if (lastDate !== todayDate) {
            const archiveFile = path.join(logDir, `app-${lastDate}.log`);
            fs.renameSync(logFile, archiveFile);
        }
    }
}

// Logging utility. Newlines are escaped so a value cannot forge extra log entries.
function logToFile(message) {
    const line = `[${new Date().toISOString()}] ${String(message).replace(/[\r\n]+/g, '\\n')}`;
    if (logToConsole) console.log(line);
    if (!fileLogging) return;
    try {
        rotateLogFileIfNeeded();
        fs.appendFileSync(logFile, `${line}\n`);
    } catch (error) {
        disableFileLogging(error);
    }
}

module.exports = { logToFile };
