/**
 * VERITAS VAULT — Database Module
 * ════════════════════════════════════════════════════════════════
 * SQLite CAS (sql.js WASM) — Content-Addressed Storage with audit chain.
 * Atomic write-temp-then-rename pattern for crash safety.
 */

const fs = require('fs');
const MiniSearch = require('minisearch');

let db = null;
let dbDirty = false;
let saveTimer = null;
let DB_PATH = null;
let DATA_DIR = null;

// ── Full-text search index (replaces LIKE-based O(N) scan) ──
let searchIndex = null;

function initSearchIndex() {
    searchIndex = new MiniSearch({
        fields: ['title', 'content', 'rel_path'],
        storeFields: ['title', 'rel_path', 'type', 'doc_id'],
        searchOptions: {
            boost: { title: 3, rel_path: 1.5, content: 1 },
            prefix: true,
            fuzzy: 0.2,
            combineWith: 'OR',
        },
    });
}

function rebuildSearchIndex() {
    if (!db || !searchIndex) return;
    searchIndex.removeAll();
    const rows = dbAll(`SELECT doc_id, title, content, rel_path, type FROM search_index`);
    for (const row of rows) {
        try {
            searchIndex.add({
                id: row.doc_id,
                doc_id: row.doc_id,
                title: row.title || '',
                content: (row.content || '').substring(0, 10240),
                rel_path: row.rel_path || '',
                type: row.type || '',
            });
        } catch { /* skip duplicates */ }
    }
}

function searchDocuments(query) {
    if (!searchIndex || !query || query.length < 2) return [];

    const results = searchIndex.search(query, { limit: 50 });
    const docIds = results.map(r => r.doc_id || r.id);
    if (docIds.length === 0) return [];

    // Enrich with full DB data
    const placeholders = docIds.map(() => '?').join(',');
    const rows = dbAll(`
        SELECT s.doc_id, s.title, s.content, s.rel_path, s.type,
               d.modified_at, d.conversation_id, d.topic
        FROM search_index s
        LEFT JOIN documents d ON d.id = s.doc_id
        WHERE s.doc_id IN (${placeholders})
    `, docIds);

    // Preserve MiniSearch ranking order
    const rowMap = {};
    for (const r of rows) rowMap[r.doc_id] = r;

    return docIds.map(id => rowMap[id]).filter(Boolean).map(r => {
        let snippet = '';
        if (r.content) {
            const lc = r.content.toLowerCase();
            const qi = lc.indexOf(query.toLowerCase());
            if (qi >= 0) {
                const start = Math.max(0, qi - 60);
                const end = Math.min(r.content.length, qi + query.length + 60);
                const raw = r.content.substring(start, end);
                snippet = '...' + raw.replace(
                    new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'),
                    '<mark>$1</mark>'
                ) + '...';
            }
        }
        return {
            rel_path: r.rel_path, type: r.type, title: r.title,
            modified_at: r.modified_at, conversation_id: r.conversation_id,
            topic: r.topic, snippet,
            content: (r.content || '').substring(0, 3000),
        };
    });
}

function updateSearchEntry(docId, title, content, relPath, type) {
    if (!searchIndex) return;
    try { searchIndex.discard(docId); } catch { /* not in index */ }
    try {
        searchIndex.add({
            id: docId,
            doc_id: docId,
            title: title || '',
            content: (content || '').substring(0, 10240),
            rel_path: relPath || '',
            type: type || '',
        });
    } catch { /* skip */ }
}

function removeSearchEntry(docId) {
    if (!searchIndex) return;
    try { searchIndex.discard(docId); } catch { /* not in index */ }
}

// ── SQL helpers ──────────────────────────────────────────────

function dbAll(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    } catch (e) {
        console.error('[DB] Query error:', sql, e.message);
        return [];
    }
}

function dbGet(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        let result = null;
        if (stmt.step()) result = stmt.getAsObject();
        stmt.free();
        return result;
    } catch (e) {
        console.error('[DB] Get error:', sql, e.message);
        return null;
    }
}

