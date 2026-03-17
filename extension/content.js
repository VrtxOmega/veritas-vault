/**
 * VERITAS VAULT — AI Session Capture (Content Script)
 * ════════════════════════════════════════════════════════════════
 * Auto-captures conversation turns from:
 *   • gemini.google.com (website + PWA)
 *   • chatgpt.com
 * 
 * Two-Hop Architecture:
 *   content.js → chrome.runtime.sendMessage → background.js → localhost:47831
 *   This bypasses CSP/CORS restrictions in PWAs.
 */

(function () {
    'use strict';

    const FLUSH_INTERVAL = 60000; // 60s periodic flush
    const INITIAL_DELAY = 8000;   // 8s wait for dynamic content
    const EXTENSION_VERSION = '3.0.0';

    let lastFlushedHash = '';
    let flushTimer = null;

    // ── Site Detection ───────────────────────────────────────────
    const HOST = window.location.hostname;
    const IS_GEMINI = HOST.includes('gemini.google.com');
    const IS_CHATGPT = HOST.includes('chatgpt.com');
    const IS_CLAUDE = HOST.includes('claude.ai');
    const SOURCE = IS_GEMINI ? 'gemini' : IS_CHATGPT ? 'chatgpt' : IS_CLAUDE ? 'claude' : 'unknown';

    // ── Title Extraction ─────────────────────────────────────────
    function getConversationTitle() {
        const title = document.title || '';
        if (IS_GEMINI) return title.replace(/^Gemini\s*[-–—]\s*/i, '').trim() || 'Gemini Session';
        if (IS_CHATGPT) return title.replace(/^ChatGPT\s*[-–—]\s*/i, '').trim() || 'ChatGPT Session';
        if (IS_CLAUDE) return title.replace(/^Claude\s*[-–—]\s*/i, '').trim() || 'Claude Session';
        return title || 'AI Session';
    }

    // ── Image Extraction Helper ──────────────────────────────────
    function extractImagesFromElement(el) {
        const images = [];
        const imgs = el.querySelectorAll('img');
        for (const img of imgs) {
            const src = img.src || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:image/svg') || src.includes('avatar')) continue;
            // Skip tiny icons (avatars, UI chrome)
            const w = img.naturalWidth || img.width || 0;
            if (w > 0 && w < 50) continue;
            images.push(src);
        }
        return images;
    }

    // ── Gemini Turn Extraction ───────────────────────────────────
    function extractGeminiTurns() {
        const turns = [];

        // Strategy 1: user-query / model-response custom elements (2024-2026 DOM)
        const allEls = [...document.querySelectorAll('user-query, model-response')];
        if (allEls.length > 0) {
            for (const el of allEls) {
                const text = el.innerText?.trim();
                if (!text || text.length < 2) continue;
                const role = el.tagName.toLowerCase() === 'user-query' ? 'user' : 'model';
                const images = extractImagesFromElement(el);
                turns.push({ role, text: text.substring(0, 10000), images });
            }
            return turns;
        }

        // Strategy 2: class-based fallback
        const msgEls = document.querySelectorAll(
            '[data-message-id], .message-content, .conversation-turn, ' +
            '.query-content, .response-content, .model-response-text'
        );
        for (const el of msgEls) {
            const text = el.innerText?.trim();
            if (!text || text.length < 2) continue;
            const cls = (el.className || '').toLowerCase();
            const parentCls = (el.closest('[class]')?.className || '').toLowerCase();
            let role = 'unknown';
            if (cls.includes('user') || cls.includes('query') || parentCls.includes('query')) role = 'user';
            else if (cls.includes('model') || cls.includes('response') || parentCls.includes('response')) role = 'model';
            turns.push({ role, text: text.substring(0, 10000) });
        }

        // Strategy 3: last resort — main content transcript
        if (turns.length === 0) {
            const main = document.querySelector('main, [role="main"]');
            if (main) {
                const text = main.innerText?.trim();
                if (text && text.length > 20) {
                    turns.push({ role: 'transcript', text: text.substring(0, 50000) });
                }
            }
        }

        return turns;
    }

    // ── ChatGPT Turn Extraction ──────────────────────────────────
    function extractChatGPTTurns() {
        const turns = [];

        // Strategy 1: article elements with data-message-author-role
        const articles = document.querySelectorAll('article[data-message-author-role]');
        if (articles.length > 0) {
            for (const el of articles) {
                const role = el.getAttribute('data-message-author-role');
                const text = el.innerText?.trim();
                if (!text || text.length < 2) continue;
                const images = extractImagesFromElement(el);
                turns.push({ role: role === 'user' ? 'user' : 'model', text: text.substring(0, 10000), images });
            }
            return turns;
        }

        // Strategy 2: data-message-id containers
        const msgContainers = document.querySelectorAll('[data-message-id]');
        if (msgContainers.length > 0) {
            for (const el of msgContainers) {
                const text = el.innerText?.trim();
                if (!text || text.length < 2) continue;
                const authorEl = el.querySelector('[data-message-author-role]');
                const role = authorEl?.getAttribute('data-message-author-role') === 'user' ? 'user' : 'model';
                turns.push({ role, text: text.substring(0, 10000) });
            }
            return turns;
        }

        // Strategy 3: class-based
        const chatEls = document.querySelectorAll(
            '[class*="user-message"], [class*="assistant-message"], ' +
            '[class*="human"], [class*="agent"], .group\\/conversation-turn'
        );
        for (const el of chatEls) {
            const text = el.innerText?.trim();
            if (!text || text.length < 5) continue;
            const cls = (el.className || '').toLowerCase();
            let role = 'unknown';
            if (cls.includes('user') || cls.includes('human')) role = 'user';
            else if (cls.includes('assistant') || cls.includes('agent')) role = 'model';
            const existing = turns.find(t => t.text === text);
            if (!existing) turns.push({ role, text: text.substring(0, 10000) });
        }

        // Strategy 4: main thread transcript
        if (turns.length === 0) {
            const main = document.querySelector('main, [role="main"], [class*="thread"]');
            if (main) {
                const text = main.innerText?.trim();
                if (text && text.length > 20) {
                    turns.push({ role: 'transcript', text: text.substring(0, 50000) });
                }
            }
        }

        return turns;
    }

    // ── Claude Turn Extraction ───────────────────────────────
    function extractClaudeTurns() {
        const turns = [];

        // Strategy 1: data-testid based (Claude's primary DOM pattern)
        const humanMsgs = document.querySelectorAll('[data-testid="human-turn"], [class*="human-turn"]');
        const aiMsgs = document.querySelectorAll('[data-testid="ai-turn"], [class*="ai-turn"]');
        if (humanMsgs.length > 0 || aiMsgs.length > 0) {
            const allTurns = [];
            for (const el of humanMsgs) {
                const text = el.innerText?.trim();
                if (text && text.length > 1) allTurns.push({ role: 'user', text: text.substring(0, 10000), el });
            }
            for (const el of aiMsgs) {
                const text = el.innerText?.trim();
                if (text && text.length > 1) allTurns.push({ role: 'model', text: text.substring(0, 10000), el });
            }
            // Sort by DOM order
            allTurns.sort((a, b) => {
                const pos = a.el.compareDocumentPosition(b.el);
                return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });
            for (const t of allTurns) turns.push({ role: t.role, text: t.text });
            if (turns.length > 0) return turns;
        }

        // Strategy 2: role-based class patterns
        const msgEls = document.querySelectorAll(
            '[class*="Message"], [class*="message-row"], [class*="conversation-turn"], ' +
            '[class*="user-message"], [class*="assistant-message"]'
        );
        for (const el of msgEls) {
            const text = el.innerText?.trim();
            if (!text || text.length < 3) continue;
            const cls = (el.className || '').toLowerCase();
            const ds = JSON.stringify(el.dataset || {}).toLowerCase();
            let role = 'unknown';
            if (cls.includes('human') || cls.includes('user') || ds.includes('human') || ds.includes('user')) role = 'user';
            else if (cls.includes('assistant') || cls.includes('ai') || ds.includes('assistant') || ds.includes('ai')) role = 'model';
            if (role !== 'unknown') {
                const existing = turns.find(t => t.text === text);
                if (!existing) turns.push({ role, text: text.substring(0, 10000) });
            }
        }
        if (turns.length > 0) return turns;

        // Strategy 3: main content transcript
        const main = document.querySelector('main, [role="main"], [class*="conversation"]');
        if (main) {
            const text = main.innerText?.trim();
            if (text && text.length > 20) {
                turns.push({ role: 'transcript', text: text.substring(0, 50000) });
            }
        }

        return turns;
    }

    // ── Unified Extraction ───────────────────────────────────────
    function extractTurns() {
        if (IS_GEMINI) return extractGeminiTurns();
        if (IS_CHATGPT) return extractChatGPTTurns();
        if (IS_CLAUDE) return extractClaudeTurns();
        return [];
    }

    // ── Hash for dedup ───────────────────────────────────────────
    function hashContent(turns) {
        const str = turns.map(t => `${t.role}:${t.text.substring(0, 100)}`).join('|');
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return String(hash);
    }

    // ── Flush via Two-Hop Relay ──────────────────────────────────
    // Content script → chrome.runtime.sendMessage → background.js → localhost
    function flushCapture() {
        try {
            const turns = extractTurns();
            if (turns.length === 0) { console.log('[VaultCapture] No turns found'); return; }

            const hash = hashContent(turns);
            if (hash === lastFlushedHash) return;

            console.log(`[VaultCapture] Attempting flush: ${turns.length} turns, hash=${hash}`);

            const payload = {
                source: SOURCE,
                title: getConversationTitle(),
                url: window.location.href,
                turns: turns,
                timestamp: new Date().toISOString(),
                turnCount: turns.length,
                extensionVersion: EXTENSION_VERSION,
            };

            // Two-hop: send to background service worker (bypasses CSP)
            chrome.runtime.sendMessage(
                { action: 'VAULT_CAPTURE', payload },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[VaultCapture] Runtime error:', chrome.runtime.lastError.message);
                        return;
                    }
                    if (response && response.ok) {
                        lastFlushedHash = hash;
                        console.log(`[VaultCapture] ✓ Flushed ${turns.length} turns (${SOURCE})`);
                    } else {
                        console.warn('[VaultCapture] Flush failed:', JSON.stringify(response));
                    }
                }
            );
        } catch (e) {
            console.warn('[VaultCapture] Flush error:', e.message);
        }
    }

    // ── Lifecycle Hooks ─────────────────────────────────────────

    // Flush on page unload
    window.addEventListener('beforeunload', () => {
        flushCapture();
    });

    // Periodic flush
    flushTimer = setInterval(flushCapture, FLUSH_INTERVAL);

    // SPA navigation detection
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            flushCapture();
            lastUrl = location.href;
            lastFlushedHash = '';
        }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });

    // Initial capture after page loads
    setTimeout(flushCapture, INITIAL_DELAY);

    console.log(`[VaultCapture] Veritas Vault ${SOURCE} capture active (v${EXTENSION_VERSION}, two-hop relay)`);
})();
