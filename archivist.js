/**
 * VERITAS VAULT — Archivist Engine
 * ════════════════════════════════════════════════════════════════
 * Port of Provenance Stack Module 20 — file ingestion, chunking,
 * classification, and corpus scanning.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────
const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 100;

const EXCLUDE_DIRS = new Set([
    '__pycache__', '.git', '.venv', 'venv', 'node_modules',
    '.pytest_cache', '.mypy_cache', 'dist', 'build', '.eggs',
    '.tox', 'htmlcov', '.idea', '.vs', '.system_generated',
    'tempmediaStorage',
]);

const INGESTIBLE_EXTS = new Set([
    '.md', '.py', '.json', '.yaml', '.yml', '.txt', '.toml',
    '.cfg', '.sol', '.js', '.ts', '.jsx', '.tsx', '.css',
    '.html', '.rs', '.go', '.sh', '.bat', '.ps1',
]);

const SCAN_STAGES = [
    { id: 1, label: 'Configuration', exts: new Set(['.json', '.yaml', '.yml', '.toml', '.cfg']) },
    { id: 2, label: 'Documentation', exts: new Set(['.md', '.txt']) },
    { id: 3, label: 'Code', exts: new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.sol', '.rs', '.go']) },
    { id: 4, label: 'Other', exts: new Set(['.html', '.css', '.sh', '.bat', '.ps1']) },
];

// ── Core Functions ───────────────────────────────────────────

function canonicalNormalize(text) {
    text = text.normalize('NFKC').trim();
    return text.split('\n').map(l => l.trimEnd()).join('\n');
}

function contentHash(text) {
    return crypto.createHash('sha256')
        .update(canonicalNormalize(text), 'utf-8')
        .digest('hex');
}

function chunkFile(content, filePath) {
    const normalized = canonicalNormalize(content);
    const chunks = [];
    let start = 0, idx = 0;
    const MAX_CHUNKS = 30; // Safety cap: prevents large files from generating 1000+ DB writes

    while (start < normalized.length && idx < MAX_CHUNKS) {
        const end = start + CHUNK_SIZE;
        const raw = normalized.substring(start, end);
        const chunkText = `# FILE: ${filePath}\n${raw}`;
        const chunkId = crypto.createHash('sha256')
            .update(`${filePath}:${idx}:${normalized.substring(start, start + 100)}`)
            .digest('hex')
            .substring(0, 16);

        chunks.push({
            chunk_id: chunkId,
            index: idx,
            content: chunkText,
            content_hash: contentHash(chunkText),
        });
        start = end - CHUNK_OVERLAP;
        idx++;
    }
    return chunks;
}

function classifyFile(relPath) {
    const n = relPath.replace(/\\/g, '/');
    if (n.startsWith('brain/')) return 'artifact';
    if (n.startsWith('knowledge/')) return 'knowledge';
    if (n.startsWith('captures/')) return 'capture';
    if (n.startsWith('scratch/')) return 'research';
    if (n.startsWith('annotations/')) return 'annotation';
    if (n.startsWith('conversations/')) return 'conversation';
    if (n.startsWith('code_tracker/')) return 'code_tracker';
    return 'document';
}

function extractConversationId(relPath) {
    const match = relPath.match(/(?:brain|annotations)[/\\]([a-f0-9-]{36})/);
    return match ? match[1] : null;
}

function extractTopic(relPath) {
    const match = relPath.replace(/\\/g, '/').match(/knowledge\/([^/]+)/);
    return match ? match[1] : null;
}

// ── Factory ──────────────────────────────────────────────────

function createArchivist({ dbAll, dbGet, dbRun, dbLastId, scheduleSave, saveDb, updateSearchEntry, removeSearchEntry, store }) {

    function ingestFile(absPath, rootDir) {
        const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
        const ext = path.extname(absPath).toLowerCase();
        if (!INGESTIBLE_EXTS.has(ext)) return null;

        let stat;
        try { stat = fs.statSync(absPath); } catch { return null; }
        if (!stat.isFile() || stat.size === 0 || stat.size > 10 * 1024 * 1024) return null;

        let content;
        try { content = fs.readFileSync(absPath, 'utf-8'); } catch { return null; }

        const fileHash = contentHash(content);

        // A5: Dedup check
        const existing = dbGet('SELECT file_hash FROM documents WHERE rel_path = ?', [relPath]);
        if (existing && existing.file_hash === fileHash) return null;

        // Remove stale data
        if (existing) {
            const oldDoc = dbGet('SELECT id FROM documents WHERE rel_path = ?', [relPath]);
            if (oldDoc) {
                dbRun('DELETE FROM chunks WHERE doc_id = ?', [oldDoc.id]);
                dbRun('DELETE FROM tags WHERE doc_id = ?', [oldDoc.id]);
                dbRun('DELETE FROM search_index WHERE doc_id = ?', [oldDoc.id]);
                removeSearchEntry(oldDoc.id);
                dbRun('DELETE FROM documents WHERE id = ?', [oldDoc.id]);
            }
        }

        const type = classifyFile(relPath);
        const conversationId = extractConversationId(relPath);
        const topic = extractTopic(relPath);
        const titleMatch = content.match(/^#\s+(.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : path.basename(absPath, ext);
        const now = Date.now() / 1000;

        // Insert document
        dbRun(`
            INSERT OR REPLACE INTO documents 
            (rel_path, abs_path, type, title, conversation_id, topic, size_bytes, file_hash, created_at, modified_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [relPath, absPath, type, title, conversationId, topic, stat.size, fileHash,
            stat.birthtimeMs / 1000, stat.mtimeMs / 1000, now]);

        const docId = dbLastId();

        // A2: Chunk + A6: Store (metadata only — BLOBs caused WASM OOM)
        const chunks = chunkFile(content, relPath);
        const emptyBlob = Buffer.alloc(0);
        for (const chunk of chunks) {
            dbRun(`
                INSERT OR REPLACE INTO chunks (chunk_id, doc_id, chunk_idx, content, content_hash, compressed, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [chunk.chunk_id, docId, chunk.index, emptyBlob, chunk.content_hash, 0, now]);
        }

        // Search index (cap content at 10KB to avoid WASM OOM)
        const searchContent = content.length > 10240 ? content.substring(0, 10240) : content;
        dbRun(`INSERT OR REPLACE INTO search_index (doc_id, title, content, rel_path, type) VALUES (?, ?, ?, ?, ?)`,
            [docId, title, searchContent, relPath, type]);
        updateSearchEntry(docId, title, searchContent, relPath, type);

        // Timeline
        dbRun(`INSERT INTO timeline (doc_id, event, detail, timestamp) VALUES (?, ?, ?, ?)`,
            [docId, existing ? 'updated' : 'captured', relPath, now]);

        // Ingestion receipt
        const receiptId = crypto.createHash('sha256')
            .update(`${relPath}:${fileHash}:${chunks.length}`)
            .digest('hex').substring(0, 16);
        dbRun(`INSERT OR REPLACE INTO ingestion_receipts (receipt_id, rel_path, file_hash, chunk_count, corpus_root, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`, [receiptId, relPath, fileHash, chunks.length, 'vault', now]);

        scheduleSave();
        return { action: existing ? 'updated' : 'captured', chunks: chunks.length, type, title };
    }

    function handleFileRemoval(absPath, rootDir) {
        const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
        const doc = dbGet('SELECT id FROM documents WHERE rel_path = ?', [relPath]);
        if (!doc) return;
        dbRun('DELETE FROM chunks WHERE doc_id = ?', [doc.id]);
        dbRun('DELETE FROM tags WHERE doc_id = ?', [doc.id]);
        dbRun('DELETE FROM search_index WHERE doc_id = ?', [doc.id]);
        removeSearchEntry(doc.id);
        dbRun('DELETE FROM documents WHERE id = ?', [doc.id]);
        dbRun('INSERT INTO timeline (doc_id, event, detail, timestamp) VALUES (?, ?, ?, ?)',
            [null, 'removed', relPath, Date.now() / 1000]);
        scheduleSave();
    }

    async function fullCorpusScan(rootDir, onProgress, relPathRoot) {
        // relPathRoot: optional root for computing rel_paths (defaults to rootDir)
        const pathRoot = relPathRoot || rootDir;
        const stats = { files: 0, indexed: 0, skipped: 0, chunks: 0, errors: 0 };

        // Per-root incremental scan: each directory tree gets its own timestamp
        // Fall back to legacy global key only for the original ANTIGRAVITY_ROOT scan path
        const rootKey = 'lastScanTimestamp_' + crypto.createHash('md5').update(rootDir).digest('hex').substring(0, 8);
        const legacyMs = rootDir.includes('antigravity') ? (store.get('lastScanTimestamp') || 0) : 0;
        const lastScanMs = store.get(rootKey) || legacyMs;
        const scanStartMs = Date.now();

        if (onProgress) onProgress(2, lastScanMs > 0 ? 'Checking for changes…' : 'Scanning knowledge base…', 0, 'Initializing');

        // Phase 1: Collect file paths + mtimes (fast walk, no reads)
        const filePaths = [];
        function walk(dir) {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (EXCLUDE_DIRS.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(fullPath); }
                else if (entry.isFile()) {
                    try {
                        const st = fs.statSync(fullPath);
                        if (lastScanMs > 0 && st.mtimeMs < lastScanMs) {
                            stats.skipped++;
                            continue;
                        }
                    } catch { continue; }
                    filePaths.push(fullPath);
                }
            }
        }
        walk(rootDir);
        stats.files = filePaths.length + stats.skipped;

        if (filePaths.length === 0) {
            if (onProgress) onProgress(100, 'Up to date', 4, 'Complete');
            saveDb();
            store.set(rootKey, scanStartMs);
            return stats;
        }

        // Phase 2: Bucket files into stages by extension
        const stageBuckets = SCAN_STAGES.map(() => []);
        for (const fp of filePaths) {
            const ext = path.extname(fp).toLowerCase();
            let placed = false;
            for (let s = 0; s < SCAN_STAGES.length; s++) {
                if (SCAN_STAGES[s].exts.has(ext)) { stageBuckets[s].push(fp); placed = true; break; }
            }
            if (!placed) stageBuckets[SCAN_STAGES.length - 1].push(fp);
        }

        // Phase 3: Process stage-by-stage
        const BATCH_SIZE = 10;
        let totalProcessed = 0;
        const totalFiles = filePaths.length;

        for (let s = 0; s < SCAN_STAGES.length; s++) {
            const stage = SCAN_STAGES[s];
            const bucket = stageBuckets[s];
            if (onProgress) onProgress(
                Math.round(5 + (totalProcessed / totalFiles) * 90),
                `Stage ${stage.id}: ${stage.label} (${bucket.length} files)`,
                stage.id, stage.label
            );

            for (let i = 0; i < bucket.length; i += BATCH_SIZE) {
                const batch = bucket.slice(i, i + BATCH_SIZE);
                for (const fp of batch) {
                    try {
                        const result = ingestFile(fp, pathRoot);
                        if (result) { stats.indexed++; stats.chunks += result.chunks; }
                        else { stats.skipped++; }
                    } catch (e) { stats.errors++; }
                    totalProcessed++;
                }
                const pct = Math.round(5 + (totalProcessed / totalFiles) * 90);
                if (onProgress) onProgress(pct, `${stage.label}: ${stats.indexed} indexed…`, stage.id, stage.label);
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        if (onProgress) onProgress(100, 'Done', 4, 'Complete');
        saveDb(); // Force save after scan
        store.set(rootKey, scanStartMs);
        return stats;
    }

    return {
        ingestFile,
        handleFileRemoval,
        fullCorpusScan,
        contentHash,
        INGESTIBLE_EXTS,
        EXCLUDE_DIRS,
    };
}

module.exports = createArchivist;
