# Contributing to VERITAS Vault

VERITAS Vault is part of the VERITAS & Sovereign Ecosystem (Omega Universe). Contributions are welcome and held to the same standard of precision and rigor as the codebase itself.

---

## Ground Rules

- **Docs-only changes** are always welcome and require no issue prior to opening a PR.
- **Bug fixes** should reference an existing issue or open one before submitting a PR.
- **New features** require a discussion issue before any implementation work begins.
- **No breaking changes** to the storage schema or IPC API surface without a migration path documented in the PR.
- All contributions must keep the application **local-first**: no additions that introduce cloud data transmission without explicit operator opt-in.

---

## Development Setup

```bash
git clone https://github.com/VrtxOmega/veritas-vault.git
cd veritas-vault
npm install
npm run rebuild   # recompile native modules (better-sqlite3) for Electron
npm run dev       # launch in development mode
```

Requires Node.js 20+, Ollama running locally, and `qwen2.5:7b` pulled.

---

## Pull Request Process

1. Fork the repository and create a branch from `main`.
2. Make your changes with clear, atomic commits.
3. Update `README.md` if your change affects setup, configuration, or architecture.
4. Open a PR with a concise description of what changed and why.
5. A maintainer will review and merge or request changes.

---

## Code Style

- Follow the existing module header format (see any `.js` file for the `═══` divider pattern).
- Use `const` and `let`; no `var`.
- All database operations must use the `db.js` helper functions (`dbRun`, `dbAll`, `dbGet`); direct `better-sqlite3` calls belong in `db.js` only.
- Error paths must log to `vault-logger.js` where applicable.

---

## Reporting Issues

Open a GitHub Issue with:
- Vault version (from `package.json`)
- Operating system and Node.js version
- Steps to reproduce
- Expected vs. actual behavior

For security vulnerabilities, see [SECURITY.md](SECURITY.md) — do not open a public issue.
