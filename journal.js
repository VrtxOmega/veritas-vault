/**
 * VERITAS VAULT — Journal Engine
 * ════════════════════════════════════════════════════════════════
 * Smart notebook core: daily digests, project threads, momentum,
 * task tracking, morning brief. High-assurance audit chain.
 *
 * Dependency-injected: receives db helpers, paths, and node modules.
 */

const ARTIFACT_TYPE_MAP = {
    'ARTIFACT_TYPE_IMPLEMENTATION_PLAN': 'Plan',
    'ARTIFACT_TYPE_WALKTHROUGH': 'Walkthrough',
    'ARTIFACT_TYPE_TASK': 'Task',
    'ARTIFACT_TYPE_OTHER': 'Document',
    'implementation_plan': 'Plan',
    'walkthrough': 'Walkthrough',
    'task': 'Task',
    'other': 'Document',
};

const CACHE_TTL = 30000; // 30s

module.exports = function createJournalEngine(deps) {
    const { ANTIGRAVITY_ROOT, capturesDir, dbAll, dbGet, dbRun, scheduleSave, crypto, path, fs } = deps;

    let _brainCache = null, _brainCacheTime = 0;
    let _knowledgeCache = null, _knowledgeCacheTime = 0;
    let _lastAuditHash = '0000000000000000';

    /** Convert Date to local YYYY-MM-DD string (avoids UTC shift). */
    function toLocalDateStr(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    // ── Audit Chain (high-assurance) ─────────────────────────────

    function auditLog(action, detail = '') {
        const now = Date.now() / 1000;
        const payload = `${_lastAuditHash}:${action}:${detail}:${now}`;
        const hash = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
        dbRun(
            'INSERT INTO journal_audit (action, detail, integrity_hash, prev_hash, timestamp) VALUES (?, ?, ?, ?, ?)',
            [action, detail, hash, _lastAuditHash, now]
        );
        _lastAuditHash = hash;
        scheduleSave();
    }

    function initAuditChain() {
        const last = dbGet('SELECT integrity_hash FROM journal_audit ORDER BY id DESC LIMIT 1');
        if (last) _lastAuditHash = last.integrity_hash;
    }

    // ── Brain Artifact Scanner ───────────────────────────────────

    function scanBrainArtifacts() {
        if (_brainCache && Date.now() - _brainCacheTime < CACHE_TTL) return _brainCache;

        const brainDir = path.join(ANTIGRAVITY_ROOT, 'brain');
        if (!fs.existsSync(brainDir)) { _brainCache = []; _brainCacheTime = Date.now(); return []; }

        const results = [];
        let entries;
        try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { return []; }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const convId = entry.name;
            const convPath = path.join(brainDir, convId);

            let files;
            try { files = fs.readdirSync(convPath); } catch { continue; }

            const metaFiles = files.filter(f => f.endsWith('.metadata.json') && !f.startsWith('.'));

            for (const metaFile of metaFiles) {
                try {
                    const raw = fs.readFileSync(path.join(convPath, metaFile), 'utf-8');
                    const meta = JSON.parse(raw);

                    const artifactFile = metaFile.replace('.metadata.json', '');
                    const absPath = path.join(convPath, artifactFile);

                    // Use the LATEST of metadata updatedAt vs file mtime
                    // Metadata timestamps go stale; file mtime reflects real activity
                    let effectiveTime;
                    try {
                        const fileStat = fs.statSync(absPath);
                        const metaTime = meta.updatedAt ? new Date(meta.updatedAt).getTime() : 0;
                        const mtime = fileStat.mtimeMs;
                        effectiveTime = new Date(Math.max(metaTime, mtime)).toISOString();
                    } catch {
                        effectiveTime = meta.updatedAt || new Date().toISOString();
                    }

                    let heading = null;
                    try {
                        const content = fs.readFileSync(absPath, 'utf-8');
                        const m = content.match(/^#\s+(.+)/m);
                        if (m) heading = m[1].trim();
                    } catch { /* no file or unreadable */ }

                    results.push({
                        conversationId: convId,
                        file: artifactFile,
                        heading,
                        type: ARTIFACT_TYPE_MAP[meta.artifactType] || ARTIFACT_TYPE_MAP[(meta.artifactType || '').replace('ARTIFACT_TYPE_', '').toLowerCase()] || 'Document',
                        summary: meta.summary || '',
                        updatedAt: effectiveTime,
                        version: meta.version || '1',
                        absPath,
                    });
                } catch { continue; }
            }
        }

        // Second pass: discover conversations with artifacts but NO metadata files
        // This catches sessions where the agent didn't produce .metadata.json
        const discoveredConvIds = new Set(results.map(r => r.conversationId));
        const KNOWN_ARTIFACTS = ['task.md', 'implementation_plan.md', 'walkthrough.md'];

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const convId = entry.name;
            if (discoveredConvIds.has(convId)) continue; // Already found via metadata

            const convPath = path.join(brainDir, convId);
            let files;
            try { files = fs.readdirSync(convPath); } catch { continue; }

            for (const knownFile of KNOWN_ARTIFACTS) {
                if (!files.includes(knownFile)) continue;
                const absPath = path.join(convPath, knownFile);
                try {
                    const stat = fs.statSync(absPath);
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const m = content.match(/^#\s+(.+)/m);
                    const heading = m ? m[1].trim() : knownFile.replace('.md', '').replace(/_/g, ' ');
                    const typeMap = { 'task.md': 'Task', 'implementation_plan.md': 'Plan', 'walkthrough.md': 'Walkthrough' };

                    results.push({
                        conversationId: convId,
                        file: knownFile,
                        heading,
                        type: typeMap[knownFile] || 'Document',
                        summary: heading,
                        updatedAt: stat.mtime.toISOString(),
                        version: '1',
                        absPath,
                    });
                    discoveredConvIds.add(convId);
                } catch { continue; }
            }
        }

        _brainCache = results;
        _brainCacheTime = Date.now();

        // Also scan Hermes agent sessions, artifacts, and knowledge under hermes/ subdirectory
        const hermesRoot = path.join(ANTIGRAVITY_ROOT, 'hermes');
        if (fs.existsSync(hermesRoot)) {
            for (const subDir of ['sessions', 'artifacts', 'knowledge']) {
                const hermesSubPath = path.join(hermesRoot, subDir);
                if (!fs.existsSync(hermesSubPath)) continue;
                try {
                    const dateDirs = fs.readdirSync(hermesSubPath, { withFileTypes: true });
                    for (const dateDir of dateDirs) {
                        if (!dateDir.isDirectory()) continue;
                        const datePath = path.join(hermesSubPath, dateDir.name);
                        let files;
                        try { files = fs.readdirSync(datePath); } catch { continue; }
                        const metaFiles = files.filter(f => f.endsWith('.metadata.json') && !f.startsWith('.'));
                        for (const metaFile of metaFiles) {
                            try {
                                const raw = fs.readFileSync(path.join(datePath, metaFile), 'utf-8');
                                const meta = JSON.parse(raw);
                                const artifactFile = metaFile.replace('.metadata.json', '');
                                const absPath = path.join(datePath, artifactFile);
                                let heading = null;
                                if (fs.existsSync(absPath)) {
                                    try {
                                        const content = fs.readFileSync(absPath, 'utf-8');
                                        const m = content.match(/^#\s+(.+)/m);
                                        if (m) heading = m[1].trim();
                                    } catch { /* no heading */ }
                                }
                                const effectiveTime = meta.updatedAt
                                    || (fs.existsSync(absPath) ? fs.statSync(absPath).mtime.toISOString() : new Date().toISOString());
                                results.push({
                                    conversationId: meta.session_id || `${subDir}:${artifactFile}`,
                                    file: artifactFile,
                                    heading: heading || meta.task || meta.title || subDir,
                                    type: subDir === 'sessions' ? 'Session' : subDir === 'artifacts' ? 'Artifact' : 'Knowledge',
                                    summary: meta.summary || meta.task || meta.outcome || '',
                                    updatedAt: effectiveTime,
                                    version: meta.version || '1',
                                    absPath,
                                    source: meta.source || 'hermes-agent',
                                });
                            } catch { continue; }
                        }
                    }
                } catch { continue; }
            }
        }

        // Also scan captured sessions (Gemini, ChatGPT, etc.)
        if (capturesDir && fs.existsSync(capturesDir)) {
            try {
                const sources = fs.readdirSync(capturesDir, { withFileTypes: true });
                for (const srcEntry of sources) {
                    if (!srcEntry.isDirectory()) continue;
                    const source = srcEntry.name;

                    // Handle _archived/{source}/ subdirectories for historical captures
                    if (source === '_archived') {
                        const archivedDir = path.join(capturesDir, '_archived');
                        try {
                            const archivedSources = fs.readdirSync(archivedDir, { withFileTypes: true });
                            for (const archivedSrc of archivedSources) {
                                if (!archivedSrc.isDirectory()) continue;
                                const arcSrcDir = path.join(archivedDir, archivedSrc.name);
                                let arcFiles;
                                try { arcFiles = fs.readdirSync(arcSrcDir); } catch { continue; }
                                const arcMetaFiles = arcFiles.filter(f => f.endsWith('.metadata.json'));
                                for (const metaFile of arcMetaFiles) {
                                    try {
                                        const raw = fs.readFileSync(path.join(arcSrcDir, metaFile), 'utf-8');
                                        const meta = JSON.parse(raw);
                                        if (!meta.updatedAt) continue;
                                        const artifactFile = metaFile.replace('.metadata.json', '');
                                        const absPath = path.join(arcSrcDir, artifactFile);
                                        let heading = null;
                                        try {
                                            const content = fs.readFileSync(absPath, 'utf-8');
                                            const m = content.match(/^#\s+(.+)/m);
                                            if (m) heading = m[1].trim();
                                        } catch (e) { console.warn('[Journal] Digest capture parse:', e.message); }
                                        results.push({
                                            conversationId: `${archivedSrc.name}:${artifactFile}`,
                                            file: artifactFile, heading, type: 'Session',
                                            summary: meta.summary || '', updatedAt: meta.updatedAt,
                                            version: meta.version || '1', absPath,
                                            source: meta.source || archivedSrc.name,
                                        });
                                    } catch { continue; }
                                }
                            }
                        } catch { /* _archived unreadable */ }
                        continue;
                    }

                    const srcDir = path.join(capturesDir, source);
                    let files;
                    try { files = fs.readdirSync(srcDir); } catch { continue; }

                    const metaFiles = files.filter(f => f.endsWith('.metadata.json'));
                    for (const metaFile of metaFiles) {
                        try {
                            const raw = fs.readFileSync(path.join(srcDir, metaFile), 'utf-8');
                            const meta = JSON.parse(raw);
                            if (!meta.updatedAt) continue;

                            const artifactFile = metaFile.replace('.metadata.json', '');
                            const absPath = path.join(srcDir, artifactFile);
                            let heading = null;
                            try {
                                const content = fs.readFileSync(absPath, 'utf-8');
                                const m = content.match(/^#\s+(.+)/m);
                                if (m) heading = m[1].trim();
                            } catch (e) { console.warn('[Journal] Digest date parse:', e.message); }

                            results.push({
                                conversationId: `${source}:${artifactFile}`,
                                file: artifactFile,
                                heading,
                                type: 'Session',
                                summary: meta.summary || '',
                                updatedAt: meta.updatedAt,
                                version: meta.version || '1',
                                absPath,
                                source: meta.source || source,
                            });
                        } catch { continue; }
                    }
                }
            } catch { /* captures dir unreadable */ }
        }

        return results;
    }

    // ── Knowledge Item Scanner ───────────────────────────────────

    function scanKnowledgeItems() {
        if (_knowledgeCache && Date.now() - _knowledgeCacheTime < CACHE_TTL) return _knowledgeCache;

        const knowledgeDir = path.join(ANTIGRAVITY_ROOT, 'knowledge');
        if (!fs.existsSync(knowledgeDir)) { _knowledgeCache = []; _knowledgeCacheTime = Date.now(); return []; }

        const results = [];
        let entries;
        try { entries = fs.readdirSync(knowledgeDir, { withFileTypes: true }); } catch { return []; }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const metaPath = path.join(knowledgeDir, entry.name, 'metadata.json');
            try {
                const raw = fs.readFileSync(metaPath, 'utf-8');
                const meta = JSON.parse(raw);
                results.push({
                    topic: entry.name,
                    title: meta.title || entry.name.replace(/_/g, ' '),
                    summary: meta.summary || '',
                    references: (meta.references || []).filter(r => r.type === 'conversation_id').map(r => r.value),
                });
            } catch { continue; }
        }

        _knowledgeCache = results;
        _knowledgeCacheTime = Date.now();
        return results;
    }

    // ── Topic Extraction ─────────────────────────────────────────

    function extractTopicsForConversations(convIds) {
        const kis = scanKnowledgeItems();
        const convSet = new Set(convIds);
        const topics = [];
        for (const ki of kis) {
            if (ki.references.some(ref => convSet.has(ref))) {
                topics.push(ki.title);
            }
        }
        return topics;
    }

    // ── Session Summaries (Content-First) ────────────────────────

    /**
     * Extract a rich, specific summary from a session's artifacts.
     * Priority: task.md checklists → walkthrough outcomes → implementation_plan components → metadata summary.
     * AI is NEVER called here — all data comes from existing content.
     */
    function extractSessionSummary(artifacts) {
        const summaries = [];

        // 1. Task.md: extract completed/in-progress checklist items
        const taskArtifact = artifacts.find(a => a.type === 'Task' && a.absPath);
        if (taskArtifact) {
            try {
                const content = fs.readFileSync(taskArtifact.absPath, 'utf-8');
                const lines = content.split('\n');
                const completed = [];
                const inProgress = [];
                for (const line of lines) {
                    const t = line.trim();
                    if (t.startsWith('- [x]')) completed.push(t.substring(6).trim());
                    else if (t.startsWith('- [/]')) inProgress.push(t.substring(6).trim());
                }
                if (completed.length > 0 || inProgress.length > 0) {
                    const parts = [];
                    if (completed.length > 0) {
                        const shown = completed.slice(0, 3);
                        parts.push(`Done: ${shown.join('; ')}${completed.length > 3 ? ` (+${completed.length - 3} more)` : ''}`);
                    }
                    if (inProgress.length > 0) {
                        parts.push(`In progress: ${inProgress.slice(0, 2).join('; ')}`);
                    }
                    summaries.push(parts.join('. '));
                }
            } catch { /* unreadable */ }
        }

        // 2. Walkthrough: extract what was accomplished (first substantive paragraph)
        const walkthrough = artifacts.find(a => a.type === 'Walkthrough');
        if (walkthrough && walkthrough.summary && walkthrough.summary.length > 20) {
            summaries.push(walkthrough.summary);
        } else if (walkthrough && walkthrough.absPath) {
            try {
                const content = fs.readFileSync(walkthrough.absPath, 'utf-8');
                // Find first paragraph that isn't a heading
                const paras = content.split('\n\n').filter(p => !p.startsWith('#') && p.trim().length > 30);
                if (paras.length > 0) {
                    const first = paras[0].replace(/\n/g, ' ').trim();
                    summaries.push(first.length > 200 ? first.substring(0, 200) + '…' : first);
                }
            } catch { /* unreadable */ }
        }

        // 3. Implementation Plan: extract component/file targets
        const plan = artifacts.find(a => a.type === 'Plan');
        if (plan && plan.summary && plan.summary.length > 20) {
            summaries.push(plan.summary);
        } else if (plan && plan.absPath) {
            try {
                const content = fs.readFileSync(plan.absPath, 'utf-8');
                // Extract [MODIFY]/[NEW]/[DELETE] file targets
                const fileTargets = content.match(/\[(MODIFY|NEW|DELETE)\].*?\[([^\]]+)\]/g);
                if (fileTargets && fileTargets.length > 0) {
                    const cleaned = fileTargets.slice(0, 4).map(f => f.replace(/\[|\]/g, '').replace(/\(.*\)/, '').trim());
                    summaries.push(`Targets: ${cleaned.join(', ')}`);
                }
            } catch { /* unreadable */ }
        }

        // 4. Any artifact with a non-trivial metadata summary
        for (const a of artifacts) {
            if (a.summary && a.summary.length > 30 && !summaries.includes(a.summary)) {
                summaries.push(a.summary);
                break; // Only take one additional metadata summary
            }
        }

        // 5. For captured sessions: extract first substantial content paragraph
        if (summaries.length === 0) {
            for (const a of artifacts) {
                if (!a.absPath) continue;
                try {
                    const content = fs.readFileSync(a.absPath, 'utf-8');
                    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
                    // Find lines with technical content (file references, function names, etc.)
                    const techLines = lines.filter(l =>
                        /\.(js|py|sol|ts|css|html|md|json|rs|go)\b/.test(l) ||
                        /function\s|class\s|const\s|import\s|require\(/.test(l) ||
                        /\b(fixed|implemented|added|refactored|debugged|audited|deployed)\b/i.test(l)
                    );
                    if (techLines.length > 0) {
                        summaries.push(techLines.slice(0, 2).map(l => l.trim()).join('. '));
                    } else if (lines.length > 0) {
                        summaries.push(lines.slice(0, 2).map(l => l.trim()).join(' ').substring(0, 200));
                    }
                    break; // Only need content from one artifact
                } catch { continue; }
            }
        }

        // Select best summary: prefer content-derived over metadata
        if (summaries.length === 0) return '';

        // Pick the most specific one (longest, or task items if available)
        const best = summaries.sort((a, b) => b.length - a.length)[0];
        return best.length > 300 ? best.substring(0, 300) + '…' : best;
    }

    /**
     * Generate a short debrief (1-line) from artifact types present.
     * E.g., "Planned + implemented + verified" or "Audited security vulnerability"
     */
    function deriveSessionDebrief(artifacts) {
        const types = new Set(artifacts.map(a => a.type));
        const parts = [];
        if (types.has('Plan')) parts.push('Planned');
        if (types.has('Task')) parts.push('Tracked tasks');
        if (types.has('Walkthrough')) parts.push('Verified');
        if (types.has('Document')) parts.push('Documented');
        if (types.has('Session')) parts.push('Session captured');

        // Add technical flavor from headings
        const headings = artifacts.map(a => a.heading).filter(Boolean);
        const uniqueHeadings = [...new Set(headings)];
        if (uniqueHeadings.length > 0 && parts.length > 0) {
            return `${parts.join(' → ')} · ${uniqueHeadings[0]}`;
        }
        return parts.length > 0 ? parts.join(' → ') : '';
    }

    // ── Session Titles ───────────────────────────────────────────

    function deriveSessionTitle(artifacts) {
        // Prefer heading from plan/walkthrough/task/session
        for (const pref of ['Plan', 'Walkthrough', 'Task', 'Session', 'hermes_session', 'Document']) {
            const a = artifacts.find(x => x.type === pref);
            if (a) {
                if (a.heading) {
                    // Differentiate by adding artifact type when heading is generic
                    return a.heading;
                }
                if (a.summary) {
                    const first = a.summary.split(/[.!]\s/)[0];
                    return first.length > 120 ? first.substring(0, 120) + '…' : first;
                }
            }
        }
        // For captured sessions: strip ISO timestamp prefix and clean underscores
        const raw = artifacts.map(a => a.file.replace('.md', '')).join(', ');
        // Pattern: 2026-03-12T09-11-42_Actual_Title → Actual Title
        const cleaned = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '').replace(/_/g, ' ');
        return cleaned || raw;
    }

    /**
     * Collapse incremental capture snapshots of the same conversation into one representative session.
     * Groups by normalized heading + source, keeps the latest snapshot (by date), attaches snapshot count.
     * @param {Array} sessions - session objects with title, source, date, conversationId, summary, etc.
     * @returns {Array} deduplicated sessions with added snapshotCount, firstSeen, allConversationIds
     */
    function deduplicateCaptures(sessions) {
        const capturedSessions = sessions.filter(s => s.source && s.source !== 'antigravity');
        const agSessions = sessions.filter(s => !s.source || s.source === 'antigravity');

        // Group captured sessions by normalized title + source
        const groups = {};
        for (const s of capturedSessions) {
            const key = `${(s.title || '').toLowerCase().trim()}::${s.source}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(s);
        }

        const dedupedCaptures = [];
        for (const [, group] of Object.entries(groups)) {
            // Sort by date descending — latest first
            group.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            const latest = { ...group[0] };
            latest.snapshotCount = group.length;
            latest.allConversationIds = group.map(s => s.conversationId);
            latest.firstSeen = group[group.length - 1].date;
            latest.lastSeen = group[0].date;

            // Pick the best summary from any snapshot (longest non-generic one)
            const genericPat = /^\w+ session: .+ \(\d+ turns\)$/;
            const bestSummary = group
                .map(s => s.summary || '')
                .filter(s => s.length > 0 && !genericPat.test(s))
                .sort((a, b) => b.length - a.length)[0];
            if (bestSummary) latest.summary = bestSummary;

            dedupedCaptures.push(latest);
        }

        return [...agSessions, ...dedupedCaptures];
    }

    // ── Daily Narrative ──────────────────────────────────────────
    // Generates a human-like 1-2 sentence summary of the day's work

    function generateDayNarrative(sessions, topics) {
        if (!sessions || sessions.length === 0) return '';

        // Collect meaningful titles (skip generic ones)
        const titles = sessions
            .map(s => s.title || '')
            .filter(t => t.length > 5 && !/^(untitled|google gemini|chatgpt)$/i.test(t));

        // Extract unique project areas from topics
        const projectAreas = (topics || []).slice(0, 3);

        // Extract actions from summaries
        const allSummaryText = sessions.map(s => s.summary || '').join(' ');
        const actionWords = allSummaryText.match(/\b(implemented|built|fixed|created|upgraded|configured|audited|analyzed|deployed|integrated|refactored|consolidated|optimized|designed|tested|debugged|evaluated|migrated)\b/gi);
        const uniqueActions = actionWords ? [...new Set(actionWords.map(a => a.toLowerCase()))].slice(0, 4) : [];

        // Extract file/component references
        const fileRefs = allSummaryText.match(/\b[\w.-]+\.(js|py|sol|ts|css|html)\b/gi);
        const uniqueFiles = fileRefs ? [...new Set(fileRefs)].slice(0, 4) : [];

        // Build narrative
        const parts = [];

        // Lead with project focus
        if (projectAreas.length > 0) {
            if (projectAreas.length === 1) {
                parts.push(`Focused on **${projectAreas[0]}**`);
            } else {
                const last = projectAreas.pop();
                parts.push(`Worked across **${projectAreas.join('**, **')}** and **${last}**`);
            }
        }

        // Add what was done
        if (uniqueActions.length > 0) {
            const actionStr = uniqueActions.join(', ');
            if (uniqueFiles.length > 0) {
                parts.push(`${actionStr} changes in \`${uniqueFiles.join('`, `')}\``);
            } else if (titles.length > 0) {
                // Use session titles to describe work
                const shortTitles = titles.slice(0, 3).map(t => {
                    // Trim long titles
                    const cleaned = t.replace(/\s*—\s*.+$/, '').trim();
                    return cleaned.length > 40 ? cleaned.substring(0, 40) + '…' : cleaned;
                });
                parts.push(`${actionStr} — ${shortTitles.join(', ')}`);
            } else {
                parts.push(actionStr);
            }
        } else if (titles.length > 0) {
            // No actions found, use titles directly
            const shortTitles = titles.slice(0, 3).map(t => {
                const cleaned = t.replace(/\s*—\s*.+$/, '').trim();
                return cleaned.length > 40 ? cleaned.substring(0, 40) + '…' : cleaned;
            });
            parts.push(shortTitles.join(', '));
        }

        // Compose final narrative
        if (parts.length === 0) return `${sessions.length} session${sessions.length !== 1 ? 's' : ''} captured.`;

        let narrative = parts.join('. ') + '.';

        // Add count context if multiple sessions
        const captureCount = sessions.filter(s => s.source && s.source !== 'antigravity').length;
        if (captureCount > 0) {
            narrative += ` Plus ${captureCount} external capture${captureCount !== 1 ? 's' : ''}.`;
        }

        return narrative;
    }

    // ── Daily Digest ─────────────────────────────────────────────

    function buildDailyDigest(dateStr) {
        const targetDate = new Date(dateStr + 'T00:00:00');
        const nextDate = new Date(targetDate);
        nextDate.setDate(nextDate.getDate() + 1);

        const allArtifacts = scanBrainArtifacts();
        const dayArtifacts = allArtifacts.filter(a => {
            const d = new Date(a.updatedAt);
            return d >= targetDate && d < nextDate;
        });

        // Group by conversation
        const byConv = {};
        for (const a of dayArtifacts) {
            if (!byConv[a.conversationId]) byConv[a.conversationId] = [];
            byConv[a.conversationId].push(a);
        }

        const pinnedIds = new Set(dbAll('SELECT conversation_id FROM pinned_sessions').map(r => r.conversation_id));

        const sessions = Object.entries(byConv).map(([convId, artifacts]) => {
            const sorted = artifacts.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
            const source = sorted[0]?.source || 'antigravity';

            return {
                conversationId: convId,
                artifacts: sorted.map(a => ({ file: a.file, type: a.type, summary: a.summary, heading: a.heading })),
                title: deriveSessionTitle(sorted),
                summary: extractSessionSummary(sorted),
                debrief: deriveSessionDebrief(sorted),
                artifactCount: sorted.length,
                pinned: pinnedIds.has(convId),
                source,
            };
        });

        const convIds = sessions.map(s => s.conversationId);
        const topics = extractTopicsForConversations(convIds);

        // Quick notes for the day
        const notes = dbAll('SELECT id, content, created_at FROM quick_notes WHERE date_str = ? ORDER BY created_at DESC', [dateStr]);

        // Source grouping for declutter — dedup incremental captures
        const dedupedSessions = deduplicateCaptures(sessions);
        const sessionsBySource = {};
        for (const s of dedupedSessions) {
            const src = s.source || 'antigravity';
            if (!sessionsBySource[src]) sessionsBySource[src] = [];
            sessionsBySource[src].push(s);
        }

        // Production summary: top project names + source breakdown
        const sourceBreakdown = {};
        for (const [src, list] of Object.entries(sessionsBySource)) {
            sourceBreakdown[src] = list.length;
        }
        const topProjects = topics.slice(0, 3);

        // Generate human-readable day narrative
        const narrative = generateDayNarrative(dedupedSessions, topics);

        auditLog('digest_view', dateStr);

        return {
            date: dateStr,
            sessions: dedupedSessions,
            sessionsBySource,
            topics,
            notes,
            narrative,
            sessionCount: dedupedSessions.length,
            artifactCount: dayArtifacts.length,
            productionSummary: {
                sourceBreakdown,
                topProjects,
            },
        };
    }

    // ── Activity Dates & Momentum ────────────────────────────────

    function getActivityDates() {
        const all = scanBrainArtifacts();
        const dateMap = {};
        for (const a of all) {
            const ds = toLocalDateStr(new Date(a.updatedAt));
            dateMap[ds] = (dateMap[ds] || 0) + 1;
        }
        return dateMap;
    }

    function getMomentumData(days = 90) {
        const dates = getActivityDates();
        const today = new Date();
        const result = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const ds = toLocalDateStr(d);
            result.push({ date: ds, count: dates[ds] || 0 });
        }
        return result;
    }

    // ── Open Tasks Tracker ───────────────────────────────────────

    function getOpenTasks() {
        const brainDir = path.join(ANTIGRAVITY_ROOT, 'brain');
        if (!fs.existsSync(brainDir)) return [];

        const tasks = [];
        let entries;
        try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { return []; }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const taskPath = path.join(brainDir, entry.name, 'task.md');
            if (!fs.existsSync(taskPath)) continue;

            try {
                const content = fs.readFileSync(taskPath, 'utf-8');
                const lines = content.split('\n');
                const heading = lines.find(l => l.startsWith('#'))?.replace(/^#+\s*/, '').trim() || 'Untitled';

                const open = [], inProgress = [], completed = [];
                for (const line of lines) {
                    const t = line.trim();
                    if (t.startsWith('- [ ]')) open.push(t.substring(6));
                    else if (t.startsWith('- [/]')) inProgress.push(t.substring(6));
                    else if (t.startsWith('- [x]')) completed.push(t.substring(6));
                }

                if (open.length > 0 || inProgress.length > 0 || completed.length > 0) {
                    let updatedAt;
                    try {
                        const meta = JSON.parse(fs.readFileSync(taskPath + '.metadata.json', 'utf-8'));
                        updatedAt = meta.updatedAt;
                    } catch {
                        updatedAt = fs.statSync(taskPath).mtime.toISOString();
                    }
                    tasks.push({ conversationId: entry.name, heading, open, inProgress, completed, updatedAt });
                }
            } catch { continue; }
        }

        return tasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    // ── Morning Brief ────────────────────────────────────────────

    function getMorningBrief() {
        const today = new Date();
        const todayStr = toLocalDateStr(today);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = toLocalDateStr(yesterday);

        const todayDigest = buildDailyDigest(todayStr);
        const yesterdayDigest = buildDailyDigest(yesterdayStr);
        const openTasks = getOpenTasks().slice(0, 5);
        const momentum = getMomentumData(14);
        const knowledgeCount = scanKnowledgeItems().length;

        // Streak calculation
        const actDates = getActivityDates();
        let streak = 0;
        const d = new Date(today);
        while (true) {
            const ds = toLocalDateStr(d);
            if (actDates[ds]) { streak++; d.setDate(d.getDate() - 1); }
            else break;
        }

        // Resume context — what were you last working on?
        const resumeContext = getResumeContext();

        // Weekly rollup — aggregate narrative for the week
        const weeklyRollup = generateWeeklyRollup();

        // Action items from AI sweep
        const actionItems = getActionItems('open');

        auditLog('morning_brief', todayStr);

        return {
            today: todayDigest, yesterday: yesterdayDigest,
            openTasks, momentum, streak, knowledgeCount,
            resumeContext, weeklyRollup, actionItems,
        };
    }

    function getResumeContext() {
        const all = scanBrainArtifacts();
        if (all.length === 0) return null;

        // Sort all artifacts by update time, most recent first
        const sorted = all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        const latest = sorted[0];
        const now = new Date();
        const lastTime = new Date(latest.updatedAt);
        const hoursAgo = Math.round((now - lastTime) / 3600000);

        let timeLabel;
        if (hoursAgo < 1) timeLabel = 'Just now';
        else if (hoursAgo === 1) timeLabel = '1 hour ago';
        else if (hoursAgo < 24) timeLabel = `${hoursAgo} hours ago`;
        else {
            const daysAgo = Math.round(hoursAgo / 24);
            timeLabel = daysAgo === 1 ? 'Yesterday' : `${daysAgo} days ago`;
        }

        // Get the last 3 unique sessions by conversationId
        const seenConvs = new Set();
        const recentSessions = [];
        for (const a of sorted) {
            if (seenConvs.has(a.conversationId)) continue;
            seenConvs.add(a.conversationId);

            // Check if there are in-progress items in task.md
            let inProgressItems = [];
            const convDir = path.join(ANTIGRAVITY_ROOT, 'brain', a.conversationId);
            try {
                const taskPath = path.join(convDir, 'task.md');
                if (fs.existsSync(taskPath)) {
                    const taskContent = fs.readFileSync(taskPath, 'utf-8');
                    const inProgress = taskContent.match(/^\s*-\s*\[\/\]\s*(.+)$/gm);
                    if (inProgress) {
                        inProgressItems = inProgress.map(l => l.replace(/^\s*-\s*\[\/\]\s*/, '').trim()).slice(0, 3);
                    }
                }
            } catch (e) { console.warn('[Journal] Classify error:', e.message); }

            const heading = a.heading || a.file?.replace('.md', '') || 'Untitled';
            const title = heading.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '').replace(/_/g, ' ');

            recentSessions.push({
                conversationId: a.conversationId,
                title,
                summary: a.summary || '',
                source: a.source || 'antigravity',
                inProgressItems,
            });

            if (recentSessions.length >= 3) break;
        }

        return {
            timeLabel,
            hoursAgo,
            lastSessionTitle: recentSessions[0]?.title || 'Unknown',
            recentSessions,
        };
    }

    function generateWeeklyRollup() {
        const today = new Date();
        const weekDays = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            weekDays.push(toLocalDateStr(d));
        }

        let totalSessions = 0;
        let totalArtifacts = 0;
        const allTopics = [];
        const allNarratives = [];
        const projectCounts = {};

        // Cache digests — build once per day, reuse everywhere
        const digestCache = {};
        for (const ds of weekDays) {
            const digest = buildDailyDigest(ds);
            digestCache[ds] = digest;
            totalSessions += digest.sessionCount;
            totalArtifacts += digest.artifactCount;
            if (digest.narrative) allNarratives.push(digest.narrative);

            for (const t of (digest.topics || [])) {
                projectCounts[t] = (projectCounts[t] || 0) + 1;
                if (!allTopics.includes(t)) allTopics.push(t);
            }
        }

        if (totalSessions === 0) return null;

        // Sort projects by frequency
        const topProjects = Object.entries(projectCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, count]) => ({ name, days: count }));

        // Count active days from cached digests (no rebuild)
        const activeDays = weekDays.filter(ds => digestCache[ds].sessionCount > 0).length;

        // Build weekly narrative
        let narrative = '';
        if (topProjects.length > 0) {
            const projectList = topProjects.map(p =>
                `**${p.name}** (${p.days} day${p.days !== 1 ? 's' : ''})`
            ).join(', ');
            narrative = `This week: ${projectList}. ${totalSessions} sessions, ${totalArtifacts} artifacts across ${activeDays} active days.`;
        }

        return {
            totalSessions,
            totalArtifacts,
            topProjects,
            narrative,
            activeDays,
        };
    }

    // ── Project Threads ──────────────────────────────────────────

    function getProjectThreads() {
        const kis = scanKnowledgeItems();
        const all = scanBrainArtifacts();

        // Separate AG artifacts from captures
        const agArtifacts = all.filter(a => !a.source);
        const captures = all.filter(a => !!a.source);

        const matchedCaptureIds = new Set();

        // Build threads from KIs with aggressive cross-source matching
        const threads = kis.map(ki => {
            // AG artifacts linked by conversation reference
            const linkedAG = agArtifacts.filter(a => ki.references.includes(a.conversationId));

            // Build keyword set from KI: title + topic folder name + summary
            const kiText = [ki.title, ki.topic, ki.summary].join(' ').toLowerCase().replace(/[_-]/g, ' ');
            const kiWords = [...new Set(kiText.split(/\s+/).filter(w => w.length > 3))];

            // Match captures: check heading, file name, AND summary
            const matchedCaptures = captures.filter(cap => {
                const capText = [
                    cap.heading || '', cap.file || '', cap.summary || ''
                ].join(' ').toLowerCase();
                // Need at least 2 keyword hits OR 1 hit on a long distinctive word (6+ chars)
                const hits = kiWords.filter(w => capText.includes(w));
                return hits.length >= 2 || hits.some(w => w.length >= 6);
            });

            matchedCaptures.forEach(c => matchedCaptureIds.add(c.conversationId));

            const allLinked = [...linkedAG, ...matchedCaptures];
            const dates = [...new Set(allLinked.map(a => toLocalDateStr(new Date(a.updatedAt))))].sort();

            const sources = new Set();
            if (linkedAG.length > 0) sources.add('antigravity');
            matchedCaptures.forEach(c => sources.add(c.source));

            return {
                topic: ki.topic,
                title: ki.title,
                summary: ki.summary,
                sessionCount: ki.references.length + matchedCaptures.length,
                artifactCount: allLinked.length,
                lastActivity: dates.length > 0 ? dates[dates.length - 1] : null,
                sources: [...sources],
                agCount: linkedAG.length,
                captureCount: matchedCaptures.length,
            };
        });

        // Merge ALL unmatched captures into a single thread per source — no more duplicates
        const unmatched = captures.filter(c => !matchedCaptureIds.has(c.conversationId));
        const unmatchedBySource = {};
        for (const cap of unmatched) {
            const src = cap.source || 'unknown';
            if (!unmatchedBySource[src]) unmatchedBySource[src] = [];
            unmatchedBySource[src].push(cap);
        }
        for (const [source, caps] of Object.entries(unmatchedBySource)) {
            const dates = caps.map(c => toLocalDateStr(new Date(c.updatedAt))).sort();
            const sourceLabels = { gemini: 'Google Gemini', chatgpt: 'ChatGPT', claude: 'Claude' };
            const label = sourceLabels[source] || source;
            threads.push({
                topic: `unlinked:${source}`,
                title: `${label} Sessions (${caps.length} unlinked)`,
                summary: `${caps.length} captured sessions not yet linked to a knowledge item`,
                sessionCount: caps.length,
                artifactCount: caps.length,
                lastActivity: dates.length > 0 ? dates[dates.length - 1] : null,
                sources: [source],
                agCount: 0,
                captureCount: caps.length,
            });
        }

        return threads.sort((a, b) => {
            if (!a.lastActivity) return 1;
            if (!b.lastActivity) return -1;
            return b.lastActivity.localeCompare(a.lastActivity);
        });
    }

    // ── Thread Detail ────────────────────────────────────────────

    function getThreadDetail(topic) {
        const kis = scanKnowledgeItems();
        const all = scanBrainArtifacts();
        const agArtifacts = all.filter(a => !a.source);
        const captures = all.filter(a => !!a.source);

        // Handle unlinked capture threads
        if (topic.startsWith('unlinked:')) {
            const source = topic.replace('unlinked:', '');
            const matchedCaptureIds = new Set();

            // Rebuild matching to find which captures are truly unlinked
            for (const ki of kis) {
                const kiText = [ki.title, ki.topic, ki.summary].join(' ').toLowerCase().replace(/[_-]/g, ' ');
                const kiWords = [...new Set(kiText.split(/\s+/).filter(w => w.length > 3))];
                for (const cap of captures) {
                    if (cap.source !== source) continue;
                    const capText = [cap.heading || '', cap.file || '', cap.summary || ''].join(' ').toLowerCase();
                    const hits = kiWords.filter(w => capText.includes(w));
                    if (hits.length >= 2 || hits.some(w => w.length >= 6)) {
                        matchedCaptureIds.add(cap.conversationId);
                    }
                }
            }

            const unlinked = captures.filter(c => c.source === source && !matchedCaptureIds.has(c.conversationId));
            const sourceLabels = { gemini: 'Google Gemini', chatgpt: 'ChatGPT', claude: 'Claude' };
            const label = sourceLabels[source] || source;

            const rawSessions = unlinked.map(cap => {
                const raw = cap.heading || cap.file?.replace(/\.md$/, '') || 'Untitled';
                const title = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '').replace(/_/g, ' ');
                return {
                    conversationId: cap.conversationId,
                    title,
                    summary: cap.summary || '',
                    debrief: `Captured from ${cap.source || 'external'}`,
                    source: cap.source,
                    date: toLocalDateStr(new Date(cap.updatedAt)),
                    artifacts: [{
                        file: cap.file,
                        type: 'Session',
                        summary: cap.summary || '',
                        heading: title,
                    }],
                };
            }).sort((a, b) => b.date.localeCompare(a.date));

            // Dedup incremental snapshots
            const sessions = deduplicateCaptures(rawSessions);

            auditLog('thread_detail', topic);
            return {
                topic,
                title: `${label} Sessions (${unlinked.length} unlinked)`,
                fullSummary: `${unlinked.length} captured sessions from ${label} that aren't yet linked to a knowledge item. These sessions may contain valuable information that could be organized into knowledge items.`,
                sessions,
                kiArtifacts: [],
            };
        }

        // KI-backed thread
        const ki = kis.find(k => k.topic === topic);
        if (!ki) return null;

        // Find linked AG artifacts
        const linkedAG = agArtifacts.filter(a => ki.references.includes(a.conversationId));

        // Find matched captures (same logic as getProjectThreads)
        const kiText = [ki.title, ki.topic, ki.summary].join(' ').toLowerCase().replace(/[_-]/g, ' ');
        const kiWords = [...new Set(kiText.split(/\s+/).filter(w => w.length > 3))];
        const matchedCaptures = captures.filter(cap => {
            const capText = [cap.heading || '', cap.file || '', cap.summary || ''].join(' ').toLowerCase();
            const hits = kiWords.filter(w => capText.includes(w));
            return hits.length >= 2 || hits.some(w => w.length >= 6);
        });

        // Group by conversation
        const byConv = {};
        for (const a of [...linkedAG, ...matchedCaptures]) {
            if (!byConv[a.conversationId]) byConv[a.conversationId] = [];
            byConv[a.conversationId].push(a);
        }

        const sessions = Object.entries(byConv).map(([convId, artifacts]) => {
            const sorted = artifacts.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
            const source = sorted[0]?.source || 'antigravity';
            return {
                conversationId: convId,
                title: deriveSessionTitle(sorted),
                summary: extractSessionSummary(sorted),
                debrief: deriveSessionDebrief(sorted),
                source,
                date: toLocalDateStr(new Date(sorted[sorted.length - 1].updatedAt)),
                artifacts: sorted.map(a => ({
                    file: a.file,
                    type: a.type,
                    summary: a.summary || '',
                    heading: a.heading,
                })),
            };
        }).sort((a, b) => b.date.localeCompare(a.date));

        // KI's own artifact files (from knowledge dir)
        const knowledgeDir = path.join(ANTIGRAVITY_ROOT, 'knowledge', topic, 'artifacts');
        let kiArtifacts = [];
        if (fs.existsSync(knowledgeDir)) {
            try {
                const files = fs.readdirSync(knowledgeDir, { withFileTypes: true });
                kiArtifacts = files
                    .filter(f => f.isFile() && f.name.endsWith('.md'))
                    .map(f => ({
                        file: f.name,
                        path: `knowledge/${topic}/artifacts/${f.name}`,
                        title: f.name.replace('.md', '').replace(/_/g, ' '),
                    }));
            } catch { /* unreadable */ }
        }

        auditLog('thread_detail', topic);
        return {
            topic,
            title: ki.title,
            fullSummary: ki.summary,
            sessions,
            kiArtifacts,
        };
    }

    // ── Session Detail ───────────────────────────────────────────

    function getSessionDetail(convId) {
        // Handle captured sessions: convId = "source:filename"
        if (convId.includes(':')) {
            const [source, captureFile] = convId.split(':', 2);
            const safeName = captureFile.replace(/\.\./g, '').replace(/[/\\]/g, '');
            const mdPath = path.join(capturesDir, source, safeName);
            const metaPath = mdPath + '.metadata.json';

            let summary = '';
            let heading = safeName.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '').replace(/_/g, ' ');
            let turns = 0;

            // Read metadata
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                summary = meta.summary || '';
                heading = meta.heading || heading;
                turns = meta.turns || 0;
            } catch (e) { console.warn('[Journal] Summarize error:', e.message); }

            // Read conversation content and parse into excerpts
            const artifacts = [];
            try {
                const content = fs.readFileSync(mdPath, 'utf-8');
                const turnBlocks = content.split(/^### /m).filter(b => b.trim());

                // Extract user questions and model responses
                const exchanges = [];
                for (let i = 0; i < turnBlocks.length; i++) {
                    const block = turnBlocks[i];
                    const isUser = /^\*\*You\*\*/.test(block);
                    const isModel = /^\*\*(ChatGPT|Gemini|Assistant|Model)\*\*/.test(block);

                    if (isUser) {
                        const userText = block.replace(/^\*\*You\*\*\s*/, '').trim();
                        const snippet = userText.substring(0, 200) + (userText.length > 200 ? '…' : '');
                        exchanges.push({ role: 'user', text: snippet });
                    } else if (isModel) {
                        const modelText = block.replace(/^\*\*[^*]+\*\*\s*/, '').trim();
                        const snippet = modelText.substring(0, 300) + (modelText.length > 300 ? '…' : '');
                        exchanges.push({ role: 'model', text: snippet });
                    }
                }

                // Show last 5 exchanges as a preview
                const recentExchanges = exchanges.slice(-6);

                // Build top-level summary artifact
                artifacts.push({
                    file: safeName,
                    type: 'Conversation',
                    heading: heading,
                    summary: summary || `${turns} turns captured from ${source}`,
                    updatedAt: new Date().toISOString(),
                });

                // Add individual exchange excerpts
                for (const ex of recentExchanges) {
                    artifacts.push({
                        file: safeName,
                        type: ex.role === 'user' ? '💬 You' : '🤖 Response',
                        heading: '',
                        summary: ex.text,
                        updatedAt: '',
                    });
                }

                // Extract key file references from the entire content
                const fileRefs = content.match(/\b[\w.-]+\.(js|py|sol|ts|css|html|json|md|rs|go)\b/gi);
                if (fileRefs) {
                    const uniqueFiles = [...new Set(fileRefs)].slice(0, 10);
                    artifacts.push({
                        file: safeName,
                        type: '📁 Files Referenced',
                        heading: '',
                        summary: uniqueFiles.join(', '),
                        updatedAt: '',
                    });
                }
            } catch (e) { console.warn('[Journal] Enrich KI error:', e.message); }

            auditLog('session_detail', convId);
            return {
                conversationId: convId,
                artifacts,
                topics: [],
                pinned: false,
            };
        }

        // Standard brain artifact lookup
        const all = scanBrainArtifacts();
        const artifacts = all.filter(a => a.conversationId === convId);
        const topics = extractTopicsForConversations([convId]);
        const pinned = !!dbGet('SELECT 1 FROM pinned_sessions WHERE conversation_id = ?', [convId]);
        auditLog('session_detail', convId);
        return {
            conversationId: convId,
            artifacts: artifacts.map(a => ({ file: a.file, type: a.type, summary: a.summary, heading: a.heading, updatedAt: a.updatedAt, absPath: a.absPath })),
            topics,
            pinned,
        };
    }

    // ── Read Artifact Content ────────────────────────────────────

    function readArtifact(convId, file, absPath) {
        let filePath;
        if (convId.includes(':')) {
            // Captured session: convId = "source:filename"
            const [source, captureFile] = convId.split(':', 2);
            const target = file || captureFile;
            const safeName = target.replace(/\.\./g, '').replace(/[/\\]/g, '');
            filePath = path.join(capturesDir, source, safeName);
        } else if (absPath) {
            // Hermes / brain artifact with absolute path
            filePath = absPath;
        } else {
            // Brain artifact: convId = conversation UUID
            const safeName = file.replace(/\.\./g, '').replace(/[/\\]/g, '');
            filePath = path.join(ANTIGRAVITY_ROOT, 'brain', convId, safeName);
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            auditLog('artifact_read', `${convId}/${path.basename(filePath)}`);
            return { content, file: path.basename(filePath), conversationId: convId };
        } catch { return null; }
    }

    // ── Quick Notes ──────────────────────────────────────────────

    function addQuickNote(dateStr, content) {
        const now = Date.now() / 1000;
        dbRun('INSERT INTO quick_notes (date_str, content, created_at) VALUES (?, ?, ?)', [dateStr, content, now]);
        scheduleSave();
        auditLog('note_added', dateStr);
        return dbAll('SELECT id, content, created_at FROM quick_notes WHERE date_str = ? ORDER BY created_at DESC', [dateStr]);
    }

    function deleteQuickNote(noteId) {
        dbRun('DELETE FROM quick_notes WHERE id = ?', [noteId]);
        scheduleSave();
        auditLog('note_deleted', String(noteId));
    }

    // ── Pinned Sessions ──────────────────────────────────────────

    function pinSession(convId, note = '') {
        const now = Date.now() / 1000;
        dbRun('INSERT OR REPLACE INTO pinned_sessions (conversation_id, pinned_at, note) VALUES (?, ?, ?)', [convId, now, note]);
        scheduleSave();
        auditLog('session_pinned', convId);
    }

    function unpinSession(convId) {
        dbRun('DELETE FROM pinned_sessions WHERE conversation_id = ?', [convId]);
        scheduleSave();
        auditLog('session_unpinned', convId);
    }

    function getPinnedSessions() {
        const rows = dbAll('SELECT conversation_id, pinned_at, note FROM pinned_sessions ORDER BY pinned_at DESC');
        const all = scanBrainArtifacts();
        return rows.map(r => {
            const artifacts = all.filter(a => a.conversationId === r.conversation_id);
            return {
                conversationId: r.conversation_id,
                pinnedAt: r.pinned_at,
                note: r.note,
                title: artifacts.length > 0 ? deriveSessionTitle(artifacts) : r.conversation_id,
                artifactCount: artifacts.length,
            };
        });
    }

    // ── Cache Control ────────────────────────────────────────────

    function invalidateCache() {
        _brainCache = null;
        _knowledgeCache = null;
    }

    // ── Read Knowledge Artifact ──────────────────────────────────

    function readKnowledgeArtifact(topic, file) {
        const safeTopic = topic.replace(/\.\./g, '').replace(/[/\\]/g, '');
        const safeFile = file.replace(/\.\./g, '').replace(/[/\\]/g, '');
        const filePath = path.join(ANTIGRAVITY_ROOT, 'knowledge', safeTopic, 'artifacts', safeFile);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            auditLog('ki_artifact_read', `${topic}/${file}`);
            return { content, file: safeFile, topic };
        } catch { return null; }
    }

    // ── Task Finalization ────────────────────────────────────────

    function finalizeTask(conversationId) {
        const brainDir = path.join(ANTIGRAVITY_ROOT, 'brain');
        const taskPath = path.join(brainDir, conversationId, 'task.md');
        if (!fs.existsSync(taskPath)) return false;

        try {
            let content = fs.readFileSync(taskPath, 'utf-8');
            // Mark all [ ] and [/] as [x]
            content = content.replace(/- \[ \]/g, '- [x]').replace(/- \[\/\]/g, '- [x]');
            fs.writeFileSync(taskPath, content);
            auditLog('task_finalized', conversationId);
            invalidateCache();
            return true;
        } catch { return false; }
    }

    function archiveTask(conversationId) {
        const brainDir = path.join(ANTIGRAVITY_ROOT, 'brain');
        const taskPath = path.join(brainDir, conversationId, 'task.md');
        if (!fs.existsSync(taskPath)) return false;

        try {
            // Rename to task.archived.md — effectively hides from getOpenTasks()
            const archivePath = path.join(brainDir, conversationId, 'task.archived.md');
            fs.renameSync(taskPath, archivePath);
            auditLog('task_archived', conversationId);
            invalidateCache();
            return true;
        } catch { return false; }
    }

    // ── AI Integration ──────────────────────────────────────────

    let vaultAI = null;
    function getAI() {
        if (!vaultAI) {
            try { vaultAI = require('./vault-ai'); } catch { vaultAI = null; }
        }
        return vaultAI;
    }

    // Ensure ai_suggestions table exists
    try {
        dbRun(`CREATE TABLE IF NOT EXISTS ai_suggestions (
            capture_id TEXT,
            ki_topic TEXT,
            confidence REAL,
            source TEXT DEFAULT 'keyword',
            debrief TEXT,
            quality INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            PRIMARY KEY (capture_id, ki_topic)
        )`);
    } catch { /* table may already exist */ }

    // Ensure action_items table exists
    try {
        dbRun(`CREATE TABLE IF NOT EXISTS action_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT,
            type TEXT,
            priority TEXT,
            description TEXT,
            status TEXT DEFAULT 'open',
            created_at INTEGER DEFAULT (strftime('%s','now'))
        )`);
    } catch { /* table may already exist */ }

    // ── KI Management ───────────────────────────────────────────

    function getKIList() {
        const kis = scanKnowledgeItems();
        return kis.map(ki => ({
            topic: ki.topic,
            title: ki.title,
            summary: ki.summary,
            refCount: ki.references.length,
        }));
    }

    function linkCaptureToKI(captureId, kiTopic) {
        const knowledgeDir = path.join(ANTIGRAVITY_ROOT, 'knowledge');
        const metaPath = path.join(knowledgeDir, kiTopic, 'metadata.json');
        if (!fs.existsSync(metaPath)) return false;

        try {
            const raw = fs.readFileSync(metaPath, 'utf-8');
            const meta = JSON.parse(raw);
            const refs = meta.references || [];

            // Don't duplicate
            if (refs.some(r => r.type === 'conversation_id' && r.value === captureId)) return true;

            refs.push({ type: 'conversation_id', value: captureId });
            meta.references = refs;
            meta.updated_at = new Date().toISOString();

            // Atomic write
            const tmpPath = metaPath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 4));
            fs.renameSync(tmpPath, metaPath);

            invalidateCache();
            auditLog('capture_linked', `${captureId} → ${kiTopic}`);
            return true;
        } catch { return false; }
    }

    function createKIFromCaptures(title, captureIds) {
        const slug = title.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .trim()
            .replace(/\s+/g, '_')
            .substring(0, 60);

        const knowledgeDir = path.join(ANTIGRAVITY_ROOT, 'knowledge');
        const kiDir = path.join(knowledgeDir, slug);
        const artifactsDir = path.join(kiDir, 'artifacts');

        if (fs.existsSync(kiDir)) return { success: false, error: 'KI already exists' };

        try {
            fs.mkdirSync(kiDir, { recursive: true });
            fs.mkdirSync(artifactsDir, { recursive: true });

            const references = captureIds.map(id => ({ type: 'conversation_id', value: id }));

            const metadata = {
                title,
                summary: `Knowledge item covering ${title}. Contains ${captureIds.length} linked sessions.`,
                references,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };

            fs.writeFileSync(path.join(kiDir, 'metadata.json'), JSON.stringify(metadata, null, 4));
            fs.writeFileSync(path.join(artifactsDir, 'overview.md'), `# ${title}\n\nThis knowledge item was created from ${captureIds.length} captured sessions.\n`);

            invalidateCache();
            auditLog('ki_created', `${slug} (${captureIds.length} captures)`);
            return { success: true, topic: slug };
        } catch (err) { return { success: false, error: err.message }; }
    }

    async function suggestKIForCapture(captureId) {
        // Check cache first
        const cached = dbAll('SELECT ki_topic, confidence, source FROM ai_suggestions WHERE capture_id = ? ORDER BY confidence DESC', [captureId]);
        if (cached.length > 0) return cached;

        const kiList = getKIList();
        const all = scanBrainArtifacts();
        const cap = all.find(a => a.conversationId === captureId);
        if (!cap) return [];

        // Read capture content for AI
        let content = '';
        try {
            if (cap.absPath) content = fs.readFileSync(cap.absPath, 'utf-8');
        } catch { /* use metadata only */ }

        const captureText = [cap.heading || '', cap.summary || '', content].join('\n');

        const ai = getAI();
        let suggestions = [];

        if (ai) {
            suggestions = await ai.suggestKIMatch(captureText, kiList) || [];
            // Cache AI suggestions
            for (const s of suggestions) {
                try {
                    dbRun('INSERT OR REPLACE INTO ai_suggestions (capture_id, ki_topic, confidence, source) VALUES (?, ?, ?, ?)',
                        [captureId, s.topic, s.confidence, 'ai']);
                    scheduleSave();
                } catch { /* ignore */ }
            }
        }

        if (suggestions.length === 0) {
            // Keyword fallback
            if (ai) {
                suggestions = ai.constructor ? [] : [];
            }
            // Manual keyword match
            const capWords = new Set(captureText.toLowerCase().split(/\s+/).filter(w => w.length > 4));
            suggestions = kiList.map(ki => {
                const kiWords = [ki.title, ki.summary].join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 4);
                const overlap = kiWords.filter(w => capWords.has(w)).length;
                const confidence = Math.min(Math.round((overlap / Math.max(kiWords.length, 1)) * 100), 95);
                return { topic: ki.topic, title: ki.title, confidence };
            })
            .filter(m => m.confidence > 20)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 3);
        }

        return suggestions;
    }

    async function autoOrganizeCaptures() {
        const all = scanBrainArtifacts();
        const captures = all.filter(a => !!a.source);
        const kis = scanKnowledgeItems();
        const matchedIds = new Set();

        // Find already-linked captures
        for (const ki of kis) {
            for (const ref of ki.references) {
                matchedIds.add(ref);
            }
        }

        // Also check keyword-matched
        for (const ki of kis) {
            const kiText = [ki.title, ki.topic, ki.summary].join(' ').toLowerCase().replace(/[_-]/g, ' ');
            const kiWords = [...new Set(kiText.split(/\s+/).filter(w => w.length > 3))];
            for (const cap of captures) {
                const capText = [cap.heading || '', cap.file || '', cap.summary || ''].join(' ').toLowerCase();
                const hits = kiWords.filter(w => capText.includes(w));
                if (hits.length >= 2 || hits.some(w => w.length >= 6)) {
                    matchedIds.add(cap.conversationId);
                }
            }
        }

        const unlinked = captures.filter(c => !matchedIds.has(c.conversationId));
        let linked = 0, reviewed = 0, created = 0;

        // Phase 1: AI-powered suggestion for each unlinked capture
        const stillUnmatched = [];
        for (const cap of unlinked) {
            const suggestions = await suggestKIForCapture(cap.conversationId);
            if (suggestions.length > 0 && suggestions[0].confidence >= 85) {
                linkCaptureToKI(cap.conversationId, suggestions[0].topic);
                linked++;
            } else {
                stillUnmatched.push(cap);
                reviewed++;
            }
        }

        // Phase 2: Cluster remaining unmatched by heading and auto-create KIs
        if (stillUnmatched.length >= 2) {
            const clusters = {};
            for (const cap of stillUnmatched) {
                const key = (cap.heading || cap.file || 'unknown')
                    .toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                if (!clusters[key]) clusters[key] = [];
                clusters[key].push(cap);
            }

            for (const [clusterKey, clusterCaps] of Object.entries(clusters)) {
                if (clusterCaps.length < 2) continue;

                const rawTitle = clusterCaps[0].heading || clusterKey;
                const kiTitle = rawTitle.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '').replace(/_/g, ' ').trim();
                if (!kiTitle || kiTitle.length < 3) continue;

                const slug = kiTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);
                const existing = kis.find(k => k.topic === slug);
                if (existing) {
                    for (const cap of clusterCaps) {
                        linkCaptureToKI(cap.conversationId, slug);
                        linked++;
                    }
                } else {
                    const captureIds = clusterCaps.map(c => c.conversationId);
                    const result = createKIFromCaptures(kiTitle, captureIds);
                    if (result.success) {
                        created++;
                        linked += captureIds.length;

                        // Generate AI summary for new KI (best-effort)
                        try {
                            const ai = getAI();
                            if (ai) {
                                const contents = clusterCaps.slice(0, 5).map(cap => {
                                    try { return cap.absPath ? fs.readFileSync(cap.absPath, 'utf-8').substring(0, 2000) : ''; }
                                    catch { return ''; }
                                }).filter(Boolean);
                                if (contents.length > 0) {
                                    const aiSummary = await ai.generateKISummary(kiTitle, contents);
                                    if (aiSummary) {
                                        const metaPath = path.join(ANTIGRAVITY_ROOT, 'knowledge', result.topic, 'metadata.json');
                                        try {
                                            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                                            meta.summary = aiSummary;
                                            meta.updated_at = new Date().toISOString();
                                            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 4));
                                        } catch { /* */ }
                                    }
                                }
                            }
                        } catch { /* AI unavailable */ }
                    }
                }
            }
        }

        // Phase 3: Re-summarize captures with generic summaries
        const genericPat = /^\w+ session: .+ \(\d+ turns\)$/;
        const staleCaptures = captures.filter(c => genericPat.test(c.summary || '') && c.absPath).slice(0, 20);
        let resummarized = 0;

        for (const cap of staleCaptures) {
            try {
                const content = fs.readFileSync(cap.absPath, 'utf-8');
                const turnBlocks = content.split(/^### /m).filter(b => b.trim());
                const modelText = turnBlocks
                    .filter(b => /^\*\*(ChatGPT|Gemini|Assistant)\*\*/.test(b))
                    .map(b => b.replace(/^\*\*[^*]+\*\*\s*/, '').substring(0, 1000))
                    .join(' ');

                if (modelText.length < 50) continue;

                const files = modelText.match(/\b[\w.-]+\.(js|py|sol|ts|css|html|json)\b/gi);
                const actions = modelText.match(/\b(implemented|created|fixed|built|audited|analyzed|configured|updated|integrated)\b/gi);

                let newSummary = '';
                if (files && actions) {
                    const uF = [...new Set(files)].slice(0, 4);
                    const uA = [...new Set(actions.map(a => a.toLowerCase()))].slice(0, 3);
                    newSummary = `${uA.join(', ')} in ${uF.join(', ')}`;
                } else if (files) {
                    newSummary = `Covers ${[...new Set(files)].slice(0, 5).join(', ')}`;
                } else {
                    const sents = modelText.split(/[.!]\s+/).filter(s => s.length > 30 && !/^(Sure|Of course|I'll|Let me|Here's)/i.test(s));
                    if (sents.length > 0) {
                        newSummary = sents[0].trim();
                        if (newSummary.length > 150) newSummary = newSummary.substring(0, 150) + '\u2026';
                    }
                }

                if (newSummary) {
                    const metaPath = cap.absPath + '.metadata.json';
                    try {
                        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                        meta.summary = newSummary;
                        meta.updated_at = new Date().toISOString();
                        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 4));
                        resummarized++;
                    } catch { /* */ }
                }
            } catch { /* unreadable */ }
        }

        if (resummarized > 0) invalidateCache();

        auditLog('auto_organize', `${linked} linked, ${created} KIs created, ${resummarized} re-summarized, ${reviewed} need review`);
        return { linked, reviewed, created, resummarized, total: unlinked.length };
    }

    async function getIntelligenceDashboard() {
        const ai = getAI();
        const kiList = getKIList();
        const all = scanBrainArtifacts();
        const captures = all.filter(a => !!a.source);

        const dashboard = {
            aiAvailable: ai ? await ai.checkOllamaHealth() : false,
            kiCount: kiList.length,
            captureCount: captures.length,
            mergeablePairs: [],
            knowledgeGaps: [],
            staleKIs: [],
            crossReferences: [],
            dependencies: [],
            trends: null,
            learningStats: null,
        };

        // Deterministic (always runs)
        if (ai) {
            dashboard.staleKIs = ai.detectStaleKIs(kiList, captures);
            dashboard.trends = ai.computeTrends(all);
            dashboard.learningStats = ai.getLearningStats();
        }

        // AI-powered (only if Ollama available)
        if (dashboard.aiAvailable && ai) {
            try { dashboard.mergeablePairs = await ai.detectMergeableKIs(kiList); } catch (e) { console.warn('[Journal] KI merge detect:', e.message); }
            try { dashboard.knowledgeGaps = await ai.detectKnowledgeGaps(kiList, captures); } catch (e) { console.warn('[Journal] KI gap detect:', e.message); }
            try { dashboard.crossReferences = await ai.discoverCrossReferences(kiList); } catch (e) { console.warn('[Journal] KI cross-ref:', e.message); }
            try { dashboard.dependencies = await ai.mapKIDependencies(kiList); } catch (e) { console.warn('[Journal] KI dependencies:', e.message); }
        }

        return dashboard;
    }

    async function getAIStatus() {
        const ai = getAI();
        if (!ai) return { available: false, reason: 'vault-ai module not loaded', model: 'none' };
        const available = await ai.checkOllamaHealth();
        return { available, reason: available ? 'Ollama ready (qwen2.5:7b)' : 'Ollama offline', model: 'qwen2.5:7b' };
    }

    // ── KI Enrichment ───────────────────────────────────────────

    async function enrichKI(kiTopic) {
        const ai = getAI();
        if (!ai) return { success: false, error: 'AI not available' };

        const knowledgeDir = path.join(ANTIGRAVITY_ROOT, 'knowledge');
        const metaPath = path.join(knowledgeDir, kiTopic, 'metadata.json');
        if (!fs.existsSync(metaPath)) return { success: false, error: 'KI not found' };

        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

            // Gather all linked content
            const contents = [];
            const allArtifacts = scanBrainArtifacts();

            for (const ref of (meta.references || [])) {
                if (ref.type === 'conversation_id') {
                    const found = allArtifacts.find(a => a.conversationId === ref.value);
                    if (found && found.absPath) {
                        try { contents.push(fs.readFileSync(found.absPath, 'utf-8')); } catch (e) { console.warn('[Journal] Read KI artifact:', e.message); }
                    }
                }
            }

            if (contents.length === 0) return { success: false, error: 'No linked content found' };

            const newSummary = await ai.enrichKISummary(meta.summary || '', meta.title, contents);
            if (!newSummary) return { success: false, error: 'AI enrichment failed' };

            meta.summary = newSummary;
            meta.updated_at = new Date().toISOString();
            meta.enriched_at = new Date().toISOString();

            const tmpPath = metaPath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 4));
            fs.renameSync(tmpPath, metaPath);

            invalidateCache();
            auditLog('ki_enriched', kiTopic);
            return { success: true, summary: newSummary };
        } catch (err) { return { success: false, error: err.message }; }
    }

    // ── Action Item Extraction ──────────────────────────────────

    async function extractActions(captureId) {
        const ai = getAI();
        if (!ai) return [];

        const all = scanBrainArtifacts();
        const cap = all.find(a => a.conversationId === captureId);
        if (!cap || !cap.absPath) return [];

        try {
            const content = fs.readFileSync(cap.absPath, 'utf-8');
            return await ai.extractActionItems(content);
        } catch { return []; }
    }

    // ── Weekly Report ───────────────────────────────────────────

    async function getWeeklyReport() {
        const ai = getAI();
        if (!ai) return 'AI offline — cannot generate report';

        const all = scanBrainArtifacts();
        const trends = ai.computeTrends(all, 7);
        const kiList = getKIList();
        const captures = all.filter(a => !!a.source);
        const staleKIs = ai.detectStaleKIs(kiList, captures);

        // Gather recent action items from cache
        const cachedActions = dbAll('SELECT * FROM ai_suggestions WHERE source = ? ORDER BY created_at DESC LIMIT 20', ['action']);

        return await ai.generateWeeklyReport({
            totalSessions: trends.totalSessions,
            topTopics: trends.topTopics,
            sourceBreakdown: trends.sourceBreakdown,
            kiChanges: 0,
            newKIs: 0,
            staleKIs: staleKIs.length,
            actionItems: cachedActions,
        });
    }

    // ── Learning Feedback ───────────────────────────────────────

    function recordAIFeedback(captureId, kiTopic, action) {
        const ai = getAI();
        if (ai) ai.recordFeedback(captureId, kiTopic, action);

        // Also persist to SQLite
        try {
            dbRun('INSERT OR REPLACE INTO ai_suggestions (capture_id, ki_topic, confidence, source) VALUES (?, ?, ?, ?)',
                [captureId, kiTopic, action === 'accepted' ? 100 : 0, `feedback_${action}`]);
            scheduleSave();
        } catch (e) { console.warn('[Journal] KI summary gen:', e.message); }

        auditLog('ai_feedback', `${captureId} ${action} ${kiTopic}`);
    }

    // ── Session Clusters ────────────────────────────────────────

    async function getSessionClusters() {
        const ai = getAI();
        const all = scanBrainArtifacts();
        const captures = all.filter(a => !!a.source).map(a => ({
            id: a.conversationId,
            title: a.heading || a.file,
            summary: a.summary || '',
        }));

        if (!ai || captures.length < 3) return [{ label: 'All captures', sessionIds: captures.map(c => c.id) }];

        try {
            return await ai.clusterSessions(captures);
        } catch {
            return [{ label: 'All captures', sessionIds: captures.map(c => c.id) }];
        }
    }

    // ── Capture Priorities ──────────────────────────────────────

    async function getCapturePriorities() {
        const ai = getAI();
        const all = scanBrainArtifacts();
        const captures = all.filter(a => !!a.source).map(a => ({
            id: a.conversationId,
            conversationId: a.conversationId,
            title: a.heading || a.file,
            heading: a.heading,
            summary: a.summary || '',
            quality: 3,
        }));

        if (!ai || captures.length === 0) return [];

        try {
            return await ai.prioritizeCaptures(captures.slice(0, 15));
        } catch { return []; }
    }

    // ── Intelligence Sweep ────────────────────────────────────────
    // Master orchestrator: runs AI functions, persists results.
    // Called on startup (delayed) and periodically.

    async function runIntelligenceSweep() {
        const ai = getAI();
        if (!ai) return { status: 'offline', message: 'AI engine not available' };

        const available = await ai.checkOllamaHealth();
        const results = { status: available ? 'ai' : 'keyword', enriched: 0, actionsFound: 0, summariesUpgraded: 0, linked: 0 };

        const captures = scanBrainArtifacts().filter(a => !!a.source);
        const kiList = scanKnowledgeItems();

        // ── 1. Re-summarize captures with weak metadata ──────────
        for (const cap of captures) {
            if (cap.summary && cap.summary.length > 40 && !/^Actions:/.test(cap.summary)) continue;
            const convId = cap.conversationId;
            if (!convId || !convId.includes(':')) continue;

            try {
                const [source, filename] = convId.split(':', 2);
                const safeName = filename.replace(/\.\./g, '').replace(/[/\\]/g, '');
                const mdPath = path.join(capturesDir, source, safeName);
                const metaPath = mdPath + '.metadata.json';
                if (!fs.existsSync(mdPath)) continue;

                const content = fs.readFileSync(mdPath, 'utf-8');
                let meta = {};
                try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) { console.warn('[Journal] KI meta parse:', e.message); }

                if (available) {
                    const aiSummary = await ai.summarizeCapture(content);
                    if (aiSummary && aiSummary.length > 20) {
                        meta.summary = aiSummary;
                        meta.summarySource = 'ai';
                        results.summariesUpgraded++;
                    }
                    const quality = await ai.captureQualityScore(content);
                    if (quality) meta.quality = quality;
                    const debrief = await ai.sessionDebrief(content);
                    if (debrief) meta.debrief = debrief;
                } else {
                    // Keyword fallback: derive from content
                    meta.summary = ai.keywordSummaryFallback ? ai.keywordSummaryFallback(content) : (meta.summary || '');
                }

                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
            } catch { /* skip bad files */ }
        }

        // ── 2. Auto-enrich stale KI summaries ────────────────────
        if (available) {
            for (const ki of kiList) {
                // Skip if summary looks detailed (>100 chars and not generic)
                if (ki.summary && ki.summary.length > 100 && !/covering various/.test(ki.summary)) continue;

                try {
                    const enrichResult = await enrichKI(ki.topic);
                    if (enrichResult && enrichResult.success) results.enriched++;
                } catch { /* skip */ }
            }
        }

        // ── 3. Extract and persist action items ──────────────────
        if (available) {
            const recent = captures.slice(0, 10);
            for (const cap of recent) {
                // Skip if already processed
                const existing = dbGet('SELECT 1 FROM action_items WHERE source_id = ?', [cap.conversationId]);
                if (existing) continue;

                try {
                    const convId = cap.conversationId;
                    if (!convId || !convId.includes(':')) continue;
                    const [source, filename] = convId.split(':', 2);
                    const safeName = filename.replace(/\.\./g, '').replace(/[/\\]/g, '');
                    const mdPath = path.join(capturesDir, source, safeName);
                    if (!fs.existsSync(mdPath)) continue;

                    const content = fs.readFileSync(mdPath, 'utf-8');
                    const actions = await ai.extractActionItems(content);

                    for (const action of (actions || [])) {
                        try {
                            dbRun('INSERT INTO action_items (source_id, type, priority, description) VALUES (?, ?, ?, ?)',
                                [convId, action.type, action.priority, action.description]);
                            results.actionsFound++;
                        } catch { /* skip dups */ }
                    }
                } catch { /* skip */ }
            }
        }

        // ── 4. Auto-link unlinked captures ────────────────────────
        try {
            const autoResults = await autoOrganizeCaptures();
            results.linked = autoResults?.linked || 0;
        } catch (e) { console.warn('[Journal] auto-organize in sweep:', e.message); }

        auditLog('intelligence_sweep', JSON.stringify(results));
        return results;
    }

    function getActionItems(status = 'open') {
        try {
            return dbAll(`SELECT * FROM action_items WHERE status = ? ORDER BY CASE priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at DESC LIMIT 30`, [status]);
        } catch { return []; }
    }

    function completeActionItem(id) {
        console.log('[Journal] completeActionItem called with id:', id);
        try {
            dbRun('UPDATE action_items SET status = "done" WHERE id = ?', [id]);
            const after = dbGet('SELECT id, status FROM action_items WHERE id = ?', [id]);
            console.log('[Journal] after UPDATE:', after);
            return true;
        } catch (e) {
            console.error('[Journal] completeActionItem error:', e.message);
            return false;
        }
    }

    // ── Cross-Session Continuity ─────────────────────────────────
    function getSessionContinuity(convId) {
        const all = scanBrainArtifacts();
        const target = all.find(a => a.conversationId === convId);
        if (!target) return null;
        const targetTitle = (target.heading || target.file || '').toLowerCase().replace(/[_-]/g, ' ');
        const targetWords = new Set(targetTitle.split(/\s+/).filter(w => w.length > 3));
        const relatedSessions = all
            .filter(a => a.conversationId !== convId)
            .map(a => {
                const title = (a.heading || a.file || '').toLowerCase().replace(/[_-]/g, ' ');
                const words = title.split(/\s+/).filter(w => w.length > 3);
                const overlap = words.filter(w => targetWords.has(w)).length;
                const score = targetWords.size > 0 ? overlap / targetWords.size : 0;
                return { ...a, overlapScore: score };
            })
            .filter(a => a.overlapScore > 0.3)
            .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
        if (relatedSessions.length === 0) return null;
        const chain = [...relatedSessions, target].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
        const myIndex = chain.findIndex(a => a.conversationId === convId);
        const prev = myIndex > 0 ? chain[myIndex - 1] : null;
        const next = myIndex < chain.length - 1 ? chain[myIndex + 1] : null;
        return {
            position: myIndex + 1, total: chain.length,
            prev: prev ? { conversationId: prev.conversationId, title: prev.heading || prev.file, date: prev.updatedAt?.split('T')[0] } : null,
            next: next ? { conversationId: next.conversationId, title: next.heading || next.file, date: next.updatedAt?.split('T')[0] } : null,
            chain: chain.map(c => ({ conversationId: c.conversationId, title: c.heading || c.file, date: c.updatedAt?.split('T')[0] })),
        };
    }

    // ── KI Health Dashboard ─────────────────────────────────────
    function getKIHealth() {
        const kis = scanKnowledgeItems();
        const all = scanBrainArtifacts();
        const now = Date.now();
        const DAY = 86400000;
        let actionItems = [];
        try { actionItems = dbAll('SELECT source_id, priority FROM action_items WHERE status = ?', ['open']); } catch (e) { console.warn('[Journal] Action items query:', e.message); }
        return kis.map(ki => {
            const linkedSessions = all.filter(a => ki.references.includes(a.conversationId));
            const thisWeek = linkedSessions.filter(s => (now - new Date(s.updatedAt).getTime()) < 7 * DAY).length;
            const thisMonth = linkedSessions.filter(s => (now - new Date(s.updatedAt).getTime()) < 30 * DAY).length;
            const latestDate = linkedSessions.length > 0
                ? linkedSessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0].updatedAt : null;
            const ageMs = latestDate ? now - new Date(latestDate).getTime() : Infinity;
            const kiSessionIds = new Set(linkedSessions.map(s => s.conversationId));
            const openActions = actionItems.filter(a => kiSessionIds.has(a.source_id)).length;
            let status;
            if (thisWeek >= 3) status = 'hot';
            else if (thisWeek >= 1) status = 'active';
            else if (ageMs < 14 * DAY) status = 'good';
            else if (ageMs < 30 * DAY) status = 'stale';
            else status = 'dormant';
            return {
                topic: ki.topic, title: ki.title, summary: ki.summary, status,
                totalSessions: linkedSessions.length, thisWeek, thisMonth,
                lastActivity: latestDate ? latestDate.split('T')[0] : 'Never',
                openActions, artifactCount: ki.artifactCount || 0,
            };
        }).sort((a, b) => {
            const order = { hot: 0, active: 1, good: 2, stale: 3, dormant: 4 };
            return (order[a.status] || 5) - (order[b.status] || 5);
        });
    }

    // ── Export Functions ─────────────────────────────────────────
    function exportKI(kiTopic) {
        const knowledgeDir = path.join(ANTIGRAVITY_ROOT, 'knowledge');
        const metaPath = path.join(knowledgeDir, kiTopic, 'metadata.json');
        if (!fs.existsSync(metaPath)) return null;
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            const sections = ['# ' + (meta.title || kiTopic) + '\n'];
            sections.push('**Last Updated:** ' + (meta.updated_at || 'Unknown'));
            sections.push('**References:** ' + ((meta.references || []).length) + ' linked sessions\n');
            if (meta.summary) sections.push('## Summary\n' + meta.summary + '\n');
            const artifactsDir = path.join(knowledgeDir, kiTopic, 'artifacts');
            if (fs.existsSync(artifactsDir)) {
                const files = fs.readdirSync(artifactsDir).filter(f => f.endsWith('.md'));
                for (const file of files) {
                    try {
                        const content = fs.readFileSync(path.join(artifactsDir, file), 'utf-8');
                        sections.push('## ' + file.replace(/\.md$/, '').replace(/_/g, ' ') + '\n' + content + '\n');
                    } catch (e) { console.warn('[Journal] Session continuity:', e.message); }
                }
            }
            return sections.join('\n');
        } catch { return null; }
    }

    function exportDailyDigest(dateStr) {
        const digest = buildDailyDigest(dateStr);
        if (!digest || digest.sessionCount === 0) return null;
        const sections = ['# Daily Digest — ' + dateStr + '\n'];
        if (digest.narrative) sections.push('> ' + digest.narrative + '\n');
        sections.push('**Sessions:** ' + digest.sessionCount + ' | **Artifacts:** ' + digest.artifactCount + '\n');
        for (const session of (digest.sessions || [])) {
            const src = session.source ? '[' + session.source.toUpperCase() + ']' : '[AG]';
            sections.push('### ' + src + ' ' + (session.title || 'Untitled'));
            if (session.summary) sections.push(session.summary);
            sections.push('');
        }
        if (digest.notes && digest.notes.length > 0) {
            sections.push('## Notes');
            for (const n of digest.notes) sections.push('- ' + n.content);
        }
        return sections.join('\n');
    }

    // ── Project Workspaces (Cross-Model) ──────────────────────────

    function createProject(name, description = '', color = '#D4AF37', icon = '📁') {
        const now = Date.now();
        dbRun(`INSERT INTO projects (name, description, color, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, description, color, icon, now, now]);
        const row = dbGet('SELECT last_insert_rowid() as id');
        return row ? row.id : null;
    }

    function getProjects() {
        const projects = dbAll(`SELECT p.*, 
            (SELECT COUNT(*) FROM project_sessions WHERE project_id = p.id) as session_count
            FROM projects p ORDER BY p.updated_at DESC`);
        
        const all = scanBrainArtifacts();
        for (const proj of projects) {
            const linked = dbAll('SELECT conversation_id, source FROM project_sessions WHERE project_id = ?', [proj.id]);
            const sources = new Set();
            let lastActivity = 0;
            for (const link of linked) {
                if (link.source) sources.add(link.source);
                const arts = all.filter(a => a.conversationId === link.conversation_id);
                for (const a of arts) {
                    const t = new Date(a.updatedAt).getTime();
                    if (t > lastActivity) lastActivity = t;
                }
            }
            proj.sources = [...sources];
            proj.lastActivity = lastActivity > 0 ? new Date(lastActivity).toISOString() : null;
        }
        return projects;
    }

    function getProjectDetail(projectId) {
        const project = dbGet('SELECT * FROM projects WHERE id = ?', [projectId]);
        if (!project) return null;

        const links = dbAll('SELECT * FROM project_sessions WHERE project_id = ? ORDER BY added_at DESC', [projectId]);
        const all = scanBrainArtifacts();

        const sessions = [];
        for (const link of links) {
            const artifacts = all.filter(a => a.conversationId === link.conversation_id);
            const latest = artifacts.reduce((max, a) => {
                const t = new Date(a.updatedAt).getTime();
                return t > max ? t : max;
            }, 0);

            sessions.push({
                conversationId: link.conversation_id,
                source: link.source || 'antigravity',
                autoLinked: !!link.auto_linked,
                addedAt: link.added_at,
                artifacts: artifacts.map(a => ({
                    file: a.file,
                    heading: a.heading,
                    type: a.type,
                    summary: a.summary,
                    updatedAt: a.updatedAt,
                })),
                lastActivity: latest > 0 ? new Date(latest).toISOString() : null,
            });
        }

        sessions.sort((a, b) => {
            const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
            const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
            return tb - ta;
        });

        return { ...project, sessions };
    }

    function linkSessionToProject(projectId, conversationId, source = 'antigravity') {
        dbRun(`INSERT OR IGNORE INTO project_sessions (project_id, conversation_id, source, added_at, auto_linked)
               VALUES (?, ?, ?, ?, 0)`, [projectId, conversationId, source, Date.now()]);
        dbRun('UPDATE projects SET updated_at = ? WHERE id = ?', [Date.now(), projectId]);
    }

    function unlinkSession(projectId, conversationId) {
        dbRun('DELETE FROM project_sessions WHERE project_id = ? AND conversation_id = ?', [projectId, conversationId]);
    }

    function deleteProject(projectId) {
        dbRun('DELETE FROM project_sessions WHERE project_id = ?', [projectId]);
        dbRun('DELETE FROM projects WHERE id = ?', [projectId]);
    }

    function updateProject(projectId, fields) {
        const allowed = ['name', 'description', 'color', 'icon'];
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (sets.length === 0) return;
        sets.push('updated_at = ?');
        vals.push(Date.now());
        vals.push(projectId);
        dbRun(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    function autoSuggestProject(conversationId) {
        const all = scanBrainArtifacts();
        const arts = all.filter(a => a.conversationId === conversationId);
        if (arts.length === 0) return [];

        const sessionText = arts.map(a => [a.heading || '', a.summary || ''].join(' ')).join(' ').toLowerCase();
        const projects = dbAll('SELECT id, name, description FROM projects');

        const matches = [];
        for (const proj of projects) {
            const words = proj.name.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            const hits = words.filter(w => sessionText.includes(w));
            if (hits.length >= 2 || hits.some(w => w.length >= 6)) {
                matches.push({ projectId: proj.id, name: proj.name, score: hits.length });
            }
        }
        return matches.sort((a, b) => b.score - a.score);
    }

    // ── Auto-Classify Projects (Ollama-powered) ─────────────────

    async function autoClassifyProjects(vaultAI) {
        if (!vaultAI || !vaultAI.isAvailable || !vaultAI.isAvailable()) {
            console.log('[Projects] Ollama offline — skipping auto-classify');
            return { created: 0, linked: 0 };
        }

        const all = scanBrainArtifacts();
        if (all.length === 0) return { created: 0, linked: 0 };

        // One-time cleanup: strip garbled "Line 2:", "line_2:" prefixes from prior LLM output
        try {
            dbRun(`UPDATE projects SET name = TRIM(SUBSTR(name, INSTR(name, ':') + 2))
                   WHERE (name LIKE 'Line %:%' OR name LIKE 'line_%:%') AND INSTR(name, ':') > 0`);
            // Remove junk action items from fiction/roleplay captures
            dbRun(`DELETE FROM action_items WHERE
                   description LIKE '%SYSTEM_STATE_OPTIMIZATION%'
                   OR description LIKE '%persona_buffer%'
                   OR description LIKE '%RECURSIVE_DEREFERENCE%'
                   OR description LIKE '%entanglement%file%'
                   OR description LIKE '%shared_entropy%'`);
        } catch (e) { console.warn('[Projects] DB cleanup:', e.message); }

        // Get all sessions already linked to a project
        const linked = new Set(
            dbAll('SELECT conversation_id FROM project_sessions').map(r => r.conversation_id)
        );

        // Find unlinked sessions (group artifacts by conversation)
        const convMap = {};
        for (const a of all) {
            if (linked.has(a.conversationId)) continue;
            if (!convMap[a.conversationId]) convMap[a.conversationId] = { artifacts: [], source: a.source || 'antigravity' };
            convMap[a.conversationId].artifacts.push(a);
        }

        const unlinkedConvs = Object.entries(convMap);
        if (unlinkedConvs.length === 0) {
            console.log('[Projects] All sessions already linked');
            return { created: 0, linked: 0 };
        }

        // Limit to 10 per scan to avoid hammering Ollama
        const batch = unlinkedConvs.slice(0, 10);
        let created = 0, linkedCount = 0;
        const existingProjects = dbAll('SELECT id, name FROM projects');

        for (const [convId, data] of batch) {
            try {
                // Build text from session artifacts
                const text = data.artifacts.map(a => 
                    [a.heading || '', a.summary || ''].join(' ')
                ).join('\n').trim();
                
                if (text.length < 20) continue; // Skip near-empty sessions

                // Ask Ollama to classify the topic
                const topic = await vaultAI.classifyCaptureTopic(text);
                if (!topic || !topic.title) continue;

                const projectName = topic.title.substring(0, 80);

                // Fuzzy match against existing projects
                const nameWords = projectName.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
                let matchedProject = null;

                for (const proj of existingProjects) {
                    const projWords = proj.name.toLowerCase().replace(/[_-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
                    const overlap = nameWords.filter(w => projWords.some(pw => pw.includes(w) || w.includes(pw)));
                    if (overlap.length >= 2 || overlap.some(w => w.length >= 6)) {
                        matchedProject = proj;
                        break;
                    }
                }

                if (matchedProject) {
                    // Link to existing project
                    dbRun('INSERT OR IGNORE INTO project_sessions (project_id, conversation_id, source, added_at, auto_linked) VALUES (?, ?, ?, ?, 1)',
                        [matchedProject.id, convId, data.source, Date.now()]);
                    dbRun('UPDATE projects SET updated_at = ? WHERE id = ?', [Date.now(), matchedProject.id]);
                    linkedCount++;
                } else {
                    // Create new project and link
                    const now = Date.now();
                    dbRun('INSERT OR IGNORE INTO projects (name, description, color, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                        [projectName, 'Auto-created by AI', '#D4AF37', '🤖', now, now]);
                    const row = dbGet('SELECT last_insert_rowid() as id');
                    if (row && row.id) {
                        dbRun('INSERT OR IGNORE INTO project_sessions (project_id, conversation_id, source, added_at, auto_linked) VALUES (?, ?, ?, ?, 1)',
                            [row.id, convId, data.source, Date.now()]);
                        existingProjects.push({ id: row.id, name: projectName }); // Add so subsequent matches work
                        created++;
                        linkedCount++;
                    }
                }
            } catch (e) {
                console.warn('[Projects] Auto-classify error for', convId.substring(0, 8), ':', e.message);
            }
        }

        console.log('[Projects] Auto-classify: ' + created + ' projects created, ' + linkedCount + ' sessions linked (' + (unlinkedConvs.length - batch.length) + ' remaining)');
        return { created, linked: linkedCount, remaining: unlinkedConvs.length - batch.length };
    }

    // ── Public API ───────────────────────────────────────────────

    return {
        initAuditChain,
        auditLog,
        buildDailyDigest,
        getMorningBrief,
        getActivityDates,
        getMomentumData,
        getOpenTasks,
        getProjectThreads,
        getSessionDetail,
        readArtifact,
        addQuickNote,
        deleteQuickNote,
        pinSession,
        unpinSession,
        getPinnedSessions,
        invalidateCache,
        finalizeTask,
        archiveTask,
        getThreadDetail,
        readKnowledgeArtifact,
        // KI Management
        getKIList,
        linkCaptureToKI,
        createKIFromCaptures,
        suggestKIForCapture,
        autoOrganizeCaptures,
        // Intelligence v2
        getIntelligenceDashboard,
        getAIStatus,
        enrichKI,
        extractActions,
        getWeeklyReport,
        recordAIFeedback,
        getSessionClusters,
        getCapturePriorities,
        // Intelligence v3
        runIntelligenceSweep,
        getActionItems,
        completeActionItem,
        // v4 — Continuity, Health, Export
        getSessionContinuity,
        getKIHealth,
        exportKI,
        exportDailyDigest,
        // v5 — Cross-Model Project Workspaces
        createProject,
        getProjects,
        getProjectDetail,
        linkSessionToProject,
        unlinkSession,
        deleteProject,
        updateProject,
        autoSuggestProject,
        autoClassifyProjects,
    };
};

