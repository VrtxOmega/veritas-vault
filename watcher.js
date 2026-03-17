/**
 * VERITAS VAULT — Filesystem Watcher
 * ════════════════════════════════════════════════════════════════
 * Deep chokidar watcher on Antigravity root with event routing.
 */

const path = require('path');

const EXCLUDE_DIRS = new Set([
    '__pycache__', '.git', '.venv', 'venv', 'node_modules',
    '.pytest_cache', '.mypy_cache', 'dist', 'build', '.eggs',
    '.tox', 'htmlcov', '.idea', '.vs', '.system_generated',
    'tempmediaStorage',
]);

function createWatcher({ archivist, journal, getMainWindow, isQuitting }) {
    let watcher = null;

    function start(rootDir, relPathRoot) {
        const pathRoot = relPathRoot || rootDir;
        const chokidar = require('chokidar');
        watcher = chokidar.watch(rootDir, {
            ignored: (filePath) => {
                const base = path.basename(filePath);
                if (EXCLUDE_DIRS.has(base)) return true;
                if (base.startsWith('.') && base !== '.gemini' && !base.endsWith('.metadata.json')) return true;
                if (filePath.endsWith('.pb')) return true;
                return false;
            },
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
            depth: 10,
        });

        const handleEvent = (event, filePath) => {
            if (isQuitting()) return;
            try {
                if (journal) journal.invalidateCache();
                const mainWindow = getMainWindow();
                const canSend = mainWindow && !mainWindow.isDestroyed();

                if (event === 'unlink') {
                    archivist.handleFileRemoval(filePath, pathRoot);
                    if (canSend) {
                        mainWindow.webContents.send('vault:capture-event', {
                            event: 'unlink',
                            path: path.relative(pathRoot, filePath).replace(/\\/g, '/'),
                            timestamp: Date.now(),
                        });
                    }
                } else {
                    const result = archivist.ingestFile(filePath, pathRoot);
                    if (result && canSend) {
                        mainWindow.webContents.send('vault:capture-event', {
                            event, ...result,
                            path: path.relative(pathRoot, filePath).replace(/\\/g, '/'),
                            timestamp: Date.now(),
                        });
                    }
                }
            } catch (e) {
                console.error(`[Vault] ${event} error:`, e.message);
            }
        };

        watcher.on('add', (fp) => handleEvent('add', fp));
        watcher.on('change', (fp) => handleEvent('change', fp));
        watcher.on('unlink', (fp) => handleEvent('unlink', fp));
        console.log(`[Vault] Watching: ${rootDir}`);
    }

    function stop() {
        if (watcher) { try { watcher.close(); } catch (e) { console.warn('[Watcher] Close error:', e.message); } }
    }

    return { start, stop };
}

module.exports = createWatcher;
