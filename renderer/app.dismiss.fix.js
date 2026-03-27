
// ═══════════════════════════════════════════════════════════════
// VERITAS VAULT v3.1c — Dismiss Persistence Fix
// Filters already-dismissed follow-ups from re-appearing on re-open.
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initDismissFix, 300);
});

function initDismissFix() {
    // Intercept dismiss events via event delegation on the panel
    const panel = document.getElementById('followup-panel');
    if (!panel) return;

    // When a dismiss-followup action fires, persist to localStorage
    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="dismiss-followup"]');
        if (!btn) return;
        const fId = btn.dataset.followupId;
        if (!fId) return;
        try {
            const d = JSON.parse(localStorage.getItem('vv_dismissed_fu') || '[]');
            if (!d.includes(fId)) {
                d.push(fId);
                localStorage.setItem('vv_dismissed_fu', JSON.stringify(d));
            }
        } catch (e) {}
    }, true); // capture phase so it fires before the main handler removes the card

    // Filter dismissed items on every panel open
    const observer = new MutationObserver(() => {
        filterDismissedFollowUps();
    });
    observer.observe(panel, { childList: true, subtree: true });

    // Initial filter pass
    filterDismissedFollowUps();
}

function filterDismissedFollowUps() {
    try {
        const dismissed = JSON.parse(localStorage.getItem('vv_dismissed_fu') || '[]');
        if (dismissed.length === 0) return;
        document.querySelectorAll('.followup-card').forEach(card => {
            const btn = card.querySelector('[data-action="dismiss-followup"]');
            const fId = btn?.dataset?.followupId;
            if (fId && dismissed.includes(fId)) {
                card.style.display = 'none';
            }
        });
    } catch (e) {}
}

// END dismiss persistence fix
