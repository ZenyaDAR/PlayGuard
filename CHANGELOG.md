# Changelog

## 0.2.1 — 2026-07-08

Fixed the Figma optimizer reporting 0% savings on every upstream that
pre-simplifies to YAML (e.g. Framelink `figma-developer-mcp`), even though
real bytes were being saved.

### Fixed
- `optimizeFigmaResponse()` measured `inBytes` from `JSON.stringify(parsed)` —
  i.e. *after* parsing — instead of the raw upstream response text. Upstreams
  that return indented YAML are routinely ~2x heavier than the compact JSON
  PlayGuard emits, so that saving was real but invisible in every stat and
  log line (`pct` always read 0). `optimizeFigmaResponse()` now takes the raw
  byte count as a second argument and the call site passes the original
  response text's length. Confirmed against live Figma API responses: a file
  that previously logged `0%` now logs `28%`–`51%` depending on payload size.

### Added
- **Module 5 — Top-level metadata trim:** drops `metadata.thumbnailUrl` /
  `metadata.lastModified` from pre-simplified upstream shapes (Framelink's
  `{ metadata, nodes, globalVars }`), which existing Module 1 can't reach
  since it only walks `document`/`children`, never a sibling `metadata` key.
- `thumbnailUrl` added to `FIGMA_DROP_KEYS`, so Module 1 now also strips the
  same field when it's top-level (raw Figma REST API shape, e.g. the official
  `@figma/mcp`).

## 0.2.0 — 2026-07-06

Follow-up pass after a codebase review: fixed two real bugs, removed duplicated
cache logic, tightened types in the request handlers, and added tests for the
parts of the proxy that previously had none.

### Fixed
- `PLAYWRIGHT_MCP_ARGS` / `FIGMA_MCP_ARGS` were split on every space, silently
  truncating any argument containing one (e.g. a Windows path with spaces).
  Added `splitArgs()`, which respects `"..."`/`'...'` quoting.
- `logCall()` used synchronous `appendFileSync` on every proxied tool call,
  blocking the event loop on disk I/O. Switched to async `appendFile`.

### Changed
- `evalCache` and `figmaCache` were two copies of the same
  get-with-TTL / clear-when-full `Map` logic. Replaced both with one shared
  `ttlCache<T>()` helper.
- Reduced `any` casts in the `ListTools`/`CallTool` request handlers, using the
  SDK's own `Tool` type and local `ToolArgs`/`ContentItem` aliases instead —
  `strict: true` in tsconfig now actually catches something there. Left `any`
  where it's genuinely warranted: the arbitrary external Figma JSON tree, and
  the two content-array spreads that feed the SDK's non-trivial content union.
- Extracted the `browser_snapshot` cache/delta/hint decision logic — previously
  spread across 8 mutable module-level globals — into a pure, exported
  `decideSnapshot()` function operating on one `SnapState` object. Behavior is
  unchanged; this is what made the logic testable without a live Playwright
  connection.

### Added
- `test/playguard-core.test.mjs` (18 cases): `dead()` crash/disconnect
  detection, `splitArgs()` quoting, `ttlCache()` TTL expiry and eviction, and
  `decideSnapshot()` cache-hit / delta / full-snapshot / hint-threshold /
  URL-change behavior.
- `.github/workflows/ci.yml`: runs `npm test` on every push and pull request
  to `main` (previously nothing ran automatically).

## 0.1.0 — 2026-06-24

Initial release: MCP proxy for Playwright and Figma with token optimization
(compact/delta snapshots, snapshot and eval caching, session auto-recovery,
Figma response optimization, screenshot policy, NDJSON analytics).
