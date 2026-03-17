/**
 * VERITAS VAULT — AI Intelligence Engine v2.0 (vault-ai.js)
 * ════════════════════════════════════════════════════════════════
 * Ollama-powered background AI for organizing, summarizing,
 * and discovering knowledge. Model: qwen2.5:7b for quality.
 * Graceful keyword fallback offline. Learning loop. Auto-ingest.
 */

const http = require('http');

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:7b';
const TIMEOUT_MS = 30000;        // 7B needs more time
const MAX_CONTEXT_CHARS = 6000;  // 7B handles more context

let _ollamaAvailable = false;
let _lastHealthCheck = 0;
const HEALTH_INTERVAL = 60000;

// ── Learning State ───────────────────────────────────────────
// Tracks accept/reject to adjust confidence bias per KI
const _learningBias = {};      // { kiTopic: number } positive = boost, negative = penalize
const _feedbackLog = [];       // { captureId, kiTopic, action, timestamp }

// ── Background Queue ─────────────────────────────────────────
const _ingestQueue = [];
let _ingestRunning = false;

// ── Low-Level Ollama HTTP ────────────────────────────────────

function ollamaPost(endpoint, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, OLLAMA_BASE);
        const data = JSON.stringify(body);
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: TIMEOUT_MS,
        }, (res) => {
            let buf = '';
            res.on('data', chunk => buf += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch { resolve({ response: buf }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
        req.write(data);
        req.end();
    });
}

function ollamaGet(endpoint) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, OLLAMA_BASE);
        const req = http.get(url, { timeout: 5000 }, (res) => {
            let buf = '';
            res.on('data', chunk => buf += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch { resolve({ raw: buf }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    });
}

// ── Health Check ─────────────────────────────────────────────

async function checkOllamaHealth() {
    if (Date.now() - _lastHealthCheck < HEALTH_INTERVAL) return _ollamaAvailable;
    try {
        const result = await ollamaGet('/api/version');
        _ollamaAvailable = !!(result && result.version);
        _lastHealthCheck = Date.now();
        return _ollamaAvailable;
    } catch {
        _ollamaAvailable = false;
        _lastHealthCheck = Date.now();
        return false;
    }
}

function isAvailable() { return _ollamaAvailable; }

// ── Core Generate (7B-tuned) ─────────────────────────────────

async function generate(prompt, systemPrompt = '', opts = {}) {
    const available = await checkOllamaHealth();
    if (!available) return null;

    try {
        const body = {
            model: opts.model || MODEL,
            prompt,
            system: systemPrompt || 'You are a precise knowledge organizer for a developer vault. Respond only with the requested output, no preamble or explanations.',
            stream: false,
            options: {
                temperature: opts.temperature || 0.25,
                num_predict: opts.maxTokens || 800,
                top_p: 0.9,
                repeat_penalty: 1.1,
            },
        };
        const result = await ollamaPost('/api/generate', body);
        return result?.response?.trim() || null;
    } catch {
        return null;
    }
}

// ── Truncation Helper ────────────────────────────────────────

function truncate(text, maxChars = MAX_CONTEXT_CHARS) {
    if (!text) return '';
    return text.length > maxChars ? text.substring(0, maxChars) + '…' : text;
}

// ═══════════════════════════════════════════════════════════════
// CORE AI OPERATIONS
// ═══════════════════════════════════════════════════════════════

// ── 1. Summarize Capture ─────────────────────────────────────

async function summarizeCapture(content) {
    const text = truncate(content);
    const result = await generate(
        `Analyze this developer session and write a SPECIFIC, TECHNICAL summary.

RULES:
- 2-4 sentences maximum
- MUST include: exact file names, function names, class names, protocol names, or tool names mentioned
- MUST include: what specifically was changed/built/fixed/analyzed
- MUST include: the outcome or finding (e.g., "found reentrancy in X", "implemented Y in Z.js", "fixed bug in function Q")
- NO generic phrases like "various improvements" or "worked on the project" or "made progress"
- Use past tense
- Be as dense with technical detail as possible

BAD: "Worked on wallet security improvements and made changes to several files."
GOOD: "Implemented AES-256 encryption in ledger.js for the OmegaWallet vault, added ERC-4337 UserOperation validation in entrypoint.sol, and fixed a reentrancy vector in the batch withdrawal flow."

Session:
${text}`,
        'You are a senior engineer writing precise commit-message-quality summaries. Every sentence must contain at least one specific technical artifact name.'
    );
    return result || keywordSummaryFallback(content);
}

function keywordSummaryFallback(content) {
    if (!content) return 'No content available';
    const lines = content.split('\n').filter(l => l.trim());
    const headings = lines.filter(l => l.startsWith('#')).map(l => l.replace(/^#+\s*/, ''));
    if (headings.length > 0) return headings.slice(0, 3).join('. ') + '.';
    return lines.slice(0, 2).join(' ').substring(0, 200);
}

// ── 2. Suggest KI Match (Learning-Adjusted) ──────────────────

async function suggestKIMatch(captureText, kiList) {
    if (!kiList || kiList.length === 0) return [];

    const kiDescriptions = kiList.map((ki, i) =>
        `${i + 1}. "${ki.title}" — ${truncate(ki.summary, 200)}`
    ).join('\n');

    const text = truncate(captureText, 3000);

    const result = await generate(
        `You are classifying a developer session into Knowledge Items.\n\nSession content:\n---\n${text}\n---\n\nAvailable Knowledge Items:\n${kiDescriptions}\n\nMatch this session to the most relevant KIs. Consider:\n- Technical topic overlap\n- Project/codebase references\n- Methodology patterns\n- Tool and framework mentions\n\nRespond in EXACTLY this format (one per line, up to 3):\nNUMBER|CONFIDENCE\n\nwhere CONFIDENCE is 0-100 representing certainty of match.\nExample: 3|87\n\nIf nothing matches above 15% confidence, respond: NONE`,
        'You are an expert knowledge classifier. Output ONLY number|confidence lines or NONE.'
    );

    if (!result || result.trim() === 'NONE') return keywordMatchFallback(captureText, kiList);

    try {
        const matches = result.split('\n')
            .map(line => line.trim())
            .filter(line => /^\d+\|\d+$/.test(line))
            .map(line => {
                const [idx, conf] = line.split('|').map(Number);
                const ki = kiList[idx - 1];
                if (!ki) return null;
                // Apply learning bias
                const bias = _learningBias[ki.topic] || 0;
                const adjustedConf = Math.max(0, Math.min(100, conf + bias));
                return { topic: ki.topic, title: ki.title, confidence: adjustedConf };
            })
            .filter(Boolean)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 3);
        return matches.length > 0 ? matches : keywordMatchFallback(captureText, kiList);
    } catch {
        return keywordMatchFallback(captureText, kiList);
    }
}

function keywordMatchFallback(captureText, kiList) {
    if (!captureText || !kiList) return [];
    const capWords = new Set(captureText.toLowerCase().split(/\s+/).filter(w => w.length > 4));

    return kiList.map(ki => {
        const kiWords = [ki.title, ki.summary].join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 4);
        const overlap = kiWords.filter(w => capWords.has(w)).length;
        let confidence = Math.min(Math.round((overlap / Math.max(kiWords.length, 1)) * 100), 95);
        const bias = _learningBias[ki.topic] || 0;
        confidence = Math.max(0, Math.min(95, confidence + bias));
        return { topic: ki.topic, title: ki.title, confidence };
    })
    .filter(m => m.confidence > 20)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

// ── 3. Classify Capture Topic ────────────────────────────────

async function classifyCaptureTopic(content) {
    const text = truncate(content, 3000);
    const result = await generate(
        `Classify this developer session. Output EXACTLY two lines:\nLine 1: A snake_case topic slug (e.g., wallet_security, smart_contract_audit, defi_protocol_analysis)\nLine 2: A clean human-readable title\n\nSession:\n${text}`,
        'You are a topic classifier. Output ONLY the two lines, nothing else.'
    );

    if (!result) return null;
    const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
        return {
            slug: lines[0].replace(/[^a-z0-9_]/g, '').substring(0, 60),
            title: lines[1].replace(/^["']|["']$/g, '').substring(0, 120),
        };
    }
    return null;
}

// ── 4. Capture Quality Score ─────────────────────────────────

async function captureQualityScore(content) {
    const text = truncate(content, 3000);
    const result = await generate(
        `Rate this developer session 1-5:\n1 = Quick question, trivial exchange\n2 = Brief discussion, minor fix\n3 = Moderate working session, some implementation\n4 = Substantial implementation with multiple changes\n5 = Deep, comprehensive session with architecture decisions\n\nConsider: lines of code changed, number of files touched, complexity of decisions, depth of analysis.\n\nSession:\n${text}\n\nOutput ONLY a single digit 1-5 followed by a pipe and one-word justification.\nExample: 4|implementation`,
        'Output ONLY in the format digit|word'
    );

    if (result) {
        const match = result.match(/^([1-5])\|/);
        if (match) return parseInt(match[1]);
        const digit = parseInt(result.trim());
        if (digit >= 1 && digit <= 5) return digit;
    }
    const len = (content || '').length;
    const headings = ((content || '').match(/^#+\s/gm) || []).length;
    if (len > 8000 && headings > 5) return 5;
    if (len > 5000 && headings > 3) return 4;
    if (len > 2000) return 3;
    if (len > 500) return 2;
    return 1;
}

// ── 5. Auto Title Cleanup ────────────────────────────────────

async function autoTitleCleanup(rawTitle) {
    let cleaned = rawTitle.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '').replace(/_/g, ' ');
    if (/^[A-Z][a-z]/.test(cleaned) && cleaned.length < 80) return cleaned;

    const result = await generate(
        `Rewrite this as a clean, professional session title (max 60 chars):\n"${cleaned}"\n\nOutput ONLY the clean title.`,
        'You are a title editor. Output ONLY the title, nothing else.'
    );
    return result || cleaned;
}

// ── 6. Session Debrief ───────────────────────────────────────

async function sessionDebrief(content) {
    const text = truncate(content, 4000);
    const result = await generate(
        `Write a single-line debrief (max 80 chars) of what happened in this session. Start with an action verb. Be specific about what was built/fixed/analyzed.\n\nSession:\n${text}`,
        'Output ONLY one line, max 80 chars, starting with a verb.'
    );
    return result ? result.substring(0, 100) : null;
}

// ── 7. Generate KI Summary ──────────────────────────────────

async function generateKISummary(title, captureContents) {
    const combined = captureContents.map((c, i) =>
        `--- Session ${i + 1} ---\n${truncate(c, 2000)}`
    ).join('\n\n');

    const result = await generate(
        `Generate a Knowledge Item summary for "${title}".

Linked sessions:
${truncate(combined, 5000)}

RULES:
- 4-8 sentences, dense with technical specifics
- MUST name specific files, functions, classes, protocols, tools, chains, or contracts
- MUST describe actual outcomes: what was built, what was found, what was decided
- Do NOT use phrases like "various aspects" or "multiple components" — name them
- Include the current state: what works, what's pending, what's broken
- If security/audit related: name the vulnerability type, the affected function, the severity

BAD: "This KI covers wallet development work across several sessions."
GOOD: "Covers the OmegaWallet v3 token integration: ERC-20 balance fetching via Alchemy's getTokenBalances() in bridge.js, custom token import with address validation in AddToken.jsx, and the encrypted ledger migration from AES-128 to AES-256 in crypto-vault.js. Transfer flow is complete for ETH/ERC-20 on mainnet and Polygon. Pending: ERC-721 NFT display and Solana SPL token support."`,
        'You are a knowledge base curator. Every sentence must contain at least one specific technical name.',
        { maxTokens: 1200 }
    );

    return result || `Knowledge item covering ${title}. Contains ${captureContents.length} linked sessions.`;
}

// ── 8. KI Enrichment (Full Rewrite) ──────────────────────────

async function enrichKISummary(currentSummary, title, allLinkedContent) {
    const combined = allLinkedContent.map((c, i) =>
        `--- Source ${i + 1} ---\n${truncate(c, 1500)}`
    ).join('\n\n');

    const result = await generate(
        `Rewrite this Knowledge Item summary to be comprehensive, specific, and up-to-date.

KI Title: "${title}"
Current Summary: ${truncate(currentSummary, 500)}

All linked content:
${truncate(combined, 4500)}

RULES:
- 5-10 sentences, dense with technical detail
- MUST name every specific file, function, protocol, tool, contract, or chain mentioned
- MUST describe actual outcomes: what was built, deployed, fixed, audited, or discovered
- MUST identify the current state: what's working, what's broken, what's pending
- Include any security findings with vulnerability type and severity
- Include any key architectural decisions with rationale
- Do NOT use generic phrases like "various improvements" or "several components"

Example good output:
"Covers the Hydra v3.0 scanner: 20 modules (384KB), fully functional, running AST-based analysis via slither and custom detectors. Neural Core baseline calibration targets Morpho Blue and Compound V3 fork contracts. Module 20 integrates EpistemicCompiler with retrieve_cve_context() for CVE_KNOWLEDGE_BASE lookups. Provenance Stack (v3.1 target) abstracts RAGPipeline, SufficiencyGate, and ReceiptSeal. All 13 new modules import cleanly. Version string on disk: 3.0.0. Pending: NeuralCore AUROC baselines and Morpho/Compact calibration targets."`,
        'You are a senior engineer maintaining a knowledge base. Be exhaustively specific.',
        { maxTokens: 1500, temperature: 0.2 }
    );

    return result || currentSummary;
}

// ── 9. Action Item Extraction ────────────────────────────────

async function extractActionItems(content) {
    const text = truncate(content, 5000);
    const result = await generate(
        `Extract actionable items from this developer session. Look for:\n- Explicit TODOs or tasks mentioned\n- Decisions that require follow-up\n- Bugs discovered but not fixed\n- Features partially implemented\n- Things explicitly deferred for later\n\nSession:\n${text}\n\nFormat EACH item as:\nTYPE|PRIORITY|DESCRIPTION\n\nTypes: TODO, BUG, DECISION, FOLLOWUP, DEFERRED\nPriority: HIGH, MEDIUM, LOW\n\nIf no actionable items found, respond: NONE`,
        'Extract action items precisely. Output ONLY the formatted lines or NONE.',
        { maxTokens: 600 }
    );

    if (!result || result.trim() === 'NONE') return [];

    return result.split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('|'))
        .map(line => {
            const parts = line.split('|');
            if (parts.length >= 3) {
                return {
                    type: (parts[0] || '').trim(),
                    priority: (parts[1] || '').trim(),
                    description: parts.slice(2).join('|').trim(),
                };
            }
            return null;
        })
        .filter(Boolean)
        .slice(0, 10);
}

// ── 10. Session Clustering ───────────────────────────────────

async function clusterSessions(sessions) {
    if (sessions.length < 3) return [{ label: 'All sessions', sessionIds: sessions.map(s => s.id) }];

    const descriptions = sessions.map((s, i) =>
        `${i + 1}. "${truncate(s.title || s.heading || 'Untitled', 80)}" — ${truncate(s.summary || '', 100)}`
    ).join('\n');

    const result = await generate(
        `Group these developer sessions into 2-5 thematic clusters.\n\nSessions:\n${descriptions}\n\nFormat each cluster as:\nLABEL|NUMBERS\nwhere NUMBERS is comma-separated session numbers.\n\nExample:\nWallet Security|1,3,7\nSmart Contract Audits|2,4,5`,
        'Group semantically similar sessions. Output ONLY the formatted lines.',
        { maxTokens: 400 }
    );

    if (!result) {
        return [{ label: 'Uncategorized', sessionIds: sessions.map(s => s.id) }];
    }

    try {
        const clusters = result.split('\n')
            .map(line => line.trim())
            .filter(line => line.includes('|'))
            .map(line => {
                const [label, nums] = line.split('|');
                const indices = nums.split(',').map(n => parseInt(n.trim()) - 1).filter(n => n >= 0 && n < sessions.length);
                return {
                    label: label.trim(),
                    sessionIds: indices.map(i => sessions[i]?.id).filter(Boolean),
                };
            })
            .filter(c => c.sessionIds.length > 0);
        return clusters.length > 0 ? clusters : [{ label: 'All', sessionIds: sessions.map(s => s.id) }];
    } catch {
        return [{ label: 'All', sessionIds: sessions.map(s => s.id) }];
    }
}

// ── 11. Priority Scoring ─────────────────────────────────────

async function prioritizeCaptures(captures) {
    if (captures.length === 0) return [];

    const descriptions = captures.map((c, i) =>
        `${i + 1}. "${truncate(c.title || c.heading || 'Untitled', 60)}" Quality:${c.quality || '?'} | ${truncate(c.summary || '', 80)}`
    ).join('\n');

    const result = await generate(
        `Rank these unlinked captures by importance for knowledge preservation.\n\nConsider:\n- Technical depth and value\n- Relevance to ongoing projects\n- Risk of losing valuable information\n- Uniqueness of content\n\nCaptures:\n${descriptions}\n\nOutput ranked list as: NUMBER|PRIORITY_SCORE(1-10)|REASON\n\nScore 10 = critical to preserve, 1 = low value.`,
        'Rank by importance. Output ONLY number|score|reason lines.',
        { maxTokens: 500 }
    );

    if (!result) {
        return captures.map((c, i) => ({ index: i, id: c.id, priority: c.quality || 3, reason: 'Keyword estimate' }));
    }

    try {
        return result.split('\n')
            .map(line => line.trim())
            .filter(line => /^\d+\|/.test(line))
            .map(line => {
                const parts = line.split('|');
                const idx = parseInt(parts[0]) - 1;
                const score = parseInt(parts[1]) || 5;
                const reason = (parts[2] || '').trim();
                const cap = captures[idx];
                return cap ? { index: idx, id: cap.id || cap.conversationId, priority: Math.min(score, 10), reason } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.priority - a.priority);
    } catch {
        return captures.map((c, i) => ({ index: i, id: c.id, priority: 3, reason: 'Fallback' }));
    }
}

// ── 12. Dependency Mapping ───────────────────────────────────

async function mapKIDependencies(kiList) {
    if (kiList.length < 2) return [];

    const descriptions = kiList.map((ki, i) =>
        `${i + 1}. "${ki.title}" — ${truncate(ki.summary, 150)}`
    ).join('\n');

    const result = await generate(
        `Analyze these Knowledge Items and identify dependency relationships.\n\nA depends on B if:\n- B is a prerequisite or foundation for A\n- A uses tools/patterns/infrastructure defined in B\n- A extends or modifies work documented in B\n\nKnowledge Items:\n${descriptions}\n\nFormat: FROM_NUM→TO_NUM|relationship\nwhere FROM depends on TO.\n\nExample: 3→1|uses security patterns from\n\nIf no dependencies, respond: NONE`,
        'Map knowledge dependencies. Output ONLY formatted lines or NONE.',
        { maxTokens: 500 }
    );

    if (!result || result.trim() === 'NONE') return [];

    try {
        return result.split('\n')
            .map(line => line.trim())
            .filter(line => line.includes('→') && line.includes('|'))
            .map(line => {
                const [arrow, rel] = line.split('|');
                const [fromStr, toStr] = arrow.split('→');
                const from = parseInt(fromStr) - 1;
                const to = parseInt(toStr) - 1;
                const kiFrom = kiList[from];
                const kiTo = kiList[to];
                if (!kiFrom || !kiTo) return null;
                return {
                    from: { topic: kiFrom.topic, title: kiFrom.title },
                    to: { topic: kiTo.topic, title: kiTo.title },
                    relationship: rel?.trim() || '',
                };
            })
            .filter(Boolean);
    } catch { return []; }
}

// ── 13. Weekly Intelligence Report ───────────────────────────

async function generateWeeklyReport(weekData) {
    const { totalSessions, topTopics, sourceBreakdown, kiChanges, actionItems, newKIs, staleKIs } = weekData;

    const context = [
        `Total sessions this week: ${totalSessions}`,
        `Top topics: ${(topTopics || []).map(t => `${t.topic} (${t.count})`).join(', ')}`,
        `Sources: ${(sourceBreakdown || []).map(s => `${s.source}: ${s.count}`).join(', ')}`,
        `KI changes: ${kiChanges || 0} KIs updated`,
        `New KIs created: ${newKIs || 0}`,
        `Stale KIs: ${staleKIs || 0}`,
        `Open action items: ${(actionItems || []).length}`,
        `High priority items: ${(actionItems || []).filter(a => a.priority === 'HIGH').length}`,
    ].join('\n');

    const result = await generate(
        `Generate a weekly intelligence report for a developer. Data:\n${context}\n\nWrite a 4-6 sentence narrative report covering:\n1. Key accomplishments and focus areas\n2. Knowledge base health (gaps, staleness)\n3. Actionable recommendations for next week\n4. Momentum assessment\n\nBe specific, data-driven, and actionable. Address the developer as "you".`,
        'You are a senior engineering manager writing a weekly review. Be concise but insightful.',
        { maxTokens: 800 }
    );

    return result || `This week: ${totalSessions} sessions across ${(topTopics || []).length} topics. ${staleKIs || 0} KIs need attention.`;
}

// ── 14. Proactive Morning Brief ──────────────────────────────

async function proactiveMorningBrief(briefData) {
    const { today, yesterday, openTasks, streak, knowledgeCount, staleKIs, unlinkedCount, actionItems, recentCaptures } = briefData;

    const captureTopics = (recentCaptures || []).map(c => c.heading || c.title || '').filter(Boolean).slice(0, 5).join(', ');

    const context = [
        `Today: ${today?.sessionCount || 0} sessions, ${today?.artifactCount || 0} artifacts`,
        `Yesterday: ${yesterday?.sessionCount || 0} sessions`,
        `Open tasks: ${openTasks?.length || 0}`,
        `Streak: ${streak || 0} days`,
        `Knowledge items: ${knowledgeCount || 0}`,
        `Stale KIs needing update: ${(staleKIs || []).length}`,
        `Unlinked captures awaiting routing: ${unlinkedCount || 0}`,
        `Open action items: ${(actionItems || []).length} (${(actionItems || []).filter(a => a.priority === 'HIGH').length} high priority)`,
        `Recent capture topics: ${captureTopics || 'none'}`,
        staleKIs?.length > 0 ? `Stale KI names: ${staleKIs.map(s => s.title).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const result = await generate(
        `Generate a personalized morning briefing for a developer. Be specific and actionable.\n\nData:\n${context}\n\nRules:\n- 3-5 sentences\n- Start with a greeting appropriate to the data (encouraging if productive, motivating if slow)\n- Mention SPECIFIC stale KIs by name if any\n- Mention SPECIFIC unlinked capture topics if any\n- Include one concrete recommendation for today\n- Be direct and professional, not cheesy`,
        'You are a developer productivity advisor. Be specific, data-driven, concise.',
        { maxTokens: 600 }
    );

    return result || null;
}

// ── 15. Merge Detection ──────────────────────────────────────

async function detectMergeableKIs(kiList) {
    if (kiList.length < 2) return [];

    const descriptions = kiList.map((ki, i) =>
        `${i + 1}. "${ki.title}" — ${truncate(ki.summary, 120)}`
    ).join('\n');

    const result = await generate(
        `Analyze these Knowledge Items for significant overlap that warrants merging.\n\n${descriptions}\n\nOnly suggest merges where content genuinely overlaps (>40% topic coverage). Format:\nNUMBER,NUMBER|reason\nIf no merges, respond: NONE`,
        'You are a knowledge organization expert. Be conservative — only suggest genuine overlaps.'
    );

    if (!result || result.trim() === 'NONE') return [];

    try {
        return result.split('\n')
            .map(line => line.trim())
            .filter(line => line.includes('|'))
            .map(line => {
                const [pair, reason] = line.split('|');
                const nums = pair.match(/\d+/g);
                if (!nums || nums.length < 2) return null;
                const [a, b] = nums.map(Number);
                const kiA = kiList[a - 1];
                const kiB = kiList[b - 1];
                if (!kiA || !kiB) return null;
                return { kiA: { topic: kiA.topic, title: kiA.title }, kiB: { topic: kiB.topic, title: kiB.title }, reason: reason?.trim() || '' };
            })
            .filter(Boolean);
    } catch { return []; }
}

// ── 16. Knowledge Gap Detection ──────────────────────────────

async function detectKnowledgeGaps(kiList, recentSessions) {
    const kiTitles = kiList.map(ki => ki.title).join(', ');
    const sessionSummaries = recentSessions.map(s =>
        truncate(s.title || s.heading || '', 80)
    ).join('\n');

    const result = await generate(
        `Existing Knowledge Items: ${kiTitles}\n\nRecent sessions without a KI:\n${truncate(sessionSummaries, 2500)}\n\nIdentify up to 3 topic areas that have enough sessions to warrant their own Knowledge Item. Format:\nTITLE|REASON|SESSION_COUNT\nIf none, respond: NONE`,
        'Identify knowledge gaps. Output ONLY formatted lines or NONE.'
    );

    if (!result || result.trim() === 'NONE') return [];

    return result.split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('|'))
        .map(line => {
            const parts = line.split('|');
            return {
                suggestedTitle: (parts[0] || '').trim(),
                reason: (parts[1] || '').trim(),
                sessionCount: parseInt(parts[2]) || 0,
            };
        })
        .filter(g => g.suggestedTitle)
        .slice(0, 5);
}

// ── 17. Stale KI Detection (Deterministic) ───────────────────

function detectStaleKIs(kiList, allCaptures, thresholdDays = 14) {
    const now = Date.now();
    const threshold = thresholdDays * 86400000;

    return kiList.map(ki => {
        const kiWords = [ki.title, ki.summary].join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 4);
        const relatedCaptures = allCaptures.filter(cap => {
            const capText = [cap.heading || '', cap.summary || ''].join(' ').toLowerCase();
            const hits = kiWords.filter(w => capText.includes(w));
            return hits.length >= 2 || hits.some(w => w.length >= 6);
        });

        const recentRelated = relatedCaptures.filter(c => {
            const age = now - new Date(c.updatedAt).getTime();
            return age < threshold;
        });

        if (recentRelated.length > 0) {
            return {
                topic: ki.topic,
                title: ki.title,
                newCaptureCount: recentRelated.length,
                message: `${recentRelated.length} new related capture${recentRelated.length !== 1 ? 's' : ''} found since last update`,
            };
        }
        return null;
    }).filter(Boolean);
}

// ── 18. Cross-Reference Discovery ────────────────────────────

async function discoverCrossReferences(kiList) {
    if (kiList.length < 3) return [];

    const descriptions = kiList.map((ki, i) =>
        `${i + 1}. "${ki.title}" — ${truncate(ki.summary, 150)}`
    ).join('\n');

    const result = await generate(
        `Find non-obvious but valuable connections between these Knowledge Items.\n\nLook for:\n- Shared technical patterns or methodologies\n- Common dependencies or infrastructure\n- Knowledge from one that would improve another\n- Complementary attack vectors or security patterns\n\n${descriptions}\n\nFormat: NUMBER,NUMBER|connection\nUp to 5 connections. If none, respond: NONE`,
        'Find deep, non-obvious connections. Output ONLY formatted lines or NONE.'
    );

    if (!result || result.trim() === 'NONE') return [];

    try {
        return result.split('\n')
            .map(line => line.trim())
            .filter(line => line.includes('|'))
            .map(line => {
                const [pair, connection] = line.split('|');
                const nums = pair.match(/\d+/g);
                if (!nums || nums.length < 2) return null;
                const [a, b] = nums.map(Number);
                const kiA = kiList[a - 1];
                const kiB = kiList[b - 1];
                if (!kiA || !kiB) return null;
                return { kiA: kiA.title, kiB: kiB.title, connection: connection?.trim() || '' };
            })
            .filter(Boolean);
    } catch { return []; }
}

// ── 19. Trend Analysis (Deterministic) ───────────────────────

function computeTrends(sessions, days = 7) {
    const now = new Date();
    const topicCounts = {};
    const sourceCounts = {};
    const dailyCounts = {};

    for (const s of sessions) {
        const sessionDate = s.date || s.updatedAt;
        if (!sessionDate) continue;
        const age = (now - new Date(sessionDate)) / 86400000;
        if (age > days) continue;

        const dayKey = typeof sessionDate === 'string' ? sessionDate.split('T')[0] : new Date(sessionDate).toISOString().split('T')[0];
        dailyCounts[dayKey] = (dailyCounts[dayKey] || 0) + 1;

        const source = s.source || 'antigravity';
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;

        const words = (s.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
        for (const w of words) {
            topicCounts[w] = (topicCounts[w] || 0) + 1;
        }
    }

    const topTopics = Object.entries(topicCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([topic, count]) => ({ topic, count }));

    const totalSessions = Object.values(dailyCounts).reduce((a, b) => a + b, 0);
    const sourceBreakdown = Object.entries(sourceCounts).map(([source, count]) => ({
        source,
        count,
        pct: totalSessions > 0 ? Math.round((count / totalSessions) * 100) : 0,
    }));

    return { topTopics, sourceBreakdown, dailyCounts, totalSessions, days };
}


// ═══════════════════════════════════════════════════════════════
// LEARNING LOOP
// ═══════════════════════════════════════════════════════════════

function recordFeedback(captureId, kiTopic, action) {
    _feedbackLog.push({ captureId, kiTopic, action, timestamp: Date.now() });

    if (action === 'accepted') {
        _learningBias[kiTopic] = (_learningBias[kiTopic] || 0) + 3;
    } else if (action === 'rejected') {
        _learningBias[kiTopic] = (_learningBias[kiTopic] || 0) - 5;
    }

    // Decay all biases slowly toward zero
    for (const topic of Object.keys(_learningBias)) {
        if (_learningBias[topic] > 0) _learningBias[topic] = Math.max(0, _learningBias[topic] - 0.5);
        if (_learningBias[topic] < 0) _learningBias[topic] = Math.min(0, _learningBias[topic] + 0.5);
    }
}

function getLearningStats() {
    return {
        totalFeedback: _feedbackLog.length,
        biases: { ..._learningBias },
        acceptRate: _feedbackLog.length > 0
            ? Math.round(_feedbackLog.filter(f => f.action === 'accepted').length / _feedbackLog.length * 100)
            : 0,
    };
}

// ═══════════════════════════════════════════════════════════════
// AUTO-INGEST PIPELINE
// ═══════════════════════════════════════════════════════════════

function queueIngest(captureData) {
    _ingestQueue.push(captureData);
    processIngestQueue();
}

async function processIngestQueue() {
    if (_ingestRunning || _ingestQueue.length === 0) return;
    _ingestRunning = true;

    while (_ingestQueue.length > 0) {
        const capture = _ingestQueue.shift();
        try {
            const content = capture.content || '';

            // Auto-process pipeline: summarize → quality → debrief → classify → suggest
            const results = {};

            results.summary = await summarizeCapture(content);
            results.quality = await captureQualityScore(content);
            results.debrief = await sessionDebrief(content);
            results.topic = await classifyCaptureTopic(content);
            results.title = await autoTitleCleanup(capture.title || capture.heading || '');
            results.actions = await extractActionItems(content);

            // Emit results via callback if available
            if (capture.onProcessed) capture.onProcessed(results);
        } catch { /* noop — don't block queue */ }
    }

    _ingestRunning = false;
}


// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

module.exports = {
    // Health
    checkOllamaHealth,
    isAvailable,

    // Core operations
    summarizeCapture,
    suggestKIMatch,
    classifyCaptureTopic,
    captureQualityScore,
    autoTitleCleanup,
    sessionDebrief,
    generateKISummary,

    // Enhanced intelligence
    enrichKISummary,
    extractActionItems,
    clusterSessions,
    prioritizeCaptures,
    mapKIDependencies,
    generateWeeklyReport,
    proactiveMorningBrief,

    // Smart organization
    detectMergeableKIs,
    detectKnowledgeGaps,
    detectStaleKIs,
    discoverCrossReferences,

    // Trends
    computeTrends,

    // Learning
    recordFeedback,
    getLearningStats,

    // Auto-ingest
    queueIngest,
    processIngestQueue,
};
