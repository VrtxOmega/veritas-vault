/**
 * VERITAS VAULT v3.0 — Renderer (Smart Notebook + RAG Chat + Follow-Ups)
 * ════════════════════════════════════════════════════════════════
 * Daily journal, momentum, project threads, task tracker.
 */

// ── Canonical Source Colors ──────────────────────────────────
const SOURCE_COLORS = { antigravity: '#D4AF37', chatgpt: '#10A37F', claude: '#CC785C', gemini: '#4285F4', hermes: '#00FF00', manual: '#888', test: '#888' };
const SOURCE_LABELS = { antigravity: 'AG', chatgpt: 'GPT', claude: 'CLA', gemini: 'GEM', hermes: 'HER', manual: 'MAN', test: 'TST' };

// ── State ────────────────────────────────────────────────────
let loadedDays = 0;
const DAYS_PER_LOAD = 7;
let currentNoteDate = null;
let _userDisplayName = 'RJ';  // Configurable via settings

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            gfm: true, breaks: false, pedantic: false,
            highlight(code, lang) {
                if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                    try { return hljs.highlight(lang, code).value; } catch { }
                }
                return '';
            }
        });
    }

    setupNavigation();
    setupSearch();
    setupSettings();
    setupKeyboard();
    setupEventDelegation();
    setupChat();
    setupFollowUps();

    await loadJournal();
    setStatus('Capturing', true);

    // Live capture events — debounce-refresh journal on file changes
    let refreshTimer = null;
    window.vault.onCapture((data) => {
        addCaptureToast(data);
        // Debounce: wait 2s after last event before refreshing
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
            try {
                const [brief, momentum] = await Promise.all([
                    window.vault.getMorningBrief(),
                    window.vault.getMomentum(91)
                ]);
                renderMorningBrief(brief);
                renderMomentum(momentum, brief.streak);
                // Refresh today's card
                const today = toDateStr(new Date());
                const todayCard = document.querySelector(`.day-card[data-date="${today}"]`);
                const digest = await window.vault.getDailyDigest(today);
                if (todayCard && digest.sessionCount > 0) {
                    todayCard.outerHTML = renderDayCard(digest, new Date());
                } else if (!todayCard && digest.sessionCount > 0) {
                    const timeline = document.getElementById('daily-timeline');
                    timeline.insertAdjacentHTML('afterbegin', renderDayCard(digest, new Date()));
                }
            } catch (e) { console.error('[Vault] Refresh error:', e); }
        }, 2000);
    });

    // Capture health warning
    window.vault.onCaptureWarning?.((data) => {
        showToast(data.message, 'warning', 10000);
    });

    // NAEF Telemetry — update subsystem health dots in titlebar
    window.vault.onTelemetry?.((health) => {
        const map = { db: 'telem-db', ollama: 'telem-ollama', capture: 'telem-capture', watcher: 'telem-watcher' };
        for (const [key, id] of Object.entries(map)) {
            const dot = document.getElementById(id);
            if (dot && health[key]) dot.setAttribute('data-status', health[key]);
        }
    });
});

// ── Navigation ───────────────────────────────────────────────
function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const panel = btn.dataset.panel;
            if (!panel) return;
            switchPanel(panel);
        });
    });
}

function switchPanel(name) {
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('active');
        b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.nav-btn[data-panel="${name}"]`);
    const panel = document.getElementById(`panel-${name}`);
    if (btn) { btn.classList.add('active'); btn.setAttribute('aria-current', 'true'); }
    if (panel) panel.classList.add('active');

    // Lazy load panels
    if (name === 'projects') loadProjects();
    if (name === 'tasks') loadTasks();
    if (name === 'intelligence') loadIntelligence();
    if (name === 'ask') loadChatPanel();
}

// ── Journal (Main View) ─────────────────────────────────────
async function loadJournal() {
    try {
        const [brief, momentum] = await Promise.all([
            window.vault.getMorningBrief(),
            window.vault.getMomentum(91)
        ]);

        renderMorningBrief(brief);
        renderMomentum(momentum, brief.streak);
        await loadPinnedSessions();
        await loadDays(DAYS_PER_LOAD);
    } catch (e) {
        console.error('[Vault] Journal load error:', e);
    }
}

function renderMorningBrief(brief) {
    const el = document.getElementById('morning-brief');
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const todayCount = brief.today?.sessionCount || 0;
    const yesterdayCount = brief.yesterday?.sessionCount || 0;
    const openCount = brief.openTasks?.reduce((s, t) => s + t.open.length + t.inProgress.length, 0) || 0;

    // Resume context panel
    let resumeHtml = '';
    if (brief.resumeContext) {
        const rc = brief.resumeContext;
        const sessionsHtml = rc.recentSessions.map(s => {
            const inProgHtml = s.inProgressItems.length > 0
                ? `<div class="resume-in-progress">${s.inProgressItems.map(i => `<span class="resume-task">🔄 ${esc(i)}</span>`).join('')}</div>`
                : '';
            const summarySnippet = s.summary ? s.summary.substring(0, 100) + (s.summary.length > 100 ? '…' : '') : '';
            return `<div class="resume-session" data-action="navigate-resume-session" data-conv-id="${s.conversationId}">
                <strong>${esc(s.title)}</strong>
                ${summarySnippet ? `<span class="resume-summary">${esc(summarySnippet)}</span>` : ''}
                ${inProgHtml}
            </div>`;
        }).join('');

        resumeHtml = `
            <div class="resume-context">
                <div class="resume-header">
                    <span class="resume-icon">📍</span>
                    <span class="resume-title">Pick up where you left off</span>
                    <span class="resume-time">${esc(rc.timeLabel)}</span>
                </div>
                ${sessionsHtml}
            </div>
        `;
    }

    // Weekly rollup panel
    let weeklyHtml = '';
    if (brief.weeklyRollup && brief.weeklyRollup.narrative) {
        const wr = brief.weeklyRollup;
        const projectBars = wr.topProjects.map(p => {
            const pct = Math.round((p.days / 7) * 100);
            return `<div class="weekly-project" data-action="navigate-weekly-project" data-project-name="${esc(p.name)}">
                <span class="weekly-project-name">${esc(p.name)}</span>
                <div class="weekly-bar"><div class="weekly-bar-fill" style="width:${pct}%"></div></div>
                <span class="weekly-days">${p.days}d</span>
            </div>`;
        }).join('');

        weeklyHtml = `
            <div class="weekly-rollup">
                <div class="weekly-header">📊 7-Day Overview</div>
                <div class="weekly-narrative">${wr.narrative.replace(/\*\*(.+?)\*\*/g, '<span class="nav-link" data-action="navigate-weekly-project" data-project-name="$1">$1</span>')}</div>
                ${projectBars}
            </div>
        `;
    }

    el.innerHTML = `
        <div class="morning-greeting">${greeting}, <strong>${esc(_userDisplayName)}</strong></div>
        <div class="morning-sub">${formatDateLong(new Date())}</div>
        <div class="morning-stats">
            <div class="morning-stat"><strong>${todayCount}</strong> session${todayCount !== 1 ? 's' : ''} today</div>
            <div class="morning-stat"><strong>${yesterdayCount}</strong> yesterday</div>
            <div class="morning-stat clickable" data-action="navigate-to-tasks"><strong>${openCount}</strong> open task${openCount !== 1 ? 's' : ''}</div>
            <div class="morning-stat"><strong>${brief.knowledgeCount}</strong> knowledge items</div>
        </div>
        ${resumeHtml}
        ${renderActionItems(brief.actionItems)}
        ${weeklyHtml}
    `;
    el.style.display = '';
}

function renderActionItems(items) {
    if (!items || items.length === 0) return '';
    const priorityColors = { HIGH: '#ff5555', MEDIUM: '#f0ad4e', LOW: '#5bc0de' };
    const typeIcons = { TODO: '☑️', BUG: '🐛', DECISION: '🔀', FOLLOWUP: '📋', DEFERRED: '⏳' };

    const itemsHtml = items.slice(0, 8).map(item => {
        const color = priorityColors[item.priority] || '#888';
        const isDone = item.status === 'done';
        const icon = isDone ? '✅' : (typeIcons[item.type] || '📌');
        const descClass = isDone ? 'action-desc done' : 'action-desc';
        const doneBtn = isDone
            ? ''
            : `<button class="action-done-btn" data-action="complete-action" data-action-id="${item.id}" title="Mark done">✓</button>`;
        return `<div class="action-item" id="action-${item.id}" data-action="navigate-action-item" data-source-id="${item.source_id || ''}">
            <span class="action-icon">${icon}</span>
            <span class="${descClass}">${esc(item.description)}</span>
            <span class="action-priority" style="color:${color}">${item.priority || ''}</span>
            ${doneBtn}
        </div>`;
    }).join('');

    return `
        <div class="action-items-panel">
            <div class="action-items-header">⚡ Action Items <span class="action-count">${items.length}</span></div>
            ${itemsHtml}
        </div>
    `;
}

function renderMomentum(data, streak) {
    const grid = document.getElementById('momentum-grid');
    if (!data || data.length === 0) return;

    const maxCount = Math.max(1, ...data.map(d => d.count));
    grid.innerHTML = data.map(d => {
        let level = 0;
        if (d.count > 0) level = Math.min(4, Math.ceil((d.count / maxCount) * 4));
        return `<div class="heat-cell" data-level="${level}" title="${d.date}: ${d.count} artifacts"></div>`;
    }).join('');

    const badge = document.getElementById('streak-badge');
    badge.textContent = streak > 0 ? `🔥 ${streak}-day streak` : '';
}

async function loadPinnedSessions() {
    try {
        const pinned = await window.vault.getPinnedSessions();
        const section = document.getElementById('pinned-section');
        const list = document.getElementById('pinned-list');
        if (!pinned || pinned.length === 0) { section.style.display = 'none'; return; }

        section.style.display = '';
        list.innerHTML = pinned.map(p => `
            <div class="pinned-card" data-action="expand-pinned" data-conv-id="${p.conversationId}">
                <span class="pinned-title">${esc(p.title)}</span>
                <span class="pinned-badge">${p.artifactCount} artifacts</span>
            </div>
        `).join('');
    } catch { }
}

async function loadDays(count) {
    const timeline = document.getElementById('daily-timeline');
    const today = new Date();

    for (let i = 0; i < count; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - loadedDays);
        const dateStr = toDateStr(d);

        try {
            const digest = await window.vault.getDailyDigest(dateStr);
            if (digest.sessionCount > 0 || (digest.notes && digest.notes.length > 0)) {
                timeline.insertAdjacentHTML('beforeend', renderDayCard(digest, d));
            }
        } catch { }
        loadedDays++;
    }
}

function renderDayCard(digest, dateObj) {
    const relative = getRelativeDay(dateObj);
    const formattedDate = formatDateLong(dateObj);

    // Production summary bar
    let summaryHtml = '';
    if (digest.productionSummary) {
        const { sourceBreakdown, topProjects } = digest.productionSummary;
        const sourceChips = Object.entries(sourceBreakdown).map(([src, count]) => {
            const colors = SOURCE_COLORS;
            const labels = SOURCE_LABELS;
            return `<span class="source-chip" style="border-color:${colors[src] || '#555'}">${labels[src] || src} <strong>${count}</strong></span>`;
        }).join('');
        const projectChips = topProjects.map(p => `<span class="topic-pill">${esc(p)}</span>`).join('');
        summaryHtml = `<div class="day-summary">${sourceChips}${projectChips}</div>`;
    }

    // Enhanced notes with timestamps and delete
    let notesHtml = '';
    if (digest.notes && digest.notes.length > 0) {
        notesHtml = `<div class="day-notes">${digest.notes.map(n => {
            const ts = n.created_at ? relativeTime(n.created_at * 1000) : '';
            return `<div class="note-item">
                <span class="note-content">${esc(n.content)}</span>
                <span class="note-meta">${ts}</span>
                <button class="note-delete" data-action="delete-note" data-note-id="${n.id}" data-date="${digest.date}" title="Delete note">×</button>
            </div>`;
        }).join('')}</div>`;
    }

    // Sessions grouped by source with collapsible accordions
    let sessionsHtml = '';
    const groups = digest.sessionsBySource || {};
    const sourceOrder = ['antigravity', 'gemini', 'chatgpt', 'claude'];
    const orderedSources = [...new Set([...sourceOrder.filter(s => groups[s]), ...Object.keys(groups)])];

    for (const src of orderedSources) {
        const srcSessions = groups[src] || [];
        if (srcSessions.length === 0) continue;

        if (src === 'antigravity') {
            // AG sessions: show expanded (they have meaningful titles)
            sessionsHtml += srcSessions.map(s => renderSessionCard(s)).join('');
        } else {
            // Capture sessions: collapsible accordion
            const labels = { gemini: 'Gemini', chatgpt: 'ChatGPT', claude: 'Claude' };
            const colors = SOURCE_COLORS;
            const label = labels[src] || src;
            const color = colors[src] || '#888';
            const groupId = `srcgroup-${digest.date}-${src}`;
            sessionsHtml += `
                <div class="source-group">
                    <div class="source-group-header" data-action="toggle-source-group" data-group-id="${groupId}">
                        <span class="source-badge" style="background:${color}">${label}</span>
                        <span class="source-group-count">${srcSessions.length} session${srcSessions.length !== 1 ? 's' : ''}</span>
                        <span class="source-group-chevron">▶</span>
                    </div>
                    <div class="source-group-body" id="${groupId}" style="display:none">
                        ${srcSessions.map(s => renderSessionCard(s)).join('')}
                    </div>
                </div>
            `;
        }
    }

    return `
        <div class="day-card" data-date="${digest.date}">
            <div class="day-header">
                ${relative ? `<span class="day-relative">${relative}</span>` : ''}
                <span class="day-date">${formattedDate}</span>
                <span class="day-count">${digest.sessionCount} session${digest.sessionCount !== 1 ? 's' : ''} · ${digest.artifactCount} artifacts</span>
            </div>
            ${digest.narrative ? `<div class="day-narrative">${digest.narrative.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\`(.+?)\`/g, '<code>$1</code>')}</div>` : ''}
            ${summaryHtml}
            ${notesHtml}
            <div class="day-actions">
                <button class="btn-ghost btn-sm" data-action="open-note" data-date="${digest.date}">+ Note</button>
                <button class="btn-ghost btn-sm" data-action="export-daily" data-date="${digest.date}">📋 Export</button>
            </div>
            ${sessionsHtml}
        </div>
    `;
}

function renderSessionCard(session) {
    const types = session.artifacts.map(a => a.type).filter((v, i, s) => s.indexOf(v) === i);
    const typeStr = types.join(' · ');
    const pinClass = session.pinned ? 'pinned' : '';
    const source = session.source || 'antigravity';
    const sourceColors = SOURCE_COLORS;
    const sourceLabels = { antigravity: 'AG', gemini: 'Gem', chatgpt: 'GPT', manual: '✎' };
    const srcColor = sourceColors[source] || '#888';
    const srcLabel = sourceLabels[source] || source.substring(0, 3);

    return `
        <div class="session-card" id="session-${session.conversationId}">
            <div class="session-header" data-action="toggle-session" data-conv-id="${session.conversationId}">
                <span class="source-badge" style="background:${srcColor}" title="${source}">${srcLabel}</span>
                <span class="session-type">${esc(typeStr)}</span>
                <span class="session-title">${esc(session.title)}</span>
                <span class="session-meta">${session.artifactCount} file${session.artifactCount !== 1 ? 's' : ''}${session.snapshotCount > 1 ? ` · 📸 ${session.snapshotCount} snapshots` : ''}</span>
                <button class="session-pin ${pinClass}" data-action="toggle-pin" data-conv-id="${session.conversationId}" title="Pin session">📌</button>
                <span class="session-chevron">▶</span>
            </div>
            ${session.summary ? `<div class="session-summary">${esc(session.summary).substring(0, 200)}${session.summary.length > 200 ? '…' : ''}</div>` : ''}
            <div class="session-detail" id="detail-${session.conversationId}"></div>
        </div>
    `;
}

async function toggleSession(convId) {
    const card = document.getElementById(`session-${convId}`);
    const detail = document.getElementById(`detail-${convId}`);
    if (!card || !detail) return;

    if (card.classList.contains('expanded')) {
        card.classList.remove('expanded');
        return;
    }

    // Fetch details if not loaded
    if (!detail.innerHTML.trim()) {
        try {
            const data = await window.vault.getSessionDetail(convId);
            detail.innerHTML = (data.artifacts || []).map(a => `
                <div class="artifact-item" data-action="open-artifact" data-conv-id="${convId}" data-file="${esc(a.file)}">
                    <div class="artifact-item-header">
                        <span class="artifact-type-badge">${esc(a.type)}</span>
                        <span class="artifact-heading">${esc(a.heading || a.file)}</span>
                    </div>
                    ${a.summary ? `<div class="artifact-summary-text">${esc(a.summary)}</div>` : ''}
                </div>
            `).join('');
        } catch {
            detail.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Could not load details</div>';
        }
    }

    card.classList.add('expanded');

    // Load session continuity (prev/next navigation)
    const contContainer = detail.querySelector('.continuity-container') || (() => {
        const c = document.createElement('div');
        c.className = 'continuity-container';
        detail.prepend(c);
        return c;
    })();
    loadSessionContinuity(convId, contContainer);
}

async function toggleThreadSession(convId) {
    const item = document.getElementById(`tsession-${convId}`);
    const detail = document.getElementById(`tdetail-${convId}`);
    if (!item || !detail) return;

    if (item.classList.contains('expanded')) {
        item.classList.remove('expanded');
        detail.style.display = 'none';
        return;
    }

    // Load detail if not already loaded
    if (!detail.innerHTML.trim()) {
        try {
            const data = await window.vault.getSessionDetail(convId);
            if (data.artifacts && data.artifacts.length > 0) {
                detail.innerHTML = data.artifacts.map(a => {
                    const typeClass = a.type.includes('You') ? 'exchange-user' : a.type.includes('Response') ? 'exchange-model' : '';
                    return `
                        <div class="capture-detail-item ${typeClass}">
                            <span class="capture-detail-type">${esc(a.type)}</span>
                            ${a.heading ? `<strong class="capture-detail-heading">${esc(a.heading)}</strong>` : ''}
                            ${a.summary ? `<div class="capture-detail-text">${esc(a.summary)}</div>` : ''}
                        </div>
                    `;
                }).join('');
            } else {
                detail.innerHTML = '<div class="capture-detail-empty">No detail available</div>';
            }
        } catch {
            detail.innerHTML = '<div class="capture-detail-empty">Could not load session detail</div>';
        }
    }

    detail.style.display = '';
    item.classList.add('expanded');
}

async function togglePin(convId) {
    const btn = document.querySelector(`#session-${convId} .session-pin`);
    if (!btn) return;

    if (btn.classList.contains('pinned')) {
        await window.vault.unpinSession(convId);
        btn.classList.remove('pinned');
    } else {
        await window.vault.pinSession(convId, '');
        btn.classList.add('pinned');
    }
    await loadPinnedSessions();
}

