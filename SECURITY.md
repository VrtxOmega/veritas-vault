# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 3.x (current) | Yes |
| < 3.0 | No |

---

## Threat Model

VERITAS Vault is a **local-first desktop application**. The primary attack surfaces are:

- **Capture Server (port 47831)**: An HTTP endpoint that accepts payloads from the browser extension. It is protected by a per-launch bearer token and per-IP rate limiting. It is not intended to be exposed outside `localhost`.
- **SQLite corpus**: Stored at `~/.gemini/antigravity/veritas_vault.db` with no encryption at rest. Access control relies entirely on OS-level filesystem permissions.
- **Browser Extension**: Communicates only with `localhost:47831`. Content scripts run in the context of ChatGPT and Gemini pages; they do not exfiltrate data to any remote endpoint other than the local Capture Server.
- **Ollama integration**: AI inference is routed to a locally-resident Ollama runtime. No prompt content is sent to external inference APIs.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

To report a vulnerability, contact the maintainer directly:

- GitHub: [@VrtxOmega](https://github.com/VrtxOmega) (use the "Report a vulnerability" button on the Security tab of this repository if available)

Include:
- A clear description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (no live exploitation required)
- Affected version(s)

You can expect an acknowledgment within 5 business days and a remediation timeline within 14 business days for confirmed vulnerabilities.

---

## Hardening Recommendations

- Run Vault on a single-user machine or ensure `~/.gemini/antigravity/` has permissions restricted to the operator's user account.
- Do not expose port 47831 on a network interface; use a firewall rule to restrict it to `127.0.0.1` if your OS does not do so by default.
- Rotate `settings.json` bearer token periodically by deleting the token field and restarting the application.
