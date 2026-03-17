/**
 * VERITAS VAULT — Smart Follow-Up Engine  
 * ════════════════════════════════════════════════════════════════
 * Proactive detection of stale work, abandoned tasks, unlinked
 * captures, and work continuity gaps. Surfaces actionable reminders.
 */

const crypto = require('crypto');

// ── Detection thresholds ─────────────────────────────────────
const STALE_AUDIT_DAYS = 3;
const ABANDONED_TASK_DAYS = 5;
const UNLINKED_CAPTURE_DAYS = 2;
const UNLINKED_MIN_QUALITY = 4;
const CONTINUITY_HOURS = 18;

// ── State ────────────────────────────────────────────────────
let _dismissed = new Set();  // Set of follow-up IDs dismissed by user
let _dbRef = null;
let _journalRef = null;

function init(dbModule, journalModule) {
    _dbRef = dbModule;
    _journalRef = journalModule;
    // Ensure table exists BEFORE any query
    _dbRef.dbRun(`CREATE TABLE IF NOT EXISTS dismissed_followups (
        followup_id TEXT PRIMARY KEY,
        dismissed_at REAL NOT NULL
    )`);
    // Now safe to load dismissed IDs
    try {
        const dismissed = _dbRef.dbAll(`SELECT followup_id FROM dismissed_followups`);
        for (const d of dismissed) _dismissed.add(d.followup_id);
    } catch { /* empty table is fine */ }
}

function makeId(type, key) {
    return crypto.createHash('sha256').update(`${type}:${key}`).digest('hex').substring(0, 12);
}

// ── Detectors ────────────────────────────────────────────────

function detectStaleAuditWork(sessions) {
    const now = Date.now();
    const auditKeywords = ['audit', 'vulnerability', 'security', 'exploit', 'bounty',
        'immunefi', 'hackerone', 'attack', 'reentrancy', 'overflow', 'slippage',
        'manipulation', 'poc', 'proof of concept'];
    const submissionKeywords = ['submit', 'submission', 'report', 'filed', 'hackerone', 'immunefi'];

    const followUps = [];

    for (const session of sessions) {
        const text = [session.heading || '', session.summary || ''].join(' ').toLowerCase();
        const isAudit = auditKeywords.some(k => text.includes(k));
        if (!isAudit) continue;

        const hasSubmission = submissionKeywords.some(k => text.includes(k));
        if (hasSubmission) continue;

        const sessionDate = new Date(session.updatedAt || session.date);
        const ageDays = (now - sessionDate.getTime()) / 86400000;
        if (ageDays < STALE_AUDIT_DAYS || ageDays > 30) continue;

        const id = makeId('stale_audit', session.conversationId || session.heading);
        if (_dismissed.has(id)) continue;

        followUps.push({
            id,
            type: 'stale_audit',
            priority: ageDays > 7 ? 'HIGH' : 'MEDIUM',
            icon: '🔍',
            title: `Audit work may need follow-up`,
            detail: `"${session.heading}" was ${Math.round(ageDays)} days ago with no submission detected.`,
            actionLabel: 'View Session',
            actionData: { action: 'navigate', convId: session.conversationId },
            createdAt: now,
        });
    }

    return followUps;
}

function detectAbandonedTasks(tasks) {
    const now = Date.now();
    const followUps = [];

    for (const task of tasks) {
        const openCount = (task.open?.length || 0) + (task.inProgress?.length || 0);
        if (openCount === 0) continue;

        const id = makeId('abandoned_task', task.conversationId || task.heading);
        if (_dismissed.has(id)) continue;

        // Parse updatedAt ISO string to ms — this is the actual field from getOpenTasks()
        const lastActivity = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
        if (lastActivity === 0) continue; // Skip if no valid date
        const idleDays = (now - lastActivity) / 86400000;
        if (idleDays < ABANDONED_TASK_DAYS) continue;

        followUps.push({
            id,
            type: 'abandoned_task',
            priority: idleDays > 10 ? 'HIGH' : 'MEDIUM',
            icon: '⏸️',
            title: `Task idle for ${Math.round(idleDays)} days`,
            detail: `"${task.heading}" has ${openCount} open item${openCount !== 1 ? 's' : ''} with no recent progress.`,
            actionLabel: 'View Tasks',
            actionData: { action: 'navigate', panel: 'tasks' },
            createdAt: now,
        });
    }

    return followUps;
}

function detectUnlinkedCaptures(sessions) {
    const now = Date.now();
    const followUps = [];

    // Find unlinked sessions (no KI topic)
    const unlinked = sessions.filter(s => {
        if (s.kiTopic || s.topic) return false;
        const quality = s.quality || 3;
        if (quality < UNLINKED_MIN_QUALITY) return false;
        const age = (now - new Date(s.updatedAt || s.date).getTime()) / 86400000;
        return age > UNLINKED_CAPTURE_DAYS && age < 30;
    });

    if (unlinked.length === 0) return [];

    const id = makeId('unlinked', `${unlinked.length}_${new Date().toDateString()}`);
    if (_dismissed.has(id)) return [];

    followUps.push({
        id,
        type: 'unlinked_captures',
        priority: unlinked.length >= 5 ? 'HIGH' : 'MEDIUM',
        icon: '📎',
        title: `${unlinked.length} high-value capture${unlinked.length !== 1 ? 's' : ''} need organizing`,
        detail: unlinked.slice(0, 3).map(s => `"${s.heading || 'Untitled'}"`).join(', ') +
            (unlinked.length > 3 ? ` + ${unlinked.length - 3} more` : ''),
        actionLabel: 'Auto-Organize',
        actionData: { action: 'auto-organize' },
        createdAt: now,
    });

    return followUps;
}