async function expandPinnedSession(convId) {
    switchPanel('journal');
    const card = document.getElementById(`session-${convId}`);
    if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!card.classList.contains('expanded')) toggleSession(convId);
    }
}

// ── Artifact Viewer ──────────────────────────────────────────
async function openArtifact(convId, file) {
    const overlay = document.getElementById('artifact-overlay');
    const title = document.getElementById('artifact-title');
    const body = document.getElementById('artifact-body');

    title.textContent = file;
    body.innerHTML = '<div style="color:var(--text-muted)">Loading…</div>';
    overlay.style.display = 'flex';

    try {
        const data = await window.vault.readArtifact(convId, file);
        if (data && data.content) {
            if (file.endsWith('.md')) {
                body.innerHTML = typeof marked !== 'undefined' ? marked.parse(data.content) : `<pre>${esc(data.content)}</pre>`;
            } else if (file.endsWith('.json')) {
                body.innerHTML = `<pre><code>${esc(data.content)}</code></pre>`;
            } else {
                body.innerHTML = `<pre>${esc(data.content)}</pre>`;
            }
        } else {
            body.innerHTML = '<div style="color:var(--text-muted)">File not found</div>';
        }
    } catch {
        body.innerHTML = '<div style="color:var(--text-muted)">Error loading artifact</div>';
    }
}

function closeArtifact() {
    document.getElementById('artifact-overlay').style.display = 'none';
    // Return focus to main content
    const activePanel = document.querySelector('.panel.active');
    if (activePanel) activePanel.focus();
}

// ── Quick Notes ──────────────────────────────────────────────
function openNoteModal(dateStr) {
    currentNoteDate = dateStr;
    document.getElementById('note-input').value = '';
    document.getElementById('note-modal').style.display = 'flex';
    document.getElementById('note-input').focus();
}

function closeNoteModal() {
    document.getElementById('note-modal').style.display = 'none';
    currentNoteDate = null;
}

async function submitQuickNote() {
    const content = document.getElementById('note-input').value.trim();
    if (!content || !currentNoteDate) return;

    await window.vault.addQuickNote(currentNoteDate, content);
    closeNoteModal();

    // Refresh the day card
    const dayCard = document.querySelector(`.day-card[data-date="${currentNoteDate}"]`);
    if (dayCard) {
        const digest = await window.vault.getDailyDigest(currentNoteDate);
        const notesContainer = dayCard.querySelector('.day-notes');
        if (notesContainer) {
            notesContainer.innerHTML = digest.notes.map(n => {
                const ts = n.created_at ? relativeTime(n.created_at * 1000) : '';
                return `<div class="note-item">
                    <span class="note-content">${esc(n.content)}</span>
                    <span class="note-meta">${ts}</span>
                    <button class="note-delete" data-action="delete-note" data-note-id="${n.id}" data-date="${currentNoteDate}" title="Delete note">×</button>
                </div>`;
            }).join('');
        } else {
            const actions = dayCard.querySelector('.day-actions');
            if (actions) {
                actions.insertAdjacentHTML('beforebegin', `<div class="day-notes">${digest.notes.map(n => {
                    const ts = n.created_at ? relativeTime(n.created_at * 1000) : '';
                    return `<div class="note-item">
                        <span class="note-content">${esc(n.content)}</span>
                        <span class="note-meta">${ts}</span>
                        <button class="note-delete" data-action="delete-note" data-note-id="${n.id}" data-date="${currentNoteDate}" title="Delete note">×</button>
                    </div>`;
                }).join('')}</div>`);
            }
        }
    }
}

// ── Load More Days ───────────────────────────────────────────
async function loadMoreDays() {
    await loadDays(DAYS_PER_LOAD);
}

// ── Search ───────────────────────────────────────────────────
function setupSearch() {
    const input = document.getElementById('search-input');
    if (!input) return;

    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => executeSearch(input.value.trim()), 300);
    });
}

async function executeSearch(query) {
    const results = document.getElementById('search-results');
    const count = document.getElementById('search-count');
    if (!query || query.length < 2) {
        results.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">Full-text search across your entire corpus</div></div>';
        count.textContent = '';
        return;
    }

    try {
        const rows = await window.vault.search(query);
        count.textContent = `${rows.length} result${rows.length !== 1 ? 's' : ''}`;

        if (rows.length === 0) {
            results.innerHTML = '<div class="empty-state"><div class="empty-text">No results found</div></div>';
            return;
        }

        results.innerHTML = rows.map(r => `
            <div class="search-result" data-action="open-search-result" data-rel-path="${esc(r.rel_path)}">
                <div class="search-result-title">${esc(r.title || r.rel_path)}</div>
                <div class="search-result-path">${esc(r.rel_path)}</div>
                ${r.snippet ? `<div class="search-result-snippet">${r.snippet}</div>` : ''}
            </div>
        `).join('');
    } catch {
        results.innerHTML = '<div class="empty-state"><div class="empty-text">Search error</div></div>';
    }
}

async function openFileFromSearch(relPath) {
    const data = await window.vault.readFile(relPath);
    if (!data) return;

    const overlay = document.getElementById('artifact-overlay');
    const title = document.getElementById('artifact-title');
    const body = document.getElementById('artifact-body');

    title.textContent = data.title || relPath;
    if (relPath.endsWith('.md')) {
        body.innerHTML = typeof marked !== 'undefined' ? marked.parse(data.content) : `<pre>${esc(data.content)}</pre>`;
    } else {
        body.innerHTML = `<pre>${esc(data.content)}</pre>`;
    }
    overlay.style.display = 'flex';
}

// ── Project Threads (Unified View) ───────────────────────────
async function loadThreads() {
    const list = document.getElementById('threads-list');
    try {
        const threads = await window.vault.getProjectThreads();
        if (!threads || threads.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">🧵</div><div class="empty-text">No project threads yet</div></div>';
            return;
        }

        const badgeColors = SOURCE_COLORS;
        const badgeLabels = { antigravity: 'AG', gemini: 'GEM', chatgpt: 'GPT' };

        list.innerHTML = threads.map(t => {
            const badges = (t.sources || []).map(s => {
                const color = badgeColors[s] || '#666';
                const label = badgeLabels[s] || s.toUpperCase().substring(0, 3);
                return `<span class="source-badge" style="background:${color}">${label}</span>`;
            }).join('');

            return `
            <div class="thread-card" data-action="expand-thread" data-topic="${esc(t.topic)}">
                <div class="thread-header">
                    <div class="thread-badges">${badges}</div>
                    <div class="thread-title">${esc(t.title)}</div>
                </div>
                <div class="thread-summary">${esc(stripMarkdown(t.summary)).substring(0, 200)}${t.summary.length > 200 ? '…' : ''}</div>
                <div class="thread-meta">
                    <span>${t.sessionCount} session${t.sessionCount !== 1 ? 's' : ''}</span>
                    <span>${t.artifactCount} artifact${t.artifactCount !== 1 ? 's' : ''}</span>
                    ${t.lastActivity ? `<span>Last: ${t.lastActivity}</span>` : ''}
                </div>
                <div class="thread-detail" id="thread-detail-${esc(t.topic)}" style="display:none"></div>
            </div>`;
        }).join('');
    } catch {
        list.innerHTML = '<div class="empty-state"><div class="empty-text">Error loading threads</div></div>';
    }
}


// ── Project Workspaces ──────────────────────────────────────────

