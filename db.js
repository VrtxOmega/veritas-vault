/**
 * VERITAS VAULT — Database Module (Native Engine)
 * ════════════════════════════════════════════════════════════════
 * better-sqlite3 (native C++ bindings) — Direct NVMe I/O, WAL mode.
 * SQLite FTS5 for full-text search — zero JS overhead, zero boot delay.
 * 
 * Migration from sql.js WASM: eliminates RAM ceiling, removes MiniSearch
 * dependency, and provides instantaneous search via B-Tree algorithm.
 */

const fs = require('fs');
const path = require('path');

let db = null;
let DB_PATH = null;
let DATA_DIR = null;

// ── SQL helpers (signature-identical to WASM predecessor) ────

function dbAll(sql, params = []) {
    if (!db) return [];
    try {
        const stmt = db.prepare(sql);
        return params.length ? stmt.all(...params) : stmt.all();
    } catch (e) {
        console.error('[DB] Query error:', sql, e.message);
        return [];
    }
}

function dbGet(sql, params = []) {
    if (!db) return null;
    try {
        const stmt = db.prepare(sql);
        return params.length ? stmt.get(...params) : stmt.get();
    } catch (e) {
        console.error('[DB] Get error:', sql, e.message);
        return null;
    }
}

function dbRun(sql, params = []) {
    if (!db) return;
    try {
        const stmt = db.prepare(sql);
        params.length ? stmt.run(...params) : stmt.run();
    } catch (e) {
        console.error('[DB] Run error:', sql, e.message);
    }
}

function dbLastId() {
    if (!db) return 0;
    try {
        const row = db.prepare('SELECT last_insert_rowid() as id').get();
        return row ? row.id : 0;
    } catch (e) {
        console.error('[DB] LastId error:', e.message);
        return 0;
    }
}

// ── Save/Schedule (native SQLite writes to disk automatically via WAL) ──
// These are kept as no-ops to maintain API compatibility with all callers.
// better-sqlite3 writes are ACID-compliant and immediate — no manual flush needed.

function saveDb() {
    // Native SQLite handles persistence automatically via WAL journaling.
    // This function exists solely for API compatibility with callers.
    if (db) {
        try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* ignore */ }
    }
}

function scheduleSave() {
    // No-op: better-sqlite3 writes are immediate and ACID-compliant.
    // All callers that used to call scheduleSave() after dbRun() are now
    // automatically persisted by the native engine.
}

// ── FTS5 Search (replaces MiniSearch entirely) ──────────────

function searchDocuments(query) {
    if (!query || query.length < 2) return [];

    try {
        // Sanitize the query for FTS5 syntax
        const safeQuery = query
            .replace(/[^\w\s\-_.]/g, '')  // strip special chars
            .trim()
            .split(/\s+/)
            .filter(t => t.length >= 2)
            .map(t => `"${t}"*`)           // prefix match with quoting
            .join(' ');

        if (!safeQuery) return [];

        const rows = db.prepare(`
            SELECT 
                si.doc_id,
                si.title,
                snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
                si.rel_path,
                si.type,
                d.modified_at,
                d.conversation_id,
                d.topic,
                rank
            FROM search_fts si
            LEFT JOIN documents d ON d.id = si.doc_id
            WHERE search_fts MATCH ?
            ORDER BY rank
            LIMIT 50
        `).all(safeQuery);

        return rows.map(r => ({
            rel_path: r.rel_path,
            type: r.type,
            title: r.title,
            modified_at: r.modified_at,
            conversation_id: r.conversation_id,
            topic: r.topic,
            snippet: r.snippet || '',
            content: '',  // FTS5 snippet replaces full content transfer
        }));
    } catch (e) {
        console.error('[DB] FTS5 search error:', e.message);
        return [];
    }
}

function updateSearchEntry(docId, title, content, relPath, type) {
    try {
        // Upsert into the FTS5 virtual table
        db.prepare(`
            INSERT OR REPLACE INTO search_fts(doc_id, title, content, rel_path, type)
            VALUES (?, ?, ?, ?, ?)
        `).run(docId, title || '', (content || '').substring(0, 10240), relPath || '', type || '');
    } catch (e) {
        console.error('[DB] FTS5 update error:', e.message);
    }
}

