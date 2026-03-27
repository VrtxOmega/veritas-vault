
// ═══════════════════════════════════════════════════════════════
// VERITAS VAULT — DASHBOARD STRIP
// Wraps #morning-brief + #momentum-section in a dashboard-strip
// flex row. Everything below becomes a scrollable sessions area.
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(setupDashboardStrip, 500);
});

function setupDashboardStrip() {
    const journalScroll = document.querySelector('.journal-scroll');
    if (!journalScroll) return;
    if (journalScroll.querySelector('.dashboard-strip')) return; // guard

    const brief = document.getElementById('morning-brief');
    const heatmap = document.getElementById('momentum-section');
    if (!brief || !heatmap) return;

    // Create the strip wrapper
    const strip = document.createElement('div');
    strip.className = 'dashboard-strip';

    // Insert strip before morning-brief (which comes first)
    journalScroll.insertBefore(strip, brief);
    strip.appendChild(brief);
    strip.appendChild(heatmap);

    // Wrap everything after the strip in a sessions scroll div
    const remaining = [...journalScroll.childNodes].filter(n => n !== strip);
    if (remaining.length > 0) {
        const sessionsWrap = document.createElement('div');
        sessionsWrap.className = 'journal-sessions-scroll';

        // Add a divider
        const divider = document.createElement('div');
        divider.className = 'sessions-divider';
        divider.textContent = 'Sessions';
        sessionsWrap.appendChild(divider);

        remaining.forEach(n => sessionsWrap.appendChild(n));
        journalScroll.appendChild(sessionsWrap);
    }

    // Re-wire setupFilterBar to insert inside sessionsWrap
    // (filter bar normally inserts after morning-brief, re-attach it)
    const existingFilterBar = document.getElementById('timeline-filter-bar');
    const sessionsWrap2 = journalScroll.querySelector('.journal-sessions-scroll');
    if (existingFilterBar && sessionsWrap2) {
        sessionsWrap2.insertBefore(existingFilterBar, sessionsWrap2.firstChild.nextSibling);
    }
}

// END Dashboard Strip