async function loadProjects() {
    const list = document.getElementById('projects-list');
    const detailView = document.getElementById('project-detail-view');
    if (detailView) detailView.style.display = 'none';
    if (!list) return;
    
    try {
        const projects = await window.vault.getProjects();
        if (!projects || projects.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><div class="empty-text">Create a project to group sessions across models</div></div>';
            list.style.display = '';
            return;
        }

        const bc = SOURCE_COLORS;
        const bl = SOURCE_LABELS;

        list.innerHTML = projects.map(p => {
            const badges = (p.sources || []).map(s => '<span class="source-badge" style="background:' + (bc[s]||'#666') + '">' + (bl[s]||s.toUpperCase().substring(0,3)) + '</span>').join('');
            const lastAct = p.lastActivity ? new Date(p.lastActivity).toLocaleDateString() : 'No activity';
            return '<div class="project-card" data-action="open-project" data-project-id="' + p.id + '" style="border-left:3px solid ' + p.color + '">' +
                '<div class="project-card-header">' +
                    '<span class="project-icon">' + p.icon + '</span>' +
                    '<span class="project-name">' + esc(p.name) + '</span>' +
                    '<div class="project-badges">' + badges + '</div>' +
                '</div>' +
                '<div class="project-card-meta">' +
                    '<span>' + p.session_count + ' session' + (p.session_count !== 1 ? 's' : '') + '</span>' +
                    '<span>Last: ' + lastAct + '</span>' +
                '</div>' +
                (p.description ? '<div class="project-card-desc">' + esc(p.description).substring(0,120) + '</div>' : '') +
                '<button class="btn-delete-project" data-action="delete-project" data-project-id="' + p.id + '" title="Delete project">×</button>' +
            '</div>';
        }).join('');
        list.style.display = '';
    } catch (e) {
        console.error('[Projects] Load error:', e);
        list.innerHTML = '<div class="empty-state"><div class="empty-text">Error loading projects</div></div>';
    }
}

async function openProject(projectId) {
    const list = document.getElementById('projects-list');
    const detailView = document.getElementById('project-detail-view');
    if (!detailView) return;

    try {
        const detail = await window.vault.getProjectDetail(projectId);
        if (!detail) return;

        list.style.display = 'none';
        detailView.style.display = '';

        document.getElementById('project-detail-name').textContent = detail.icon + ' ' + detail.name;

        const bc = SOURCE_COLORS;
        const bl = SOURCE_LABELS;

        const timeline = document.getElementById('project-timeline');
        if (!detail.sessions || detail.sessions.length === 0) {
            timeline.innerHTML = '<div class="empty-state"><div class="empty-text">No sessions linked yet. Use the Journal to add sessions to this project.</div></div>';
            return;
        }

        timeline.innerHTML = detail.sessions.map(s => {
            const srcColor = bc[s.source] || '#666';
            const srcLabel = bl[s.source] || s.source;
            const lastAct = s.lastActivity ? new Date(s.lastActivity).toLocaleDateString() : '';
            const heading = s.artifacts.length > 0 ? (s.artifacts[0].heading || s.artifacts[0].file) : s.conversationId.substring(0, 8);
            const summary = s.artifacts.length > 0 ? (s.artifacts[0].summary || '').substring(0, 200) : '';

            return '<div class="project-session-card">' +
                '<div class="project-session-header">' +
                    '<span class="source-badge" style="background:' + srcColor + '">' + srcLabel + '</span>' +
                    '<span class="project-session-title">' + esc(heading) + '</span>' +
                    '<span class="project-session-date">' + lastAct + '</span>' +
                    '<button class="btn-unlink" data-action="unlink-session" data-project-id="' + detail.id + '" data-conv-id="' + s.conversationId + '" title="Remove from project">×</button>' +
                '</div>' +
                (summary ? '<div class="project-session-summary">' + esc(summary) + '</div>' : '') +
                '<div class="project-session-artifacts">' + s.artifacts.length + ' artifact' + (s.artifacts.length !== 1 ? 's' : '') + (s.autoLinked ? ' · auto-linked' : '') + '</div>' +
            '</div>';
        }).join('');
    } catch (e) {
        console.error('[Projects] Detail error:', e);
    }
}

