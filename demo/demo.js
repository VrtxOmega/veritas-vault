// VERITAS VAULT Demo — Fictional Mock Data + Interactivity
(function() {
'use strict';

// ── Navigation ──
document.querySelectorAll('.nav-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    });
});

// ── Follow-ups ──
const bell = document.getElementById('notification-bell');
const fPanel = document.getElementById('followup-panel');
bell.addEventListener('click', () => { fPanel.style.display = fPanel.style.display === 'none' ? 'block' : 'none'; });
document.getElementById('close-followups').addEventListener('click', () => { fPanel.style.display = 'none'; });

// ── Artifact Overlay ──
const overlay = document.getElementById('artifact-overlay');
document.getElementById('close-artifact').addEventListener('click', () => { overlay.style.display = 'none'; });
function showArtifact(title, content) {
    document.getElementById('artifact-title').textContent = title;
    document.getElementById('artifact-body').textContent = content;
    overlay.style.display = 'flex';
}

// ── Toast ──
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
}

// ══════════════════════════════════════════════════════
// PANEL 1: JOURNAL
// ══════════════════════════════════════════════════════
const journalHTML = `
<div class="journal-scroll">
    <div class="morning-brief">
        <div class="brief-label">☀️ Morning Brief — March 17, 2026</div>
        <div class="brief-text">Good morning. You're on a <strong>9-day streak</strong> — solid consistency. Yesterday you wrapped up the authentication refactor and shipped the dashboard redesign to staging. You have <strong>3 open action items</strong>, including the payment gateway integration test. Two Knowledge Items need enrichment: <em>Backend Architecture Patterns</em> has 4 new related captures. Consider running an Intelligence Sweep to auto-organize 6 unlinked sessions.</div>
    </div>

    <div class="momentum-section">
        <div class="section-label">Activity</div>
        <div class="momentum-grid" id="momentum-grid"></div>
        <div class="momentum-meta"><span class="streak-badge">🔥 9 day streak</span></div>
    </div>

    <div class="pinned-section">
        <div class="section-label">📌 Pinned</div>
        <div class="pinned-card"><span>📝</span><span class="pinned-title">Project Atlas — API Gateway Migration</span><span class="pinned-note">Critical path</span></div>
        <div class="pinned-card"><span>🔒</span><span class="pinned-title">Sentinel Auth — OAuth2 PKCE Flow</span><span class="pinned-note">Security review</span></div>
    </div>

    <div id="daily-timeline">
        <div class="day-card">
            <div class="day-header"><span class="day-date">Today — March 17</span><span class="day-count">4 sessions · 10 artifacts</span></div>
            <div class="day-sessions">
                <div class="quick-note">📝 Verify rate limiter config before prod deploy on Thursday</div>
                <div class="session-card" data-expand>
                    <div class="session-title">Payment Gateway — Stripe Webhook Handler Refactor</div>
                    <div class="session-meta">
                        <span class="source-badge antigravity">Antigravity</span>
                        <span class="quality-stars">★★★★★</span>
                        <span>11 artifacts</span>
                    </div>
                    <div class="session-summary">Refactored the Stripe webhook handler to use idempotency keys for retry safety. Added signature verification via stripe.webhooks.constructEvent(). Created dead-letter queue for failed webhook processing. Wrote integration tests covering 12 event types including payment_intent.succeeded, charge.refunded, and invoice.payment_failed.</div>
                    <div class="session-artifacts">
                        <span class="artifact-chip" data-artifact="plan">📄 implementation_plan.md</span>
                        <span class="artifact-chip" data-artifact="task">📋 task.md</span>
                        <span class="artifact-chip" data-artifact="walk">📝 walkthrough.md</span>
                    </div>
                </div>
                <div class="session-card" data-expand>
                    <div class="session-title">Dashboard Redesign — Chart Component Library</div>
                    <div class="session-meta">
                        <span class="source-badge antigravity">Antigravity</span>
                        <span class="quality-stars">★★★★★</span>
                        <span>7 artifacts</span>
                    </div>
                    <div class="session-summary">Built reusable chart components (AreaChart, BarStack, HeatmapGrid) using D3.js with React wrappers. Implemented responsive breakpoints and dark/light theme support. Added tooltip system with crosshair tracking. Performance: &lt;16ms render for 10K data points.</div>
                    <div class="session-artifacts">
                        <span class="artifact-chip">📄 chart_api.md</span>
                        <span class="artifact-chip">📋 task.md</span>
                    </div>
                </div>
                <div class="session-card" data-expand>
                    <div class="session-title">Redis Caching Strategy for User Sessions</div>
                    <div class="session-meta">
                        <span class="source-badge gemini">Gemini</span>
                        <span class="quality-stars">★★★★</span>
                        <span>5 turns</span>
                    </div>
                    <div class="session-summary">Explored Redis Cluster vs Sentinel for session caching. Decided on Sentinel with read replicas for HA. TTL strategy: 30min sliding window with 24h hard cap. Estimated 60% reduction in DB read load for auth-heavy endpoints.</div>
                </div>
            </div>
        </div>

        <div class="day-card">
            <div class="day-header"><span class="day-date">Yesterday — March 16</span><span class="day-count">5 sessions · 14 artifacts</span></div>
            <div class="day-sessions">
                <div class="session-card" data-expand>
                    <div class="session-title">GraphQL Schema — Federation Gateway Setup</div>
                    <div class="session-meta">
                        <span class="source-badge antigravity">Antigravity</span>
                        <span class="quality-stars">★★★★★</span>
                        <span>16 artifacts</span>
                    </div>
                    <div class="session-summary">Set up Apollo Federation gateway with 4 subgraphs: users, orders, inventory, analytics. Implemented @key directives for cross-service entity resolution. Added DataLoader batching to eliminate N+1 queries.</div>
                </div>
                <div class="session-card" data-expand>
                    <div class="session-title">CI/CD Pipeline — GitHub Actions Matrix Builds</div>
                    <div class="session-meta">
                        <span class="source-badge chatgpt">ChatGPT</span>
                        <span class="quality-stars">★★★★</span>
                        <span>8 turns</span>
                    </div>
                    <div class="session-summary">Optimized GitHub Actions workflows with matrix strategy for Node 18/20/22 × Ubuntu/Windows. Added Playwright E2E tests in parallel. Reduced pipeline time from 14min to 6min with caching and selective test runs.</div>
                </div>
                <div class="session-card" data-expand>
                    <div class="session-title">PostgreSQL Query Optimization — Slow Endpoints</div>
                    <div class="session-meta">
                        <span class="source-badge gemini">Gemini</span>
                        <span class="quality-stars">★★★</span>
                        <span>4 turns</span>
                    </div>
                    <div class="session-summary">Analyzed EXPLAIN plans for 3 slow API endpoints. Added composite indexes on (user_id, created_at) and (status, priority). Rewrote subquery in orders endpoint to use lateral join. P95 latency dropped from 450ms to 38ms.</div>
                </div>
            </div>
        </div>

        <div class="day-card">
            <div class="day-header"><span class="day-date">March 15</span><span class="day-count">3 sessions · 6 artifacts</span></div>
            <div class="day-sessions">
                <div class="session-card" data-expand>
                    <div class="session-title">WebSocket Architecture — Real-time Notifications</div>
                    <div class="session-meta">
                        <span class="source-badge antigravity">Antigravity</span>
                        <span class="quality-stars">★★★★★</span>
                        <span>6 artifacts</span>
                    </div>
                    <div class="session-summary">Designed WebSocket pub/sub architecture using Socket.io with Redis adapter for horizontal scaling. Implemented channel-based subscriptions with JWT auth on handshake. Added heartbeat monitoring and automatic reconnection with exponential backoff.</div>
                </div>
            </div>
        </div>
    </div>
</div>`;

