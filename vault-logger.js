/**
 * VERITAS VAULT — Structured Logger
 * ════════════════════════════════════════════════════════════════
 * File-based logging with daily rotation, 7-day retention.
 * Tees all output to both console and log file.
 *
 * Usage:
 *   const logger = require('./vault-logger');
 *   logger.init(dataDir);            // call once at startup
 *   logger.info('Module', 'msg');     // [INFO]  [Module] msg
 *   logger.warn('Module', 'msg');     // [WARN]  [Module] msg
 *   logger.error('Module', 'msg');    // [ERROR] [Module] msg
 */

const fs = require('fs');
const path = require('path');

const LOG_RETENTION_DAYS = 7;
let _logDir = null;
let _logStream = null;
let _currentDate = null;

function init(dataDir) {
    _logDir = path.join(dataDir, 'logs');
    if (!fs.existsSync(_logDir)) fs.mkdirSync(_logDir, { recursive: true });

    _openStream();
    _rotateOldLogs();

    // Intercept console methods so existing console.log/warn/error calls
    // throughout the codebase also write to the log file automatically.
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => {
        origLog.apply(console, args);
        _writeLine('INFO', args.map(String).join(' '));
    };
    console.warn = (...args) => {
        origWarn.apply(console, args);
        _writeLine('WARN', args.map(String).join(' '));
    };
    console.error = (...args) => {
        origError.apply(console, args);
        _writeLine('ERROR', args.map(String).join(' '));
    };
}

function _today() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function _openStream() {
    const date = _today();
    if (_logStream && date === _currentDate) return; // already open for today

    if (_logStream) {
        try { _logStream.end(); } catch { /* ignore */ }
    }

    _currentDate = date;
    const logPath = path.join(_logDir, `vault-${date}.log`);
    _logStream = fs.createWriteStream(logPath, { flags: 'a' });
    _logStream.on('error', () => { /* prevent crash on disk-full etc */ });
}

function _writeLine(level, message) {
    if (!_logStream) return;

    // Roll over to new file if date changed
    const today = _today();
    if (today !== _currentDate) _openStream();

    const ts = new Date().toISOString();
    const line = `${ts} [${level.padEnd(5)}] ${message}\n`;
    try { _logStream.write(line); } catch { /* non-fatal */ }
}

function _rotateOldLogs() {
    if (!_logDir) return;
    try {
        const files = fs.readdirSync(_logDir)
            .filter(f => f.startsWith('vault-') && f.endsWith('.log'))
            .sort()
            .reverse();

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
        const cutoffStr = cutoff.toISOString().split('T')[0];

        for (const file of files) {
            const dateStr = file.replace('vault-', '').replace('.log', '');
            if (dateStr < cutoffStr) {
                fs.unlinkSync(path.join(_logDir, file));
            }
        }
    } catch (e) {
        // Can't log rotation errors to file (chicken-egg), use stderr
        process.stderr.write(`[Logger] Rotation error: ${e.message}\n`);
    }
}

// Explicit structured log methods (for new code or when you want module tagging)
function info(module, message) { console.log(`[${module}] ${message}`); }
function warn(module, message) { console.warn(`[${module}] ${message}`); }
function error(module, message) { console.error(`[${module}] ${message}`); }

function close() {
    if (_logStream) {
        try { _logStream.end(); } catch { /* ignore */ }
        _logStream = null;
    }
}

module.exports = { init, info, warn, error, close };
