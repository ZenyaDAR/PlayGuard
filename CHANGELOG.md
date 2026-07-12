# Changelog

## 0.5.0 — 2026-07-12

### Added
- `browser_snapshot` accepts `section`, `around`, and `depth` params to return
  only a landmark subtree instead of the full tree — for pages where the
  relevant UI is buried under a large accessibility tree, compaction alone
  wasn't enough to keep snapshots small. Falls back to the full snapshot
  with a warning if the requested section/ref isn't found.
- `PLAYGUARD_SMART_WAIT`: when a snapshot looks like it caught a page mid-load
  (few refs plus a loading/spinner/skeleton indicator), retries up to
  `PLAYGUARD_SMART_WAIT_MAX_RETRIES` times (default 3, `PLAYGUARD_SMART_WAIT_MS`
  apart, default 1000ms) before returning — avoids agents acting on a stale
  or half-rendered snapshot. Off by default (opt-in via `=1`/`=true`) since it
  adds latency to every snapshot call.
- Snapshot cache/delta decisions now key on the active section/around/depth
  filter, so switching filters always forces a fresh snapshot instead of a
  stale cache hit from a differently-filtered request.

## 0.4.1 — 2026-07-11

### Added
- Published to npm — install via `npx playguard` instead of a git clone.
- `publish.yml`: GitHub Action that publishes to npm on a GitHub Release or a
  pushed `v*` tag, skipping if that version is already published.
- `ci.yml` now also runs `npm publish --dry-run` on every push/PR so a broken
  package (missing files, bad `package.json`) fails CI before it fails a release.

### Fixed
- Bin resolution (`localBin`) now falls back to the bare command name on PATH
  when installed via npm — the previous hardcoded `node_modules/.bin` path
  only worked from a local clone.
- `bin` field path normalized (dropped a leading `./` npm silently rewrites
  at publish time).

## 0.4.0 — 2026-07-11

Field data (167 logged calls over two days) showed the structural Figma
modules (M2/M3/M4/M6) never fire on Framelink (`figma-developer-mcp`)
responses: Framelink pre-simplifies to `{metadata, nodes[], globalVars}` and
has already removed everything those modules target. Measured against real
responses, the remaining fat is duplicate sibling subtrees, no-op layout
styles, and float noise.

### Added
- Figma optimizer Module 8 for the Framelink shape:
  - **8a** — sibling subtrees identical except for ids collapse to
    `{id, name, _sameAs: firstId}` (repeated cards/icons).
  - **8a+** — structural copies (same tree and styles, different text/layer
    name/position) collapse to the same stub plus a `_textDiff` map, and only
    when the stub is actually smaller; on card grids this is the dominant
    module. Copies that differ in styling never collapse.
  - **8b** — layout styles that say nothing (`{mode:"none", sizing:{}}`) are
    dropped from `globalVars.styles` together with the node refs to them.
  - **8c** — float noise in styles is rounded to 2 decimals
    (`lineHeight: "1.3999999364217122em"` → `"1.4em"`); node `text` is never
    touched. Real-response effect: −41%/−53% total vs −31%/−34% before.
- Analytics fields to make the next `npm run analyze` conclusive:
  - `inst` — random per-process id on every log line (caches are in-memory,
    so only same-instance repeat misses indicate a problem);
  - `argsHash` + `depth` on Figma calls — distinguishes "cache is broken"
    from "the agent varied the arguments";
  - `visual: true` on screenshots the agent explicitly requested as pixels.
- `bench/analyze.mjs`: server-instance count, Figma repeat-call cache proof
  (hits vs cross-instance vs same-instance misses with gaps), M8 module
  breakdown rows, `{visual:true}` screenshot count.

### Fixed
- Figma cache key now sorts argument keys and normalizes `nodeId`
  (`39-327` ≡ `39:327`), so the same logical request no longer misses the
  cache on formatting differences. The normalization now replaces *every*
  hyphen, not just the first — a multi-segment `nodeId` used to still miss
  the cache depending on which form the agent sent.
- Delta snapshots could never actually fire after an action. Every mutating
  tool (`browser_click`, `browser_type`, ...) wiped the *entire* snapshot
  cache — including the line set the delta diff is computed against — so the
  click-then-snapshot flow the feature exists for always fell back to a full
  snapshot; delta only ever triggered between two `browser_snapshot` calls
  with no action in between. Mutating tools now only invalidate the
  `UNCHANGED`/screenshot-redirect shortcuts (`hash`/`compact`); the line set
  and URL survive so the next snapshot can still delta against pre-action
  state. Also added a URL check to the `UNCHANGED` cache-hit branch, closing
  a latent case where two different pages with a coincidentally identical
  hash would report `UNCHANGED`.