// ══════════════════════════════════════════════════════
// PANEL 2: SEARCH
// ══════════════════════════════════════════════════════
const searchHTML = `
<div class="panel-inner">
    <div class="search-header">
        <input type="text" class="search-input" id="demo-search" placeholder="Search across all captured documents…" value="authentication">
        <span class="search-count">9 results</span>
    </div>
    <div class="search-results">
        <div class="search-result">
            <div class="search-result-title">Sentinel Auth — OAuth2 PKCE Implementation <span class="type-badge knowledge">knowledge</span></div>
            <div class="search-result-path">knowledge/backend_architecture/sentinel_auth_oauth2.md</div>
            <div class="search-result-snippet">...implemented PKCE flow for mobile <mark>authentication</mark>. The code_verifier is generated client-side using crypto.randomBytes(32), then hashed with S256 for the <mark>authentication</mark> challenge...</div>
        </div>
        <div class="search-result">
            <div class="search-result-title">API Gateway Migration — Token Validation <span class="type-badge artifact">artifact</span></div>
            <div class="search-result-path">brain/a2b3c4d5/implementation_plan.md</div>
            <div class="search-result-snippet">...moved JWT <mark>authentication</mark> middleware to gateway level. All downstream services now receive pre-validated tokens via X-User-Claims header, eliminating redundant <mark>authentication</mark> checks...</div>
        </div>
        <div class="search-result">
            <div class="search-result-title">WebSocket Handshake Auth Pattern <span class="type-badge capture">capture</span></div>
            <div class="search-result-path">captures/antigravity/2026-03-15_WebSocket-Architecture.md</div>
            <div class="search-result-snippet">...JWT <mark>authentication</mark> on WebSocket handshake prevents unauthorized connections. Token refresh happens over HTTP, not WS, to avoid <mark>authentication</mark> state in the socket layer...</div>
        </div>
        <div class="search-result">
            <div class="search-result-title">Redis Session Caching Strategy <span class="type-badge capture">capture</span></div>
            <div class="search-result-path">captures/gemini/2026-03-17_Redis-Caching-Strategy.md</div>
            <div class="search-result-snippet">...session-based <mark>authentication</mark> tokens cached in Redis with 30-minute sliding TTL. Reduces <mark>authentication</mark> DB queries by estimated 60%...</div>
        </div>
        <div class="search-result">
            <div class="search-result-title">CI/CD Pipeline Security Scanning <span class="type-badge artifact">artifact</span></div>
            <div class="search-result-path">brain/f6e7d8c9/walkthrough.md</div>
            <div class="search-result-snippet">...added SAST scanning step that validates <mark>authentication</mark> endpoint input sanitization. Catches SQL injection and XSS in <mark>authentication</mark> forms during CI...</div>
        </div>
    </div>
</div>`;

