/**
 * VERITAS VAULT — RAG Engine v2 (vault-rag.js)
 * ════════════════════════════════════════════════════════════════
 * Retrieval-Augmented Generation over the user's captured corpus.
 * 
 * Pipeline: Embed query (nomic-embed-text) → Cosine similarity →
 *           Top-K chunks → Context injection → qwen2.5:7b → Answer
 * 
 * v2: Crash-resilient indexing with checkpoint/resume and memory-
 *     efficient incremental Float32Array writes. Never accumulates
 *     intermediate JS arrays — writes directly into flat buffer.
 * 
 * Fallback: If nomic-embed-text unavailable, uses MiniSearch keyword
 *           retrieval instead.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const EMBED_MODEL = 'nomic-embed-text';
const CHAT_MODEL = 'qwen2.5:7b';
const EMBED_DIM = 768;
const EMBED_TIMEOUT = 15000;
const CHAT_TIMEOUT = 60000;
const TOP_K = 8;
const MAX_CONTEXT_CHARS = 8000;
const MAX_HISTORY = 20;

const BATCH_SIZE = 16;              // Reduced from 32 to lower peak memory
const CHECKPOINT_INTERVAL = 10;     // Save checkpoint every 10 batches

// ── State ────────────────────────────────────────────────────
let _vectors = null;        // Float32Array flat buffer (N x EMBED_DIM)
let _docMeta = [];          // [{docId, title, relPath, type, chunkText}]
let _indexBuilt = false;
let _indexBuildTime = null;
let _embedAvailable = false;
let _chatHistory = [];      // [{role, content, sources?, timestamp}]
let _dbRef = null;          // reference to db module
let _dataDir = null;        // canonical directory for index persistence

function init(dbModule, dataDir, onProgress) {
    _dbRef = dbModule;
    if (dataDir) _dataDir = dataDir;

    // Fast-boot: parse metadata instantly, defer massive buffer read
    if (_dataDir) {
        loadIndexBackground(_dataDir, onProgress);
    }
}

// ── Ollama HTTP helpers ──────────────────────────────────────

function ollamaPost(endpoint, body, timeout = EMBED_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, OLLAMA_BASE);
        const data = JSON.stringify(body);
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout,
        }, (res) => {
            let buf = '';
            res.on('data', chunk => buf += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch { resolve({ response: buf }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

// ── Embedding ────────────────────────────────────────────────

async function checkEmbedModel() {
    try {
        const result = await ollamaPost('/api/embed', {
            model: EMBED_MODEL,
            input: ['test'],
        }, 10000);
        _embedAvailable = !!(result?.embeddings?.length > 0);
        return _embedAvailable;
    } catch {
        _embedAvailable = false;
        return false;
    }
}

async function embedTexts(texts) {
    if (!_embedAvailable) return null;
    try {
        const result = await ollamaPost('/api/embed', {
            model: EMBED_MODEL,
            input: texts,
        }, EMBED_TIMEOUT);
        return result?.embeddings || null;
    } catch {
        return null;
    }
}

async function embedSingle(text) {
    const result = await embedTexts([text]);
    return result ? result[0] : null;
}

// ── Vector Store ─────────────────────────────────────────────

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}

// ── Checkpoint helpers ───────────────────────────────────────

function getCheckpointPath() {
    return _dataDir ? path.join(_dataDir, 'rag_checkpoint.json') : null;
}

function saveCheckpoint(embeddedCount, totalChunks, vectors, docMeta) {
    const cpPath = getCheckpointPath();
    if (!cpPath) return;
    try {
        // Save vectors so far
        const vecPath = path.join(_dataDir, 'rag_vectors_partial.bin');
        const vecSlice = new Float32Array(vectors.buffer, 0, embeddedCount * EMBED_DIM * 4);
        fs.writeFileSync(vecPath, Buffer.from(vectors.buffer, 0, embeddedCount * EMBED_DIM * 4));
        fs.writeFileSync(cpPath, JSON.stringify({
            embeddedCount,
            totalChunks,
            dim: EMBED_DIM,
            meta: docMeta.slice(0, embeddedCount).map(m => ({
                docId: m.docId, title: m.title,
                relPath: m.relPath, type: m.type,
            })),
            savedAt: Date.now(),
        }));
        console.log(`[RAG] Checkpoint: ${embeddedCount}/${totalChunks} chunks saved`);
    } catch (e) {
        console.warn('[RAG] Checkpoint save error:', e.message);
    }
}

function loadCheckpoint() {
    const cpPath = getCheckpointPath();
    if (!cpPath || !fs.existsSync(cpPath)) return null;
    try {
        const vecPath = path.join(_dataDir, 'rag_vectors_partial.bin');
        if (!fs.existsSync(vecPath)) return null;

        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));

        // Don't resume checkpoints older than 24h (corpus may have changed significantly)
        if (Date.now() - cp.savedAt > 86400000) {
            console.log('[RAG] Checkpoint too old (>24h), discarding');
            clearCheckpoint();
            return null;
        }

        const vecBuf = fs.readFileSync(vecPath);
        const vectors = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4);
        console.log(`[RAG] Resuming from checkpoint: ${cp.embeddedCount}/${cp.totalChunks}`);
        return { ...cp, vectors };
    } catch (e) {
        console.warn('[RAG] Checkpoint load error:', e.message);
        return null;
    }
}

function clearCheckpoint() {
    try {
        const cpPath = getCheckpointPath();
        const vecPath = _dataDir ? path.join(_dataDir, 'rag_vectors_partial.bin') : null;
        if (cpPath && fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
        if (vecPath && fs.existsSync(vecPath)) fs.unlinkSync(vecPath);
    } catch { /* ignore */ }
}