async function expandThread(topic) {
    const detailEl = document.getElementById(`thread-detail-${topic}`);
    if (!detailEl) return;

    // Toggle off if already visible
    if (detailEl.style.display !== 'none') {
        detailEl.style.display = 'none';
        return;
    }

    detailEl.style.display = 'block';
    detailEl.innerHTML = '<div class="thread-loading">Loading…</div>';

    try {
        const detail = await window.vault.getThreadDetail(topic);
        if (!detail) { detailEl.innerHTML = '<div class="empty-text">Could not load thread detail</div>'; return; }

        const badgeColors = SOURCE_COLORS;
        const badgeLabels = { antigravity: 'AG', gemini: 'Gem', chatgpt: 'GPT' };

        // Full summary
        const summaryHtml = `
            <div class="thread-detail-section">
                <div class="thread-detail-label">Summary</div>
                <div class="thread-detail-text">${esc(detail.fullSummary)}</div>
            </div>
        `;

        // KI documentation artifacts
        let kiDocsHtml = '';
        if (detail.kiArtifacts && detail.kiArtifacts.length > 0) {
            kiDocsHtml = `
                <div class="thread-detail-section">
                    <div class="thread-detail-label">📚 Knowledge Docs (${detail.kiArtifacts.length})</div>
                    <div class="thread-detail-docs">
                        ${detail.kiArtifacts.map(a => `
                            <div class="thread-doc-item" data-action="open-ki-artifact" data-topic="${esc(topic)}" data-file="${esc(a.file)}">
                                <span class="thread-doc-icon">📄</span>
                                <span class="thread-doc-title">${esc(a.title)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Linked sessions
        let sessionsHtml = '';
        if (detail.sessions && detail.sessions.length > 0) {
            sessionsHtml = `
                <div class="thread-detail-section">
                    <div class="thread-detail-label">🔗 Sessions (${detail.sessions.length})</div>
                    <div class="thread-detail-sessions">
                        ${detail.sessions.map(s => {
                            const srcColor = badgeColors[s.source] || '#888';
                            const srcLabel = badgeLabels[s.source] || s.source?.substring(0, 3).toUpperCase() || 'AG';
                            const artifactLinks = s.artifacts.map(a => `
                                <span class="thread-artifact-link" data-action="open-artifact" data-conv-id="${esc(s.conversationId)}" data-file="${esc(a.file)}">
                                    ${esc(a.type)} ${a.heading ? '· ' + esc(a.heading).substring(0, 60) : ''}
                                </span>
                            `).join('');

                            const isUnlinked = topic.startsWith('unlinked:');
                            const suggestRow = isUnlinked ? `<div class="suggest-row" id="suggest-${esc(s.conversationId)}"></div>` : '';
                            const actionBtns = isUnlinked ? `
                                <div class="session-actions">
                                    <button class="btn-xs btn-ghost" data-action="open-ki-picker" data-capture-id="${esc(s.conversationId)}">Link to…</button>
                                </div>
                            ` : '';

                            return `
                                <div class="thread-session-item" id="tsession-${esc(s.conversationId)}">
                                    <div class="thread-session-header" data-action="toggle-thread-session" data-conv-id="${esc(s.conversationId)}">
                                        <span class="source-badge source-badge-sm" style="background:${srcColor}">${srcLabel}</span>
                                        <span class="thread-session-title">${esc(s.title)}</span>
                                        <span class="thread-session-date">${s.date}</span>
                                        <span class="thread-session-chevron">▶</span>
                                    </div>
                                    ${s.snapshotCount > 1 ? `<div class="thread-session-snapshots">📸 ${s.snapshotCount} snapshots${s.firstSeen && s.lastSeen ? ` · ${s.firstSeen} → ${s.lastSeen}` : ''}</div>` : ''}
                                    ${s.summary ? `<div class="thread-session-summary">${esc(s.summary).substring(0, 200)}${s.summary.length > 200 ? '…' : ''}</div>` : ''}
                                    ${s.debrief ? `<div class="thread-session-debrief">${esc(s.debrief)}</div>` : ''}
                                    <div class="thread-session-detail" id="tdetail-${esc(s.conversationId)}"></div>
                                    ${artifactLinks ? `<div class="thread-session-artifacts">${artifactLinks}</div>` : ''}
                                    ${suggestRow}
                                    ${actionBtns}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;

            // Add Create KI button for unlinked threads
            if (topic.startsWith('unlinked:')) {
                sessionsHtml += `
                    <div class="thread-detail-section">
                        <button class="btn btn-gold btn-sm" data-action="create-ki-from-thread" data-topic="${esc(topic)}">+ Create KI from these captures</button>
                    </div>
                `;
            }
        }

        detailEl.innerHTML = summaryHtml + kiDocsHtml + sessionsHtml;

        // Auto-suggest for unlinked sessions
        if (topic.startsWith('unlinked:')) {
            for (const s of detail.sessions) {
                loadSuggestionsForSession(s.conversationId);
            }
        }
    } catch (err) {
        detailEl.innerHTML = `<div class="empty-text">Error: ${esc(err.message)}</div>`;
    }
}

// ── Auto-Suggest Chips ───────────────────────────────────────
async function loadSuggestionsForSession(captureId) {
    const container = document.getElementById(`suggest-${captureId}`);
    if (!container) return;

    container.innerHTML = '<span class="suggest-loading">analyzing…</span>';

    try {
        const suggestions = await window.vault.suggestKIForCapture(captureId);
        if (!suggestions || suggestions.length === 0) {
            container.innerHTML = '<span class="suggest-none">No matches found</span>';
            return;
        }

        container.innerHTML = suggestions.map(s => {
            const confColor = s.confidence >= 80 ? '#4CAF50' : s.confidence >= 50 ? '#FFA726' : '#999';
            return `<span class="suggest-chip" data-action="quick-link-ki" data-capture-id="${esc(captureId)}" data-ki-topic="${esc(s.topic || s.ki_topic)}" style="border-color:${confColor}">
                ${esc(s.title || s.ki_topic)} <em>${s.confidence}%</em>
            </span>`;
        }).join('');
    } catch {
        container.innerHTML = '<span class="suggest-none">Error loading suggestions</span>';
    }
}

// ── KI Management State ──────────────────────────────────────
let _pendingKICaptureIds = [];
let _pendingLinkCaptureId = null;

function openCreateKIModal(captureIds) {
    _pendingKICaptureIds = captureIds;
    const modal = document.getElementById('create-ki-modal');
    const input = document.getElementById('create-ki-title');
    const capturesEl = document.getElementById('create-ki-captures');
    input.value = '';
    capturesEl.textContent = `${captureIds.length} capture${captureIds.length !== 1 ? 's' : ''} will be linked`;
    modal.style.display = 'flex';
    input.focus();
}

async function openKIPicker(captureId) {
    _pendingLinkCaptureId = captureId;
    const modal = document.getElementById('ki-picker-modal');
    const list = document.getElementById('ki-picker-list');
    list.innerHTML = '<div class="thread-loading">Loading KIs…</div>';
    modal.style.display = 'flex';

    try {
        const kis = await window.vault.getKIList();
        list.innerHTML = kis.map(ki => `
            <div class="ki-picker-item" data-action="select-ki" data-ki-topic="${esc(ki.topic)}">
                <div class="ki-picker-title">${esc(ki.title)}</div>
                <div class="ki-picker-meta">${ki.refCount} references</div>
            </div>
        `).join('');
    } catch {
        list.innerHTML = '<div class="empty-text">Error loading KIs</div>';
    }
}

// ── Intelligence Dashboard ───────────────────────────────────
async function loadIntelligence() {
    const dashboard = document.getElementById('intel-dashboard');
    const statusBadge = document.getElementById('ai-status-badge');

    dashboard.innerHTML = '<div class="empty-state"><div class="empty-icon">🧠</div><div class="empty-text">Loading intelligence…</div></div>';

    try {
        const data = await window.vault.getIntelligenceDashboard();

        // Update AI status
        if (data.aiAvailable) {
            statusBadge.className = 'ai-status-badge online';
            statusBadge.textContent = '● AI Ready (7B)';
        } else {
            statusBadge.className = 'ai-status-badge offline';
            statusBadge.textContent = '● Offline';
        }

        let html = '';

        // Overview stats
        html += `
            <div class="intel-section">
                <div class="intel-section-label">📊 Overview</div>
                <div class="intel-stat-grid">
                    <div class="intel-stat-block">
                        <span class="intel-stat-value">${data.kiCount || 0}</span>
                        <span class="intel-stat-label">knowledge items</span>
                    </div>
                    <div class="intel-stat-block">
                        <span class="intel-stat-value">${data.captureCount || 0}</span>
                        <span class="intel-stat-label">captures</span>
                    </div>
                    ${data.trends ? `
                        <div class="intel-stat-block">
                            <span class="intel-stat-value">${data.trends.totalSessions}</span>
                            <span class="intel-stat-label">${data.trends.days}d sessions</span>
                        </div>
                    ` : ''}
                </div>
                ${data.trends ? `<div class="intel-chips">${data.trends.sourceBreakdown.map(s => `<span class="intel-chip">${esc(s.source)} ${s.pct}%</span>`).join('')}</div>` : ''}
            </div>
        `;

        // Weekly report + Enrich all
        html += `
            <div class="intel-section">
                <div class="intel-section-label">📝 Actions</div>
                <div class="intel-actions-grid">
                    <button class="btn btn-sm btn-gold" data-action="generate-weekly-report">📊 Weekly Report</button>
                    <button class="btn btn-sm btn-ghost" data-action="run-clusters">🧩 Cluster Sessions</button>
                    <button class="btn btn-sm btn-ghost" data-action="run-priorities">📋 Rank Priorities</button>
                </div>
                <div id="intel-report-output" class="intel-report-output" style="display:none"></div>
            </div>
        `;

        // Learning stats
        if (data.learningStats && data.learningStats.totalFeedback > 0) {
            html += `
                <div class="intel-section">
                    <div class="intel-section-label">🎯 Learning</div>
                    <div class="intel-stat-row">
                        <span class="intel-stat-value">${data.learningStats.totalFeedback}</span>
                        <span class="intel-stat-label">feedback signals</span>
                    </div>
                    <div class="intel-stat-row">
                        <span class="intel-stat-value">${data.learningStats.acceptRate}%</span>
                        <span class="intel-stat-label">accept rate</span>
                    </div>
                </div>
            `;
        }

        // Dependencies
        if (data.dependencies && data.dependencies.length > 0) {
            html += `
                <div class="intel-section">
                    <div class="intel-section-label">🔗 Knowledge Dependencies</div>
                    ${data.dependencies.map(d => `
                        <div class="intel-item intel-dep">
                            <strong>${esc(d.from.title)}</strong> → <strong>${esc(d.to.title)}</strong>
                            <div class="intel-reason">${esc(d.relationship)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Merge suggestions
        if (data.mergeablePairs && data.mergeablePairs.length > 0) {
            html += `
                <div class="intel-section">
                    <div class="intel-section-label">🔀 Merge Suggestions</div>
                    ${data.mergeablePairs.map(p => `
                        <div class="intel-item intel-merge">
                            <strong>${esc(p.kiA.title)}</strong> ↔ <strong>${esc(p.kiB.title)}</strong>
                            <div class="intel-reason">${esc(p.reason)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Knowledge gaps
        if (data.knowledgeGaps && data.knowledgeGaps.length > 0) {
            html += `
                <div class="intel-section">
                    <div class="intel-section-label">🕳️ Knowledge Gaps</div>
                    ${data.knowledgeGaps.map(g => `
                        <div class="intel-item intel-gap">
                            <strong>${esc(g.suggestedTitle)}</strong>
                            <div class="intel-reason">${esc(g.reason)}${g.sessionCount ? ` (${g.sessionCount} sessions)` : ''}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Stale KI alerts (with enrich button)
        if (data.staleKIs && data.staleKIs.length > 0) {
            html += `
                <div class="intel-section">
                    <div class="intel-section-label">⏰ Stale Knowledge Items</div>
                    ${data.staleKIs.map(s => `
                        <div class="intel-item intel-stale">
                            <div style="display:flex;justify-content:space-between;align-items:center">
                                <strong>${esc(s.title)}</strong>
                                <button class="btn-xs btn-gold" data-action="enrich-ki" data-ki-topic="${esc(s.topic)}">Enrich</button>
                            </div>
                            <div class="intel-reason">${esc(s.message)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Cross-references
        if (data.crossReferences && data.crossReferences.length > 0) {
            html += `
                <div class="intel-section">
                    <div class="intel-section-label">🔗 Cross-References</div>
                    ${data.crossReferences.map(c => `
                        <div class="intel-item intel-xref">
                            <strong>${esc(c.kiA)}</strong> ↔ <strong>${esc(c.kiB)}</strong>
                            <div class="intel-reason">${esc(c.connection)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        if (!html) {
            html = '<div class="empty-state"><div class="empty-icon">✨</div><div class="empty-text">All knowledge is organized. No actions needed.</div></div>';
        }

        dashboard.innerHTML = html;
    } catch (err) {
        dashboard.innerHTML = `<div class="empty-text">Error: ${esc(err.message)}</div>`;
    }
}

// ── Open Tasks ───────────────────────────────────────────────
let taskFilter = 'active'; // 'all' | 'active' | 'completed'

async function loadTasks() {
    const list = document.getElementById('tasks-list');
    try {
        const tasks = await window.vault.getOpenTasks();
        if (!tasks || tasks.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">All caught up!</div></div>';
            return;
        }

        // Filter controls
        const allCount = tasks.length;
        const activeCount = tasks.filter(t => t.inProgress.length > 0 || t.open.length > 0).length;
        const completedOnlyCount = tasks.filter(t => t.inProgress.length === 0 && t.open.length === 0).length;

        const filterHtml = `
            <div class="task-filters">
                <button class="task-filter-btn ${taskFilter === 'active' ? 'active' : ''}" data-action="set-task-filter" data-filter="active">Active <span class="filter-count">${activeCount}</span></button>
                <button class="task-filter-btn ${taskFilter === 'all' ? 'active' : ''}" data-action="set-task-filter" data-filter="all">All <span class="filter-count">${allCount}</span></button>
                <button class="task-filter-btn ${taskFilter === 'completed' ? 'active' : ''}" data-action="set-task-filter" data-filter="completed">Completed <span class="filter-count">${completedOnlyCount}</span></button>
            </div>
        `;

        // Apply filter
        let filteredTasks = tasks;
        if (taskFilter === 'active') {
            filteredTasks = tasks.filter(t => t.inProgress.length > 0 || t.open.length > 0);
        } else if (taskFilter === 'completed') {
            filteredTasks = tasks.filter(t => t.inProgress.length === 0 && t.open.length === 0);
        }

        const tasksHtml = filteredTasks.map(t => {
            const total = t.open.length + t.inProgress.length + t.completed.length;
            const doneCount = t.completed.length;
            const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
            const hasOpen = t.open.length > 0 || t.inProgress.length > 0;

            return `
            <div class="task-group" data-conv-id="${t.conversationId}">
                <div class="task-group-header">
                    <div class="task-group-title">${esc(t.heading)}</div>
                    <div class="task-group-actions">
                        ${hasOpen ? `<button class="btn-ghost btn-xs" data-action="finalize-task" data-conv-id="${t.conversationId}" title="Mark all complete">✓ Finalize</button>` : ''}
                        <button class="btn-ghost btn-xs" data-action="archive-task" data-conv-id="${t.conversationId}" title="Archive (hide from view)">📦 Archive</button>
                    </div>
                </div>
                <div class="task-progress-bar">
                    <div class="task-progress-fill" style="width:${pct}%"></div>
                    <span class="task-progress-label">${doneCount}/${total} (${pct}%)</span>
                </div>
                ${t.inProgress.map(item => `
                    <div class="task-item">
                        <span class="task-check in-progress">◐</span>
                        <span class="task-text in-progress">${esc(item)}</span>
                    </div>
                `).join('')}
                ${t.open.map(item => `
                    <div class="task-item">
                        <span class="task-check open">○</span>
                        <span class="task-text">${esc(item)}</span>
                    </div>
                `).join('')}
                ${taskFilter !== 'active' ? t.completed.map(item => `
                    <div class="task-item">
                        <span class="task-check done">✓</span>
                        <span class="task-text" style="text-decoration:line-through;opacity:0.5">${esc(item)}</span>
                    </div>
                `).join('') : ''}
            </div>`;
        }).join('');

        list.innerHTML = filterHtml + (filteredTasks.length === 0
            ? '<div class="empty-state"><div class="empty-text">No tasks match this filter</div></div>'
            : tasksHtml);
    } catch {
        list.innerHTML = '<div class="empty-state"><div class="empty-text">Error loading tasks</div></div>';
    }
}

// ── Settings ─────────────────────────────────────────────────
async function setupSettings() {
    document.getElementById('set-platform').textContent = window.vault.platform;
    document.getElementById('set-version').textContent = window.vault.version;

    // Wire clipboard toggle
    const clipToggle = document.getElementById('set-clipboard');
    if (clipToggle) {
        clipToggle.addEventListener('change', () => {
            window.vault.toggleClipboard(clipToggle.checked);
        });
    }

    // Wire display name input
    const nameInput = document.getElementById('set-display-name');
    if (nameInput) {
        nameInput.addEventListener('change', () => {
            const name = nameInput.value.trim();
            if (name) {
                _userDisplayName = name;
                window.vault.setSettings({ displayName: name });
            }
        });
    }

    try {
        const settings = await window.vault.getSettings();
        if (settings) {
            if (clipToggle) clipToggle.checked = settings.clipboardEnabled !== false;
            if (settings.displayName) {
                _userDisplayName = settings.displayName;
                if (nameInput) nameInput.value = settings.displayName;
            }
        }
    } catch (e) { console.warn('[Vault] Settings load:', e.message); }
}

// ── Keyboard ─────────────────────────────────────────────────
function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Escape — close modals/overlays in priority order
        if (e.key === 'Escape') {
            const createKI = document.getElementById('create-ki-modal');
            const kiPicker = document.getElementById('ki-picker-modal');
            const noteModal = document.getElementById('note-modal');
            const artOverlay = document.getElementById('artifact-overlay');
            const followPanel = document.getElementById('followup-panel');

            if (createKI && createKI.style.display !== 'none') { createKI.style.display = 'none'; }
            else if (kiPicker && kiPicker.style.display !== 'none') { kiPicker.style.display = 'none'; }
            else if (noteModal && noteModal.style.display !== 'none') closeNoteModal();
            else if (artOverlay && artOverlay.style.display !== 'none') closeArtifact();
            else if (followPanel && followPanel.style.display !== 'none') { followPanel.style.display = 'none'; }
            else {
                const expanded = document.querySelector('.session-card.expanded');
                if (expanded) expanded.classList.remove('expanded');
                const kbFocused = document.querySelector('.session-card.kb-focused');
                if (kbFocused) kbFocused.classList.remove('kb-focused');
            }
        }
        // Ctrl+K → focus search
        if (e.ctrlKey && !e.shiftKey && e.key === 'k') {
            e.preventDefault();
            switchPanel('search');
            document.getElementById('search-input')?.focus();
        }
        // Ctrl+J → journal
        if (e.ctrlKey && e.key === 'j') {
            e.preventDefault();
            switchPanel('journal');
        }
        // Ctrl+T → threads
        if (e.ctrlKey && e.key === 't') {
            e.preventDefault();
            switchPanel('threads');
        }
        // Ctrl+Shift+K → chat
        if (e.ctrlKey && e.shiftKey && e.key === 'K') {
            e.preventDefault();
            switchPanel('ask');
            setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
        }
        // Ctrl+U → toggle follow-ups
        if (e.ctrlKey && e.key === 'u') {
            e.preventDefault();
            toggleFollowUpPanel();
        }
        // Ctrl+E → export today
        if (e.ctrlKey && e.key === 'e') {
            e.preventDefault();
            const todayStr = new Date().toISOString().split('T')[0];
            if (typeof exportDailyToClipboard === 'function') exportDailyToClipboard(todayStr);
        }
        // Arrow navigation for sessions
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.target.matches('input, textarea')) {
            e.preventDefault();
            const cards = [...document.querySelectorAll('.session-card:not([style*="display:none"])')];
            if (cards.length === 0) return;
            const focused = document.querySelector('.session-card.kb-focused');
            let idx = focused ? cards.indexOf(focused) : -1;
            if (focused) focused.classList.remove('kb-focused');
            if (e.key === 'ArrowDown') idx = Math.min(idx + 1, cards.length - 1);
            else idx = Math.max(idx - 1, 0);
            cards[idx].classList.add('kb-focused');
            cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        // Enter — expand focused session
        if (e.key === 'Enter' && !e.target.matches('input, textarea, button')) {
            const focused = document.querySelector('.session-card.kb-focused');
            if (focused) {
                const convId = focused.id.replace('session-', '');
                toggleSession(convId);
            }
        }
    });

    // Click outside overlays to close
    document.getElementById('artifact-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'artifact-overlay') closeArtifact();
    });
    document.getElementById('note-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'note-modal') closeNoteModal();
    });
}

// ── Status ───────────────────────────────────────────────────
function setStatus(text, active = false) {
    const el = document.getElementById('status-text');
    const pill = document.getElementById('status-pill');
    if (el) el.textContent = text;
    if (pill) pill.className = `status-pill${active ? ' status-active' : ''}`;
}

function addCaptureToast(data) {
    // Show real toast + status pill update
    setStatus(`Captured: ${data.path || 'file'}`, true);
    showToast(`📥 Captured: ${data.path || 'new file'}`, 'success', 3000);
    setTimeout(() => setStatus('Capturing', true), 3000);
}

// ── Utilities ────────────────────────────────────────────────
function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function stripMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/^#{1,6}\s+/gm, '')             // strip heading markers
        .replace(/\*\*(.+?)\*\*/g, '$1')          // bold → plain
        .replace(/\*(.+?)\*/g, '$1')              // italic → plain
        .replace(/`([^`]+)`/g, '$1')              // inline code → plain
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // links → text
        .replace(/^\s*[-*]\s+/gm, '')             // list bullets
        .replace(/\n{2,}/g, ' ')                  // collapse newlines
        .trim();
}

function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function formatDateLong(d) {
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function getRelativeDay(d) {
    // Normalize both to local midnight
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    // Parse d as local date (YYYY-MM-DD strings get parsed as UTC, so split manually)
    const parts = String(d).split('-');
    const targetMidnight = parts.length === 3
        ? new Date(+parts[0], +parts[1] - 1, +parts[2]).getTime()
        : new Date(new Date(d).getFullYear(), new Date(d).getMonth(), new Date(d).getDate()).getTime();
    const diff = Math.round((todayMidnight - targetMidnight) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff} days ago`;
    return null;
}

function relativeTime(epochMs) {
    const diff = Date.now() - epochMs;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(epochMs).toLocaleDateString();
}

// ── Event Delegation ─────────────────────────────────────────
// Centralized click handler — eliminates all inline onclick attributes
// ── Dashboard Navigation Helpers ─────────────────────────────
// Navigate to a panel, scroll to a target element, and highlight it
function navigateWithHighlight(panelName, selector, fallbackPanel, fallbackId) {
    switchPanel(panelName);
    showBreadcrumb(panelName);

    // Wait for panel to render, then find & highlight target
    setTimeout(() => {
        const target = document.querySelector(selector);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('target-highlight');
            setTimeout(() => target.classList.remove('target-highlight'), 2000);
        } else if (fallbackPanel && fallbackId) {
            // No matching task group — try falling back to threads
            navigateToThread(fallbackId);
        }
    }, 300);
}

// Navigate to the threads panel and expand a thread matching the project name
function navigateToThread(projectName) {
    switchPanel('threads');
    showBreadcrumb('threads');

    // Wait for threads to render, then find & expand matching thread
    setTimeout(() => {
        const threadCards = document.querySelectorAll('.thread-card[data-topic]');
        let bestMatch = null;
        const searchLower = projectName.toLowerCase().replace(/[_-]/g, ' ');

        for (const card of threadCards) {
            const titleEl = card.querySelector('.thread-title');
            const title = (titleEl?.textContent || '').toLowerCase();
            const topic = (card.dataset.topic || '').toLowerCase().replace(/[_-]/g, ' ');
            if (title === searchLower || topic === searchLower) {
                bestMatch = card;
                break;
            }
            if (title.includes(searchLower) || searchLower.includes(title.split(' ').slice(0, 3).join(' '))) {
                bestMatch = card;
            }
        }

        if (bestMatch) {
            bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
            bestMatch.classList.add('target-highlight');
            setTimeout(() => bestMatch.classList.remove('target-highlight'), 2000);
            const topic = bestMatch.dataset.topic;
            if (topic) {
                const detail = document.getElementById(`thread-detail-${topic}`);
                if (detail && detail.style.display === 'none') {
                    expandThread(topic);
                }
            }
        }
    }, 400);
}

// Show a breadcrumb pill to return to the dashboard
function showBreadcrumb(panelName) {
    const existing = document.querySelector('.breadcrumb-back');
    if (existing) existing.remove();

    const panel = document.getElementById(`panel-${panelName}`);
    if (!panel) return;

    const inner = panel.querySelector('.panel-inner') || panel;
    const bc = document.createElement('div');
    bc.className = 'breadcrumb-back';
    bc.setAttribute('data-action', 'dismiss-breadcrumb');
    bc.innerHTML = '\u2190 Back to Dashboard';
    bc.addEventListener('click', () => {
        bc.style.animation = 'breadcrumb-out 0.2s ease forwards';
        setTimeout(() => {
            bc.remove();
            switchPanel('journal');
        }, 200);
    });
    inner.insertBefore(bc, inner.firstChild);

    // Auto-hide after 8 seconds
    setTimeout(() => {
        if (bc.parentNode) {
            bc.style.animation = 'breadcrumb-out 0.2s ease forwards';
            setTimeout(() => bc.remove(), 200);
        }
    }, 8000);
}

function setupEventDelegation() {
    document.addEventListener('click', (e) => {
        // Walk up from target to find nearest data-action element
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        const action = actionEl.dataset.action;
        const convId = actionEl.dataset.convId;
        const file = actionEl.dataset.file;
        const date = actionEl.dataset.date;
        const relPath = actionEl.dataset.relPath;

        switch (action) {
            case 'toggle-session':
                toggleSession(convId);
                break;
            case 'toggle-thread-session':
                toggleThreadSession(convId);
                break;
            case 'complete-action': {
                e.stopPropagation();
                const actionId = actionEl.dataset.actionId;
                if (actionId) {
                    window.vault.completeActionItem(parseInt(actionId)).then(() => {
                        return window.vault.getActionItems('open');
                    }).then(freshItems => {
                        const panel = document.querySelector('.action-items-panel');
                        if (panel) {
                            const newHtml = renderActionItems(freshItems);
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = newHtml;
                            panel.innerHTML = tempDiv.querySelector('.action-items-panel').innerHTML;
                        }
                    }).catch(err => {
                        console.error('[Vault] complete-action failed:', err);
                        alert('Could not complete action: ' + (err.message || String(err)));
                    });
                }
                break;
            }
            case 'navigate-action-item': {
                // Skip if the click was on the ✓ button (handled by complete-action)
                if (e.target.closest('.action-done-btn')) break;
                const sourceId = actionEl.dataset.sourceId;
                if (sourceId) {
                    navigateWithHighlight('tasks', `.task-group[data-conv-id="${sourceId}"]`, 'threads', sourceId);
                } else {
                    switchPanel('tasks');
                    showBreadcrumb('tasks');
                }
                break;
            }
            case 'navigate-weekly-project': {
                const projectName = actionEl.dataset.projectName;
                if (projectName) {
                    navigateToThread(projectName);
                }
                break;
            }
            case 'navigate-resume-session': {
                const resumeConvId = actionEl.dataset.convId;
                if (resumeConvId) {
                    switchPanel('journal');
                    const card = document.getElementById(`session-${resumeConvId}`);
                    if (card) {
                        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        if (!card.classList.contains('expanded')) toggleSession(resumeConvId);
                        card.classList.add('target-highlight');
                        setTimeout(() => card.classList.remove('target-highlight'), 2000);
                    }
                }
                break;
            }
            case 'navigate-to-tasks': {
                switchPanel('tasks');
                showBreadcrumb('tasks');
                break;
            }
            case 'dismiss-breadcrumb': {
                const bc = actionEl.closest('.breadcrumb-back');
                if (bc) {
                    bc.style.animation = 'breadcrumb-out 0.2s ease forwards';
                    setTimeout(() => bc.remove(), 200);
                }
                break;
            }
            case 'toggle-pin':
                e.stopPropagation();
                togglePin(convId);
                break;
            case 'expand-pinned':
                expandPinnedSession(convId);
                break;
            case 'export-ki': {
                e.stopPropagation();
                const kiTopic = actionEl.dataset.kiTopic;
                if (kiTopic) exportKIToClipboard(kiTopic);
                break;
            }
            case 'export-daily': {
                e.stopPropagation();
                const dateStr = actionEl.dataset.date;
                if (dateStr) exportDailyToClipboard(dateStr);
                break;
            }
            case 'view-thread': {
                e.stopPropagation();
                const topic = actionEl.dataset.topic;
                if (topic) {
                    switchPanel('threads');
                    setTimeout(() => {
                        const threadEl = document.querySelector('[data-topic="' + topic + '"]');
                        if (threadEl) threadEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 200);
                }
                break;
            }
            case 'open-note':
                openNoteModal(date);
                break;
            case 'open-artifact':
                e.stopPropagation();
                openArtifact(convId, file);
                break;
            case 'open-search-result':
                openFileFromSearch(relPath);
                break;
            case 'close-artifact':
                closeArtifact();
                break;
            case 'close-note':
                closeNoteModal();
                break;
            case 'submit-note':
                submitQuickNote();
                break;
            case 'load-more':
                loadMoreDays();
                break;
            case 'window-minimize':
                window.vault.minimize();
                break;
            case 'window-maximize':
                window.vault.maximize();
                break;
            case 'window-close':
                window.vault.close();
                break;
            case 'toggle-source-group': {
                const groupId = actionEl.dataset.groupId;
                const body = document.getElementById(groupId);
                const chevron = actionEl.querySelector('.source-group-chevron');
                if (body) {
                    const isHidden = body.style.display === 'none';
                    body.style.display = isHidden ? 'block' : 'none';
                    if (chevron) chevron.textContent = isHidden ? '▼' : '▶';
                }
                break;
            }
            case 'delete-note': {
                const noteId = actionEl.dataset.noteId;
                const noteDate = actionEl.dataset.date;
                if (noteId) {
                    window.vault.deleteQuickNote(parseInt(noteId)).then(() => {
                        // Remove the note item from DOM
                        const noteItem = actionEl.closest('.note-item');
                        if (noteItem) noteItem.remove();
                    });
                }
                break;
            }
            case 'set-task-filter': {
                taskFilter = actionEl.dataset.filter || 'active';
                loadTasks();
                break;
            }
            case 'finalize-task': {
                window.vault.finalizeTask(convId).then(() => loadTasks());
                break;
            }
            case 'archive-task': {
                window.vault.archiveTask(convId).then(() => loadTasks());
                break;
            }
            case 'expand-thread': {
                const topic = actionEl.dataset.topic;
                if (topic) expandThread(topic);
                break;
            }
            case 'open-ki-artifact': {
                e.stopPropagation(); // Don't trigger expand-thread on parent
                const topic = actionEl.dataset.topic;
                const kiFile = actionEl.dataset.file;
                if (topic && kiFile) {
                    window.vault.readKnowledgeArtifact(topic, kiFile).then(data => {
                        if (!data) return;
                        const overlay = document.getElementById('artifact-overlay');
                        const titleEl = document.getElementById('artifact-title');
                        const body = document.getElementById('artifact-body');
                        titleEl.textContent = data.file.replace('.md', '').replace(/_/g, ' ');
                        body.innerHTML = typeof marked !== 'undefined' ? marked.parse(data.content) : `<pre>${esc(data.content)}</pre>`;
                        overlay.style.display = 'flex';
                        const closeBtn = overlay.querySelector('[data-action="close-artifact"]');
                        if (closeBtn) closeBtn.focus();
                    });
                }
                break;
            }
            case 'quick-link-ki': {
                e.stopPropagation();
                const captureId = actionEl.dataset.captureId;
                const kiTopic = actionEl.dataset.kiTopic;
                if (captureId && kiTopic) {
                    window.vault.linkCaptureToKI(captureId, kiTopic).then(() => {
                        window.vault.recordAIFeedback(captureId, kiTopic, 'accepted');
                        actionEl.closest('.thread-session-item')?.remove();
                    });
                }
                break;
            }
            case 'open-ki-picker': {
                e.stopPropagation();
                const captureId = actionEl.dataset.captureId;
                if (captureId) openKIPicker(captureId);
                break;
            }
            case 'select-ki': {
                const kiTopic = actionEl.dataset.kiTopic;
                if (_pendingLinkCaptureId && kiTopic) {
                    window.vault.linkCaptureToKI(_pendingLinkCaptureId, kiTopic).then(() => {
                        document.getElementById('ki-picker-modal').style.display = 'none';
                        loadThreads();
                    });
                }
                break;
            }
            case 'create-ki-from-thread': {
                e.stopPropagation();
                const threadTopic = actionEl.dataset.topic;
                if (threadTopic) {
                    window.vault.getThreadDetail(threadTopic).then(detail => {
                        if (detail) {
                            const ids = detail.sessions.map(s => s.conversationId);
                            openCreateKIModal(ids);
                        }
                    });
                }
                break;
            }
            case 'confirm-create-ki': {
                const title = document.getElementById('create-ki-title').value.trim();
                if (title && _pendingKICaptureIds.length > 0) {
                    window.vault.createKIFromCaptures(title, _pendingKICaptureIds).then(result => {
                        document.getElementById('create-ki-modal').style.display = 'none';
                        if (result.success) loadThreads();
                    });
                }
                break;
            }
            case 'close-create-ki': {
                document.getElementById('create-ki-modal').style.display = 'none';
                break;
            }
            case 'close-ki-picker': {
                document.getElementById('ki-picker-modal').style.display = 'none';
                break;
            }
            case 'auto-organize': {
                actionEl.textContent = '⚡ Organizing…';
                actionEl.disabled = true;
                window.vault.autoOrganize().then(result => {
                    actionEl.textContent = `⚡ Done: ${result.linked} linked, ${result.reviewed} need review`;
                    actionEl.disabled = false;
                    setTimeout(() => { actionEl.textContent = '⚡ Auto-Organize Captures'; }, 3000);
                    loadIntelligence();
                }).catch(() => {
                    actionEl.textContent = '⚡ Auto-Organize Captures';
                    actionEl.disabled = false;
                });
                break;
            }
            case 'enrich-ki': {
                e.stopPropagation();
                const kiTopic = actionEl.dataset.kiTopic;
                if (kiTopic) {
                    actionEl.textContent = 'Enriching…';
                    actionEl.disabled = true;
                    window.vault.enrichKI(kiTopic).then(result => {
                        actionEl.textContent = result.success ? '✓ Enriched' : '✗ Failed';
                        setTimeout(() => { actionEl.textContent = 'Enrich'; actionEl.disabled = false; }, 3000);
                    });
                }
                break;
            }
            case 'generate-weekly-report': {
                actionEl.textContent = '📊 Generating…';
                actionEl.disabled = true;
                window.vault.getWeeklyReport().then(report => {
                    const output = document.getElementById('intel-report-output');
                    if (output) {
                        output.style.display = 'block';
                        output.innerHTML = `<div class="intel-report">${esc(report).replace(/\n/g, '<br>')}</div>`;
                    }
                    actionEl.textContent = '📊 Weekly Report';
                    actionEl.disabled = false;
                });
                break;
            }
            case 'run-clusters': {
                actionEl.textContent = '🧩 Clustering…';
                actionEl.disabled = true;
                window.vault.getSessionClusters().then(clusters => {
                    const output = document.getElementById('intel-report-output');
                    if (output) {
                        output.style.display = 'block';
                        output.innerHTML = clusters.map(c => `
                            <div class="intel-item intel-cluster">
                                <strong>${esc(c.label)}</strong>
                                <div class="intel-reason">${c.sessionIds.length} sessions</div>
                            </div>
                        `).join('');
                    }
                    actionEl.textContent = '🧩 Cluster Sessions';
                    actionEl.disabled = false;
                });
                break;
            }
            case 'run-priorities': {
                actionEl.textContent = '📋 Ranking…';
                actionEl.disabled = true;
                window.vault.getCapturePriorities().then(priorities => {
                    const output = document.getElementById('intel-report-output');
                    if (output) {
                        output.style.display = 'block';
                        output.innerHTML = priorities.map((p, i) => `
                            <div class="intel-item intel-priority">
                                <div style="display:flex;justify-content:space-between">
                                    <strong>#${i + 1}</strong>
                                    <span class="priority-score">${p.priority}/10</span>
                                </div>
                                <div class="intel-reason">${esc(p.reason)}</div>
                            </div>
                        `).join('');
                    }
                    actionEl.textContent = '📋 Rank Priorities';
                    actionEl.disabled = false;
                });
                break;
            }
            // ── Chat Actions ─────────────────────────────────
            case 'send-chat': {
                sendChatMessage();
                break;
            }
            case 'chat-suggest': {
                const query = actionEl.dataset.query;
                if (query) {
                    document.getElementById('chat-input').value = query;
                    sendChatMessage();
                }
                break;
            }
            case 'clear-chat': {
                window.vault.clearChatHistory().then(() => {
                    const msgEl = document.getElementById('chat-messages');
                    msgEl.innerHTML = `
                        <div class="chat-welcome">
                            <div class="chat-welcome-icon">🏛</div>
                            <div class="chat-welcome-title">What do you want to know?</div>
                            <div class="chat-welcome-sub">Ask anything about your captured sessions, audits, projects, and knowledge items.</div>
                            <div class="chat-suggestions">
                                <button class="chat-suggestion" data-action="chat-suggest" data-query="What vulnerabilities have I found recently?">🔍 Recent vulnerabilities</button>
                                <button class="chat-suggestion" data-action="chat-suggest" data-query="Summarize my OmegaWallet work">💼 OmegaWallet summary</button>
                                <button class="chat-suggestion" data-action="chat-suggest" data-query="What attack patterns have I documented?">⚔️ Attack patterns</button>
                                <button class="chat-suggestion" data-action="chat-suggest" data-query="What tasks are still open?">📋 Open tasks</button>
                            </div>
                        </div>
                    `;
                });
                break;
            }
            case 'rebuild-rag': {
                actionEl.textContent = 'Rebuilding…';
                actionEl.disabled = true;
                window.vault.rebuildRAGIndex().then(result => {
                    actionEl.textContent = `Done (${result.chunks || 0} chunks)`;
                    actionEl.disabled = false;
                    setTimeout(() => { actionEl.textContent = 'Rebuild Index'; }, 3000);
                }).catch(() => {
                    actionEl.textContent = 'Rebuild Index';
                    actionEl.disabled = false;
                });
                break;
            }
            // ── Follow-Up Actions ────────────────────────────
            case 'toggle-followups': {
                toggleFollowUpPanel();
                break;
            }
            case 'close-followups': {
                document.getElementById('followup-panel').style.display = 'none';
                break;
            }
            case 'dismiss-followup': {
                const fId = actionEl.dataset.followupId;
                if (fId) {
                    window.vault.dismissFollowUp(fId).then(() => {
                        actionEl.closest('.followup-card')?.remove();
                        updateFollowUpBadge();
                    });
                }
                break;
            }
            case 'followup-action': {
                const fAction = actionEl.dataset.followupAction;
                if (fAction === 'auto-organize') {
                    window.vault.autoOrganize();
                } else if (fAction === 'enrich-ki') {
                    window.vault.enrichKI(actionEl.dataset.kiTopic);
                } else if (fAction === 'navigate') {
                    const targetPanel = actionEl.dataset.panel;
                    const targetConvId = actionEl.dataset.convId;
                    if (targetPanel) {
                        switchPanel(targetPanel);
                    }
                    if (targetConvId) {
                        // Navigate to journal and expand the session
                        switchPanel('journal');
                        setTimeout(() => toggleSession(targetConvId), 300);
                    }
                }
                document.getElementById('followup-panel').style.display = 'none';
                break;
            }
            case 'show-projects-tab': {
                // Handled by standalone handler at end of file — skip to avoid double-fire
                break;
            }
            case 'new-project': {
                const modal = document.getElementById('new-project-modal');
                if (modal) modal.style.display = 'flex';
                const ni = document.getElementById('new-project-name');
                if (ni) { ni.value = ''; ni.focus(); }
                const di = document.getElementById('new-project-desc');
                if (di) di.value = '';
                break;
            }
            case 'close-project-modal': {
                const modal = document.getElementById('new-project-modal');
                if (modal) modal.style.display = 'none';
                break;
            }
            case 'create-project': {
                const name = document.getElementById('new-project-name')?.value?.trim();
                if (!name) break;
                const desc = document.getElementById('new-project-desc')?.value?.trim() || '';
                const activeSwatch = document.querySelector('.color-swatch.active');
                const color = activeSwatch ? activeSwatch.dataset.color : '#D4AF37';
                window.vault.createProject(name, desc, color, '📂').then(() => {
                const modal2 = document.getElementById('new-project-modal');
                if (modal2) modal2.style.display = 'none';
                loadProjects();
                }); break;
            }
            case 'open-project': {
                const pid = el.dataset.projectId || el.closest('[data-project-id]')?.dataset?.projectId;
                if (pid) openProject(parseInt(pid));
                break;
            }
            case 'back-to-projects': {
                loadProjects();
                break;
            }
            case 'delete-project': {
                const pid = el.dataset.projectId;
                if (pid && confirm('Delete this project? Sessions will not be affected.')) {
                    window.vault.deleteProject(parseInt(pid)).then(() => {
                    loadProjects();
                });
                }
                break;
            }
            case 'unlink-session': {
                const pid = el.dataset.projectId;
                const cid = el.dataset.convId;
                if (pid && cid) {
                    window.vault.unlinkSession(parseInt(pid), cid).then(() => {
                    openProject(parseInt(pid));
                });
                }
                break;
            }
            case 'add-to-project': {
                const cid = el.dataset.convId;
                const src = el.dataset.source || 'antigravity';
                if (!cid) break;
                window.vault.getProjects().then(projects => {
                if (!projects || projects.length === 0) {
                    const name = prompt('No projects yet. Enter a name to create one:');
                    if (name) {
                        const pid = window.vault.createProject(name).then(pid2 => window.vault.linkSession(pid2, cid, src).then(() => showToast("Session linked to " + name)));
                    }
                } else {
                    const choices = projects.map((p, i) => (i + 1) + '. ' + p.name).join('\n');
                    const pick = prompt('Select project:\n' + choices + '\n\nEnter number (or type a new name):');
                    if (!pick) return;
                    const idx = parseInt(pick) - 1;
                    if (idx >= 0 && idx < projects.length) {
                        window.vault.linkSession(projects[idx].id, cid, src).then(() => showToast("Linked to " + projects[idx].name));
                    } else {
                        const pid = window.vault.createProject(pick.trim()).then(pid3 => window.vault.linkSession(pid3, cid, src).then(() => showToast("Created & linked to " + pick.trim())));
                    }
                }
                });
                break;
            }
            case 'toggle-ki-health': {
                const p = document.getElementById('ki-health-panel');
                const showing = p && p.style.display !== 'none';
                if (p) p.style.display = showing ? 'none' : '';
                actionEl.textContent = showing ? '📊 Show KI Health' : '📊 Hide KI Health';
                if (!showing) loadKIHealth();
                break;
            }
        }
    });
}


// ═══════════════════════════════════════════════════════════════
// CHAT SYSTEM
// ═══════════════════════════════════════════════════════════════

let _chatBusy = false;

function setupChat() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    if (!input || !sendBtn) return;

    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        sendBtn.disabled = !input.value.trim() || _chatBusy;
    });

    // Enter to send (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (input.value.trim() && !_chatBusy) sendChatMessage();
        }
    });

    // RAG progress
    if (window.vault.onRAGProgress) {
        window.vault.onRAGProgress(({ pct, msg }) => {
            const badge = document.getElementById('rag-mode-badge');
            if (badge) badge.textContent = `${pct}% ${msg}`;
        });
    }
}

