/**
 * VERITAS VAULT — Main Process (Orchestrator)
 * ════════════════════════════════════════════════════════════════
 * Background-listening, auto-organizing AI interaction notebook.
 * 
 * Architecture (modular):
 *   • db.js           — SQLite CAS + MiniSearch full-text index
 *   • archivist.js    — Ingest pipeline, chunking, classification
 *   • watcher.js      — Deep filesystem watcher (chokidar)
 *   • capture-server.js — HTTP capture server (Chrome extension relay)
 *   • clipboard-monitor.js — Clipboard polling with rate limiting
 *   • journal.js      — Daily digests, audit chain, KI management
 *   • vault-ai.js     — AI operations (Ollama)
 *   • vault-rag.js    — RAG chat engine (embeddings + retrieval)
 *   • followup-engine.js — Smart follow-up detection
 * 
 * Examina omnia, venerare nihil, pro te cogita.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Domain modules
const { initDatabase, closeDatabase, getDbPath, dbAll, dbGet, dbRun, dbLastId, saveDb, scheduleSave, searchDocuments, updateSearchEntry, removeSearchEntry } = require('./db');
const createArchivist = require('./archivist');
const createWatcher = require('./watcher');
const createCaptureServer = require('./capture-server');
const createClipboardMonitor = require('./clipboard-monitor');
const createJournalEngine = require('./journal');
const vaultRAG = require('./vault-rag');
const followupEngine = require('./followup-engine');
const vaultLogger = require('./vault-logger');

// Prevent EPIPE crashes when parent terminal dies
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return;
    console.error('[Vault] Uncaught:', err);
});


// ══════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════

const ANTIGRAVITY_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
let DATA_DIR, DB_PATH, SETTINGS_PATH, CLIPBOARD_DIR, CAPTURES_DIR;


// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════

let mainWindow = null;
let tray = null;
let isQuitting = false;
let store = null;
let journal = null;
let archivist = null;
let fileWatcher = null;
let captureServer = null;
let clipboardMonitor = null;
let _followUpCache = [];
let _followUpTimer = null;
let _ragRebuildTimer = null;

/** Debounced RAG rebuild — waits 30s after last capture before rebuilding */
function scheduleRAGRebuild() {
    if (_ragRebuildTimer) clearTimeout(_ragRebuildTimer);
    _ragRebuildTimer = setTimeout(async () => {
        _ragRebuildTimer = null;
        try {
            console.log('[Vault] Auto-rebuilding RAG index after capture...');
            const result = await vaultRAG.buildIndex((pct, msg) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('vault:rag-progress', { pct, msg });
                }
            });
            console.log(`[Vault] RAG auto-rebuild complete: ${result?.chunks || 0} chunks`);
        } catch (e) {
            console.error('[Vault] RAG auto-rebuild error:', e.message);
        }
    }, 30000); // 30s debounce
}

function initPaths() {
    DATA_DIR = path.join(app.getPath('userData'), 'vault_data');
    DB_PATH = path.join(DATA_DIR, 'vault.db');
    SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
    CLIPBOARD_DIR = path.join(DATA_DIR, 'clipboard_captures');
    CAPTURES_DIR = path.join(DATA_DIR, 'captures');
}

// ── Data Backup ──────────────────────────────────────────────
function autoBackup() {
    try {
        if (!fs.existsSync(DB_PATH)) return;
        const backupDir = path.join(DATA_DIR, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const backupPath = path.join(backupDir, `vault-${timestamp}.db`);
        const latestPath = path.join(DATA_DIR, 'vault.db.bak');

        // Always keep latest .bak
        fs.copyFileSync(DB_PATH, latestPath);

        // Daily backup (skip if today's already exists)
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(DB_PATH, backupPath);
            console.log(`[Vault] Auto-backup: ${backupPath}`);
        }

        // Rotate: keep last 7 daily backups
        const backups = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('vault-') && f.endsWith('.db'))
            .sort()
            .reverse();
        for (const old of backups.slice(7)) {
            fs.unlinkSync(path.join(backupDir, old));
            console.log(`[Vault] Rotated old backup: ${old}`);
        }
    } catch (e) {
        console.error('[Vault] Auto-backup error:', e.message);
    }
}