// ── Build Index (crash-resilient) ────────────────────────────

async function buildIndex(onProgress) {
    if (!_dbRef) return { success: false, reason: 'No database' };

    await checkEmbedModel();

    const rows = _dbRef.dbAll(`
        SELECT s.doc_id, s.title, s.content, s.rel_path, s.type
        FROM search_index s
        WHERE s.content IS NOT NULL AND length(s.content) > 50
    `);

    if (rows.length === 0) return { success: false, reason: 'No documents' };

    if (onProgress) onProgress(0, `Indexing ${rows.length} documents...`);

    // Chunk documents into smaller pieces for better retrieval
    const chunks = [];
    for (const row of rows) {
        const content = row.content || '';
        const chunkSize = 800;
        const overlap = 150;

        if (content.length <= chunkSize) {
            chunks.push({
                docId: row.doc_id,
                title: row.title || '',
                relPath: row.rel_path || '',
                type: row.type || '',
                chunkText: content,
            });
        } else {
            let start = 0, idx = 0;
            while (start < content.length && idx < 15) { // max 15 chunks per doc
                const slice = content.substring(start, start + chunkSize);
                chunks.push({
                    docId: row.doc_id,
                    title: row.title || '',
                    relPath: row.rel_path || '',
                    type: row.type || '',
                    chunkText: slice,
                });
                start += chunkSize - overlap;
                idx++;
            }
        }
    }

    if (!_embedAvailable) {
        // Store chunks without embeddings — will use keyword fallback
        _docMeta = chunks;
        _vectors = null;
        _indexBuilt = true;
        _indexBuildTime = Date.now();
        if (onProgress) onProgress(100, `Indexed ${chunks.length} chunks (keyword mode)`);
        return { success: true, mode: 'keyword', chunks: chunks.length, docs: rows.length };
    }

    // ── Memory-efficient embedding with checkpoint/resume ────
    //
    // Pre-allocate the FULL Float32Array up front. Write directly into it
    // per batch — never accumulate intermediate JS arrays.
    //
    const totalChunks = chunks.length;
    let startBatch = 0;
    let vectors;

    // Check for checkpoint (resume after crash)
    const checkpoint = loadCheckpoint();
    if (checkpoint && checkpoint.totalChunks === totalChunks) {
        // Resume: copy partial vectors into full-size buffer
        vectors = new Float32Array(totalChunks * EMBED_DIM);
        vectors.set(checkpoint.vectors);
        startBatch = Math.floor(checkpoint.embeddedCount / BATCH_SIZE) * BATCH_SIZE;
        const pct = Math.round((startBatch / totalChunks) * 100);
        if (onProgress) onProgress(pct, `Resuming from checkpoint: ${startBatch}/${totalChunks}`);
        console.log(`[RAG] Resuming embedding from batch ${startBatch}/${totalChunks}`);
    } else {
        vectors = new Float32Array(totalChunks * EMBED_DIM); // Pre-allocate (3KB per chunk)
        if (checkpoint) {
            console.log('[RAG] Corpus changed since checkpoint, starting fresh');
            clearCheckpoint();
        }
    }

    let batchesSinceCheckpoint = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;

    for (let i = startBatch; i < totalChunks; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, totalChunks);
        const batch = chunks.slice(i, batchEnd);
        const texts = batch.map(c => `${c.title}\n${c.chunkText}`.substring(0, 2000));

        try {
            const embeddings = await embedTexts(texts);
            if (embeddings) {
                // Write directly into pre-allocated Float32Array — NO intermediate arrays
                for (let b = 0; b < embeddings.length; b++) {
                    const offset = (i + b) * EMBED_DIM;
                    const vec = embeddings[b];
                    for (let d = 0; d < EMBED_DIM; d++) {
                        vectors[offset + d] = vec[d] || 0;
                    }
                }
                consecutiveFailures = 0;
            } else {
                // Zeros already in place (Float32Array init)
                consecutiveFailures++;
            }
        } catch (e) {
            // Zeros already in place
            consecutiveFailures++;
            console.warn(`[RAG] Embed batch ${i}-${batchEnd} failed: ${e.message}`);
        }

        // Abort if Ollama keeps failing (probably crashed/OOM'd itself)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[RAG] ${MAX_CONSECUTIVE_FAILURES} consecutive embed failures — saving checkpoint and aborting`);
            saveCheckpoint(i, totalChunks, vectors, chunks);
            // Fall through to keyword mode with partial embeddings
            break;
        }

        const pct = Math.round((batchEnd / totalChunks) * 100);
        if (onProgress) onProgress(pct, `Embedding: ${batchEnd}/${totalChunks}`);

        // Checkpoint every N batches
        batchesSinceCheckpoint++;
        if (batchesSinceCheckpoint >= CHECKPOINT_INTERVAL) {
            saveCheckpoint(batchEnd, totalChunks, vectors, chunks);
            batchesSinceCheckpoint = 0;
        }

        // Yield event loop — let Electron breathe
        await new Promise(resolve => setImmediate(resolve));
    }

    // ── Finalize ─────────────────────────────────────────────
    _vectors = vectors;
    _docMeta = chunks;
    _indexBuilt = true;
    _indexBuildTime = Date.now();

    // Save final index and clean up checkpoint
    if (_dataDir) {
        saveIndex(_dataDir);
        clearCheckpoint();
    }

    if (onProgress) onProgress(100, `Indexed ${totalChunks} chunks (semantic mode)`);
    return { success: true, mode: 'semantic', chunks: totalChunks, docs: rows.length };
}

