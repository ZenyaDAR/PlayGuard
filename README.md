# PlayGuard

An MCP proxy that sits between your AI agent and browser/design tools. It wraps [Playwright MCP](https://github.com/microsoft/playwright-mcp) and optionally a Figma MCP, exposing a single unified MCP server while transparently adding:

- **Automatic session recovery** — dead browser sessions are revived; the agent never sees a crash error
- **Token optimization** — compact snapshots, delta diffs, snapshot cache, and eval caching reduce browser snapshot cost by 70–90%
- **Figma response optimization** — strips metadata, invisible layers, duplicate component instances, and SVG geometry blobs before the response reaches the agent
- **Screenshot policy** — redirect, warn, block, or allow screenshot calls

Works with Claude Code, Claude Desktop, Cursor, Codex, or any MCP-compatible agent.

---

## Architecture

```
Claude Code / Claude Desktop / Cursor / Codex
           │
           │  MCP (stdio)
           ▼
    ┌─────────────────┐
    │    PlayGuard    │  ← single proxy for everything
    │                 │
    │  • router       │  browser_* → Playwright MCP
    │  • recovery     │  figma_*   → Figma MCP (optional)
    │  • optimizer    │
    │  • cache        │
    │  • analytics    │
    └────────┬────────┘
             │
      ┌──────┴──────┐
      ▼             ▼
Playwright MCP   Figma MCP
      │
      ▼
  Chromium / Firefox / WebKit
```

Figma MCP is optional. If `FIGMA_MCP_CMD` is not set, PlayGuard runs in browser-only mode with no behavior changes. Playwright MCP is bundled as a dependency — no separate installation required.

---

## Features

### Browser (Playwright)

#### Automatic Session Recovery

PlayGuard intercepts dead-session errors before the agent sees them:

```
Target.*closed · Browser.*closed · connect ECONNREFUSED · crashed
```

It restarts Playwright MCP, restores the last URL, and retries the call transparently. Two concurrent calls during a crash → one restart, both calls continue.

#### Compact Snapshots

`browser_snapshot` normally returns the full accessibility tree. PlayGuard keeps only lines with `[ref=]` (interactive elements) and structural landmarks (`nav`, `main`, `form`, `dialog`, …). Static text and decorative images have no refs and are not needed for navigation.

```
[PlayGuard compact: 312/1840 lines, ~83% removed, 124.3KB→14.1KB]
```

Set `PLAYGUARD_COMPACT=false` to receive the raw snapshot.

#### Delta Snapshots

When a page changes only slightly, PlayGuard returns a diff instead of the full snapshot:

```
[PlayGuard delta: +3 added, 1 removed, ~91% saved]
ADDED:
  - button "Submit" [ref=47]
REMOVED:
  - button "Loading..." [ref=44]
```

#### Snapshot Cache + Prefetch

After `browser_navigate`, PlayGuard immediately fetches a snapshot in the background. The next `browser_snapshot` is served from cache instantly. An unchanged page returns `UNCHANGED` without hitting the browser.

#### Screenshot Policy

| Mode | Behavior |
|------|----------|
| `warn` (default) | Screenshot executes; warning written to stderr |
| `redirect` | Replaced with `browser_snapshot`. Pass `{visual:true}` for a real screenshot |
| `block` | Blocked with an error; agent is told which env var to change |
| `allow` | No restriction |

#### Eval Cache + Output Compaction

Repeated `browser_evaluate` calls with the same script on the same URL are served from cache (configurable TTL). Large eval output is truncated to a character limit to avoid blowing the context window.

---

### Figma Optimizer

PlayGuard intercepts Figma MCP responses and runs them through an optimization pipeline before delivering to the agent.

```
[PlayGuard figma: -68% (284.0KB→91.0KB)]
```

> **Note:** Modules 1–4 and 6 target raw Figma REST API JSON (`document.children`, `componentId`, `fillGeometry`). If your Figma MCP upstream returns pre-simplified YAML (e.g. Framelink `figma-developer-mcp`), those modules find nothing to strip — Module 8 handles that shape instead — and `inBytes`/`outBytes` are still measured from the actual upstream response text, so the automatic YAML→JSON reformatting (typically ~2x on its own) and Module 5's metadata trim both still count as real savings. `parseSkip` in the NDJSON log means the response body couldn't be parsed as JSON or YAML at all, not that the optimizer no-op'd.

**Module 1 — Metadata Cleaner:** Removes fields irrelevant to layout: `createdAt`, `updatedAt`, `creator`, `thumbnailUrl`, `pluginData`, `sharedPluginData`, `exportSettings`, `reactions`, `interactions`, etc.

**Module 2 — Invisible Layer Pruner:** Recursively removes nodes where `visible === false` or `opacity === 0`.

**Module 3 — Component Deduplication:** Repeated instances of the same component are collapsed to a reference. 100 buttons → first full definition + 99 references with overrides only.

```json
{ "type": "INSTANCE", "name": "Button/Primary", "_ref": "123:4", "overrides": [] }
```

**Module 4 — SVG Refs:** Replaces inline SVG geometry (`fillGeometry`) with `{ "_svgRef": "nodeId" }`. The agent gets the shape identifier without thousands of path coordinates.

**Module 6 — Layout Compressor:** Removes absolute `x`/`y` from nodes inside Auto Layout containers — they are redundant because position is determined by `layoutMode`, `gap`, and `padding`.

**Module 5 — Top-Level Metadata Trim:** Drops `metadata.thumbnailUrl` (a signed, single-use preview URL) and `metadata.lastModified` from pre-simplified upstream shapes like Framelink's `{ metadata, nodes, globalVars }` — fields Module 1 can't reach because it only walks `document`/`children`, not a sibling `metadata` key.

**Module 8 — Framelink Shape Optimizer:** Targets the pre-simplified `{ metadata, nodes[], globalVars.styles }` shape (Framelink `figma-developer-mcp`), where Modules 2/4/6 find nothing to strip. **8a:** sibling subtrees identical except for ids collapse to `{ id, name, _sameAs: firstId }` (repeated cards/icons); structural copies that differ only in text/name/position collapse to the same stub plus a `_textDiff` map. **8b:** no-op layout styles (`{ mode: "none", sizing: {} }`) are dropped from `globalVars.styles` along with node refs to them. **8c:** float noise in styles is rounded to 2 decimals (`"1.3999999364217122em"` → `"1.4em"`); node `text` is never touched.

**Module 7 — Budget Trim:** If the optimized tree still exceeds `FIGMA_TEXT_COMPACT`, it's trimmed structurally instead of sliced as text. Budget is allocated depth-first, proportional to each branch's size; a branch that doesn't fit collapses to an `{id, name, type, _stub:true}` marker instead of being silently dropped, so every top-level section stays visible and the agent can re-fetch a stubbed branch by its `id`. Only a genuinely unparseable response (`parseSkip`) falls back to a raw text slice.

---

## Requirements

- Node.js 18+
- npm

---

## Installation

```bash
git clone https://github.com/ZenyaDAR/PlayGuard.git
cd playguard
npm install
npm run build
```

---

## Usage

### Claude Code

Add to `~/.claude/claude_desktop_config.json` (or your project's `.claude/settings.json`):

**Browser only:**

```json
{
  "mcpServers": {
    "playguard": {
      "command": "node",
      "args": ["/path/to/playguard/dist/index.js"],
      "env": {
        "PLAYGUARD_SCREENSHOTS": "redirect"
      }
    }
  }
}
```

**Browser + Figma:**

```json
{
  "mcpServers": {
    "playguard": {
      "command": "node",
      "args": ["/path/to/playguard/dist/index.js"],
      "env": {
        "PLAYGUARD_SCREENSHOTS": "redirect",
        "FIGMA_MCP_CMD": "npx @figma/mcp",
        "FIGMA_API_KEY": "your-figma-api-key",
        "FIGMA_CACHE_TTL": "60000"
      }
    }
  }
}
```

Do **not** add Playwright MCP separately — PlayGuard spawns it automatically from its bundled dependency.

### Claude Desktop

Same JSON format. Config file locations:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

### Windows paths

Use forward slashes in JSON strings. Spaces in paths do not need escaping:

```json
"args": ["C:/Users/YourName/projects/playguard/dist/index.js"]
```

---

## Environment Variables

### Playwright

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYGUARD_SCREENSHOTS` | `warn` | `allow` / `warn` / `block` / `redirect` |
| `PLAYGUARD_COMPACT` | `true` | Set `false` to disable compact snapshots and receive the raw accessibility tree |
| `PLAYGUARD_DELTA` | `true` | Set `false` to disable delta snapshots |
| `PLAYGUARD_DELTA_THRESHOLD` | `0.4` | Fraction of lines that must change to trigger a full snapshot instead of a delta (0–1) |
| `PLAYGUARD_TOKEN_BUDGET` | `0` | Max tokens per snapshot; truncates on a line boundary so `[ref=]` tags are never split. `0` = off |
| `PLAYGUARD_HINT_THRESHOLD` | `4` | After N consecutive snapshots without any action, inject a hint listing available interactive refs |
| `PLAYGUARD_PREFETCH_SNAPSHOT` | `true` | Set `false` to disable background snapshot prefetch after `browser_navigate` |
| `PLAYGUARD_EVAL_CACHE_TTL` | `500` | `browser_evaluate` cache TTL in ms. `0` = off |
| `PLAYGUARD_EVAL_COMPACT` | `10000` | Max characters for eval output. `0` = off |
| `PLAYWRIGHT_MCP_CMD` | bundled binary | Override the Playwright MCP command |
| `PLAYWRIGHT_MCP_ARGS` | — | Extra arguments passed to Playwright MCP (space-separated; wrap an argument in `"..."` or `'...'` if it contains a space, e.g. a path) |
| `PLAYGUARD_LOG_DIR` | `logs/` | Override the NDJSON analytics log directory |

### Figma

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_MCP_CMD` | — | Figma MCP launch command. Unset = Figma disabled |
| `FIGMA_MCP_ARGS` | — | Extra arguments for Figma MCP (space-separated; wrap an argument in `"..."` or `'...'` if it contains a space) |
| `FIGMA_CACHE_TTL` | `0` | Figma response cache TTL in ms. `0` = off |
| `FIGMA_SVG_REFS` | `true` | Set `false` to keep SVG geometry inline |
| `FIGMA_TEXT_COMPACT` | `10000` | Max characters for the Figma text response. When the optimizer parsed the tree, an over-budget response is trimmed structurally (Module 7) — branches collapse to `{id,name,type}` stubs, never silently disappear. Only falls back to a raw text slice if the response never parsed (`parseSkip`). `0` = off |
| `FIGMA_API_KEY` | — | Forwarded to the Figma MCP child process |

---

## Configuration Examples

**Headless browser + Figma with cache:**
```json
"env": {
  "PLAYWRIGHT_MCP_ARGS": "--headless",
  "FIGMA_MCP_CMD": "npx @figma/mcp",
  "FIGMA_API_KEY": "your-figma-api-key",
  "FIGMA_CACHE_TTL": "120000"
}
```

**Firefox + block screenshots:**
```json
"env": {
  "PLAYWRIGHT_MCP_ARGS": "--browser firefox",
  "PLAYGUARD_SCREENSHOTS": "block"
}
```

**Persist cookies between sessions:**
```json
"env": {
  "PLAYWRIGHT_MCP_ARGS": "--storage-state /tmp/browser-state.json"
}
```

**Redirect screenshots + hard token cap:**
```json
"env": {
  "PLAYGUARD_SCREENSHOTS": "redirect",
  "PLAYGUARD_TOKEN_BUDGET": "4000"
}
```

---

## Analytics

All tool calls are logged to `logs/YYYY-MM-DD.ndjson`. Run the report:

```bash
npm run analyze
```

Sample output:

```
── Snapshot token savings ────────────────────────────────
  Cache hits:      12/47 snapshots (8 from prefetch)
  Bytes saved by cache:    84.3 KB  (~21 075 tokens)
  Bytes saved by compact:  312.1 KB (~78 025 tokens)
  Total saved:             396.4 KB (~99 100 tokens)
  Reduction vs raw:        83%  (82.1 KB sent vs 478.5 KB without PlayGuard)

── PlayGuard interceptions ───────────────────────────────
  Screenshot → snapshot: 5 redirected (2 from cache, ~18 400 tokens saved)
  Eval cache hits:       8/11 evaluates (~240ms saved at 30ms avg)

── Figma optimizer ───────────────────────────────────────
  Calls:       24 total  (6 cache hits, 18 optimized)
  Tokens in:   ~71 000  →  out: ~22 750  (saved ~48 250, -68%)

── Latency by tool ───────────────────────────────────────
| tool              | count | errors | err% | intercepted | avg ms | p50 | p95 |
```

Each NDJSON line includes all fields for downstream analysis:
- **Playwright:** `rawBytes`, `keptBytes`, `savedBytes`, `delta`, `cacheHit`, `prefetchHit`, `snapCount`, `scriptHash`
- **Figma:** `fileKey`, `nodeId`, `inBytes`, `outBytes`, `savedTokens`, `metaKeysDeleted`, `invisiblePruned`, `svgRefsReplaced`, `instancesCollapsed`, `layoutCoordsRemoved`

---

## Benchmark

```bash
npm run bench
```

Measures proxy overhead, snapshot vs screenshot size, cache hit rate, and crash recovery time. No LLM in the loop — raw numbers only.

---

## Tests

```bash
npm test
```

Covers `collapseRuns`, `compactSnap` (including token budget boundary), the full Figma optimizer pipeline (`optimizeFigmaResponse`), and the structural budget trim (`budgetTrimFigma`) in `test/playguard.test.mjs`, plus `dead()` crash detection, `splitArgs()` quoting, the shared `ttlCache()` helper, and the `decideSnapshot()` cache/delta/hint decision logic, and the Module 8 Framelink-shape optimizations in `test/playguard-core.test.mjs`.

CI (GitHub Actions, `.github/workflows/ci.yml`) runs `npm test` on every push and pull request to `main`.

---

## Comparison

| Scenario | Without PlayGuard | With PlayGuard |
|----------|-------------------|----------------|
| Browser crashes | Error; session broken | Auto-recovery; agent never sees it |
| Concurrent calls during crash | Two failures or two browsers | One restart; both calls continue |
| `browser_snapshot` (full tree) | 100–500 KB | 10–80 KB after compact |
| Repeated `browser_snapshot` same page | Re-fetches every time | Cache hit or `UNCHANGED` |
| Figma file with 50+ components | 200–500 KB JSON | 60–150 KB after optimization |
| Two MCPs in agent config | Two separate servers | One PlayGuard |
| Proxy overhead | None | ~1–3 ms per Playwright call |

---

## Project Structure

```
playguard/
├── src/
│   └── index.ts                    All server logic (~980 lines)
├── dist/                           Compiled output (generated by npm run build)
├── bench/
│   ├── run.mjs                     Benchmark: latency, token savings, crash recovery
│   └── analyze.mjs                 Analytics report from NDJSON logs
├── test/
│   ├── playguard.test.mjs          Compact/Figma optimizer tests (Node built-in test runner)
│   └── playguard-core.test.mjs     Crash detection, arg parsing, caching, snapshot decision tests
├── .github/workflows/ci.yml        Runs npm test on push/PR
├── logs/                           Per-day NDJSON call logs (auto-created at runtime)
├── package.json
└── tsconfig.json
```

---

## License

MIT
