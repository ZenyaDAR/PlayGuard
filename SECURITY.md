# Security Policy

## Supported Versions

Only the latest published release is supported with security fixes.

| Version | Supported |
|---------|-----------|
| latest  | ✅ |
| < latest | ❌ |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, report it privately:

- Email: dziza12345@gmail.com
- Or use [GitHub Security Advisories](https://github.com/ZenyaDAR/PlayGuard/security/advisories/new) for this repo.

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (a minimal repro is ideal)
- Affected version(s)

You should get an initial response within a few days. Once a fix is
confirmed, a patch release will be published and the report credited
(unless you'd prefer to stay anonymous).

## Scope notes

PlayGuard spawns child MCP processes (Playwright MCP, and optionally Figma,
Chrome DevTools, Shopify Dev and Context7 MCPs) and forwards `FIGMA_*` variables to the Figma child. Other upstreams get a filtered environment (their own settings plus system basics), never PlayGuard's other API keys.
Treat `FIGMA_API_KEY` and any credentials passed via env vars as secrets —
they are not logged, but they are held in process memory and passed to child
process environments.