// ══════════════════════════════════════════════════════
// PANEL 3: THREADS
// ══════════════════════════════════════════════════════
const threadsHTML = `
<div class="panel-inner">
    <h2 class="panel-title">Project Threads</h2>
    <div class="ki-health-section">
        <button class="ki-health-toggle" id="health-toggle">📊 Show KI Health</button>
        <div id="ki-health-panel" style="display:none">
            <div class="health-grid">
                <div class="health-card"><div class="health-label">🔥 Hot</div><div class="health-count hot">2</div></div>
                <div class="health-card"><div class="health-label">⚡ Active</div><div class="health-count active">4</div></div>
                <div class="health-card"><div class="health-label">✅ Good</div><div class="health-count good">6</div></div>
                <div class="health-card"><div class="health-label">⏳ Stale</div><div class="health-count stale">3</div></div>
                <div class="health-card"><div class="health-label">💤 Dormant</div><div class="health-count dormant">1</div></div>
            </div>
        </div>
    </div>
    <div class="threads-list">
        <div class="thread-card"><div class="thread-title">🔐 Backend Architecture Patterns</div><div class="thread-summary">API gateway migration, GraphQL federation, Redis caching, WebSocket pub/sub, PostgreSQL optimization. Core backend knowledge base spanning microservices architecture.</div><div class="thread-meta"><span>12 sessions</span><span>34 artifacts</span><span>Last: Today</span></div></div>
        <div class="thread-card"><div class="thread-title">💳 Payment Integration</div><div class="thread-summary">Stripe webhook handler, idempotency keys, retry safety, dead-letter queue for failed events. PCI compliance patterns and subscription billing lifecycle.</div><div class="thread-meta"><span>8 sessions</span><span>22 artifacts</span><span>Last: Today</span></div></div>
        <div class="thread-card"><div class="thread-title">📊 Dashboard & Analytics Platform</div><div class="thread-summary">D3.js chart library, React component wrappers, responsive breakpoints, real-time streaming data visualization, A/B test result panels.</div><div class="thread-meta"><span>10 sessions</span><span>28 artifacts</span><span>Last: Today</span></div></div>
        <div class="thread-card"><div class="thread-title">🔑 Sentinel Auth System</div><div class="thread-summary">OAuth2 PKCE flow, JWT lifecycle, refresh token rotation, session store migration, MFA with TOTP/WebAuthn, rate limiting on auth endpoints.</div><div class="thread-meta"><span>7 sessions</span><span>18 artifacts</span><span>Last: Mar 16</span></div></div>
        <div class="thread-card"><div class="thread-title">🚀 CI/CD & DevOps</div><div class="thread-summary">GitHub Actions matrix builds, Playwright E2E in parallel, Docker multi-stage builds, Terraform infrastructure modules, production deploy runbooks.</div><div class="thread-meta"><span>6 sessions</span><span>15 artifacts</span><span>Last: Mar 16</span></div></div>
        <div class="thread-card"><div class="thread-title">📡 Real-time Infrastructure</div><div class="thread-summary">Socket.io with Redis adapter, channel-based subscriptions, heartbeat monitoring, presence tracking, notification delivery pipeline.</div><div class="thread-meta"><span>4 sessions</span><span>9 artifacts</span><span>Last: Mar 15</span></div></div>
    </div>
</div>`;