function saveIndex(dataDir) {
    if (!_vectors || !_docMeta.length) return;
    try {
        const metaPath = path.join(dataDir, 'rag_meta.json');
        const vecPath = path.join(dataDir, 'rag_vectors.bin');
        fs.writeFileSync(metaPath, JSON.stringify({
            dim: EMBED_DIM,
            count: _docMeta.length,
            builtAt: _indexBuildTime,
            meta: _docMeta.map(m => ({
                docId: m.docId, title: m.title,
                relPath: m.relPath, type: m.type,
            })),
        }));
        fs.writeFileSync(vecPath, Buffer.from(_vectors.buffer));
        console.log(`[RAG] Saved index: ${_docMeta.length} chunks`);
    } catch (e) {
        console.error('[RAG] Save error:', e.message);
    }
}

function loadIndexBackground(dataDir, onProgress) {
    try {
        if (dataDir) _dataDir = dataDir; 
        const dir = _dataDir || dataDir;
        if (!dir) return false;
        
        const metaPath = path.join(dir, 'rag_meta.json');
        const vecPath = path.join(dir, 'rag_vectors.bin');
        if (!fs.existsSync(metaPath) || !fs.existsSync(vecPath)) return false;

        // 1. Sync load metadata (Fast, ~1s)
        console.log('[RAG] Loading metadata...');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        _docMeta = meta.meta.map(m => ({
            ...m,
            chunkText: '', 
        }));
        _indexBuildTime = meta.builtAt;

        // 2. Fast off-heap allocation (OS lazy pages, 0ms)
        const stats = fs.statSync(vecPath);
        const buffer = Buffer.alloc(stats.size); 
        _vectors = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
        _indexBuilt = true; 

        // 3. Silently stream the 1.8GB file into the buffer directly using C++ IO handles
        // Chunk sizes keep the UI thread buttery smooth (60fps)
        const fd = fs.openSync(vecPath, 'r');
        const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB
        let position = 0;

        const readLoop = async () => {
            while (position < stats.size) {
                const bytesToRead = Math.min(CHUNK_SIZE, stats.size - position);
                fs.readSync(fd, buffer, position, bytesToRead, position);
                position += bytesToRead;
                
                if (onProgress) {
                    const pct = Math.round((position / stats.size) * 100);
                    onProgress(pct, `Loading AI Index: ${pct}%`);
                }
                
                // Absolute yield to Main Thread event loop per chunk (using setTimeout to allow network I/O)
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            fs.closeSync(fd);
            console.log(`[RAG] Streaming load complete: ${_docMeta.length} chunks initialized into memory.`);
        };

        // Fire and forget background routine
        readLoop().catch(e => console.error('[RAG] Background stream error:', e));

        return true;
    } catch (e) {
        console.error('[RAG] Background load error:', e.message);
        return false;
    }
}

// ── Retrieval ────────────────────────────────────────────────

async function retrieveChunks(query, topK = TOP_K) {
    if (!_indexBuilt || !_docMeta.length) return [];

    if (_vectors && _embedAvailable) {
        // Semantic retrieval
        const queryVec = await embedSingle(query);
        if (queryVec) {
            const scores = [];
            for (let i = 0; i < _docMeta.length; i++) {
                const docVec = _vectors.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM);
                const sim = cosineSimilarity(queryVec, docVec);
                scores.push({ index: i, score: sim });
            }
            scores.sort((a, b) => b.score - a.score);
            const topResults = scores.slice(0, topK);

            // Load chunk text from DB for top results
            return topResults.map(s => {
                const meta = _docMeta[s.index];
                let chunkText = meta.chunkText;
                if (!chunkText && _dbRef) {
                    const row = _dbRef.dbGet(
                        `SELECT content FROM search_index WHERE doc_id = ?`,
                        [meta.docId]
                    );
                    chunkText = row?.content || '';
                }
                return {
                    docId: meta.docId,
                    title: meta.title,
                    relPath: meta.relPath,
                    type: meta.type,
                    score: s.score,
                    text: chunkText,
                };
            }).filter(r => r.score > 0.15);
        }
    }

    // Keyword fallback — use MiniSearch from db module
    if (_dbRef) {
        const results = _dbRef.searchDocuments(query);
        return results.slice(0, topK).map(r => ({
            docId: 0,
            title: r.title || '',
            relPath: r.rel_path || '',
            type: r.type || '',
            score: 0.5,
            text: r.content || r.snippet || '',
        }));
    }

    return [];
}