function loadChatPanel() {
    // Update RAG mode badge
    window.vault.getRAGStats().then(stats => {
        const badge = document.getElementById('rag-mode-badge');
        if (badge) {
            badge.className = `rag-mode-badge ${stats.vectorMode || 'offline'}`;
            badge.textContent = `● ${stats.vectorMode || 'offline'} (${stats.chunkCount || 0} chunks)`;
        }
    }).catch(() => {});

    // Rebuild chat history from backend if messages area only has welcome screen
    const msgArea = document.getElementById('chat-messages');
    if (!msgArea) return;
    const hasMessages = msgArea.querySelector('.chat-msg');
    if (hasMessages) return; // Already has rendered messages, don't reload

    window.vault.getChatHistory().then(history => {
        if (!history || history.length === 0) return;

        // Clear welcome screen
        const welcome = msgArea.querySelector('.chat-welcome');
        if (welcome) welcome.remove();

        for (const msg of history) {
            if (msg.role === 'user') {
                msgArea.insertAdjacentHTML('beforeend', `
                    <div class="chat-msg user">
                        <div class="chat-msg-label">YOU</div>
                        <div class="chat-msg-body">${esc(msg.content)}</div>
                    </div>
                `);
            } else {
                const parsed = typeof marked !== 'undefined' ? marked.parse(msg.content) : esc(msg.content);
                let sourcesHtml = '';
                if (msg.sources && msg.sources.length > 0) {
                    sourcesHtml = `<div class="chat-sources">${msg.sources.map(s =>
                        `<span class="chat-source-chip" title="${esc(s.relPath || '')}">${esc(s.title || s.relPath || 'source')}</span>`
                    ).join('')}</div>`;
                }
                msgArea.insertAdjacentHTML('beforeend', `
                    <div class="chat-msg">
                        <div class="chat-msg-label">VAULT</div>
                        <div class="chat-msg-body">${parsed}</div>
                        ${sourcesHtml}
                    </div>
                `);
            }
        }
        msgArea.scrollTop = msgArea.scrollHeight;
    }).catch(() => {});
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msgArea = document.getElementById('chat-messages');
    const sendBtn = document.getElementById('chat-send');
    const query = input.value.trim();
    if (!query || _chatBusy) return;

    // Clear welcome screen on first message
    const welcome = msgArea.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Render user message
    msgArea.insertAdjacentHTML('beforeend', `
        <div class="chat-msg user">
            <div class="chat-msg-label">YOU</div>
            <div class="chat-msg-body">${esc(query)}</div>
        </div>
    `);

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    _chatBusy = true;

    // Show typing indicator
    const typingId = `typing-${Date.now()}`;
    msgArea.insertAdjacentHTML('beforeend', `
        <div class="chat-msg" id="${typingId}">
            <div class="chat-msg-label">VAULT</div>
            <div class="chat-msg-body">
                <div class="chat-typing">
                    <div class="chat-typing-dot"></div>
                    <div class="chat-typing-dot"></div>
                    <div class="chat-typing-dot"></div>
                </div>
            </div>
        </div>
    `);
    msgArea.scrollTop = msgArea.scrollHeight;

    try {
        const result = await window.vault.chat(query);

        // Remove typing indicator
        document.getElementById(typingId)?.remove();

        // Render AI response with markdown
        const parsed = typeof marked !== 'undefined' ? marked.parse(result.answer) : esc(result.answer);
        let sourcesHtml = '';
        if (result.sources && result.sources.length > 0) {
            sourcesHtml = `<div class="chat-sources">${result.sources.map(s =>
                `<span class="chat-source-chip" title="${esc(s.relPath || '')}">${esc(s.title || s.relPath || 'source')}</span>`
            ).join('')}</div>`;
        }

        msgArea.insertAdjacentHTML('beforeend', `
            <div class="chat-msg">
                <div class="chat-msg-label">VAULT</div>
                <div class="chat-msg-body">${parsed}</div>
                ${sourcesHtml}
            </div>
        `);

        // Update mode badge
        const badge = document.getElementById('rag-mode-badge');
        if (badge && result.mode) {
            badge.className = `rag-mode-badge ${result.mode}`;
        }
    } catch (err) {
        document.getElementById(typingId)?.remove();
        msgArea.insertAdjacentHTML('beforeend', `
            <div class="chat-msg">
                <div class="chat-msg-label">VAULT</div>
                <div class="chat-msg-body" style="color:var(--red)">Error: ${esc(err.message || 'Failed to reach AI')}</div>
            </div>
        `);
    }

    _chatBusy = false;
    msgArea.scrollTop = msgArea.scrollHeight;
}