function detectStaleKIs(kiList, sessions) {
    const now = Date.now();
    const followUps = [];

    for (const ki of kiList) {
        const kiWords = [ki.title, ki.summary || ''].join(' ').toLowerCase()
            .split(/\s+/).filter(w => w.length > 4);

        let recentRelated = 0;
        for (const s of sessions) {
            const sText = [s.heading || '', s.summary || ''].join(' ').toLowerCase();
            const hits = kiWords.filter(w => sText.includes(w));
            if (hits.length >= 2) {
                const age = (now - new Date(s.updatedAt || s.date).getTime()) / 86400000;
                if (age < 14) recentRelated++;
            }
        }

        if (recentRelated < 2) continue;

        const id = makeId('stale_ki', ki.topic);
        if (_dismissed.has(id)) continue;

        followUps.push({
            id,
            type: 'stale_ki',
            priority: recentRelated >= 4 ? 'HIGH' : 'MEDIUM',
            icon: '📚',
            title: `KI "${ki.title}" may need enrichment`,
            detail: `${recentRelated} new related sessions found since last update.`,
            actionLabel: 'Enrich',
            actionData: { action: 'enrich-ki', kiTopic: ki.topic },
            createdAt: now,
        });
    }

    return followUps;
}

function detectContinuityGap(sessions) {
    const now = Date.now();
    const followUps = [];

    // Find substantive sessions from yesterday
    const yesterday = sessions.filter(s => {
        const age = (now - new Date(s.updatedAt || s.date).getTime()) / 3600000;
        return age > CONTINUITY_HOURS && age < 48 && (s.quality || 3) >= 4;
    });

    // Check if there's any substantial work today
    const today = sessions.filter(s => {
        const age = (now - new Date(s.updatedAt || s.date).getTime()) / 3600000;
        return age < CONTINUITY_HOURS;
    });

    if (yesterday.length > 0 && today.length === 0) {
        const topSession = yesterday.sort((a, b) => (b.quality || 3) - (a.quality || 3))[0];
        const id = makeId('continuity', topSession.conversationId || topSession.heading);
        if (!_dismissed.has(id)) {
            followUps.push({
                id,
                type: 'continuity',
                priority: 'LOW',
                icon: '🔄',
                title: 'Continue where you left off?',
                detail: `Last substantial session: "${topSession.heading}"`,
                actionLabel: 'View',
                actionData: { action: 'navigate', convId: topSession.conversationId },
                createdAt: now,
            });
        }
    }

    return followUps;
}

// ── Main Scanner ─────────────────────────────────────────────

async function generateFollowUps() {
    if (!_journalRef) return [];

    try {
        // Gather data — journal methods are synchronous
        const sessions = [];
        
        // getActivityDates returns { dateStr: count }, NOT an array
        const activityDatesMap = _journalRef.getActivityDates();
        const activityDates = Object.keys(activityDatesMap || {}).sort().reverse();
        
        for (const dateStr of activityDates.slice(0, 14)) {
            try {
                const digest = _journalRef.buildDailyDigest(dateStr);
                if (digest && digest.sessions) {
                    for (const s of digest.sessions) {
                        // Map digest session shape → detector shape
                        // digest gives: { conversationId, title, artifacts[], artifactCount, pinned, source }
                        // detectors expect: heading, summary, updatedAt, quality
                        const firstArtifact = (s.artifacts && s.artifacts[0]) || {};
                        sessions.push({
                            conversationId: s.conversationId,
                            heading: s.title || firstArtifact.heading || 'Untitled',
                            summary: firstArtifact.summary || s.title || '',
                            updatedAt: `${dateStr}T12:00:00.000Z`,
                            quality: s.artifactCount >= 3 ? 5 : (s.artifactCount >= 1 ? 3 : 1),
                            source: s.source,
                            topic: null,  // Digest sessions don't carry KI topic
                            kiTopic: null,
                            date: dateStr,
                        });
                    }
                }
            } catch { /* skip bad days */ }
        }

        // getOpenTasks and getKIList are synchronous
        let tasks = [];
        try { tasks = _journalRef.getOpenTasks() || []; } catch { /* silent */ }

        let kiList = [];
        try { kiList = _journalRef.getKIList() || []; } catch { /* silent */ }

        // Run all detectors
        const followUps = [
            ...detectStaleAuditWork(sessions),
            ...detectAbandonedTasks(tasks),
            ...detectUnlinkedCaptures(sessions),
            ...detectStaleKIs(kiList, sessions),
            ...detectContinuityGap(sessions),
        ];

        // Sort by priority
        const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        followUps.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

        return followUps.slice(0, 10);
    } catch (e) {
        console.error('[FollowUp] Error:', e.message);
        return [];
    }
}

function dismissFollowUp(followUpId) {
    _dismissed.add(followUpId);
    if (_dbRef) {
        _dbRef.dbRun(`INSERT OR REPLACE INTO dismissed_followups (followup_id, dismissed_at) VALUES (?, ?)`,
            [followUpId, Date.now() / 1000]);
        _dbRef.scheduleSave();
    }
}

module.exports = {
    init,
    generateFollowUps,
    dismissFollowUp,
};
