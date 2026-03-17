/**
 * VERITAS VAULT — Capture Server
 * ════════════════════════════════════════════════════════════════
 * HTTP server receiving captured sessions from Chrome extension.
 * Bearer token auth + restricted CORS + offline queue drain on connect.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CAPTURE_PORT = 47831;
const CAPTURE_MAX_BODY = 5e6; // 5MB max request body
const SERVER_VERSION = '3.0.0';

function createCaptureServer({ store, archivist, journal, getMainWindow, capturesDir, dataDir, onCaptureComplete }) {
    let server = null;
    let captureToken = null;

    // ── Rate Limiter (10 req/min per IP) ─────────────────────────
    const RATE_LIMIT = 30;
    const RATE_WINDOW = 60000; // 1 minute
    const _rateBuckets = new Map(); // IP -> { count, resetAt }

    function checkRateLimit(ip) {
        const now = Date.now();
        let bucket = _rateBuckets.get(ip);
        if (!bucket || now > bucket.resetAt) {
            bucket = { count: 0, resetAt: now + RATE_WINDOW };
            _rateBuckets.set(ip, bucket);
        }
        bucket.count++;
        return bucket.count <= RATE_LIMIT;
    }

    // Auto-clean stale buckets every 5 min
    setInterval(() => {
        const now = Date.now();
        for (const [ip, bucket] of _rateBuckets) {
            if (now > bucket.resetAt) _rateBuckets.delete(ip);
        }
    }, 300000);

    function initToken() {
        captureToken = store.get('captureToken');
        if (!captureToken) {
            captureToken = crypto.randomBytes(32).toString('hex');
            store.set('captureToken', captureToken);
            console.log('[Vault] Generated new capture token');
        }
    }

    function getToken() { return captureToken; }

    function saveCapturedSession(data) {
        const { source = 'unknown', title = 'Untitled', turns = [], url = '', timestamp } = data;
        const sourceDir = path.join(capturesDir, source);
        if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });

        const ts = timestamp ? new Date(timestamp) : new Date();
        const dateStr = ts.toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const filename = `${dateStr}_${title.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50).trim().replace(/\s+/g, '_')}.md`;
        const filePath = path.join(sourceDir, filename);

        // Format turns as markdown
        let md = `---\nsource: ${source}\ntitle: ${title}\nurl: ${url}\ncaptured: ${ts.toISOString()}\nturns: ${turns.length}\n---\n\n# ${title}\n\n`;
        for (const turn of turns) {
            const label = turn.role === 'user' ? '**You**' :
                turn.role === 'model' ? (source === 'chatgpt' ? '**ChatGPT**' : source === 'claude' ? '**Claude**' : '**Gemini**') : '**' + turn.role + '**';
            md += `### ${label}\n\n${turn.text}\n\n`;
            if (turn.images && turn.images.length > 0) {
                for (const imgUrl of turn.images) {
                    md += `![image](${imgUrl})\n\n`;
                }
            }
            md += `---\n\n`;
        }

        // Dedup
        const contentHashVal = crypto.createHash('sha256').update(md).digest('hex').substring(0, 16);
        const existing = fs.existsSync(filePath);
        if (existing) {
            const existingHash = crypto.createHash('sha256')
                .update(fs.readFileSync(filePath, 'utf-8')).digest('hex').substring(0, 16);
            if (existingHash === contentHashVal) return { action: 'dedup', file: filename };
        }

        fs.writeFileSync(filePath, md, 'utf-8');

        // Metadata for journal engine — generate content-derived summary
        const metaPath = filePath + '.metadata.json';
        const summary = deriveCaptureSummary(title, turns, source);
        fs.writeFileSync(metaPath, JSON.stringify({
            artifactType: 'other',
            summary,
            updatedAt: ts.toISOString(),
            source: source,
            version: '1',
        }), 'utf-8');

        // Ingest into corpus
        archivist.ingestFile(filePath, dataDir);

        // Queue background AI summary enrichment (non-blocking)
        try {
            const vaultAI = require('./vault-ai');
            if (vaultAI && vaultAI.queueIngest) {
                vaultAI.queueIngest(filePath, 'capture');
            }
        } catch (e) { console.warn('[Capture] AI summary unavailable:', e.message); }

        // Notify renderer
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.webContents.send('vault:capture-event', {
                event: 'external_capture',
                source, title,
                path: `captures/${source}/${filename}`,
                timestamp: Date.now(),
            });
        }

        // Invalidate journal cache
        if (journal) journal.invalidateCache();

        // Trigger debounced RAG index rebuild so new captures are searchable
        if (onCaptureComplete) {
            try { onCaptureComplete(); } catch (e) { console.warn('[Capture] Post-capture hook:', e.message); }
        }

        console.log(`[Capture] Saved ${source} session: ${filename} (${turns.length} turns)`);
        return { action: existing ? 'updated' : 'captured', file: filename, turns: turns.length };
    }

    /**
     * Extract a real summary from conversation turns without AI.
     * Scans model responses for: file names, function names, actions taken, key topics.
     */
    function deriveCaptureSummary(title, turns, source) {
        const modelTurns = turns.filter(t => t.role === 'model' || t.role === 'assistant');
        if (modelTurns.length === 0) return `${source} session: ${title} (${turns.length} turns)`;

        // Collect all model response text (first 5000 chars to avoid perf issues)
        let modelText = modelTurns.map(t => t.text || '').join(' ');
        if (modelText.length > 5000) modelText = modelText.substring(0, 5000);

        // Extract file references
        const fileRefs = modelText.match(/\b[\w.-]+\.(js|py|sol|ts|jsx|tsx|css|html|json|rs|go|md|yaml|yml|toml)\b/gi);
        const uniqueFiles = fileRefs ? [...new Set(fileRefs)].slice(0, 5) : [];

        // Extract action verbs (what was done)
        const actions = [];
        const actionPatterns = [
            /\b(implemented|created|built|added|fixed|debugged|refactored|deployed|audited|analyzed|configured|migrated|updated|integrated|optimized)\b/gi,
        ];
        for (const pat of actionPatterns) {
            const matches = modelText.match(pat);
            if (matches) actions.push(...new Set(matches.map(m => m.toLowerCase())));
        }
        const uniqueActions = [...new Set(actions)].slice(0, 4);

        // Extract key technical terms (capitalized multi-word phrases, frameworks, etc.)
        const techTerms = modelText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
        const uniqueTerms = techTerms ? [...new Set(techTerms)].filter(t => t.length > 5).slice(0, 3) : [];

        // Extract first substantive sentence from model (not just "Sure, I'll help")
        const sentences = modelText.split(/[.!]\s+/).filter(s => s.length > 30 && !s.match(/^(Sure|Of course|I'll|Let me|Here's|Certainly)/i));
        const firstSubstantive = sentences.length > 0 ? sentences[0].trim() : '';

        // Build summary
        const parts = [];
        if (uniqueActions.length > 0 && uniqueFiles.length > 0) {
            parts.push(`${uniqueActions.slice(0, 2).join(', ')} in ${uniqueFiles.slice(0, 3).join(', ')}`);
        } else if (uniqueActions.length > 0) {
            parts.push(uniqueActions.join(', '));
        }
        if (uniqueTerms.length > 0) {
            parts.push(uniqueTerms.join(', '));
        }
        if (firstSubstantive && parts.length === 0) {
            const truncSentence = firstSubstantive.length > 150 ? firstSubstantive.substring(0, 150) + '…' : firstSubstantive;
            parts.push(truncSentence);
        }

        if (parts.length > 0) {
            const summary = parts.join('. ');
            return summary.length > 250 ? summary.substring(0, 250) + '…' : summary;
        }
        return `${source} session: ${title} (${turns.length} turns)`;
    }

    function start() {
        server = http.createServer((req, res) => {
            // Restricted CORS — only chrome-extension origins
            const origin = req.headers.origin || '';
            if (origin.startsWith('chrome-extension://') || origin === '') {
                res.setHeader('Access-Control-Allow-Origin', origin || 'chrome-extension://*');
            }
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

            if (req.method === 'POST' && req.url === '/capture') {
                // Rate limiting
                const clientIP = req.socket.remoteAddress || '127.0.0.1';
                if (!checkRateLimit(clientIP)) {
                    console.warn(`[Capture] Rate limited: ${clientIP}`);
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end('{"ok":false,"reason":"rate_limited"}');
                    return;
                }

                // Bearer token auth
                const authHeader = req.headers.authorization || '';
                const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
                if (!token || token !== captureToken) {
                    console.warn('[Capture] Rejected: invalid or missing auth token');
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end('{"ok":false,"reason":"unauthorized"}');
                    return;
                }

                let body = '';
                req.on('data', chunk => { body += chunk; if (body.length > CAPTURE_MAX_BODY) { req.destroy(); } });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        if (!data.source || !Array.isArray(data.turns) || data.turns.length === 0) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end('{"ok":false,"reason":"invalid_payload"}');
                            return;
                        }
                        const result = saveCapturedSession(data);

                        // Version handshake: warn if extension version drifts
                        let versionWarning = null;
                        const extVer = data.extensionVersion || 'unknown';
                        if (extVer === 'unknown') {
                            versionWarning = 'Extension version not reported; update extension to v' + SERVER_VERSION;
                            console.warn('[Capture] Extension did not report version');
                        } else {
                            const extMajor = extVer.split('.')[0];
                            const srvMajor = SERVER_VERSION.split('.')[0];
                            if (extMajor !== srvMajor) {
                                versionWarning = `Extension v${extVer} may be incompatible with server v${SERVER_VERSION}. Please reload the extension.`;
                                console.warn(`[Capture] Version mismatch: extension=${extVer}, server=${SERVER_VERSION}`);
                            }
                        }

                        const response = { ok: true, ...result, serverVersion: SERVER_VERSION };
                        if (versionWarning) response.versionWarning = versionWarning;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(response));
                    } catch (e) {
                        console.error('[Capture] Parse error:', e.message);
                        res.writeHead(400); res.end('{"ok":false}');
                    }
                });
            } else if (req.method === 'GET' && req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true,"version":"3.0.0"}');
            } else if (req.method === 'GET' && req.url === '/token') {
                // Localhost-only token fetch — safe because server binds to 127.0.0.1
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, token: captureToken }));
            } else {
                res.writeHead(404); res.end('{"ok":false}');
            }
        });

        server.listen(CAPTURE_PORT, '127.0.0.1', () => {
            console.log(`[Vault] Capture server listening on localhost:${CAPTURE_PORT} (auth required)`);
        });
        server.on('error', (e) => {
            console.error('[Vault] Capture server error:', e.message);
        });
    }

    function stop() {
        if (server) {
            try { server.close(); } catch (e) { console.warn('[Capture] Server close:', e.message); }
            server = null;
        }
    }

    return { initToken, getToken, start, stop };
}

module.exports = createCaptureServer;