// ══════════════════════════════════════════════════════════════
// SETTINGS STORE
// ══════════════════════════════════════════════════════════════

class SettingsStore {
    constructor(defaults = {}) {
        this._path = SETTINGS_PATH;
        this._data = { ...defaults };
        try {
            if (fs.existsSync(this._path)) {
                this._data = { ...defaults, ...JSON.parse(fs.readFileSync(this._path, 'utf-8')) };
            }
        } catch (e) { /* use defaults */ }
    }
    store() { fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2)); }
    get(key) { return this._data[key]; }
    set(key, value) { this._data[key] = value; this.store(); }
    all() { return { ...this._data }; }
    merge(obj) { Object.assign(this._data, obj); this.store(); }
}


// ══════════════════════════════════════════════════════════════
// WINDOW / TRAY
// ══════════════════════════════════════════════════════════════

const WINDOW_STATE_FILE = () => path.join(DATA_DIR, 'window-state.json');

function loadWindowState() {
    try {
        const raw = fs.readFileSync(WINDOW_STATE_FILE(), 'utf-8');
        const state = JSON.parse(raw);
        const { screen } = require('electron');
        const displays = screen.getAllDisplays();
        const onScreen = displays.some(d => {
            const b = d.bounds;
            return state.x >= b.x && state.x < b.x + b.width &&
                state.y >= b.y && state.y < b.y + b.height;
        });
        if (!onScreen) return null;
        return state;
    } catch { return null; }
}

function saveWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const bounds = mainWindow.getBounds();
        const isMax = mainWindow.isMaximized();
        fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify({
            x: bounds.x, y: bounds.y,
            width: bounds.width, height: bounds.height,
            isMaximized: isMax,
        }), 'utf-8');
    } catch { /* silent */ }
}

function createWindow() {
    return new Promise((resolve) => {
        const iconPath = path.join(__dirname, 'veritas_vault_icon.png');
        const saved = loadWindowState();
        const opts = {
            width: saved?.width || 1400,
            height: saved?.height || 900,
            minWidth: 900,
            minHeight: 600,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#0D0D0D',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
            },
            icon: iconPath,
            show: false,
        };
        if (saved?.x != null) { opts.x = saved.x; opts.y = saved.y; }

        mainWindow = new BrowserWindow(opts);
        if (saved?.isMaximized) mainWindow.maximize();
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
            resolve();
        });

        // Persist window state on resize/move (debounced)
        let stateTimer = null;
        const debouncedSave = () => {
            if (stateTimer) clearTimeout(stateTimer);
            stateTimer = setTimeout(saveWindowState, 500);
        };
        mainWindow.on('resize', debouncedSave);
        mainWindow.on('move', debouncedSave);
        mainWindow.on('maximize', debouncedSave);
        mainWindow.on('unmaximize', debouncedSave);

        mainWindow.on('close', (e) => {
            if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
        });

        // Crash recovery logging
        mainWindow.webContents.on('render-process-gone', (_, details) => {
            console.error('[Vault] Renderer crashed:', details.reason);
        });
        mainWindow.webContents.on('unresponsive', () => {
            console.warn('[Vault] Window unresponsive — corpus scan may be blocking');
        });
        mainWindow.webContents.on('responsive', () => {
            console.log('[Vault] Window responsive again');
        });
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'veritas_vault_icon.png');
    let trayIcon;
    try {
        trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } catch {
        trayIcon = nativeImage.createFromBuffer(createTrayIconBuffer()).resize({ width: 16, height: 16 });
    }
    tray = new Tray(trayIcon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Veritas Vault', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: 'separator' },
        { label: `Watching: ${ANTIGRAVITY_ROOT}`, enabled: false },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);

    tray.setToolTip('Veritas Vault — Capturing');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        if (mainWindow) {
            if (mainWindow.isVisible()) mainWindow.hide();
            else { mainWindow.show(); mainWindow.focus(); }
        }
    });
}

