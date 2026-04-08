<div align="center">
  <img src="https://raw.githubusercontent.com/VrtxOmega/Gravity-Omega/master/omega_icon.png" width="100" alt="VERITAS" />
  <h1>VERITAS VAULT</h1>
  <p><strong>High-Assurance AI Knowledge Engine</strong></p>
  <p><em>Auto-capture, organize, and intelligence your developer work.</em></p>
</div>

![Status](https://img.shields.io/badge/Status-ACTIVE-success?style=for-the-badge&labelColor=000000&color=d4af37)
![Version](https://img.shields.io/badge/Version-v3.0-blue?style=for-the-badge&labelColor=000000)
![Stack](https://img.shields.io/badge/Stack-Electron%20%2B%20SQLite-informational?style=for-the-badge&labelColor=000000)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge&labelColor=000000)

---

VERITAS Vault auto-captures, organizes, and intelligences developer work across Antigravity, ChatGPT, and Gemini sessions. 14 core modules, 7 UI panels, and a browser extension — all running locally with zero cloud dependency.

> **Every session captured. Every decision indexed. Every insight retrievable.**

## Architecture

`
+--------------------------------------+
|          ELECTRON MAIN               |
|  capture-server | clipboard-monitor  |
|  watcher | sqlite-db | vault-ai      |
+--------------------------------------+
|          RENDERER (7 panels)         |
|  Journal | Search | Threads | Tasks  |
|  Ask/Chat | Settings | Follow-ups    |
+--------------------------------------+
|          BROWSER EXTENSION           |
|  ChatGPT + Gemini session capture    |
+--------------------------------------+
`

### 14 Core Modules

| Module | Purpose |
|--------|---------|
| **Journal Engine** | Session recording, timestamped entry management |
| **Vault AI** | 19 AI functions via Ollama (qwen2.5:7b) |
| **Vault RAG** | Retrieval-augmented chat over captured knowledge |
| **Follow-Up Engine** | Action item extraction and tracking |
| **Archivist** | Session archival and long-term storage |
| **Capture Server** | HTTP endpoint for browser extension data |
| **Clipboard Monitor** | System clipboard change detection |
| **Watcher** | File system change monitoring |
| **SQLite DB** | Persistent structured storage |
| **Morning Brief** | Resume context + action items + weekly rollup |
| **KI Health Dashboard** | Hot/active/good/stale/dormant knowledge items |
| **Intelligence Sweep** | Auto re-summarize, enrich KIs, extract actions |
| **Cross-Session Continuity** | Detect and link related sessions |
| **Toast Notifications** | System-level alerts for captured events |

## Features

- **Morning Brief Dashboard** - Resume context, action items, and weekly rollup on startup
- **7 UI Panels** - Journal, Search, Threads, Tasks, Ask/Chat, Settings, Follow-ups
- **KI Health Dashboard** - Track knowledge item freshness (hot/active/good/stale/dormant)
- **Intelligence Sweep** - Auto-orchestrated re-summarization, enrichment, and linking
- **Browser Extension** - Capture ChatGPT and Gemini sessions in real-time
- **Vault RAG Chat** - Ask questions over your entire captured knowledge base
- **Keyboard Navigation** - `Ctrl+K` search, `Ctrl+J` journal, `Ctrl+T` tasks, `Ctrl+E` export
- **Export to Clipboard** - One-click copy of any session or knowledge item

## Quick Start

### Requirements
- Node.js 20+
- Ollama (for AI features)

### Install

`ash
npm install
npm start
`

### Browser Extension

Install the extension from `extension/` to capture ChatGPT and Gemini sessions automatically.

## License

MIT

---

<div align="center">
  <sub>Built by <a href="https://github.com/VrtxOmega">RJ Lopez</a> | VERITAS Framework</sub>
</div>