// ══════════════════════════════════════════════════════
// PANEL 4: TASKS
// ══════════════════════════════════════════════════════
const tasksHTML = `
<div class="panel-inner">
    <h2 class="panel-title">Open Plans</h2>
    <div class="task-group">
        <div class="task-group-title">Stripe Webhook Refactor (4 items)</div>
        <div class="task-item"><span class="task-checkbox progress">[/]</span><span>Add dead-letter queue for failed webhook events</span></div>
        <div class="task-item"><span class="task-checkbox">[ ]</span><span>Write integration tests for charge.refunded event flow</span></div>
        <div class="task-item"><span class="task-checkbox">[ ]</span><span>Implement idempotency key dedup in payment_intent handler</span></div>
        <div class="task-item"><span class="task-checkbox done">[x]</span><span>Add Stripe signature verification via constructEvent()</span></div>
    </div>
    <div class="task-group">
        <div class="task-group-title">GraphQL Federation Gateway (3 items)</div>
        <div class="task-item"><span class="task-checkbox progress">[/]</span><span>Set up @key directives for cross-service entity resolution</span></div>
        <div class="task-item"><span class="task-checkbox">[ ]</span><span>Add DataLoader batching to eliminate N+1 in orders subgraph</span></div>
        <div class="task-item"><span class="task-checkbox done">[x]</span><span>Define schema stitching for users + inventory subgraphs</span></div>
    </div>
    <div class="task-group">
        <div class="task-group-title">Dashboard Chart Components (2 items)</div>
        <div class="task-item"><span class="task-checkbox">[ ]</span><span>Implement crosshair tooltip system with axis snapping</span></div>
        <div class="task-item"><span class="task-checkbox">[ ]</span><span>Add responsive breakpoint logic for mobile chart layouts</span></div>
    </div>
    <div class="task-group">
        <div class="task-group-title">Redis Session Migration (2 items)</div>
        <div class="task-item"><span class="task-checkbox progress">[/]</span><span>Configure Sentinel with read replicas for HA session store</span></div>
        <div class="task-item"><span class="task-checkbox">[ ]</span><span>Implement sliding TTL with 24h hard cap on session tokens</span></div>
    </div>
</div>`;