// ── Chat ─────────────────────────────────────────────────────

async function chat(query) {
    if (!query || query.trim().length < 3) {
        return { answer: 'Please ask a more specific question.', sources: [] };
    }

    const chunks = await retrieveChunks(query);

    // Build context from retrieved chunks
    let context = '';
    const sources = [];
    const seenPaths = new Set();

    for (const chunk of chunks) {
        if (context.length > MAX_CONTEXT_CHARS) break;

        const text = (chunk.text || '').substring(0, 1500);
        context += `\n--- Source: ${chunk.title} (${chunk.relPath}) ---\n${text}\n`;

        if (!seenPaths.has(chunk.relPath)) {
            seenPaths.add(chunk.relPath);
            sources.push({
                title: chunk.title,
                relPath: chunk.relPath,
                type: chunk.type,
                score: chunk.score,
            });
        }
    }

    // Build conversation context from recent history
    const recentHistory = _chatHistory.slice(-4).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 300)}`
    ).join('\n');

    const systemPrompt = `You are an AI research assistant embedded in "Veritas Vault", a developer's knowledge management system. You have access to the developer's captured sessions, notes, knowledge items, and project documentation.

RULES:
- Answer based ONLY on the provided source context. If the context doesn't contain relevant information, say so explicitly.
- Be specific: cite file paths, function names, vulnerability types, protocol names, and exact technical details from the sources.
- Do NOT make up information. Do NOT hallucinate technical details not present in the sources.
- When referencing a source, mention it naturally (e.g., "In your Ethena audit..." or "Based on the OmegaWallet session...").
- Be direct and technical. No fluff. The developer is an expert security researcher.
- If multiple sources are relevant, synthesize across them.
- Keep answers focused and actionable.`;

    const prompt = `${recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : ''}Source context from your knowledge base:
${context || '(No relevant sources found)'}

User question: ${query}

Answer based on the above sources. Be specific and cite the sources naturally.`;

    try {
        const result = await ollamaPost('/api/generate', {
            model: CHAT_MODEL,
            prompt,
            system: systemPrompt,
            stream: false,
            options: {
                temperature: 0.3,
                num_predict: 1200,
                top_p: 0.9,
                repeat_penalty: 1.1,
            },
        }, CHAT_TIMEOUT);

        const answer = result?.response?.trim() || 'Unable to generate a response. Check if Ollama is running.';

        // Store in history
        _chatHistory.push({ role: 'user', content: query, timestamp: Date.now() });
        _chatHistory.push({ role: 'assistant', content: answer, sources, timestamp: Date.now() });

        // Cap history
        if (_chatHistory.length > MAX_HISTORY * 2) {
            _chatHistory = _chatHistory.slice(-MAX_HISTORY * 2);
        }

        return { answer, sources, mode: _vectors ? 'semantic' : 'keyword' };
    } catch (e) {
        // Ollama offline — provide keyword results only
        const fallback = sources.length > 0
            ? `I found ${sources.length} relevant documents but couldn't generate a synthesis (Ollama offline):\n\n${sources.map(s => `• **${s.title}** — ${s.relPath}`).join('\n')}`
            : 'Ollama is offline and no relevant documents were found. Start Ollama to enable AI chat.';

        return { answer: fallback, sources, mode: 'offline' };
    }
}

function getChatHistory() {
    return _chatHistory.map(m => ({
        role: m.role,
        content: m.content,
        sources: m.sources || [],
        timestamp: m.timestamp,
    }));
}

function clearHistory() {
    _chatHistory = [];
}

function getStats() {
    return {
        indexBuilt: _indexBuilt,
        chunkCount: _docMeta.length,
        vectorMode: _vectors ? 'semantic' : 'keyword',
        embedAvailable: _embedAvailable,
        buildTime: _indexBuildTime,
        historyLength: _chatHistory.length,
    };
}

module.exports = {
    init,
    checkEmbedModel,
    buildIndex,
    loadIndexBackground,
    retrieveChunks,
    chat,
    getChatHistory,
    clearHistory,
    getStats,
};