function removeSearchEntry(docId) {
    try {
        db.prepare('DELETE FROM search_fts WHERE doc_id = ?').run(docId);
    } catch (e) {
        console.error('[DB] FTS5 remove error:', e.message);
    }
}

// ── WASM → Native Migration ─────────────────────────────────

function migrateFromWasm(wasmDbPath) {
    if (!fs.existsSync(wasmDbPath)) return false;

    console.log('[DB] Detected legacy WASM database. Migrating to native SQLite...');
    const t0 = Date.now();

    try {
        // sql.js stores the DB as a raw binary blob. We need to load it,
        // extract all tables, and insert into the native DB.
        const initSqlJs = require('sql.js');
        const SQL = require('sql.js');

        // sql.js init is async, but we handle this at the caller level
        return { needsAsyncMigration: true, wasmPath: wasmDbPath };
    } catch (e) {
        console.error('[DB] Migration check error:', e.message);
        return false;
    }
}

async function performAsyncMigration(wasmDbPath) {
    console.log('[DB] Performing async WASM → Native migration...');
    const t0 = Date.now();

    try {
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();
        const fileBuffer = fs.readFileSync(wasmDbPath);
        const wasmDb = new SQL.Database(fileBuffer);

        // Extract all data from WASM tables
        const tables = ['documents', 'chunks', 'timeline', 'ingestion_receipts', 
                        'tags', 'pinned_sessions', 'quick_notes', 'journal_audit'];

        for (const table of tables) {
            try {
                const stmt = wasmDb.prepare(`SELECT * FROM ${table}`);
                const rows = [];
                while (stmt.step()) rows.push(stmt.getAsObject());
                stmt.free();

                if (rows.length === 0) continue;

                // Get column names from first row
                const cols = Object.keys(rows[0]);
                const placeholders = cols.map(() => '?').join(',');
                const insertSql = `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
                const insertStmt = db.prepare(insertSql);

                const insertMany = db.transaction((rowList) => {
                    for (const row of rowList) {
                        insertStmt.run(...cols.map(c => row[c]));
                    }
                });

                insertMany(rows);
                console.log(`[DB] Migrated ${rows.length} rows from ${table}`);
            } catch (e) {
                console.error(`[DB] Migration table ${table}:`, e.message);
            }
        }

        // Migrate search_index → search_fts (the old MiniSearch source table)
        try {
            const stmt = wasmDb.prepare('SELECT doc_id, title, content, rel_path, type FROM search_index');
            const searchRows = [];
            while (stmt.step()) searchRows.push(stmt.getAsObject());
            stmt.free();

            if (searchRows.length > 0) {
                const insertFts = db.prepare(`
                    INSERT OR REPLACE INTO search_fts(doc_id, title, content, rel_path, type) 
                    VALUES (?, ?, ?, ?, ?)
                `);
                const insertAll = db.transaction((rowList) => {
                    for (const row of rowList) {
                        insertFts.run(
                            row.doc_id,
                            row.title || '',
                            (row.content || '').substring(0, 10240),
                            row.rel_path || '',
                            row.type || ''
                        );
                    }
                });
                insertAll(searchRows);
                console.log(`[DB] Migrated ${searchRows.length} search entries to FTS5`);
            }
        } catch (e) {
            console.error('[DB] Search migration:', e.message);
        }

        wasmDb.close();

        // Archive the old WASM DB (don't delete — safety first)
        const archivePath = wasmDbPath + '.wasm.bak';
        fs.renameSync(wasmDbPath, archivePath);
        console.log(`[DB] WASM database archived to ${archivePath}`);

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[DB] Migration complete in ${elapsed}s`);
        return true;
    } catch (e) {
        console.error('[DB] Async migration failed:', e.message);
        return false;
    }
}

// ── Database Initialization ─────────────────────────────────

async function initDatabase(dataDir, dbPath) {
    DATA_DIR = dataDir;
    DB_PATH = dbPath;

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // Determine if we need to migrate from WASM
    const nativeDbPath = dbPath.replace(/\.sqlite$/, '') + '.native.sqlite';
    const wasmExists = fs.existsSync(dbPath);
    const nativeExists = fs.existsSync(nativeDbPath);

    // Use native path going forward
    DB_PATH = nativeDbPath;

    const Database = require('better-sqlite3');

    // Open native database (creates if not exists)
    db = new Database(DB_PATH);

    // Enable WAL mode for concurrent reads and crash safety
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');  // 64MB cache
    db.pragma('foreign_keys = ON');

    // Create schema
    db.exec(`
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_doc_type ON documents(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_doc_hash ON documents(file_hash)');

    db.exec(`
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks(doc_id)');

    // FTS5 virtual table — replaces MiniSearch entirely
    // content="" makes it an external-content FTS table (lightweight)
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
            doc_id UNINDEXED,
            title,
            content,
            rel_path,
            type UNINDEXED,
            tokenize='porter unicode61'
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS timeline (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id     INTEGER,
            event      TEXT NOT NULL,
            detail     TEXT,
            timestamp  REAL NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_ts ON timeline(timestamp)');

    db.exec(`
        CREATE TABLE IF NOT EXISTS ingestion_receipts (
            receipt_id   TEXT PRIMARY KEY,
            rel_path     TEXT NOT NULL,
            file_hash    TEXT NOT NULL,
            chunk_count  INTEGER NOT NULL,
            corpus_root  TEXT NOT NULL,
            created_at   REAL NOT NULL
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS tags (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            tag    TEXT NOT NULL
        )
    `);

    // Journal tables (high-assurance)
    db.exec(`
        CREATE TABLE IF NOT EXISTS pinned_sessions (
            conversation_id TEXT PRIMARY KEY,
            pinned_at       REAL NOT NULL,
            note            TEXT
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS quick_notes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date_str    TEXT NOT NULL,
            content     TEXT NOT NULL,
            created_at  REAL NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_qn_date ON quick_notes(date_str)');
    db.exec(`
        CREATE TABLE IF NOT EXISTS journal_audit (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            action          TEXT NOT NULL,
            detail          TEXT,
            integrity_hash  TEXT NOT NULL,
            prev_hash       TEXT,
            timestamp       REAL NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON journal_audit(timestamp)');

    // Follow-up dismissals
    db.exec(`
        CREATE TABLE IF NOT EXISTS dismissed_followups (
            followup_id   TEXT PRIMARY KEY,
            dismissed_at  REAL NOT NULL
        )
    `);

    // search_index — regular table that vault-rag.js and archivist.js read/write directly
    db.exec(`
        CREATE TABLE IF NOT EXISTS search_index (
            doc_id    INTEGER PRIMARY KEY,
            title     TEXT,
            content   TEXT,
            rel_path  TEXT,
            type      TEXT
        )
    `);

    // Triggers to keep FTS5 in sync with the regular search_index table
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS search_index_ai AFTER INSERT ON search_index BEGIN
            INSERT OR REPLACE INTO search_fts(doc_id, title, content, rel_path, type)
            VALUES (NEW.doc_id, NEW.title, NEW.content, NEW.rel_path, NEW.type);
        END
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS search_index_ad AFTER DELETE ON search_index BEGIN
            DELETE FROM search_fts WHERE doc_id = OLD.doc_id;
        END
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS search_index_au AFTER UPDATE ON search_index BEGIN
            INSERT OR REPLACE INTO search_fts(doc_id, title, content, rel_path, type)
            VALUES (NEW.doc_id, NEW.title, NEW.content, NEW.rel_path, NEW.type);
        END
    `);

    // Action items (task tracking from journal intelligence sweeps)
    db.exec(`
        CREATE TABLE IF NOT EXISTS action_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id   TEXT,
            type        TEXT,
            priority    TEXT,
            description TEXT,
            status      TEXT DEFAULT 'open',
            created_at  INTEGER DEFAULT (strftime('%s','now'))
        )
    `);

    // Cross-model project workspaces
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT,
            color       TEXT DEFAULT '#D4AF37',
            icon        TEXT DEFAULT '📁',
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS project_sessions (
            project_id      INTEGER NOT NULL,
            conversation_id TEXT NOT NULL,
            source          TEXT,
            added_at        REAL NOT NULL,
            auto_linked     INTEGER DEFAULT 0,
            PRIMARY KEY (project_id, conversation_id),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    `);

    // Migrate from WASM if legacy DB exists and native is new
    if (wasmExists && !nativeExists) {
        await performAsyncMigration(dbPath);
    }

    console.log(`[DB] Native SQLite ready (WAL mode, FTS5 active)`);
    return db;
}

function closeDatabase() {
    if (db) {
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
        } catch (e) {
            console.warn('[DB] Close error:', e.message);
        }
    }
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
