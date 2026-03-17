/**
 * VERITAS VAULT — Extension Popup Controller
 * ════════════════════════════════════════════════════════════════
 * Token setup, connection health check, queue stats.
 */

const HEALTH_SUFFIX = '/health';

document.addEventListener('DOMContentLoaded', async () => {
    const tokenInput = document.getElementById('token-input');
    const serverInput = document.getElementById('server-input');
    const saveBtn = document.getElementById('save-btn');
    const clearBtn = document.getElementById('clear-btn');
    const fetchBtn = document.getElementById('fetch-btn');
    const statusEl = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const statQueued = document.getElementById('stat-queued');
    const statSent = document.getElementById('stat-sent');

    // ── Load saved config ────────────────────────────────────
    try {
        const data = await chrome.storage.local.get(['vaultToken', 'vaultServer', 'vaultSentToday', 'vaultSentDate']);
        if (data.vaultToken) tokenInput.value = data.vaultToken;
        if (data.vaultServer) serverInput.value = data.vaultServer;

        // Today's send count
        const today = new Date().toISOString().split('T')[0];
        if (data.vaultSentDate === today) {
            statSent.textContent = data.vaultSentToday || 0;
        }

        // Auto-fetch if no token set
        if (!data.vaultToken) {
            await fetchTokenFromVault();
        }
    } catch (e) {
        console.warn('[Popup] Load config:', e.message);
    }

    // ── Fetch Token from Vault ───────────────────────────────
    async function fetchTokenFromVault() {
        const server = serverInput.value.trim() || 'http://localhost:47831';
        fetchBtn.textContent = '…';
        try {
            const resp = await fetch(server + '/token', {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.token) {
                    tokenInput.value = data.token;
                    await chrome.storage.local.set({ vaultToken: data.token });
                    try { await chrome.runtime.sendMessage({ type: 'RELOAD_CONFIG' }); } catch {}
                    setStatus('connected', 'Token synced from Vault');
                    fetchBtn.textContent = '✓';
                    setTimeout(() => { fetchBtn.textContent = '⟳ Fetch'; }, 2000);
                    return true;
                }
            }
            setStatus('disconnected', 'Could not fetch token');
        } catch {
            setStatus('disconnected', 'Vault not running');
        }
        fetchBtn.textContent = '⟳ Fetch';
        return false;
    }

    fetchBtn.addEventListener('click', fetchTokenFromVault);

    // ── Queue count ──────────────────────────────────────────
    try {
        const db = await openQueue();
        const tx = db.transaction('queue', 'readonly');
        const store = tx.objectStore('queue');
        const countReq = store.count();
        countReq.onsuccess = () => { statQueued.textContent = countReq.result; };
        db.close();
    } catch (e) {
        statQueued.textContent = '?';
    }

    // ── Health check ─────────────────────────────────────────
    await checkHealth(serverInput.value);

    // ── Save & Test ──────────────────────────────────────────
    saveBtn.addEventListener('click', async () => {
        const token = tokenInput.value.trim();
        const server = serverInput.value.trim();

        if (!token) {
            setStatus('disconnected', 'Token is required');
            return;
        }

        setStatus('checking', 'Saving & testing…');

        await chrome.storage.local.set({
            vaultToken: token,
            vaultServer: server || 'http://localhost:47831'
        });

        // Notify background service worker to reload token
        try {
            await chrome.runtime.sendMessage({ type: 'RELOAD_CONFIG' });
        } catch (e) {
            console.warn('[Popup] Background notify:', e.message);
        }

        await checkHealth(server || 'http://localhost:47831');
    });

    // ── Clear Queue ──────────────────────────────────────────
    clearBtn.addEventListener('click', async () => {
        try {
            const db = await openQueue();
            const tx = db.transaction('queue', 'readwrite');
            tx.objectStore('queue').clear();
            await new Promise(resolve => { tx.oncomplete = resolve; });
            db.close();
            statQueued.textContent = '0';
        } catch (e) {
            console.warn('[Popup] Clear queue:', e.message);
        }
    });

    // ── Helpers ──────────────────────────────────────────────
    async function checkHealth(server) {
        try {
            const resp = await fetch(server + HEALTH_SUFFIX, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                const version = data.version || '?';
                setStatus('connected', `Connected — Vault v${version}`);
            } else {
                setStatus('disconnected', `Server responded ${resp.status}`);
            }
        } catch (e) {
            if (e.name === 'TimeoutError' || e.name === 'AbortError') {
                setStatus('disconnected', 'Connection timed out');
            } else {
                setStatus('disconnected', 'Vault not running');
            }
        }
    }

    function setStatus(state, text) {
        statusEl.className = 'status-bar ' + state;
        statusText.textContent = text;
    }
});

// ── IndexedDB Queue (same as background.js) ──────────────────
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