// ═══════════════════════════════════════════════════════════════
// FOLLOW-UP SYSTEM
// ═══════════════════════════════════════════════════════════════

function setupFollowUps() {
    // Listen for real-time follow-up updates
    if (window.vault.onFollowUpUpdate) {
        window.vault.onFollowUpUpdate(({ count }) => {
            updateFollowUpBadge(count);
        });
    }

    // Initial fetch after short delay
    setTimeout(() => {
        window.vault.getFollowUps().then(followUps => {
            updateFollowUpBadge(followUps.length);
        }).catch(() => {});
    }, 5000);
}

function updateFollowUpBadge(count) {
    const badge = document.getElementById('followup-badge');
    if (!badge) return;
    if (count === undefined) {
        // Count cards in panel
        count = document.querySelectorAll('.followup-card').length;
    }
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

async function toggleFollowUpPanel() {
    const panel = document.getElementById('followup-panel');
    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = 'block';

    // Load follow-ups
    const list = document.getElementById('followup-list');
    list.innerHTML = '<div class="empty-text">Loading…</div>';

    try {
        const followUps = await window.vault.getFollowUps();
        if (followUps.length === 0) {
            list.innerHTML = '<div class="empty-text" style="padding:20px;text-align:center;">✅ No follow-ups needed right now</div>';
            updateFollowUpBadge(0);
            return;
        }

        list.innerHTML = followUps.map(f => `
            <div class="followup-card priority-${f.priority}">
                <div class="followup-icon">${f.icon || '📌'}</div>
                <div class="followup-content">
                    <div class="followup-title">${esc(f.title)}</div>
                    <div class="followup-detail">${esc(f.detail)}</div>
                    <div class="followup-actions">
                        ${f.actionLabel ? `<button class="followup-action-btn primary" data-action="followup-action" data-followup-action="${f.actionData?.action || ''}" data-ki-topic="${f.actionData?.kiTopic || ''}" data-conv-id="${f.actionData?.convId || ''}" data-panel="${f.actionData?.panel || ''}">${esc(f.actionLabel)}</button>` : ''}
                        <button class="followup-action-btn" data-action="dismiss-followup" data-followup-id="${f.id}">Dismiss</button>
                    </div>
                </div>
            </div>
        `).join('');

        updateFollowUpBadge(followUps.length);
    } catch {
        list.innerHTML = '<div class="empty-text">Failed to load follow-ups</div>';
    }
}


// ═══════════════════════════════════════════════════════════════
// TOAST NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════════

function showToast(message, type = 'info', duration = 5000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'vault-toast toast-' + type;
    const icons = { info: '📌', success: '✅', warning: '⚠️', sweep: '🧠' };
    toast.innerHTML = '<span class="toast-icon">' + (icons[type] || '📌') + '</span><span class="toast-msg">' + message + '</span>';
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Listen for sweep-complete from main process
if (window.vault && window.vault.onSweepComplete) {
    window.vault.onSweepComplete((results) => {
        if (!results) return;
        const parts = [];
        if (results.summariesUpgraded > 0) parts.push(results.summariesUpgraded + ' summaries upgraded');
        if (results.enriched > 0) parts.push(results.enriched + ' KIs enriched');
        if (results.actionsFound > 0) parts.push(results.actionsFound + ' action items found');
        if (results.linked > 0) parts.push(results.linked + ' captures linked');
        if (parts.length > 0) {
            showToast('Intelligence sweep: ' + parts.join(', '), 'sweep', 7000);
        } else {
            showToast('Intelligence sweep complete — all up to date', 'success', 3000);
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// KI HEALTH DASHBOARD
// ═══════════════════════════════════════════════════════════════

async function loadKIHealth() {
    const panel = document.getElementById('ki-health-panel');
    if (!panel) return;

    try {
        const health = await window.vault.getKIHealth();
        if (!health || health.length === 0) {
            panel.innerHTML = '<div class="empty-text">No Knowledge Items found</div>';
            return;
        }

        const statusConfig = {
            hot:     { color: '#ff5555', bg: 'rgba(255,85,85,0.08)',   icon: '🔥', label: 'Hot' },
            active:  { color: '#f0ad4e', bg: 'rgba(240,173,78,0.08)', icon: '⚡', label: 'Active' },
            good:    { color: '#5bc0de', bg: 'rgba(91,192,222,0.08)',  icon: '✅', label: 'Good' },
            stale:   { color: '#888',    bg: 'rgba(136,136,136,0.05)', icon: '💤', label: 'Stale' },
            dormant: { color: '#555',    bg: 'rgba(85,85,85,0.05)',    icon: '🕸',  label: 'Dormant' },
        };

        panel.innerHTML = health.map(ki => {
            const cfg = statusConfig[ki.status] || statusConfig.good;
            return '<div class="ki-health-card" style="border-left:3px solid ' + cfg.color + ';background:' + cfg.bg + '">' +
                '<div class="ki-health-header">' +
                    '<span class="ki-health-icon">' + cfg.icon + '</span>' +
                    '<span class="ki-health-title">' + esc(ki.title) + '</span>' +
                    '<span class="ki-health-status" style="color:' + cfg.color + '">' + cfg.label + '</span>' +
                '</div>' +
                '<div class="ki-health-meta">' +
                    '<span>' + ki.totalSessions + ' sessions</span>' +
                    '<span>' + ki.thisWeek + ' this week</span>' +
                    '<span>Last: ' + ki.lastActivity + '</span>' +
                    (ki.openActions > 0 ? '<span style="color:#ff5555">' + ki.openActions + ' open actions</span>' : '') +
                '</div>' +
                (ki.summary ? '<div class="ki-health-summary">' + esc(ki.summary).substring(0, 120) + (ki.summary.length > 120 ? '…' : '') + '</div>' : '') +
                '<div class="ki-health-actions">' +
                    '<button class="btn-xs btn-ghost" data-action="export-ki" data-ki-topic="' + esc(ki.topic) + '">📋 Export</button>' +
                    '<button class="btn-xs btn-ghost" data-action="view-thread" data-topic="' + esc(ki.topic) + '">View →</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch {
        panel.innerHTML = '<div class="empty-text">Failed to load KI health</div>';
    }
}

// ═══════════════════════════════════════════════════════════════
// EXPORT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function exportKIToClipboard(kiTopic) {
    try {
        const md = await window.vault.exportKI(kiTopic);
        if (md) {
            await navigator.clipboard.writeText(md);
            showToast('KI exported to clipboard', 'success', 3000);
        } else {
            showToast('Nothing to export', 'warning', 3000);
        }
    } catch {
        showToast('Export failed', 'warning', 3000);
    }
}

async function exportDailyToClipboard(dateStr) {
    try {
        const md = await window.vault.exportDailyDigest(dateStr);
        if (md) {
            await navigator.clipboard.writeText(md);
            showToast('Daily digest exported to clipboard', 'success', 3000);
        } else {
            showToast('Nothing to export for ' + dateStr, 'warning', 3000);
        }
    } catch {
        showToast('Export failed', 'warning', 3000);
    }
}

// ═══════════════════════════════════════════════════════════════
// SESSION CONTINUITY INDICATOR
// ═══════════════════════════════════════════════════════════════

async function loadSessionContinuity(convId, container) {
    if (!container) return;
    try {
        const cont = await window.vault.getSessionContinuity(convId);
        if (!cont || cont.total <= 1) { container.innerHTML = ''; return; }

        let html = '<div class="continuity-bar">';
        html += '<span class="continuity-label">Session ' + cont.position + ' of ' + cont.total + '</span>';
        if (cont.prev) html += '<button class="btn-xs btn-ghost continuity-nav" data-action="toggle-session" data-conv-id="' + esc(cont.prev.conversationId) + '">← ' + esc(cont.prev.title).substring(0, 30) + '</button>';
        if (cont.next) html += '<button class="btn-xs btn-ghost continuity-nav" data-action="toggle-session" data-conv-id="' + esc(cont.next.conversationId) + '">' + esc(cont.next.title).substring(0, 30) + ' →</button>';
        html += '</div>';
        container.innerHTML = html;
    } catch { container.innerHTML = ''; }
}

// ═══════════════════════════════════════════════════════════════
// VERITAS VAULT v3.1 — CONSOLIDATED FEATURE JS
// Single file. Covers: DOM reorder, heatmap interactivity + month
// labels, action item folding, dismiss persistence.
// ═══════════════════════════════════════════════════════════════

(function VaultV31() {
    'use strict';

    // ── 1. Move activity section above morning brief ────────────
    function reorderSections() {
        var scroll = document.querySelector('.journal-scroll');
        var heat   = document.getElementById('momentum-section');
        if (scroll && heat && scroll.firstChild !== heat) {
            scroll.insertBefore(heat, scroll.firstChild);
        }
    }

    // ── 2. Action items folding ─────────────────────────────────
    // Shows HIGH items + top 5 MEDIUM by default. "Show all" button.
    function setupActionFolding() {
        var panel = document.querySelector('.action-items-panel');
        if (!panel || panel.dataset.folded) return;
        panel.dataset.folded = '1';

        var items  = Array.from(panel.querySelectorAll('.action-item'));
        if (items.length <= 6) return; // not worth folding

        // Sort: HIGH first, then MEDIUM, then LOW
        var priority = function(el) {
            var p = (el.querySelector('.action-priority') || {}).textContent || '';
            return p.includes('HIGH') ? 0 : p.includes('MEDIUM') ? 1 : 2;
        };
        items.sort(function(a,b) { return priority(a) - priority(b); });
        items.forEach(function(el,i) { el.parentNode.appendChild(el); }); // re-order in DOM

        // Hide items beyond top 6 (all HIGH + top 5 MEDIUM equiv)
        var visibleCount = 0;
        items.forEach(function(el) {
            if (priority(el) === 0) { el.classList.remove('vv-hidden'); } // always show HIGH
            else {
                if (visibleCount < 5) { el.classList.remove('vv-hidden'); visibleCount++; }
                else { el.classList.add('vv-hidden'); }
            }
        });

        var hiddenCount = items.filter(function(el){ return el.classList.contains('vv-hidden'); }).length;
        if (hiddenCount === 0) return;

        // Create "Show all" button
        var btn = document.createElement('button');
        btn.id = 'action-show-more';
        btn.textContent = 'Show all ' + items.length + ' items';
        panel.appendChild(btn);

        btn.addEventListener('click', function() {
            var expanded = btn.dataset.expanded === '1';
            items.forEach(function(el) {
                el.classList.toggle('vv-hidden', expanded && priority(el) !== 0 && items.indexOf(el) >= (items.filter(function(x){return priority(x)===0;}).length + 5));
            });
            if (expanded) {
                btn.textContent = 'Show all ' + items.length + ' items';
                btn.dataset.expanded = '0';
                items.filter(function(el){ return !el.classList.contains('vv-hidden'); }).slice(-1)[0]?.scrollIntoView({behavior:'smooth',block:'nearest'});
            } else {
                items.forEach(function(el){ el.classList.remove('vv-hidden'); });
                btn.textContent = 'Show less';
                btn.dataset.expanded = '1';
            }
        });
    }

    // ── 3. Heatmap: month labels + interactivity ────────────────
    var heatTip = null;
    function ensureTip() {
        if (heatTip) return;
        heatTip = document.createElement('div');
        heatTip.id = 'heat-tip';
        heatTip.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;background:#1A1A1A;border:1px solid rgba(212,175,55,0.35);border-radius:7px;padding:7px 12px;font-size:11px;color:#E0E0E0;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.1s;white-space:nowrap';
        document.body.appendChild(heatTip);
    }

    function setupHeatmap() {
        var section = document.getElementById('momentum-section');
        var grid    = section && section.querySelector('.momentum-grid, .heatmap-grid, .heat-grid');
        if (!section || !grid) return;
        ensureTip();

        // Month labels: derive from data-date attributes or sequential
        var cells     = Array.from(section.querySelectorAll('.heat-cell'));
        var totalCols = cells.length;

        // Inject month row if not already there
        if (!section.querySelector('.heatmap-month-row') && totalCols > 0) {
            var monthRow = document.createElement('div');
            monthRow.className = 'heatmap-month-row';
            // Determine column count (assumed 14 weeks = 14 columns for weekly bars)
            var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            var now = new Date();
            // Build label for each column based on week offset from today
            var cols = grid.children.length || 14;
            for (var c = 0; c < cols; c++) {
                var weeksAgo = cols - 1 - c;
                var d = new Date(now);
                d.setDate(d.getDate() - weeksAgo * 7);
                var lbl = document.createElement('div');
                lbl.className = 'heatmap-month-label';
                // Show month label only on first column of that month
                var prevWeek = new Date(d); prevWeek.setDate(prevWeek.getDate()-7);
                lbl.textContent = (c === 0 || prevWeek.getMonth() !== d.getMonth()) ? months[d.getMonth()] : '';
                monthRow.appendChild(lbl);
            }
            section.appendChild(monthRow);
        }

        // Wire cell interactivity
        cells.forEach(function(cell) {
            if (cell.dataset.wired) return;
            cell.dataset.wired = '1';

            var rawTitle = cell.getAttribute('title') || '';
            cell.removeAttribute('title');
            if (!rawTitle) return;

            var parts  = rawTitle.split(': ');
            var dateStr = parts[0] || '';
            var countStr = parts[1] || '';
            var displayDate = dateStr;
            try {
                var d2 = new Date(dateStr + 'T12:00:00');
                displayDate = d2.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
            } catch(e){}

            function moveTip(e) {
                var x = e.clientX+14, y = e.clientY-40;
                if (x+180 > window.innerWidth) x = e.clientX-160;
                heatTip.style.left = x+'px'; heatTip.style.top = y+'px';
            }

            cell.addEventListener('mouseenter', function(e) {
                heatTip.innerHTML = '<strong style="color:#D4AF37">' + displayDate + '</strong>' + (countStr ? '<br>'+countStr : '');
                heatTip.style.opacity = '1';
                moveTip(e);
            });
            cell.addEventListener('mousemove', moveTip);
            cell.addEventListener('mouseleave', function() { heatTip.style.opacity = '0'; });

            if (cell.dataset.level > '0') {
                cell.addEventListener('click', function() {
                    var dayCards = document.querySelectorAll('.day-card,[data-date]');
                    var target = null;
                    dayCards.forEach(function(el) {
                        var elDate = el.dataset.date || '';
                        if (!elDate) { var h = el.querySelector('.day-header,h2,h3'); if(h) elDate=h.textContent; }
                        if (dateStr && elDate.includes(dateStr.slice(5))) target = el;
                    });
                    if (target) {
                        target.scrollIntoView({behavior:'smooth',block:'start'});
                        target.style.transition = 'background 0.3s';
                        target.style.background = 'rgba(212,175,55,0.07)';
                        setTimeout(function(){ target.style.background=''; }, 1200);
                    }
                });
            }
        });
    }

    // ── 4. Dismiss persistence ──────────────────────────────────
    function setupDismissFix() {
        var panel = document.getElementById('followup-panel');
        if (!panel) return;
        panel.addEventListener('click', function(e) {
            var btn = e.target.closest('[data-action="dismiss-followup"]');
            if (!btn) return;
            var fId = btn.dataset.followupId;
            if (!fId) return;
            try {
                var d = JSON.parse(localStorage.getItem('vv_dismissed_fu')||'[]');
                if (!d.includes(fId)) { d.push(fId); localStorage.setItem('vv_dismissed_fu',JSON.stringify(d)); }
            } catch(e2){}
        }, true);
        new MutationObserver(function() {
            try {
                var dismissed = JSON.parse(localStorage.getItem('vv_dismissed_fu')||'[]');
                dismissed.forEach(function(fId) {
                    var btn = panel.querySelector('[data-followup-id="'+fId+'"]');
                    if (btn) { var card = btn.closest('.followup-card'); if(card) card.remove(); }
                });
            } catch(e){}
        }).observe(panel, {childList:true,subtree:true});
    }

    // ── Bootstrap ───────────────────────────────────────────────
    function init() {
        reorderSections();
        setupDismissFix();

        // Heatmap and action folding need the morning brief to be rendered first
        var Observer = new MutationObserver(function() {
            setupHeatmap();
            setupActionFolding();
        });
        var brief = document.getElementById('morning-brief');
        if (brief) Observer.observe(brief, {childList:true, subtree:true, attributes:true});

        // Also try directly after 1s and 3s as fallback
        setTimeout(function() { setupHeatmap(); setupActionFolding(); }, 1000);
        setTimeout(function() { setupHeatmap(); setupActionFolding(); }, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function(){setTimeout(init,100);});
    } else {
        setTimeout(init, 100);
    }

})();
// END VaultV31

// VAULT v3.2 â€” heatmap month labels + interactivity + DOM reorder + action fold + dismiss
(function VaultV32() {
    'use strict';

    // â”€â”€ DOM reorder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function reorderSections() {
        var scroll = document.querySelector('.journal-scroll');
        var heat   = document.getElementById('momentum-section');
        if (scroll && heat && scroll.firstChild !== heat) scroll.insertBefore(heat, scroll.firstChild);
    }

    // â”€â”€ Tooltip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var tip;
    function ensureTip() {
        if (tip) return;
        tip = document.createElement('div');
        tip.id = 'heat-tip';
        tip.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;background:#1A1A1A;border:1px solid rgba(212,175,55,0.35);border-radius:7px;padding:7px 12px;font-size:11px;color:#E0E0E0;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.1s;white-space:nowrap';
        document.body.appendChild(tip);
    }

    // â”€â”€ Heatmap: month labels derived from ACTUAL cell dates â”€â”€â”€â”€
    function setupHeatmap() {
        var section = document.getElementById('momentum-section');
        if (!section) return;
        ensureTip();

        var cells = Array.from(section.querySelectorAll('.heat-cell'));
        if (!cells.length) return;

        // Wire each cell (hover + click) â€” once only
        cells.forEach(function(cell) {
            if (cell.dataset.wired) return;
            cell.dataset.wired = '1';
            var rawTitle = cell.getAttribute('title') || '';
            cell.removeAttribute('title');
            if (!rawTitle) return;
            var dateStr   = rawTitle.split(':')[0].trim();
            var countStr  = rawTitle.split(': ')[1] || '';
            var dispDate  = dateStr;
            try { dispDate = new Date(dateStr+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); } catch(e){}

            cell.addEventListener('mouseenter', function(e) {
                tip.innerHTML = '<strong style="color:#D4AF37">'+dispDate+'</strong>'+(countStr?'<br>'+countStr:'');
                tip.style.opacity='1'; moveTip(e);
            });
            cell.addEventListener('mousemove', moveTip);
            cell.addEventListener('mouseleave', function(){ tip.style.opacity='0'; });

            if (parseInt(cell.dataset.level||0) > 0) {
                cell.style.cursor = 'pointer';
                cell.addEventListener('click', function() {
                    var target = null;
                    document.querySelectorAll('.day-card,[data-date]').forEach(function(el) {
                        var ed = el.dataset.date||'';
                        if (!ed) { var h=el.querySelector('.day-header,h2,h3'); if(h) ed=h.textContent; }
                        if (dateStr && ed.includes(dateStr.slice(5))) target=el;
                    });
                    if (target) {
                        target.scrollIntoView({behavior:'smooth',block:'start'});
                        target.style.transition='background 0.3s ease';
                        target.style.background='rgba(212,175,55,0.07)';
                        setTimeout(function(){ target.style.background=''; },1200);
                    }
                });
            }
        });

        // â”€ Build month labels using actual dates from cell titles â”€
        if (section.querySelector('.heatmap-month-row')) return; // already done

        // The grid is 7 rows Ã— N columns (one column = one week).
        // cells[0] = oldest day, cells[last] = newest day.
        // We need to detect the column count from CSS or the grid element.
        var grid = section.querySelector('#momentum-grid');
        if (!grid || !cells.length) return;

        var gridStyle = window.getComputedStyle(grid);
        var colTemplate = gridStyle.getPropertyValue('grid-template-columns') || '';
        // Count columns: colTemplate is "Xpx Xpx ..." â€” count spaces isn't reliable.
        // Better: total cells / 7 rows (7 days per column)
        var totalCells = cells.length;
        var rows = 7; // standard heatmap: 7 days per column
        var cols = Math.ceil(totalCells / rows);

        // Parse actual date from each column's first cell
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var monthRow = document.createElement('div');
        monthRow.className = 'heatmap-month-row';
        monthRow.style.cssText = 'display:grid;grid-template-columns:repeat('+cols+',1fr);padding:4px 0 0;font-size:8px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#2E2C28';

        var lastMonth = -1;
        for (var c = 0; c < cols; c++) {
            var cellIdx = c * rows;
            var cell0 = cells[cellIdx];
            var lbl = document.createElement('div');
            lbl.style.cssText = 'text-align:center';
            if (cell0) {
                // date from data-date attr we set, or from the wired rawTitle stored elsewhere
                // We need the date â€” re-read from title if available, else skip
                // Since we removed title above, check if cellIdx has a wired date
                // Better: store date on dataset when wiring
                var d0title = cell0.dataset.cellDate || '';
                if (d0title) {
                    try {
                        var d0 = new Date(d0title+'T12:00:00');
                        var m = d0.getMonth();
                        lbl.textContent = (m !== lastMonth) ? months[m] : '';
                        lastMonth = m;
                    } catch(e) {}
                }
            }
            monthRow.appendChild(lbl);
        }

        // Move streak badge above month row
        var badge = section.querySelector('#streak-badge');
        // Insert month row before the badge, or append to section
        if (badge && badge.parentNode === section) {
            section.insertBefore(monthRow, badge);
        } else {
            var grid2 = section.querySelector('#momentum-grid');
            if (grid2) grid2.after(monthRow);
            else section.appendChild(monthRow);
        }
    }

    // Store cell dates BEFORE removing titles, so month row can read them
    function preTagCells() {
        var cells = document.querySelectorAll('#momentum-section .heat-cell:not([data-cell-date])');
        cells.forEach(function(cell) {
            var t = cell.getAttribute('title') || '';
            if (t) cell.dataset.cellDate = t.split(':')[0].trim();
        });
    }

    // â”€â”€ Streak badge layout fix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function fixStreakLayout() {
        var badge = document.getElementById('streak-badge');
        if (!badge) return;
        badge.style.cssText = 'display:block;padding:6px 0 0;font-size:11px;font-weight:700;color:#D4AF37;letter-spacing:0.2px';
    }

    // â”€â”€ Action items folding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function setupActionFolding() {
        var panel = document.querySelector('.action-items-panel');
        if (!panel || panel.dataset.folded) return;
        panel.dataset.folded = '1';
        var items = Array.from(panel.querySelectorAll('.action-item'));
        if (items.length <= 6) return;

        var hp = function(el){ var t=(el.querySelector('.action-priority')||{}).textContent||''; return t.indexOf('HIGH')>=0?0:t.indexOf('MEDIUM')>=0?1:2; };
        items.sort(function(a,b){ return hp(a)-hp(b); });
        items.forEach(function(el){ el.parentNode.appendChild(el); });

        var shown = 0;
        items.forEach(function(el){
            var p = hp(el);
            if (p===0 || (p===1 && shown<5)) { el.classList.remove('vv-hidden'); if(p>0) shown++; }
            else { el.classList.add('vv-hidden'); }
        });

        var hidden = items.filter(function(el){ return el.classList.contains('vv-hidden'); }).length;
        if (!hidden) return;

        var btn = document.createElement('button');
        btn.id = 'action-show-more';
        btn.textContent = 'Show all '+items.length+' items';
        panel.appendChild(btn);
        btn.addEventListener('click', function() {
            var exp = btn.dataset.exp==='1';
            if (!exp) { items.forEach(function(el){ el.classList.remove('vv-hidden'); }); btn.textContent='Show less'; btn.dataset.exp='1'; }
            else {
                shown=0; items.forEach(function(el){
                    var p=hp(el);
                    if(p===0||(p===1&&shown<5)){el.classList.remove('vv-hidden');if(p>0)shown++;}
                    else{el.classList.add('vv-hidden');}
                });
                btn.textContent='Show all '+items.length+' items'; btn.dataset.exp='0';
            }
        });
    }

    // â”€â”€ Dismiss persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function setupDismissFix() {
        var panel = document.getElementById('followup-panel');
        if (!panel) return;
        panel.addEventListener('click', function(e) {
            var btn = e.target.closest('[data-action="dismiss-followup"]');
            if (!btn) return;
            try { var d=JSON.parse(localStorage.getItem('vv_dismissed_fu')||'[]'); if(!d.includes(btn.dataset.followupId)){d.push(btn.dataset.followupId);localStorage.setItem('vv_dismissed_fu',JSON.stringify(d));} } catch(e2){}
        }, true);
        new MutationObserver(function(){
            try { var dm=JSON.parse(localStorage.getItem('vv_dismissed_fu')||'[]'); dm.forEach(function(id){ var b=panel.querySelector('[data-followup-id="'+id+'"]'); if(b){var c=b.closest('.followup-card');if(c)c.remove();} }); } catch(e){}
        }).observe(panel, {childList:true,subtree:true});
    }

    function moveTip(e) { var x=e.clientX+14,y=e.clientY-40; if(x+180>window.innerWidth) x=e.clientX-155; tip.style.left=x+'px'; tip.style.top=y+'px'; }

    // â”€â”€ Bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function init() {
        reorderSections();
        fixStreakLayout();
        setupDismissFix();
        preTagCells();
        setupHeatmap();
        setupActionFolding();
        // Re-run after renders settle
        setTimeout(function(){ preTagCells(); setupHeatmap(); setupActionFolding(); }, 1500);
        setTimeout(function(){ setupHeatmap(); }, 3500);
    }

    if (document.readyState==='loading') { document.addEventListener('DOMContentLoaded',function(){ setTimeout(init,150); }); }
    else { setTimeout(init,150); }

})();
// END VaultV32
// Color swatch selection for project modal
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("color-swatch")) {
        document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
        e.target.classList.add("active");
    }
});

