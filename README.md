# VERITAS VAULT v3.0

> High-assurance AI knowledge engine that auto-captures, organizes, and intelligences your developer work across Antigravity, ChatGPT, and Gemini sessions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                │
│                                                         │
│  main.js ─── Orchestrator (791L)                        │
│  ├── db.js ─── SQLite CAS + MiniSearch (332L)           │
│  ├── archivist.js ─── Ingest Pipeline (297L)            │
│  ├── journal.js ─── Digest Engine (~2400L)              │
│  ├── vault-ai.js ─── 19 AI Ops via Ollama (829L)       │
│  ├── vault-rag.js ─── RAG Chat Engine (575L)            │
│  ├── capture-server.js ─── HTTP Relay (292L)            │
│  ├── followup-engine.js ─── Smart Alerts (305L)         │
│  ├── watcher.js ─── FS Watcher (81L)                    │
│  ├── clipboard-monitor.js ─── Polling (68L)             │
│  └── vault-logger.js ─── Structured Logging (~100L)     │
│                                                         │
│  preload.js ─── Secure IPC Bridge (55+ methods)         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                   RENDERER PROCESS                      │
│                                                         │
│  renderer/index.html ─── 7 Panels + 4 Modals (343L)    │
│  renderer/app.js ─── Full UI Logic (~2500L)             │
│  renderer/styles/vault.css ─── Design System (71KB)     │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                  BROWSER EXTENSION                      │
│                                                         │
│  extension/content.js ─── DOM Scraper (14KB)            │
│  extension/background.js ─── HTTP Relay (9KB)           │
│  extension/popup.html/js ─── Config UI (13KB)           │
└─────────────────────────────────────────────────────────┘
```

## Features

### Core Engine
- **SQLite Content-Addressed Storage** — WASM-based (sql.js), atomic write-temp-rename for crash safety
- **MiniSearch Full-Text Index** — Sub-millisecond fuzzy search with prefix matching
- **SHA-256 Dedup** — Content hashing on all ingested files, captures, and clipboard
- **Incremental Corpus Scan** — Only processes files modified since last scan
- **7-Day Auto-Backup** — Daily timestamped DB backups with automatic rotation

### AI Intelligence (Ollama qwen2.5:7b)
- 19 AI functions: summarize, classify, quality score, cluster, prioritize, enrich, extract actions
- Keyword/heuristic fallback when Ollama offline
- Learning loop with accept/reject feedback bias adjustment
- Auto-ingest pipeline: background FIFO queue for non-blocking capture processing
- Intelligence Sweep: 4-phase auto-orchestrator (re-summarize → enrich KIs → extract actions → auto-link)

### RAG Chat
- Dual-mode: semantic (nomic-embed-text 768d vectors) + keyword fallback
- Crash-resilient indexing with checkpoint/resume
- Memory-efficient Float32Array embedding storage
- Cosine similarity retrieval → Top-8 chunks → Context injection → qwen2.5:7b synthesis

### Capture Pipeline
- Chrome extension captures ChatGPT, Gemini, and Claude sessions
- Local HTTP server on 127.0.0.1:47831 with bearer token auth
- Rate limiting (30 req/min) + CORS restricted to chrome-extension:// origins
- Clipboard monitor: 2s polling with SHA-256 dedup and rate limiting
- Filesystem watcher: chokidar deep watch with 10-level depth

### Smart Follow-Ups
- 5 proactive detectors: stale audits, abandoned tasks, unlinked captures, stale KIs, continuity gaps
- Dismissal persistence via SQLite
- Priority sorting (HIGH → MEDIUM → LOW)

### Journal Engine
- Daily digest builder with session aggregation
- AI-powered morning brief with resume context and action items
- Activity momentum heatmap
- Pinned sessions with notes
- Quick notes per date
- Tamper-evident audit chain (SHA-256 hash chain)

### UI (7 Panels)
- **Journal** — Morning brief, momentum heatmap, pinned sessions, daily timeline
- **Search** — Full-text fuzzy search with highlighted snippets
- **Threads** — Knowledge Item threads with KI Health Dashboard
- **Tasks** — Open task.md tracking with finalize/archive
- **Intelligence** — AI dashboard with auto-organize, clusters, priorities
- **Ask** — RAG chat with source citations and suggested queries
- **Settings** — Profile, capture config, AI model info, keyboard shortcuts

## Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Electron 34 |
| Database | sql.js (SQLite WASM) |
| AI | Ollama (qwen2.5:7b + nomic-embed-text) |
| Search | MiniSearch 7.x |
| FS Watch | Chokidar 4.x |
| Markdown | Marked 17.x + Highlight.js 11.x |

## Security

- Context isolation + no node integration in renderer
- CSP: `default-src 'self'; script-src 'self'`
- 32-byte random bearer token auth on capture server
- Localhost-only server binding
- Atomic DB writes (temp → rename)
- Single instance lock
- 5MB request body limit

## License

BSL-1.1