- `lastUrl` was only ever updated by explicit `browser_navigate` calls, so
  `browser_navigate_back` left it pointing at the pre-back URL. On a session
  crash, `revive()` uses `lastUrl` to restore the page — meaning a crash
  after navigating back silently restored the wrong page. A small
  `urlHistory` stack now pushes on `browser_navigate` and pops on
  `browser_navigate_back` to keep `lastUrl` correct. (Navigation via clicked
  links or form submits is still untracked — Playwright MCP doesn't report
  the resulting URL in tool output.)
- The Figma optimizer's `try/catch` around parsing also wrapped the call to
  `optimizeFigmaResponse()` itself, so a genuine bug in the optimizer was
  swallowed and logged as `parseSkip: "parse-error"` — indistinguishable
  from "upstream sent malformed JSON/YAML." Parsing and optimization are now
  in separate try scopes; an optimizer exception propagates and logs as a
  real error instead of being misdiagnosed as an upstream format issue.

## 0.3.0 — 2026-07-09

The `FIGMA_TEXT_COMPACT` fallback (when the optimized Figma tree is still too
big to send) used to slice the stringified JSON at a fixed character offset.
That's a blind cut: anything after the offset — later sibling frames, later
pages, `globalVars` — was silently dropped with no way for the agent to know
it was ever there. Also picks up four smaller correctness fixes that had
landed locally but were never released or logged.

### Fixed
- `splitArgs()` (used for `PLAYWRIGHT_MCP_ARGS`/`FIGMA_MCP_ARGS`) lost the
  first *and* last character of any argument with an unclosed quote, e.g.
  `--foo "unclosed` became `--foo unclose`. Quotes are now stripped only
  when they actually pair up; an unclosed quote survives literally.
- `collapseRuns()` printed a literal `undefined` in the fold marker for a run
  of look-alike lines with no `[ref=]` in them (e.g. adjacent blank lines
  left behind after `compactSnap` filters text). Runs without refs now print
  `[×N more similar lines]` instead of `[×N more similar elements, refs
  undefined–undefined]`.
- `deduplicateComponents()` (Figma optimizer Module 3) could pick an
  *overridden* instance as the base definition other instances collapse
  into as a `_ref`. Since refs don't carry the base's overrides, every
  collapsed instance would silently inherit visual changes that only
  applied to the original override. Only a clean (no-override) instance can
  become a base now.
- PlayGuard reported a hardcoded `"0.1.0"` as its own version to both the
  MCP client handshake (`spawnConn`/`spawnFigmaConn`) and the `Server`
  constructor, regardless of the actual released version. `VERSION` is now
  read from `package.json` at startup and used in all three places.

### Added
- **Module 7 — Budget Trim** (`budgetTrimFigma()` / `budgetTrimNode()`):
  replaces the character slice with a structural trim of the parsed tree.
  Budget is allocated depth-first, proportional to each branch's own size; a
  branch that doesn't fit collapses to an `{id, name, type, _stub:true,
  _omittedChildren}` marker instead of vanishing, so every top-level section
  stays visible in the response and the agent can re-fetch a stubbed branch
  by its `id`. Handles both the raw REST API shape (`document.children`) and
  Framelink's pre-simplified `{ metadata, nodes, globalVars }` shape. The
  output is always valid JSON — no more slicing mid-structure.
  - Falls back to the old boundary-safe text slice only when the response
    never parsed into a tree at all (`parseSkip` — genuinely malformed
    upstream), where there's no structure left to trim.
  - NDJSON log gains a `textStubbed` field; the truncation banner now reports
    how many sections were stubbed, e.g. `figma output truncated (12066→9800
    chars, 3 section(s) stubbed)`.
- Regression tests for the four fixes above, plus `dead()` coverage for the
  `Navigation failed`/`Protocol error` patterns and two more `decideSnapshot()`
  cases (removed-only delta, change-ratio exactly at the delta threshold) in
  `test/playguard-core.test.mjs` and `test/playguard.test.mjs`.

### Changed
- `FIGMA_TEXT_COMPACT` default raised `8000` → `10000` chars, since the new
  trim makes larger budgets cheap to raise without losing whole sections.
- `PLAYGUARD_EVAL_COMPACT` default raised `8000` → `10000` chars, to keep the
  two text-compaction limits consistent. `bench/analyze.mjs`'s report line had
  its own hardcoded copy of the old `8000` default for display purposes — it
  now shows `"default"` instead of a guessed number when the env var isn't
  set, so this can't drift out of sync again.

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