// ── Projects Sub-Tab Handler ─────────────────────── (projects-tab-handler)
document.addEventListener('click', (e) => {
    const tab = e.target.closest('.projects-tab');
    if (!tab) return;
    
    const tabName = tab.dataset.tab;
    if (!tabName) return;

    // Toggle active tab styling
    document.querySelectorAll('.projects-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Show/hide sections
    const lists = document.getElementById('projects-list');
    const threads = document.getElementById('projects-threads-section');
    const health = document.getElementById('projects-health-section');
    const detail = document.getElementById('project-detail-view');
    const newBtn = document.getElementById('btn-new-project');

    if (lists) lists.style.display = tabName === 'workspaces' ? '' : 'none';
    if (threads) threads.style.display = tabName === 'threads' ? '' : 'none';
    if (health) health.style.display = tabName === 'health' ? '' : 'none';
    if (detail) detail.style.display = 'none';
    if (newBtn) newBtn.style.display = tabName === 'workspaces' ? '' : 'none';

    // Load content for the selected tab
    if (tabName === 'threads' && typeof loadThreads === 'function') loadThreads();
    if (tabName === 'health' && typeof loadKIHealth === 'function') loadKIHealth();
    if (tabName === 'workspaces' && typeof loadProjects === 'function') loadProjects();
});
