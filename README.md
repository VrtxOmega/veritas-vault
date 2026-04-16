<div align="center">
  <img src="https://raw.githubusercontent.com/VrtxOmega/Gravity-Omega/master/omega_icon.png" width="100" alt="VERITAS VAULT" />
  <h1>VERITAS VAULT</h1>
  <p><strong>Sovereign Knowledge Retention Engine — Electron Desktop Application</strong></p>
</div>

<div align="center">

![Status](https://img.shields.io/badge/Status-ACTIVE-success?style=for-the-badge&labelColor=000000&color=d4af37)
![Version](https://img.shields.io/badge/Version-v3.6.0-informational?style=for-the-badge&labelColor=000000&color=d4af37)
![Stack](https://img.shields.io/badge/Stack-Electron%20%2B%20SQLite-informational?style=for-the-badge&labelColor=000000)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge&labelColor=000000)

</div>

---

VERITAS Vault is the local-first, zero-cloud knowledge retention substrate for the Omega Universe operator stack — auto-capturing, classifying, and indexing every AI session, decision thread, and clipboard event into a deterministic SQLite store with full-text retrieval and RAG-augmented query.

---

## Ecosystem Canon

VERITAS Vault is the retention layer that makes the Sovereign Operator's memory durable. Every session ingested by the Capture Server is validated, classified by the Archivist pipeline, and committed to a WAL-journaled SQLite corpus under ACID guarantees — no cloud relay, no ephemeral cache. The Vault exposes this corpus to the operator through seven panel surfaces, a RAG chat interface, and 19 discrete AI functions powered by a locally-resident Ollama runtime. Knowledge items age through five deterministic health states — hot, active, good, stale, dormant — and the Intelligence Sweep re-enriches them on a governed cadence. Doctrine: what is captured is owned; what is owned is retrievable; what is retrievable is actionable.

---

## Overview

Veritas Vault runs as an Electron desktop application on Windows. It passively observes the operator's AI workflow — intercepting ChatGPT and Gemini sessions via a browser extension, monitoring the filesystem for Antigravity output, and polling the system clipboard — then persists every artifact into a structured SQLite corpus stored at `~/.gemini/antigravity/`. The operator interface exposes seven panels for review, search, threading, task management, conversational retrieval, settings, and follow-up tracking. No data leaves the machine.

---

## Features

| Capability | Detail |
|---|---|
| Morning Brief Dashboard | Resume context, open action items, and weekly rollup on startup |
| 7 Operator Panels | Journal, Search, Threads, Tasks, Ask/Chat, Settings, Follow-ups |
| KI Health Dashboard | Track knowledge item freshness: hot / active / good / stale / dormant |
| Intelligence Sweep | Auto-orchestrated re-summarization, enrichment, and cross-session linking |
| Browser Extension | Intercepts ChatGPT and Gemini sessions in real time |
| Vault RAG Chat | Conversational retrieval over the full captured knowledge corpus |
| Keyboard Navigation | `Ctrl+K` search, `Ctrl+J` journal, `Ctrl+T` tasks, `Ctrl+E` export |
| Clipboard Capture | Monitors system clipboard for developer artifacts |
| Export to Clipboard | One-click copy of any session or knowledge item |
| Offline-First | Zero cloud dependency; all processing runs locally |

---

## Architecture

```
+---------------------------------------------------------------------+
|                         INGESTION LAYER                             |
|  Browser Extension  -->  Capture Server (HTTP :47831)               |
|  Filesystem Watcher -->  Archivist Pipeline                         |
|  Clipboard Monitor  -->  Archivist Pipeline                         |
+----------------------------------+----------------------------------+
                                   | classify -> chunk -> validate
                                   v
+---------------------------------------------------------------------+
|                          STORAGE LAYER                              |
|  SQLite (better-sqlite3, WAL mode, FTS5 full-text search)           |
|  sessions | knowledge_items | action_items | search_index           |
|  ~/.gemini/antigravity/veritas_vault.db                             |
+------------------+---------------------------+---------------------+
                   |                           |
                   v                           v
+---------------------------+   +-----------------------------------+
|      AI ENGINE LAYER      |   |       OPERATOR INTERFACE          |
|  Vault AI  (Ollama)       |   |  Electron Renderer -- 7 Panels    |
|  19 AI functions          |   |  Journal  | Search  | Threads     |
|  Vault RAG (embeddings)   |   |  Tasks    | Ask/Chat| Settings    |
|  Follow-Up Engine         |   |  Follow-ups                       |
|  Morning Brief Engine     |   |                                   |
+---------------------------+   +-----------------------------------+
```

### Core Modules

| Module | File | Purpose |
|---|---|---|
| Main Orchestrator | `main.js` | Electron main process; IPC hub; window/tray lifecycle |
| Database | `db.js` | SQLite with WAL journaling and FTS5 full-text search |
| Archivist | `archivist.js` | Ingest pipeline: classification, chunking, deduplication |
| Vault AI | `vault-ai.js` | 19 AI functions routed through local Ollama runtime |
| Vault RAG | `vault-rag.js` | Embedding-based retrieval-augmented chat engine |
| Follow-Up Engine | `followup-engine.js` | Action item extraction and deadline tracking |
| Journal Engine | `journal.js` | Daily digests, Morning Brief, audit chain, KI management |
| Capture Server | `capture-server.js` | HTTP endpoint (port 47831) receiving extension payloads |
| Clipboard Monitor | `clipboard-monitor.js` | System clipboard polling with rate limiting |
| Watcher | `watcher.js` | Filesystem change monitoring via chokidar |
| Logger | `vault-logger.js` | Structured internal event logging |
| Launcher | `launch.js` | Process bootstrap and environment initialization |
| Preload | `preload.js` | Electron contextBridge API surface |
| Renderer | `renderer/` | 7-panel UI: Journal, Search, Threads, Tasks, Ask/Chat, Settings, Follow-ups |

---

## Quickstart

### Prerequisites

- **Node.js** 20 or later
- **Ollama** running locally with `qwen2.5:7b` pulled (required for AI features)
- **Windows** (primary target; NSIS installer via `npm run dist`)

### Install and Run

```bash
# 1. Clone the repository
git clone https://github.com/VrtxOmega/veritas-vault.git
cd veritas-vault

# 2. Install dependencies (includes native module compilation)
npm install

# 3. Launch the application
npm start
```

For development mode (verbose logging):

```bash
npm run dev
```

### Build Windows Installer

```bash
# Recompile native modules for the target Electron version first
npm run rebuild

# Build NSIS installer (outputs to dist/)
npm run dist
```

### Browser Extension

Load the unpacked extension from the `extension/` directory into Chrome (or any Chromium-based browser) via **Settings -> Extensions -> Load unpacked**. Once loaded, ChatGPT and Gemini sessions are relayed to the Capture Server automatically.

---

## Configuration

Veritas Vault stores all runtime data under `~/.gemini/antigravity/`. No `.env` file is required for basic operation.

| Path | Content |
|---|---|
| `~/.gemini/antigravity/veritas_vault.db` | Primary SQLite corpus |
| `~/.gemini/antigravity/captures/` | Raw session capture files |
| `~/.gemini/antigravity/clipboard/` | Clipboard artifact snapshots |
| `~/.gemini/antigravity/settings.json` | Operator preferences (written at first launch) |

**Ollama**: The AI engine expects Ollama to be accessible at `http://localhost:11434`. Pull the required model before first launch:

```bash
ollama pull qwen2.5:7b
```

The Capture Server listens on `http://localhost:47831`. The browser extension targets this endpoint with a bearer token generated at first run and stored in `settings.json`.

---

## Data Model / Storage

Veritas Vault uses **SQLite** (`better-sqlite3`, WAL journal mode) as its exclusive persistence layer. There is no remote database and no external sync service.

### Primary Tables

| Table | Description |
|---|---|
| `sessions` | Top-level session records (source, timestamp, raw content) |
| `knowledge_items` | Processed, classified entries with health state |
| `action_items` | Extracted follow-ups and tasks with due-date metadata |
| `search_index` | FTS5 virtual table enabling full-corpus text search |

### Knowledge Item Health States

```
hot  ->  active  ->  good  ->  stale  ->  dormant
```

Health state transitions are computed from last-touched timestamps and enrichment history. The Intelligence Sweep re-processes items approaching stale or dormant thresholds.

---

## Security & Sovereignty

- **Local-first architecture**: The SQLite corpus and all AI inference run on the operator's machine. No session data, knowledge items, or clipboard captures are transmitted to external services.
- **Capture Server authentication**: The HTTP endpoint (port 47831) requires a bearer token generated at first launch. The token is stored in `settings.json` and validated on every extension request.
- **Rate limiting**: The Capture Server enforces a per-IP rate limit (30 requests per 60-second window) to prevent runaway extension payloads.
- **CORS restriction**: The Capture Server accepts cross-origin requests only from recognized browser extension origins.
- **No cloud telemetry**: Veritas Vault does not include analytics, crash reporting, or update checks that contact external servers.

> Note: Security posture reflects the current codebase. Operators running Vault on shared or multi-user machines should review filesystem permissions on the `~/.gemini/antigravity/` data directory. See [SECURITY.md](SECURITY.md) for the disclosure process.

---

## Roadmap

| Milestone | Status |
|---|---|
| SQLite WAL + FTS5 migration (from WASM sql.js) | Complete |
| 19-function Vault AI via Ollama | Complete |
| RAG chat engine with embedding-based retrieval | Complete |
| Morning Brief + KI Health Dashboard | Complete |
| Cross-session continuity linking | Complete |
| macOS and Linux packaging | Planned |
| Encrypted corpus option | Planned |
| Multi-vault federation | Planned |
| Operator plugin API | Planned |

---

## Omega Universe

Veritas Vault is the retention substrate of the VERITAS & Sovereign Ecosystem. Related nodes:

| Repository | Role |
|---|---|
| [sovereign-arcade](https://github.com/VrtxOmega/sovereign-arcade) | Operator gaming and mission console |
| [drift](https://github.com/VrtxOmega/drift) | Real-time operator dashboard and command interface |
| [SovereignMedia](https://github.com/VrtxOmega/SovereignMedia) | Local-first media management for the operator stack |
| [omega-brain-mcp](https://github.com/VrtxOmega/omega-brain-mcp) | MCP server bridging the Omega intelligence layer |
| [Ollama-Omega](https://github.com/VrtxOmega/Ollama-Omega) | Governed Ollama runtime and model management |
| [Aegis](https://github.com/VrtxOmega/Aegis) | Security posture and access-control layer |
| [aegis-rewrite](https://github.com/VrtxOmega/aegis-rewrite) | Next-generation Aegis architecture |

---

## License

Released under the [MIT License](LICENSE).

---

<div align="center">
  <sub>Built by <a href="https://github.com/VrtxOmega">RJ Lopez</a> &nbsp;|&nbsp; VERITAS &amp; Sovereign Ecosystem &mdash; Omega Universe</sub>
</div>
