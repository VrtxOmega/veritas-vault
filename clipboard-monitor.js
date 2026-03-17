/**
 * VERITAS VAULT — Clipboard Monitor
 * ════════════════════════════════════════════════════════════════
 * 2s polling clipboard with SHA-256 dedup, size cap, and rate limiting.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MAX_CLIPBOARD_SIZE = 100000; // 100KB max capture
const CLIPBOARD_RATE_WINDOW = 60000; // 1 minute window
const CLIPBOARD_RATE_MAX = 10; // max 10 captures per window

function createClipboardMonitor({ clipboard, archivist, getMainWindow, clipboardDir, dataDir }) {
    let interval = null;
    let lastClipHash = null;
    let rateLog = [];

    function start() {
        if (!fs.existsSync(clipboardDir)) fs.mkdirSync(clipboardDir, { recursive: true });
        interval = setInterval(() => {
            try {
                const text = clipboard.readText();
                if (!text || text.length < 50) return;

                // Size cap
                if (text.length > MAX_CLIPBOARD_SIZE) return;

                // Rate limiter
                const now = Date.now();
                rateLog = rateLog.filter(t => now - t < CLIPBOARD_RATE_WINDOW);
                if (rateLog.length >= CLIPBOARD_RATE_MAX) return;

                const hash = crypto.createHash('sha256').update(text).digest('hex');
                if (hash === lastClipHash) return;
                lastClipHash = hash;
                rateLog.push(now);

                const ts = new Date();
                const filename = `clip_${ts.toISOString().replace(/[:.]/g, '-')}.md`;
                const filePath = path.join(clipboardDir, filename);
                fs.writeFileSync(filePath, `---\ncaptured: ${ts.toISOString()}\nsource: clipboard\nhash: ${hash}\n---\n\n${text}`, 'utf-8');

                const result = archivist.ingestFile(filePath, dataDir);
                const mainWindow = getMainWindow();
                if (result && mainWindow) {
                    mainWindow.webContents.send('vault:capture-event', {
                        event: 'clipboard', ...result,
                        path: `clipboard_captures/${filename}`,
                        timestamp: Date.now(),
                    });
                }
            } catch (e) { /* silent */ }
        }, 2000);
    }

    function stop() {
        if (interval) { clearInterval(interval); interval = null; }
    }

    function isRunning() { return interval !== null; }

    return { start, stop, isRunning };
}

module.exports = createClipboardMonitor;