// ══════════════════════════════════════════════════════
// PANEL 5: INTELLIGENCE
// ══════════════════════════════════════════════════════
const intelHTML = `
<div class="panel-inner">
    <div class="intel-header">
        <h2 class="panel-title">AI Intelligence</h2>
        <span class="ai-status-badge online">● Ollama Online — qwen2.5:7b</span>
    </div>
    <div class="intel-actions">
        <button class="btn btn-gold btn-sm" id="auto-organize-btn">⚡ Auto-Organize Captures</button>
        <button class="btn btn-ghost btn-sm" id="sweep-btn">🔄 Run Intelligence Sweep</button>
        <button class="btn btn-ghost btn-sm">📊 Weekly Report</button>
    </div>
    <div class="intel-section">
        <div class="intel-section-title">Session Clusters</div>
        <div class="cluster-card"><div class="cluster-label">Backend & Data Layer</div><div class="cluster-sessions">GraphQL Federation, PostgreSQL Optimization, Redis Caching, API Gateway — 9 sessions</div></div>
        <div class="cluster-card"><div class="cluster-label">Frontend & Visualization</div><div class="cluster-sessions">Dashboard Redesign, Chart Components, D3.js Wrappers, Theme System — 6 sessions</div></div>
        <div class="cluster-card"><div class="cluster-label">Infrastructure & DevOps</div><div class="cluster-sessions">CI/CD Pipeline, Docker Builds, WebSocket Scaling, Monitoring — 5 sessions</div></div>
    </div>
    <div class="intel-section">
        <div class="intel-section-title">Capture Priorities (Unlinked)</div>
        <div class="priority-item"><div class="priority-score high">9</div><div><div style="font-size:12px;font-weight:600">PostgreSQL lateral join optimization patterns</div><div style="font-size:10px;color:var(--text-muted)">High-value performance knowledge applicable across all data endpoints</div></div></div>
        <div class="priority-item"><div class="priority-score high">8</div><div><div style="font-size:12px;font-weight:600">Socket.io horizontal scaling with Redis adapter</div><div style="font-size:10px;color:var(--text-muted)">Critical infrastructure pattern for real-time features</div></div></div>
        <div class="priority-item"><div class="priority-score med">6</div><div><div style="font-size:12px;font-weight:600">GitHub Actions caching strategies for monorepos</div><div style="font-size:10px;color:var(--text-muted)">DevOps optimization applicable to CI pipeline improvements</div></div></div>
    </div>
    <div class="intel-section">
        <div class="intel-section-title">Knowledge Gaps Detected</div>
        <div class="cluster-card"><div class="cluster-label">Suggested: Error Handling & Resilience Patterns</div><div class="cluster-sessions">4 sessions reference circuit breakers and retry strategies but no dedicated KI exists</div></div>
    </div>
</div>`;

// ══════════════════════════════════════════════════════
// PANEL 6: ASK (CHAT)
// ══════════════════════════════════════════════════════
const askHTML = `
<div class="panel-inner chat-panel">
    <div class="chat-header">
        <h2 class="panel-title">Ask Your Vault</h2>
        <div class="chat-header-actions">
            <span class="rag-mode-badge">● Semantic</span>
            <button class="btn-ghost btn-xs">Clear</button>
            <button class="btn-ghost btn-xs">Rebuild Index</button>
        </div>
    </div>
    <div class="chat-messages" id="chat-messages">
        <div class="chat-msg user"><div class="msg-bubble">How did we handle authentication in the API gateway?</div></div>
        <div class="chat-msg assistant"><div class="msg-bubble">Based on your captured sessions, here's how authentication was implemented in the API gateway:<br><br><strong>1. Gateway-Level JWT Validation</strong> — In the March 16 migration session, you moved JWT authentication middleware from individual services to the gateway. All downstream services now receive pre-validated claims via the <code>X-User-Claims</code> header, eliminating redundant auth checks.<br><br><strong>2. PKCE Flow for Mobile</strong> — The Sentinel Auth sessions document your OAuth2 PKCE implementation using <code>crypto.randomBytes(32)</code> for code_verifier generation with S256 challenge.<br><br><strong>3. Token Refresh Strategy</strong> — Refresh tokens use rotation with replay detection. Each refresh invalidates the previous token and issues a new pair. Suspicious reuse triggers a full session revocation.<br><br><strong>4. Rate Limiting</strong> — Auth endpoints are rate-limited at 10 req/min per IP with a sliding window stored in Redis.
            <div class="msg-sources">
                <div class="msg-source">📎 <span class="source-path">knowledge/backend_architecture/sentinel_auth_oauth2.md</span> (0.94)</div>
                <div class="msg-source">📎 <span class="source-path">brain/a2b3c4d5/implementation_plan.md</span> (0.89)</div>
                <div class="msg-source">📎 <span class="source-path">captures/antigravity/2026-03-15_WebSocket-Auth.md</span> (0.82)</div>
            </div>
        </div></div>
        <div class="chat-msg user"><div class="msg-bubble">What's the current Redis caching architecture?</div></div>
        <div class="chat-msg assistant"><div class="msg-bubble">Your Redis architecture uses <strong>Sentinel</strong> with read replicas for high availability, decided during your March 17 Gemini session:<br><br>• <strong>Session store</strong>: 30-minute sliding TTL with 24-hour hard cap<br>• <strong>Adapter</strong>: Socket.io Redis adapter for WebSocket horizontal scaling<br>• <strong>Expected impact</strong>: ~60% reduction in DB read load for auth-heavy endpoints<br><br>You chose Sentinel over Cluster because your workload is read-heavy and doesn't need hash-slot partitioning.
            <div class="msg-sources">
                <div class="msg-source">📎 <span class="source-path">captures/gemini/2026-03-17_Redis-Caching-Strategy.md</span> (0.91)</div>
            </div>
        </div></div>
    </div>
    <div class="chat-input-bar">
        <textarea class="chat-input" placeholder="Ask your vault..." rows="1"></textarea>
        <button class="btn-gold chat-send">↑</button>
    </div>
</div>`;

