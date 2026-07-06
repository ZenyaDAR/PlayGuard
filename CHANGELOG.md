# Changelog

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