function createTrayIconBuffer() {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const border = x === 0 || x === size - 1 || y === 0 || y === size - 1;
            const inner = x >= 5 && x <= 10 && y >= 5 && y <= 10;
            buf[i] = (border || inner) ? 0xD4 : 0x0D;
            buf[i + 1] = (border || inner) ? 0xAF : 0x0D;
            buf[i + 2] = (border || inner) ? 0x37 : 0x0D;
            buf[i + 3] = 0xFF;
        }
    }
    return buf;
}


// ══════════════════════════════════════════════════════════════
// IPC HANDLERS
// ══════════════════════════════════════════════════════════════

function registerIPC() {
    // Window controls
    ipcMain.on('window-minimize', () => mainWindow?.minimize());
    ipcMain.on('window-maximize', () => {
        if (mainWindow?.isMaximized()) mainWindow.unmaximize();
        else mainWindow?.maximize();
    });
    ipcMain.on('window-close', () => { isQuitting = true; app.quit(); });
    ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

    // File Tree
    ipcMain.handle('vault:file-tree', () => {
        const rows = dbAll(`
            SELECT rel_path, type, title, size_bytes, modified_at, conversation_id, topic
            FROM documents ORDER BY type, rel_path
        `);
        const tree = {};
        for (const row of rows) {
            const parts = row.rel_path.split('/');
            let node = tree;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!node[parts[i]]) node[parts[i]] = {};
                node = node[parts[i]];
            }
            node[parts[parts.length - 1]] = { _file: true, ...row };
        }
        return tree;
    });

    // Read File
    ipcMain.handle('vault:read-file', (_, relPath) => {
        const normalized = relPath.replace(/\.\./g, '').replace(/\\/g, '/');
        const doc = dbGet('SELECT abs_path, type, title FROM documents WHERE rel_path = ?', [normalized]);
        if (!doc) return null;
        try {
            const content = fs.readFileSync(doc.abs_path, 'utf-8');
            return { content, type: doc.type, title: doc.title, path: normalized };
        } catch { return null; }
    });

    // Search (MiniSearch inverted index)
    ipcMain.handle('vault:search', (_, query) => {
        return searchDocuments(query);
    });

    // Stats
    ipcMain.handle('vault:stats', () => {
        const docCount = dbGet('SELECT COUNT(*) as c FROM documents')?.c || 0;
        const chunkCount = dbGet('SELECT COUNT(*) as c FROM chunks')?.c || 0;
        const types = dbAll('SELECT type, COUNT(*) as c FROM documents GROUP BY type');
        const dbPath = getDbPath();
        const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
        const recentCaptures = dbAll(`
            SELECT d.rel_path, d.type, d.title, t.event, t.timestamp
            FROM timeline t LEFT JOIN documents d ON d.id = t.doc_id
            ORDER BY t.timestamp DESC LIMIT 20
        `);
        return { documents: docCount, chunks: chunkCount, types, dbSizeKB: Math.round(dbSize / 1024), recentCaptures };
    });

    // Timeline
    ipcMain.handle('vault:timeline', (_, days = 7) => {
        const since = (Date.now() / 1000) - (days * 86400);
        return dbAll(`
            SELECT t.event, t.detail, t.timestamp, d.type, d.title
            FROM timeline t LEFT JOIN documents d ON d.id = t.doc_id
            WHERE t.timestamp > ? ORDER BY t.timestamp DESC
        `, [since]);
    });

    // Settings
    ipcMain.handle('vault:get-settings', () => store.all());
    ipcMain.handle('vault:set-settings', (_, settings) => { store.merge(settings); return store.all(); });

    // Watch Directories
    ipcMain.handle('vault:get-watch-dirs', () => store.get('watchDirs') || [ANTIGRAVITY_ROOT]);
    ipcMain.handle('vault:add-watch-dir', (_, dirPath) => {
        const dirs = store.get('watchDirs') || [ANTIGRAVITY_ROOT];
        if (!dirs.includes(dirPath)) { dirs.push(dirPath); store.set('watchDirs', dirs); }
        return dirs;
    });
    ipcMain.handle('vault:remove-watch-dir', (_, dirPath) => {
        let dirs = (store.get('watchDirs') || [ANTIGRAVITY_ROOT]).filter(d => d !== dirPath);
        store.set('watchDirs', dirs);
        return dirs;
    });

    // ── Data Backup / Export / Restore ────────────────────────
    ipcMain.handle('vault:export-all', async () => {
        try {
            const documents = dbAll('SELECT * FROM documents');
            const chunks = dbAll('SELECT * FROM chunks');
            const timeline = dbAll('SELECT * FROM timeline');
            const settings = store.all();
            const exportData = {
                version: '3.0.0',
                exported_at: new Date().toISOString(),
                documents,
                chunks,
                timeline,
                settings,
                stats: {
                    documents: documents.length,
                    chunks: chunks.length,
                    timeline_events: timeline.length,
                }
            };
            const exportPath = path.join(DATA_DIR, `vault-export-${new Date().toISOString().split('T')[0]}.json`);
            fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
            return { ok: true, path: exportPath, stats: exportData.stats };
        } catch (e) {
            console.error('[Vault] Export error:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('vault:restore-backup', async () => {
        const backupPath = path.join(DATA_DIR, 'vault.db.bak');
        if (!fs.existsSync(backupPath)) {
            return { ok: false, error: 'No backup file found' };
        }
        try {
            // Save current as .pre-restore
            const preRestorePath = path.join(DATA_DIR, 'vault.db.pre-restore');
            if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, preRestorePath);
            fs.copyFileSync(backupPath, DB_PATH);
            return { ok: true, message: 'Backup restored. Restart to apply.' };
        } catch (e) {
            console.error('[Vault] Restore error:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('vault:backup-info', () => {
        const backupDir = path.join(DATA_DIR, 'backups');
        const latestBak = path.join(DATA_DIR, 'vault.db.bak');
        const result = { hasBackup: false, backups: [] };
        if (fs.existsSync(latestBak)) {
            result.hasBackup = true;
            result.latestSize = fs.statSync(latestBak).size;
            result.latestModified = fs.statSync(latestBak).mtime.toISOString();
        }
        if (fs.existsSync(backupDir)) {
            result.backups = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('vault-') && f.endsWith('.db'))
                .sort().reverse()
                .map(f => ({
                    name: f,
                    size: fs.statSync(path.join(backupDir, f)).size,
                    date: f.replace('vault-', '').replace('.db', '')
                }));
        }
        return result;
    });

    // Clipboard toggle
    ipcMain.handle('vault:toggle-clipboard', (_, enabled) => {
        store.set('clipboardEnabled', enabled);
        if (enabled && !clipboardMonitor.isRunning()) clipboardMonitor.start();
        if (!enabled && clipboardMonitor.isRunning()) clipboardMonitor.stop();
        return enabled;
    });

    // ── Journal Engine IPC ─────────────────────────────────────
    ipcMain.handle('vault:daily-digest', (_, dateStr) => journal.buildDailyDigest(dateStr));
    ipcMain.handle('vault:morning-brief', () => journal.getMorningBrief());
    ipcMain.handle('vault:activity-dates', () => journal.getActivityDates());
    ipcMain.handle('vault:momentum', (_, days) => journal.getMomentumData(days));
    ipcMain.handle('vault:open-tasks', () => journal.getOpenTasks());
    ipcMain.handle('vault:project-threads', () => journal.getProjectThreads());
    ipcMain.handle('vault:session-detail', (_, convId) => journal.getSessionDetail(convId));
    ipcMain.handle('vault:read-artifact', (_, convId, file) => journal.readArtifact(convId, file));
    ipcMain.handle('vault:pin-session', (_, convId, note) => { journal.pinSession(convId, note); return true; });
    ipcMain.handle('vault:unpin-session', (_, convId) => { journal.unpinSession(convId); return true; });
    ipcMain.handle('vault:pinned-sessions', () => journal.getPinnedSessions());
    ipcMain.handle('vault:add-quick-note', (_, dateStr, content) => journal.addQuickNote(dateStr, content));
    ipcMain.handle('vault:delete-quick-note', (_, noteId) => { journal.deleteQuickNote(noteId); return true; });

    // Task finalization
    ipcMain.handle('vault:finalize-task', (_, convId) => journal.finalizeTask(convId));
    ipcMain.handle('vault:archive-task', (_, convId) => journal.archiveTask(convId));

    // Thread detail + knowledge artifacts
    ipcMain.handle('vault:thread-detail', (_, topic) => journal.getThreadDetail(topic));
    ipcMain.handle('vault:read-ki-artifact', (_, topic, file) => journal.readKnowledgeArtifact(topic, file));

    // KI Management
    ipcMain.handle('vault:ki-list', () => journal.getKIList());
    ipcMain.handle('vault:link-capture-ki', (_, captureId, kiTopic) => journal.linkCaptureToKI(captureId, kiTopic));
    ipcMain.handle('vault:create-ki', (_, title, captureIds) => journal.createKIFromCaptures(title, captureIds));
    ipcMain.handle('vault:suggest-ki', (_, captureId) => journal.suggestKIForCapture(captureId));
    ipcMain.handle('vault:auto-organize', () => journal.autoOrganizeCaptures());

    // AI Intelligence
    ipcMain.handle('vault:intelligence-dashboard', () => journal.getIntelligenceDashboard());
    ipcMain.handle('vault:ai-status', () => journal.getAIStatus());

    // Intelligence v2
    ipcMain.handle('vault:enrich-ki', (_, kiTopic) => journal.enrichKI(kiTopic));
    ipcMain.handle('vault:extract-actions', (_, captureId) => journal.extractActions(captureId));
    ipcMain.handle('vault:weekly-report', () => journal.getWeeklyReport());
    ipcMain.handle('vault:ai-feedback', (_, captureId, kiTopic, action) => journal.recordAIFeedback(captureId, kiTopic, action));
    ipcMain.handle('vault:session-clusters', () => journal.getSessionClusters());
    ipcMain.handle('vault:capture-priorities', () => journal.getCapturePriorities());

    // Intelligence v3
    ipcMain.handle('vault:intelligence-sweep', () => journal.runIntelligenceSweep());
    ipcMain.handle('vault:action-items', (_, status) => journal.getActionItems(status));
    ipcMain.handle('vault:complete-action', (_, id) => journal.completeActionItem(id));

    // v4 — Continuity, Health, Export
    ipcMain.handle('vault:session-continuity', (_, convId) => journal.getSessionContinuity(convId));
    ipcMain.handle('vault:ki-health', () => journal.getKIHealth());
    ipcMain.handle('vault:export-ki', (_, kiTopic) => journal.exportKI(kiTopic));
    ipcMain.handle('vault:export-daily', (_, dateStr) => journal.exportDailyDigest(dateStr));

    // Auto-intelligence sweep on startup (delayed 15s to let app load)
    setTimeout(async () => {
        try {
            const results = await journal.runIntelligenceSweep();
            // Send notification to renderer
            const win = BrowserWindow.getAllWindows()[0];
            if (win && win.webContents) {
                win.webContents.send('vault:sweep-complete', results);
            }
        } catch {}
    }, 15000);

    // ── RAG Chat IPC ───────────────────────────────────────────
    ipcMain.handle('vault:chat', async (_, query) => {
        return vaultRAG.chat(query);
    });
    ipcMain.handle('vault:chat-history', () => vaultRAG.getChatHistory());
    ipcMain.handle('vault:chat-clear', () => { vaultRAG.clearHistory(); return true; });
    ipcMain.handle('vault:rag-stats', () => vaultRAG.getStats());
    ipcMain.handle('vault:rag-rebuild', async () => {
        return vaultRAG.buildIndex((pct, msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('vault:rag-progress', { pct, msg });
            }
        });
    });

    // ── Follow-Up IPC ──────────────────────────────────────────
    ipcMain.handle('vault:follow-ups', async () => {
        _followUpCache = await followupEngine.generateFollowUps();
        return _followUpCache;
    });
    ipcMain.handle('vault:dismiss-follow-up', (_, followUpId) => {
        followupEngine.dismissFollowUp(followUpId);
        _followUpCache = _followUpCache.filter(f => f.id !== followUpId);
        return true;
    });
    ipcMain.handle('vault:follow-up-count', () => _followUpCache.length);

    // Periodic follow-up scan (every 30 min)
    _followUpTimer = setInterval(async () => {
        try {
            _followUpCache = await followupEngine.generateFollowUps();
            if (_followUpCache.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('vault:follow-up-update', { count: _followUpCache.length });
            }
        } catch (e) { console.warn('[Vault] Follow-up periodic scan:', e.message); }
    }, 30 * 60 * 1000);

    // External
    ipcMain.on('open-external', (_, url) => shell.openExternal(url));
    ipcMain.on('vault:show-in-folder', (_, relPath) => {
        const doc = dbGet('SELECT abs_path FROM documents WHERE rel_path = ?', [relPath]);
        if (doc) shell.showItemInFolder(doc.abs_path);
    });

    // Capture token (for extension configuration)
    ipcMain.handle('vault:get-capture-token', () => captureServer.getToken());
}