// ══════════════════════════════════════════════════════
// PANEL 7: SETTINGS
// ══════════════════════════════════════════════════════
const settingsHTML = `
<div class="panel-inner">
    <h2 class="panel-title">Settings</h2>
    <div class="settings-grid">
        <div class="settings-group"><h3>Profile</h3>
            <div class="setting-row"><label>Display Name</label><span class="setting-val">Developer</span></div>
        </div>
        <div class="settings-group"><h3>Capture</h3>
            <div class="setting-row"><label>Clipboard Monitor</label><label class="toggle"><input type="checkbox" checked><span class="toggle-slider"></span></label></div>
            <div class="setting-row"><label>Watch Directory</label><span class="setting-val">~/.gemini/antigravity</span></div>
            <div class="setting-row"><label>Capture Token</label><span class="setting-val setting-token" title="Click to copy">e4a1••••••••7f2c</span></div>
        </div>
        <div class="settings-group"><h3>AI Engine</h3>
            <div class="setting-row"><label>Model</label><span class="setting-val">qwen2.5:7b</span></div>
            <div class="setting-row"><label>Embeddings</label><span class="setting-val">nomic-embed-text</span></div>
        </div>
        <div class="settings-group"><h3>System</h3>
            <div class="setting-row"><label>Platform</label><span class="setting-val">win32</span></div>
            <div class="setting-row"><label>Version</label><span class="setting-val">3.0.0</span></div>
            <div class="setting-row"><label>Engine</label><span class="setting-val">SQLite CAS + Audit Chain</span></div>
            <div class="setting-row"><label>Documents</label><span class="setting-val">612 indexed</span></div>
            <div class="setting-row"><label>RAG Chunks</label><span class="setting-val">2,847 vectors (semantic)</span></div>
        </div>
        <div class="settings-group"><h3>Keyboard Shortcuts</h3>
            <div class="setting-row"><label>Search</label><span class="setting-val">Ctrl+K</span></div>
            <div class="setting-row"><label>Journal</label><span class="setting-val">Ctrl+J</span></div>
            <div class="setting-row"><label>Threads</label><span class="setting-val">Ctrl+T</span></div>
            <div class="setting-row"><label>Chat</label><span class="setting-val">Ctrl+Shift+K</span></div>
            <div class="setting-row"><label>Follow-ups</label><span class="setting-val">Ctrl+U</span></div>
            <div class="setting-row"><label>Export Today</label><span class="setting-val">Ctrl+E</span></div>
        </div>
    </div>
</div>`;

// ── Inject Panel Content ──
document.getElementById('panel-journal').innerHTML = journalHTML;
document.getElementById('panel-search').innerHTML = searchHTML;
document.getElementById('panel-threads').innerHTML = threadsHTML;
document.getElementById('panel-tasks').innerHTML = tasksHTML;
document.getElementById('panel-intelligence').innerHTML = intelHTML;
document.getElementById('panel-ask').innerHTML = askHTML;
document.getElementById('panel-settings').innerHTML = settingsHTML;

