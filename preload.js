/**
 * VERITAS VAULT — Preload (Secure IPC Bridge)
 * ════════════════════════════════════════════════════════════════
 * High-assurance contextBridge. No node access in renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {

    // ── Window Controls ──────────────────────────────────────────
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

    // ── Journal Engine ───────────────────────────────────────────
    getDailyDigest: (dateStr) => ipcRenderer.invoke('vault:daily-digest', dateStr),
    getMorningBrief: () => ipcRenderer.invoke('vault:morning-brief'),
    getActivityDates: () => ipcRenderer.invoke('vault:activity-dates'),
    getMomentum: (days) => ipcRenderer.invoke('vault:momentum', days),
    getOpenTasks: () => ipcRenderer.invoke('vault:open-tasks'),
    getProjectThreads: () => ipcRenderer.invoke('vault:project-threads'),
    getSessionDetail: (convId) => ipcRenderer.invoke('vault:session-detail', convId),
    readArtifact: (convId, file) => ipcRenderer.invoke('vault:read-artifact', convId, file),

    // ── Pinned Sessions ──────────────────────────────────────────
    pinSession: (convId, note) => ipcRenderer.invoke('vault:pin-session', convId, note),
    unpinSession: (convId) => ipcRenderer.invoke('vault:unpin-session', convId),
    getPinnedSessions: () => ipcRenderer.invoke('vault:pinned-sessions'),

    // ── Quick Notes ──────────────────────────────────────────────
    addQuickNote: (dateStr, content) => ipcRenderer.invoke('vault:add-quick-note', dateStr, content),
    deleteQuickNote: (noteId) => ipcRenderer.invoke('vault:delete-quick-note', noteId),

    // ── Task Finalization ────────────────────────────────────────
    finalizeTask: (convId) => ipcRenderer.invoke('vault:finalize-task', convId),
    archiveTask: (convId) => ipcRenderer.invoke('vault:archive-task', convId),

    // ── Thread Detail ────────────────────────────────────────────
    getThreadDetail: (topic) => ipcRenderer.invoke('vault:thread-detail', topic),
    readKnowledgeArtifact: (topic, file) => ipcRenderer.invoke('vault:read-ki-artifact', topic, file),

    // ── KI Management ────────────────────────────────────────────
    getKIList: () => ipcRenderer.invoke('vault:ki-list'),
    linkCaptureToKI: (captureId, kiTopic) => ipcRenderer.invoke('vault:link-capture-ki', captureId, kiTopic),
    createKIFromCaptures: (title, captureIds) => ipcRenderer.invoke('vault:create-ki', title, captureIds),
    suggestKIForCapture: (captureId) => ipcRenderer.invoke('vault:suggest-ki', captureId),
    autoOrganize: () => ipcRenderer.invoke('vault:auto-organize'),

    // ── AI Intelligence ──────────────────────────────────────────
    getIntelligenceDashboard: () => ipcRenderer.invoke('vault:intelligence-dashboard'),
    getAIStatus: () => ipcRenderer.invoke('vault:ai-status'),

    // ── Intelligence v2 ─────────────────────────────────────────
    enrichKI: (kiTopic) => ipcRenderer.invoke('vault:enrich-ki', kiTopic),
    extractActions: (captureId) => ipcRenderer.invoke('vault:extract-actions', captureId),
    getWeeklyReport: () => ipcRenderer.invoke('vault:weekly-report'),
    recordAIFeedback: (captureId, kiTopic, action) => ipcRenderer.invoke('vault:ai-feedback', captureId, kiTopic, action),
    getSessionClusters: () => ipcRenderer.invoke('vault:session-clusters'),
    getCapturePriorities: () => ipcRenderer.invoke('vault:capture-priorities'),

    // ── Intelligence v3 ─────────────────────────────────────────
    runIntelligenceSweep: () => ipcRenderer.invoke('vault:intelligence-sweep'),
    getActionItems: (status) => ipcRenderer.invoke('vault:action-items', status),
    completeActionItem: (id) => ipcRenderer.invoke('vault:complete-action', id),

    // ── v4 — Continuity, Health, Export ──────────────────────────
    getSessionContinuity: (convId) => ipcRenderer.invoke('vault:session-continuity', convId),
    getKIHealth: () => ipcRenderer.invoke('vault:ki-health'),
    exportKI: (kiTopic) => ipcRenderer.invoke('vault:export-ki', kiTopic),
    exportDailyDigest: (dateStr) => ipcRenderer.invoke('vault:export-daily', dateStr),
    onSweepComplete: (callback) => ipcRenderer.on('vault:sweep-complete', (_, results) => callback(results)),

    // ── Search ───────────────────────────────────────────────────
    search: (query) => ipcRenderer.invoke('vault:search', query),
    getStats: () => ipcRenderer.invoke('vault:stats'),
    readFile: (relPath) => ipcRenderer.invoke('vault:read-file', relPath),

    // ── RAG Chat ─────────────────────────────────────────────────
    chat: (query) => ipcRenderer.invoke('vault:chat', query),
    getChatHistory: () => ipcRenderer.invoke('vault:chat-history'),
    clearChatHistory: () => ipcRenderer.invoke('vault:chat-clear'),
    getRAGStats: () => ipcRenderer.invoke('vault:rag-stats'),
    rebuildRAGIndex: () => ipcRenderer.invoke('vault:rag-rebuild'),
    onRAGProgress: (cb) => { ipcRenderer.on('vault:rag-progress', (_, d) => cb(d)); },

    // ── Follow-Ups ───────────────────────────────────────────────
    getFollowUps: () => ipcRenderer.invoke('vault:follow-ups'),
    dismissFollowUp: (id) => ipcRenderer.invoke('vault:dismiss-follow-up', id),
    getFollowUpCount: () => ipcRenderer.invoke('vault:follow-up-count'),
    onFollowUpUpdate: (cb) => { ipcRenderer.on('vault:follow-up-update', (_, d) => cb(d)); },

    // ── Settings ─────────────────────────────────────────────────
    getSettings: () => ipcRenderer.invoke('vault:get-settings'),
    setSettings: (settings) => ipcRenderer.invoke('vault:set-settings', settings),
    toggleClipboard: (enabled) => ipcRenderer.invoke('vault:toggle-clipboard', enabled),

    // ── Data Backup / Export ─────────────────────────────────────
    exportAll: () => ipcRenderer.invoke('vault:export-all'),
    restoreBackup: () => ipcRenderer.invoke('vault:restore-backup'),
    getBackupInfo: () => ipcRenderer.invoke('vault:backup-info'),

    // ── Live Events ──────────────────────────────────────────────
    onCapture: (cb) => { ipcRenderer.on('vault:capture-event', (_, d) => cb(d)); },
    onCaptureWarning: (cb) => { ipcRenderer.on('vault:capture-warning', (_, d) => cb(d)); },
    onTelemetry: (cb) => { ipcRenderer.on('vault:telemetry', (_, d) => cb(d)); },

    // ── External ─────────────────────────────────────────────────
    openExternal: (url) => ipcRenderer.send('open-external', url),
    showInFolder: (relPath) => ipcRenderer.send('vault:show-in-folder', relPath),

    // ── Platform ─────────────────────────────────────────────────
    platform: process.platform,
    version: '3.5.0',

    // ── Project Workspaces ────────────────────────────────────────
    createProject:     (name, desc, color, icon) => ipcRenderer.invoke('vault:create-project', name, desc, color, icon),
    getProjects:       ()           => ipcRenderer.invoke('vault:projects'),
    getProjectDetail:  (id)         => ipcRenderer.invoke('vault:project-detail', id),
    linkSession:       (pid, cid, src) => ipcRenderer.invoke('vault:link-session', pid, cid, src),
    unlinkSession:     (pid, cid)   => ipcRenderer.invoke('vault:unlink-session', pid, cid),
    deleteProject:     (id)         => ipcRenderer.invoke('vault:delete-project', id),
    updateProject:     (id, fields) => ipcRenderer.invoke('vault:update-project', id, fields),
    autoSuggestProject:(cid)        => ipcRenderer.invoke('vault:suggest-project', cid),

    // ── Capture Token (for extension setup) ──────────────────────
    getCaptureToken: () => ipcRenderer.invoke('vault:get-capture-token'),
});