// ══════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ══════════════════════════════════════════════════════════════

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    console.log('[Vault] Another instance running. Quitting.');
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) { mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
    });

    app.whenReady().then(async () => {
        initPaths();

        // ── Initialize structured logging ────────────────────
        vaultLogger.init(DATA_DIR);
        console.log('[Vault] Structured file logging active');

        store = new SettingsStore({
            clipboardEnabled: true,
            watchDirs: [ANTIGRAVITY_ROOT],
            theme: 'obsidian',
        });

        // ── Initialize database ──────────────────────────────
        await initDatabase(DATA_DIR, DB_PATH);
        autoBackup();

        // ── Initialize domain modules ────────────────────────
        const crypto = require('crypto');

        archivist = createArchivist({
            dbAll, dbGet, dbRun, dbLastId,
            scheduleSave, saveDb,
            updateSearchEntry, removeSearchEntry,
            store,
        });

        journal = createJournalEngine({
            ANTIGRAVITY_ROOT, capturesDir: CAPTURES_DIR,
            dbAll, dbGet, dbRun, scheduleSave,
            crypto, path, fs,
        });
        journal.initAuditChain();

        captureServer = createCaptureServer({
            store, archivist, journal,
            getMainWindow: () => mainWindow,
            capturesDir: CAPTURES_DIR,
            dataDir: DATA_DIR,
            onCaptureComplete: scheduleRAGRebuild,
        });

        clipboardMonitor = createClipboardMonitor({
            clipboard, archivist,
            getMainWindow: () => mainWindow,
            clipboardDir: CLIPBOARD_DIR,
            dataDir: DATA_DIR,
        });

        fileWatcher = createWatcher({
            archivist, journal,
            getMainWindow: () => mainWindow,
            isQuitting: () => isQuitting,
        });

        // ── Initialize RAG + Follow-Up engines ───────────────
        const dbModule = require('./db');
        const ragDataDir = path.join(app.getPath('userData'), 'vault_data');
        if (!fs.existsSync(ragDataDir)) fs.mkdirSync(ragDataDir, { recursive: true });
        vaultRAG.init(dbModule, ragDataDir);
        followupEngine.init(dbModule, journal);

        registerIPC();

        // ── Start services ───────────────────────────────────
        captureServer.initToken();
        captureServer.start();
        if (store.get('clipboardEnabled')) clipboardMonitor.start();

        // Yield event loop so server.listen() binds
        await new Promise(resolve => setImmediate(resolve));

        // ── Splash screen during scan ────────────────────────
        let splashWin = new BrowserWindow({
            width: 380, height: 160,
            frame: false, resizable: false, transparent: false,
            backgroundColor: '#0D0D0D',
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        splashWin.webContents.setMaxListeners(30); // Prevent MaxListenersExceeded warning
        splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
        splashWin.once('ready-to-show', () => splashWin.show());

        console.log('[Vault] Starting corpus scan...');
        const t0 = Date.now();
        const scanProgress = (pct, msg) => {
            if (splashWin && !splashWin.isDestroyed()) {
                const safeMsg = msg.replace(/'/g, "\\'");
                splashWin.webContents.executeJavaScript(
                    `if(window.updateProgress){window.updateProgress(${pct},'${safeMsg}')}`
                ).catch(() => {});
            }
        };
        const scanStats = await archivist.fullCorpusScan(ANTIGRAVITY_ROOT, scanProgress);

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[Vault] Scan: ${scanStats.indexed} indexed, ${scanStats.skipped} skipped in ${elapsed}s`);

        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;

        await createWindow();
        createTray();
        fileWatcher.start(ANTIGRAVITY_ROOT);

        // Also watch captures directory for live capture updates
        // Use DATA_DIR as rootDir for consistent rel_paths with capture-server
        if (fs.existsSync(CAPTURES_DIR)) {
            const captureWatcher = createWatcher({
                archivist, journal,
                getMainWindow: () => mainWindow,
                isQuitting: () => isQuitting,
            });
            captureWatcher.start(CAPTURES_DIR, DATA_DIR);
        }

        // ── Background captures scan + RAG index build (non-blocking) ────────
        // Deferred to after window opens to prevent main-process hang
        setTimeout(async () => {
            try {
                // Scan captures directory (lives under userData, not ANTIGRAVITY_ROOT)
                if (fs.existsSync(CAPTURES_DIR)) {
                    console.log('[Vault] Background: scanning captures...');
                    const captureStats = await archivist.fullCorpusScan(CAPTURES_DIR, null, DATA_DIR);
                    console.log(`[Vault] Background: ${captureStats.indexed} captures indexed, ${captureStats.skipped} skipped`);
                }
            } catch (e) {
                console.error('[Vault] Captures scan error:', e.message);
            }

            // Rebuild RAG index after captures are ingested
            try {
                console.log('[Vault] Building RAG index...');
                const result = await vaultRAG.buildIndex((pct, msg) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('vault:rag-progress', { pct, msg });
                    }
                });
                console.log(`[Vault] RAG index ready: ${result?.chunks || 0} chunks (${result?.mode || 'unknown'})`);
            } catch (e) {
                console.error('[Vault] RAG build error:', e.message);
            }
        }, 5000); // 5s delay to let window settle

        // ── Initial follow-up scan ───────────────────────────
        setTimeout(async () => {
            try {
                _followUpCache = await followupEngine.generateFollowUps();
                if (_followUpCache.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('vault:follow-up-update', { count: _followUpCache.length });
                }
                console.log(`[Vault] Follow-ups: ${_followUpCache.length} items detected`);
            } catch (e) { console.warn('[Vault] Follow-up initial scan:', e.message); }
        }, 15000);

        // ── Capture health check (warn if no extension captures in 24h) ───
        setTimeout(() => {
            try {
                let recentCaptureCount = 0;
                const oneDayAgoMs = Date.now() - 86400000;
                if (fs.existsSync(CAPTURES_DIR)) {
                    for (const src of fs.readdirSync(CAPTURES_DIR)) {
                        const srcDir = path.join(CAPTURES_DIR, src);
                        try {
                            if (!fs.statSync(srcDir).isDirectory()) continue;
                            for (const f of fs.readdirSync(srcDir)) {
                                if (f.endsWith('.md')) {
                                    const stat = fs.statSync(path.join(srcDir, f));
                                    if (stat.mtimeMs > oneDayAgoMs) recentCaptureCount++;
                                }
                            }
                        } catch { /* skip unreadable dirs */ }
                    }
                }
                if (recentCaptureCount === 0 && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('vault:capture-warning', {
                        message: 'No extension captures in 24h — check that the browser extension has a valid token set.',
                    });
                    console.warn('[Vault] Capture health: 0 extension captures in last 24h');
                } else {
                    console.log(`[Vault] Capture health: ${recentCaptureCount} captures in last 24h`);
                }
            } catch (e) { console.warn('[Vault] Capture health check:', e.message); }
        }, 60000);
    });

    app.on('window-all-closed', () => { /* stay in tray */ });

    app.on('before-quit', () => {
        isQuitting = true;
        console.log('[Vault] Graceful shutdown started...');

        saveWindowState();
        fileWatcher?.stop();
        clipboardMonitor?.stop();
        captureServer?.stop();
        closeDatabase();

        console.log('[Vault] Shutdown complete.');
        vaultLogger.close();
    });
}