// ── Momentum Heatmap ──
const grid = document.getElementById('momentum-grid');
const levels = ['', 'l1', 'l2', 'l3', 'l4'];
const pattern = [0,0,1,2,1,0,0, 0,1,2,3,2,1,0, 1,2,3,4,3,2,1, 0,1,3,4,4,3,2, 1,2,2,3,4,3,1, 0,1,2,3,3,2,0, 0,0,1,2,4,3,2, 1,2,3,4,4,3,2, 0,1,2,3,3,4,3, 0,0,1,4,3,4,4, 0,0,1,2,3,4,0, 0,0,0,1,3,4,4];
pattern.forEach(l => { const c = document.createElement('div'); c.className = 'momentum-cell ' + (levels[l] || ''); grid.appendChild(c); });

// ── Session Card Expand ──
document.querySelectorAll('[data-expand]').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('expanded'));
});

// ── Artifact Click ──
document.querySelectorAll('[data-artifact]').forEach(chip => {
    chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = chip.dataset.artifact;
        const artifacts = {
            plan: `# Stripe Webhook Handler Refactor\n\n## Goal\nRefactor webhook handler for idempotency and retry safety.\n\n## Proposed Changes\n\n### Webhook Controller\n- Add stripe.webhooks.constructEvent() signature verification\n- Implement idempotency key dedup via Redis SET NX\n- Create dead-letter queue for failed events\n\n### Event Processors\n- payment_intent.succeeded → order fulfillment\n- charge.refunded → refund reconciliation\n- invoice.payment_failed → dunning flow\n\n## Verification\n- Integration tests for all 12 event types\n- Load test: 500 webhooks/sec sustained\n- Verify exactly-once processing guarantee`,
            task: `# Stripe Webhook Refactor\n\n- [x] Add Stripe signature verification\n- [/] Dead-letter queue for failed events\n- [ ] Integration tests for charge.refunded\n- [ ] Idempotency key dedup in payment_intent`,
            walk: `# Walkthrough: Stripe Webhook Refactor\n\n## Changes Made\n- Replaced raw JSON parsing with constructEvent()\n- Added Redis-backed idempotency using SET NX EX 86400\n- Created DLQ table with retry_count and last_error\n\n## Tested\n- 12 event types × 3 scenarios each = 36 test cases\n- All passing in CI (6.2s total)\n\n## Metrics\n- Webhook processing: p50=12ms, p99=48ms\n- Zero duplicate processing in 10K event load test`
        };
        showArtifact(chip.textContent.trim().replace(/^.{2}/, ''), artifacts[type] || artifacts.plan);
    });
});

// ── KI Health Toggle ──
document.getElementById('health-toggle')?.addEventListener('click', () => {
    const p = document.getElementById('ki-health-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
});

// ── Follow-Ups ──
document.getElementById('followup-list').innerHTML = `
    <div class="followup-item"><div class="followup-icon">🔍</div><div class="followup-content"><div class="followup-title">Task may need follow-up</div><div class="followup-detail">"GraphQL Federation" has 3 open items idle for 2 days.</div></div><span class="followup-priority HIGH">HIGH</span></div>
    <div class="followup-item"><div class="followup-icon">📎</div><div class="followup-content"><div class="followup-title">6 captures need organizing</div><div class="followup-detail">"PostgreSQL Lateral Joins", "Redis Adapter Scaling", "Docker Multi-Stage" + 3 more</div></div><span class="followup-priority MEDIUM">MEDIUM</span></div>
    <div class="followup-item"><div class="followup-icon">📚</div><div class="followup-content"><div class="followup-title">KI may need enrichment</div><div class="followup-detail">"Backend Architecture Patterns" has 4 new related sessions since last update.</div></div><span class="followup-priority MEDIUM">MEDIUM</span></div>
`;

// ── Sweep & Organize Buttons ──
document.getElementById('sweep-btn')?.addEventListener('click', () => {
    showToast('⚡ Intelligence Sweep complete — 3 captures summarized, 2 KIs enriched, 4 actions extracted');
});
document.getElementById('auto-organize-btn')?.addEventListener('click', () => {
    showToast('⚡ Auto-organized 6 captures → linked to 3 Knowledge Items');
});

})();
