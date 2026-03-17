/**
 * VERITAS VAULT — Background Service Worker (Two-Hop Relay v3)
 * ════════════════════════════════════════════════════════════════
 * Receives captured session data from content.js via chrome.runtime.sendMessage
 * and relays it to the local VeritasVault capture server.
 * 
 * v3: On-demand token reads (no in-memory cache) to survive MV3 service
 *     worker sleep/wake cycles. IndexedDB offline queue. Sent-today counter.
 */

const CAPTURE_URL = 'http://localhost:47831/capture';
const HEALTH_URL = 'http://localhost:47831/health';
const TOKEN_URL = 'http://localhost:47831/token';
const RETRY_INTERVAL = 30000; // 30s retry timer
const MAX_QUEUE_SIZE = 200;

// ── Auto-sync token from Vault on startup ────────────────────
async function autoSyncToken() {
    try {
        const resp = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.token) return;

        const stored = await chrome.storage.local.get(['vaultToken']);
        if (stored.vaultToken !== data.token) {
            await chrome.storage.local.set({ vaultToken: data.token });
            console.log('[VaultRelay] Auto-synced token from Vault');
            updateBadge();
            drainQueue();
        }
    } catch {
        // Vault not running — will retry on next wake
    }
}

// Run auto-sync on service worker start (delayed to let Vault boot)
setTimeout(autoSyncToken, 5000);

// ── Token (on-demand from storage — survives SW sleep) ───────
async function getToken() {
    const data = await chrome.storage.local.get(['vaultToken', 'captureToken']);
    return data.vaultToken || data.captureToken || null;
}

// ── Sent-Today Counter ───────────────────────────────────────
async function incrementSentToday() {
    const today = new Date().toISOString().split('T')[0];
    const data = await chrome.storage.local.get(['vaultSentToday', 'vaultSentDate']);
    const count = (data.vaultSentDate === today) ? (data.vaultSentToday || 0) : 0;
    await chrome.storage.local.set({ vaultSentToday: count + 1, vaultSentDate: today });
}

// ── IndexedDB Queue ──────────────────────────────────────────
function openQueue() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('VaultCaptureQueue', 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('queue')) {
                db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function enqueue(payload) {
    try {
        const db = await openQueue();
        const tx = db.transaction('queue', 'readwrite');
        const store = tx.objectStore('queue');
        // Cap queue size
        const count = await new Promise(resolve => {
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
        });
        if (count >= MAX_QUEUE_SIZE) {
            console.log('[VaultRelay] Queue full, dropping oldest');
            // Delete oldest
            const cursor = store.openCursor();
            cursor.onsuccess = () => { if (cursor.result) cursor.result.delete(); };
        }
        store.add({ payload, timestamp: Date.now() });
        await new Promise(resolve => { tx.oncomplete = resolve; });
        db.close();
    } catch (e) {
        console.error('[VaultRelay] Enqueue error:', e);
    }
}

async function drainQueue() {
    const token = await getToken();
    if (!token) return;
    try {
        const db = await openQueue();
        const tx = db.transaction('queue', 'readwrite');
        const store = tx.objectStore('queue');
        const all = await new Promise(resolve => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
        });
        for (const item of all) {
            try {
                const resp = await fetch(CAPTURE_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify(item.payload),
                });
                if (resp.ok) {
                    store.delete(item.id);
                    await incrementSentToday();
                    console.log(`[VaultRelay] Drained queued capture from ${item.payload.source}`);
                }
            } catch {
                // Vault still offline, stop draining
                break;
            }
        }
        await new Promise(resolve => { tx.oncomplete = resolve; });
        db.close();
    } catch (e) {
        console.error('[VaultRelay] Drain error:', e);
    }
}

// ── Badge Management ─────────────────────────────────────────
async function updateBadge() {
    const token = await getToken();
    if (token) {
        chrome.action.setBadgeText({ text: '' });
        chrome.action.setTitle({ title: 'Veritas Vault — Session Capture' });
    } else {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#F87171' });
        chrome.action.setTitle({ title: 'Veritas Vault — No token set! Click to configure.' });
    }
}

// Set badge on startup
updateBadge();

// Listen for token updates from popup
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.vaultToken || changes.captureToken)) {
        const newToken = changes.vaultToken?.newValue || changes.captureToken?.newValue;
        if (newToken) {
            console.log('[VaultRelay] Token updated');
            updateBadge();
            drainQueue();
        } else {
            updateBadge();
        }
    }
});

// ── Message Handler ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SET_TOKEN') {
        chrome.storage.local.set({ vaultToken: message.token });
        updateBadge();
        drainQueue();
        sendResponse({ ok: true });
        return;
    }

    if (message.type === 'RELOAD_CONFIG') {
        console.log('[VaultRelay] Config reloaded');
        updateBadge();
        drainQueue();
        sendResponse({ ok: true });
        return;
    }

    if (message.action !== 'VAULT_CAPTURE') return;

    const payload = message.payload;
    if (!payload || !payload.turns || payload.turns.length === 0) {
        sendResponse({ ok: false, reason: 'empty' });
        return;
    }

    // Async handler — read token on-demand, then send or queue
    (async () => {
        const token = await getToken();

        if (!token) {
            // No token — queue for later
            await enqueue(payload);
            console.log(`[VaultRelay] No token — queued ${payload.turns.length} turns (${payload.source})`);
            sendResponse({ ok: true, queued: true });
            return;
        }

        try {
            const resp = await fetch(CAPTURE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify(payload),
            });

            if (resp.status === 401) {
                console.warn('[VaultRelay] Token rejected (401) — queuing');
                await enqueue(payload);
                sendResponse({ ok: false, reason: 'unauthorized' });
                return;
            }

            const data = await resp.json();
            await incrementSentToday();
            console.log(`[VaultRelay] ${payload.source}: ${payload.turns.length} turns → ${data.action || 'ok'}`);
            sendResponse({ ok: true, ...data });
        } catch (err) {
            // Vault offline — queue for later
            console.log('[VaultRelay] Vault offline, queuing:', err.message);
            await enqueue(payload);
            sendResponse({ ok: true, queued: true });
        }
    })();

    return true; // keep sendResponse channel open for async
});

// ── Periodic Drain ───────────────────────────────────────────
setInterval(drainQueue, RETRY_INTERVAL);

console.log('[VaultRelay] Veritas Vault background relay v3 active (on-demand auth + offline queue)');