function dbRun(sql, params = []) {
    try {
        db.run(sql, params);
        dbDirty = true;
    } catch (e) {
        console.error('[DB] Run error:', sql, e.message);
    }
}

function dbLastId() {
    const row = dbGet('SELECT last_insert_rowid() as id');
    return row ? row.id : 0;
}

function saveDb() {
    if (!db || !dbDirty) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        // Atomic write: write to temp file then rename (prevents corruption on crash)
        const tmpPath = DB_PATH + '.tmp';
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, DB_PATH);
        dbDirty = false;
    } catch (e) {
        console.error('[DB] Save error:', e.message);
        // Clean up temp file on failure
        try { fs.unlinkSync(DB_PATH + '.tmp'); } catch (e) { console.warn('[DB] Temp cleanup:', e.message); }
    }
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDb, 2000);
}

async function initDatabase(dataDir, dbPath) {
    DATA_DIR = dataDir;
    DB_PATH = dbPath;

    const initSqlJs = require('sql.js');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const SQL = await initSqlJs();

    // Load existing DB or create new
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS documents (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rel_path      TEXT UNIQUE NOT NULL,
            abs_path      TEXT NOT NULL,
            type          TEXT NOT NULL,
            title         TEXT,
            conversation_id TEXT,
            topic         TEXT,
            size_bytes    INTEGER,
            file_hash     TEXT NOT NULL,
            created_at    REAL NOT NULL,
            modified_at   REAL NOT NULL,
            indexed_at    REAL NOT NULL
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_doc_type ON documents(type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_doc_hash ON documents(file_hash)');

    db.run(`
        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id      TEXT PRIMARY KEY,
            doc_id        INTEGER NOT NULL,
            chunk_idx     INTEGER NOT NULL,
            content       BLOB NOT NULL,
            content_hash  TEXT NOT NULL,
            compressed    INTEGER DEFAULT 1,
            created_at    REAL NOT NULL
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks(doc_id)');

    // Search index table (metadata for rebuild)
    db.run(`
        CREATE TABLE IF NOT EXISTS search_index (
            doc_id    INTEGER PRIMARY KEY,
            title     TEXT,
            content   TEXT,
            rel_path  TEXT,
            type      TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS timeline (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id     INTEGER,
            event      TEXT NOT NULL,
            detail     TEXT,
            timestamp  REAL NOT NULL
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_timeline_ts ON timeline(timestamp)');

    db.run(`
        CREATE TABLE IF NOT EXISTS ingestion_receipts (
            receipt_id   TEXT PRIMARY KEY,
            rel_path     TEXT NOT NULL,
            file_hash    TEXT NOT NULL,
            chunk_count  INTEGER NOT NULL,
            corpus_root  TEXT NOT NULL,
            created_at   REAL NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS tags (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            tag    TEXT NOT NULL
        )
    `);

    // Journal tables (high-assurance)
    db.run(`
        CREATE TABLE IF NOT EXISTS pinned_sessions (
            conversation_id TEXT PRIMARY KEY,
            pinned_at       REAL NOT NULL,
            note            TEXT
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS quick_notes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date_str    TEXT NOT NULL,
            content     TEXT NOT NULL,
            created_at  REAL NOT NULL
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_qn_date ON quick_notes(date_str)');
    db.run(`
        CREATE TABLE IF NOT EXISTS journal_audit (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            action          TEXT NOT NULL,
            detail          TEXT,
            integrity_hash  TEXT NOT NULL,
            prev_hash       TEXT,
            timestamp       REAL NOT NULL
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_audit_ts ON journal_audit(timestamp)');

    // Save initial schema
    saveDb();

    // Build full-text search index
    initSearchIndex();
    rebuildSearchIndex();

    return db;
}

function closeDatabase() {
    saveDb();
    if (db) { try { db.close(); } catch (e) { console.warn('[DB] Close error:', e.message); } }
}

function getDbPath() { return DB_PATH; }

module.exports = {
    initDatabase,
    closeDatabase,
    getDbPath,
    dbAll,
    dbGet,
    dbRun,
    dbLastId,
    saveDb,
    scheduleSave,
    searchDocuments,
    updateSearchEntry,
    removeSearchEntry,
};
