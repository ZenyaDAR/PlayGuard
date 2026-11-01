# PlayGuard

**A proxy MCP: one MCP server in your client config that runs several MCP servers under the hood, exposes all their tools through a single connection, and optimizes their responses.**

You add `playguard` to your MCP client once. Which upstream MCPs it starts is decided by environment variables in that one config entry — an upstream without its variable is not started and its tools are not listed. Every response passes through PlayGuard on the way back, which adds:

- **One connection, several upstreams** — [Playwright MCP](https://github.com/microsoft/playwright-mcp) (bundled, always on), Figma (Framelink or the official desktop server), [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), Shopify Dev MCP and Context7. A failing optional upstream only removes its own tools; the others keep working
- **Token optimization** — compact/delta/`UNCHANGED` snapshots, Figma tree trimming, network-list summaries, rewritten documentation answers; browser snapshot cost drops 70–90%
- **Session recovery** — dead browser sessions and crashed upstream processes are revived; the agent doesn't see the crash
- **Caching** — snapshot, `browser_evaluate`, Figma and on-disk documentation caches
- **Screenshot policy** — redirect, warn, block, or allow screenshot calls
- **Logged savings** — every call is written to an NDJSON log; `npm run analyze` reports tokens saved per upstream
- **Two tools of its own** — `playguard_a11y_audit` (axe-core in the Playwright page) and `playguard_compare_design` (Figma node vs live DOM element, Framelink only)

Works with Claude Code, Claude Desktop, Cursor, Codex, or any MCP-compatible agent.

**Website:** [playguard.dev](https://playguard.dev/) · **Docs:** [How PlayGuard works](https://playguard.dev/docs/)

---

## Upstream MCPs at a glance

| Upstream | Enable with | What PlayGuard optimizes | Details |
|----------|-------------|--------------------------|---------|
| **Playwright MCP** (`@playwright/mcp`, bundled) | always on | Compact / delta / `UNCHANGED` snapshots, snapshot filters, session recovery, screenshot policy, eval cache, `--codegen none`, batching hints | [Browser](#browser-playwright) |
| **Figma, Framelink** (`figma-developer-mcp`) | `FIGMA_MCP_CMD` + `FIGMA_API_KEY` (any Figma plan) | Optimizer modules, structural budget trim, cache, `playguard_compare_design` | [Figma Optimizer](#figma-optimizer) |
| **Figma, official desktop server** | `FIGMA_MCP_URL=http://127.0.0.1:3845/mcp` (no key; Figma desktop app + Dev/Full seat on a paid plan) | Passthrough, whole responses, no cache | [Official Figma MCP](#official-figma-mcp-desktop-server) |
| **Chrome DevTools MCP** | `DEVTOOLS_MCP_CMD` | Network summary, request trim, snapshot compaction, trace trim, error hints, privacy launch defaults | [Chrome DevTools MCP](#chrome-devtools-mcp-optional) |
| **Shopify Dev MCP** | `SHOPIFY_DEV_MCP_CMD` | Response rewrites, disk cache, `UNCHANGED` repeats, compacted `tools/list` | [Documentation MCPs](#documentation-mcps-shopify-dev-and-context7-optional) |
| **Context7** | `CONTEXT7_MCP_CMD` | Response rewrites, disk cache, `UNCHANGED` repeats, compacted `tools/list` | [Documentation MCPs](#documentation-mcps-shopify-dev-and-context7-optional) |

Figma is one option at a time: Framelink or the official desktop server (`FIGMA_MCP_URL` wins if both are set). Figma's remote server (`mcp.figma.com`) can't be proxied — see [Official Figma MCP](#official-figma-mcp-desktop-server).

### Choosing upstreams

The `env` block of the `playguard` entry decides what runs. Nothing to install separately: Playwright MCP ships with PlayGuard, the others are launched through the command you give. For example, Playwright + Framelink Figma + Shopify Dev:

```json
{
  "mcpServers": {
    "playguard": {
      "command": "npx",
      "args": ["-y", "playguard@latest"],
      "env": {
        "PLAYGUARD_SCREENSHOTS": "redirect",
        "FIGMA_MCP_CMD": "npx",
        "FIGMA_MCP_ARGS": "-y figma-developer-mcp --stdio",
        "FIGMA_API_KEY": "your-figma-api-key",
        "SHOPIFY_DEV_MCP_CMD": "npx -y @shopify/dev-mcp@latest"
      }
    }
  }
}
```

Remove a variable to drop that upstream. **Restart the MCP client after changing the config** — the server and its upstreams are started once per client session.

---

## Architecture

```
Claude Code / Claude Desktop / Cursor / Codex
           │
           │  MCP (stdio) — one connection
           ▼
   ┌───────────────────┐
   │     PlayGuard     │  proxy MCP
   │                   │
   │  • router         │  browser_*          → Playwright MCP        (always)
   │  • recovery       │  Figma tools        → Framelink / Figma     (FIGMA_MCP_CMD / _URL)
   │  • optimizers     │  DevTools tools     → Chrome DevTools MCP   (DEVTOOLS_MCP_CMD)
   │  • caches         │  Shopify docs tools → Shopify Dev MCP       (SHOPIFY_DEV_MCP_CMD)
   │  • analytics      │  Context7 tools     → Context7              (CONTEXT7_MCP_CMD)
   │  • own tools      │  playguard_a11y_audit, playguard_compare_design
   └─────────┬─────────┘
             │  one child process per enabled upstream
   ┌─────────┼───────────┬──────────┬───────────┬──────────┐
   ▼         ▼           ▼          ▼           ▼          ▼
Playwright  Figma     Chrome     Shopify    Context7   (each optional
  MCP       MCP      DevTools    Dev MCP                except Playwright)
   │                    │
   ▼                    ▼
Chromium / Firefox / WebKit    Chrome (its own instance)
```

Every upstream except Playwright is optional. If none of `FIGMA_MCP_CMD`, `FIGMA_MCP_URL`, `DEVTOOLS_MCP_CMD`, `SHOPIFY_DEV_MCP_CMD` and `CONTEXT7_MCP_CMD` is set, PlayGuard runs with Playwright only. Playwright MCP is bundled as a dependency — no separate installation required. Optional upstreams start lazily and are isolated from each other; `tools/list` waits a bounded time for a slow one and announces its tools later with `tools/list_changed`.

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

#### Snapshot Filtering

For pages where even the compact tree is large, `browser_snapshot` accepts optional params to narrow the result to one subtree:

- `section` — return only the landmark subtree whose label starts with or contains this string (e.g. `"form"`, `"navigation \"Footer\""`)
- `around` — return only the landmark subtree containing this `[ref=N]`, useful once you know a specific element's ref
- `depth` — cap the returned subtree's depth (combine with `section`/`around` for a high-level overview first, or use alone to flatten the whole tree)

Falls back to the full snapshot with a `[PlayGuard: ... not found]` warning if the requested section/ref doesn't exist. Switching filters between calls always forces a fresh snapshot — it never returns a stale `UNCHANGED`/cached result from a differently-filtered request.

#### Smart Wait

Set `PLAYGUARD_SMART_WAIT=1` to have `browser_snapshot` retry when a page looks mid-load — few interactive refs plus a loading/spinner/skeleton indicator in the text. Retries `PLAYGUARD_SMART_WAIT_MAX_RETRIES` times, `PLAYGUARD_SMART_WAIT_MS` apart, before returning (with a warning if it still looks like it's loading). Off by default — it adds latency to every snapshot call.

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

An unchanged page returns `UNCHANGED` without hitting the browser.

Optional prefetch (`PLAYGUARD_PREFETCH_SNAPSHOT=true`, off by default since 0.8.0): after `browser_navigate`, PlayGuard fetches a snapshot in the background so the next `browser_snapshot` is served from cache. It only pays off for agents that snapshot right after navigating — any `browser_evaluate` or action in between discards it, and the background call competes with that action for the browser.

#### Shorter Playwright Responses

PlayGuard starts the bundled Playwright MCP with `--codegen none`, which drops the `### Ran Playwright code` block from every response (80–150 characters per call). Not applied to a custom `PLAYWRIGHT_MCP_CMD` or when `--codegen` is already in `PLAYWRIGHT_MCP_ARGS`; set `PLAYGUARD_CODEGEN=keep` to restore it.

#### Batching Hints

Every `browser_evaluate` / `browser_run_code_unsafe` call waits at least ~0.5 s inside Playwright MCP for the page to settle. PlayGuard appends a one-line hint to those tools' descriptions (and to `browser_wait_for`) nudging the agent to combine checks into fewer calls. `PLAYGUARD_HINTS=false` turns this off.

#### Screenshot Policy

| Mode | Behavior |
|------|----------|
| `warn` (default) | Screenshot executes; warning written to stderr |
| `redirect` | Replaced with `browser_snapshot`. Pass `{visual:true}` for a real screenshot; a call with `filename`, `element`/`ref`/`target` or `fullPage` always gets pixels |
| `block` | Blocked with an error; agent is told which env var to change |
| `allow` | No restriction |

#### Eval Cache + Output Compaction

Repeated `browser_evaluate` calls with the same script on the same URL are served from cache (configurable TTL). Large eval output is truncated to a character limit to avoid blowing the context window.

#### Accessibility Audit

`playguard_a11y_audit` runs [axe-core](https://github.com/dequelabs/axe-core) (bundled) inside the page the `browser_*` tools have open and returns a short report instead of axe's raw JSON:

```
[PlayGuard a11y: 6 violations (6 elements) · 7 rules passed · axe 4.14.0 · wcag2a,wcag2aa,… · https://shop.test/]

critical image-alt — Images must have alternative text (1)
  - img  <img src="…" class="hero">
    Element does not have an alt attribute (+4 more)
  https://dequeuniversity.com/rules/axe/4.14/image-alt

serious  color-contrast — Elements must meet minimum color contrast ratio thresholds (1)
  - main > p  <p style="color:#bbb">Low contrast text</p>
    Element has insufficient color contrast of 1.91 (foreground color: #bbbbbb, …). Expected contrast ratio of 4.5:1
```

Rules are sorted by impact; each lists at most 5 elements (the rest are counted) with a CSS selector, a 140-char html excerpt and the first way to fix it. Rules axe could not decide are named under "Needs manual review".

| Param | Default | |
|-------|---------|---|
| `selector` | whole page | Audit only this part, e.g. `#cart-drawer` — open a dialog first, then audit it |
| `tags` | `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` | Replaces the default. To add `best-practice` (non-WCAG advice) or `wcag2aaa`, pass the defaults plus it. A single string is accepted; any tag that matches no axe rule (a typo) is an error, not a clean report |

Automated checks don't cover keyboard flow or screen-reader wording. The page keeps axe loaded after the first audit.

---

### Figma Optimizer

PlayGuard intercepts Figma MCP responses and runs them through an optimization pipeline before delivering to the agent.

```
[PlayGuard figma: -68% (284.0KB→91.0KB)]
```

> **Note:** Modules 1–4 and 6 target raw Figma REST API JSON (`document.children`, `componentId`, `fillGeometry`). If your Figma MCP upstream returns pre-simplified YAML (e.g. Framelink `figma-developer-mcp`), those modules find nothing to strip — Module 8 handles that shape instead — and `inBytes`/`outBytes` are still measured from the actual upstream response text, so the automatic YAML→JSON reformatting (typically ~2x on its own) and Module 5's metadata trim both still count as real savings. `parseSkip` in the NDJSON log means the response body couldn't be parsed as JSON or YAML at all, not that the optimizer no-op'd. Framelink 0.13+ defaults to a `tree` text format that is neither, so PlayGuard starts the Figma child with `OUTPUT_FORMAT=json` unless you set `OUTPUT_FORMAT` yourself (`yaml` and `json` both work; `tree` disables the optimizer and `playguard_compare_design`).

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

### Official Figma MCP (desktop server)

Instead of Framelink you can route Figma's own MCP server through PlayGuard. No API key goes in the config: the Figma desktop app's login authorizes it.

```json
"env": {
  "FIGMA_MCP_URL": "http://127.0.0.1:3845/mcp"
}
```

1. Open the Figma desktop app (latest version), switch to Dev Mode (Shift+D) and click **Enable desktop MCP server** in the Inspect panel.
2. Needs a **Dev or Full seat on a paid plan** — Figma's requirement, not PlayGuard's.

Its tools (`get_design_context`, `get_metadata`, `get_variable_defs`, `get_screenshot`, …) are merged into the tool list. They return generated code and XML rather than a JSON style tree, so PlayGuard passes them through whole — never sliced by `FIGMA_TEXT_COMPACT`. `FIGMA_CACHE_TTL` does not apply either: without a `nodeId` the server answers from the current selection in the app and reflects live edits. `playguard_compare_design` needs Framelink; it is not listed in this mode and says so if called. If the app is closed or started after PlayGuard, a Figma call returns how to turn the server on; once it is up, the next call connects, its tools are registered and the client is told to re-list (`tools/list_changed`). A server error for one call never drops the connection other calls are using; only a transport failure does, and a call is retried once only when it certainly never reached the server. Credentials in the URL are kept out of messages and logs. `FIGMA_MCP_URL` wins when `FIGMA_MCP_CMD` is also set.

| | Framelink (`FIGMA_MCP_CMD`) | Official desktop (`FIGMA_MCP_URL`) |
|---|---|---|
| Config | `FIGMA_API_KEY` | URL only, sign-in is the Figma app's |
| Figma plan | any, free included | Dev/Full seat on a paid plan |
| Returns | JSON node tree | React + Tailwind code, variables, screenshots |
| PlayGuard optimizer, `playguard_compare_design` | yes | no (passthrough) |

**Figma's remote server (`https://mcp.figma.com/mcp`, browser sign-in) can't go through PlayGuard**: Figma only admits clients listed in its MCP catalog. Setting that URL is refused at startup with this explanation. Add it to your MCP client directly, next to PlayGuard (Claude Code: `claude mcp add --transport http figma https://mcp.figma.com/mcp`); its responses then skip PlayGuard. On the remote server, Figma limits Starter-plan users and View/Collab seats to 6 tool calls a month.

---

### Design Diff

`playguard_compare_design` compares a Figma node against the live DOM element that implements it and reports the exact differences — no screenshots, no eyeballing.

```
[PlayGuard design diff: 42:1337 → [data-testid="login-btn"] 2 mismatches, 6 matches]

  fontSize:        Figma 16px              → Browser 14px              ⚠️  MISMATCH (+2.0px)
  color:           Figma rgb(255, 255, 255)→ Browser rgb(255, 255, 255) ✓  MATCH
  backgroundColor: Figma rgb(25, 118, 210) → Browser rgb(25, 118, 210) ✓  MATCH
  padding:         Figma 12px 24px 12px 24px → Browser 12px 16px 12px 16px ⚠️  MISMATCH (Δright:+8px, Δleft:+8px)
  borderRadius:    Figma 8px               → Browser 8px 8px 8px 8px   ✓  MATCH
```

Three modes:

| Mode | Arguments | Use |
|------|-----------|-----|
| Single | `figmaNodeId` + `browserSelector` | One element |
| Batch | `pairs: [{figmaNodeId, browserSelector}, …]` | Several at once; one bad selector doesn't sink the rest |
| Auto-map | `figmaNodeId` + `autoMap: true` | Point at a component; layers beneath are matched to DOM elements by `data-figma-id`, `data-testid`, `id`, `class`, or exact text |

Notes on how it decides:

- **Properties are auto-selected per node.** A TEXT layer gets its typography and colour; a container gets `backgroundColor`/`padding`/`borderRadius`/`boxShadow`. Pass `properties[]` to override.
- **Tolerances.** Sizes compare within `PLAYGUARD_DESIGN_DIFF_TOLERANCE_PX`, colours within `PLAYGUARD_DESIGN_DIFF_TOLERANCE_COLOR` per channel. Box properties (`padding`, `margin`, `borderRadius`, `borderWidth`) compare side-by-side, so `8px 8px 0 0` never passes as `8px`.
- **Unset ≠ unknown.** A property Figma leaves unset but CSS zero-defaults (no shadow, no border) is still checked, so a stray browser value is caught. `margin` is the exception — Figma has no margin concept, so it is reported as unknown rather than as a defect.
- **Typography follows the label.** A button's font size is read from its TEXT layer at any depth, and its background is never mistaken for its text colour.
- **`width`/`height` are never auto-selected** — they depend on the viewport, not the design. Request them explicitly and a warning rides along.
- **Auto-map never guesses.** A candidate selector matching zero or several elements is reported as unmapped, not silently attached to the wrong element.
- **A missing node is an error, not a substitute.** A `figmaNodeId` the upstream response doesn't contain fails that pair, rather than falling back to whatever the response's root frame happens to be.

Both upstream shapes are handled: the raw Figma REST API node JSON (any upstream that returns it unchanged) and Framelink's pre-simplified `globalVars.styles` form (`figma-developer-mcp`).

---

### Chrome DevTools MCP (optional)

[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) (`chrome-devtools-mcp`, by Google) is an opt-in third upstream. Its tools (`take_snapshot`, `list_network_requests`, `get_network_request`, `list_console_messages`, `performance_start_trace`, `lighthouse_audit`, `get_css_styles`, …) are merged into PlayGuard's tool list under their own names and routed to it.

Use it for what Playwright MCP does not cover well: request/response headers and bodies, performance traces and insights, Lighthouse audits, computed CSS. For clicking through a flow, keep using the `browser_*` tools — they have session recovery and the cheaper snapshot pipeline.

```json
"env": {
  "DEVTOOLS_MCP_CMD": "npx -y chrome-devtools-mcp@latest",
  "DEVTOOLS_MCP_ARGS": "--headless --isolated"
}
```

PlayGuard starts the upstream lazily (on the first `tools/list` or call), so the first start can include an `npx` download. `tools/list` waits up to `PLAYGUARD_LIST_WAIT_MS` (6 s) for it, then lists without it and sends `notifications/tools/list_changed` once its tools are in. The same bounded wait applies to the Figma upstream. A DevTools failure only removes the DevTools tools — Playwright and Figma keep working.

#### Two browsers

chrome-devtools-mcp launches **its own Chrome**, separate from Playwright's. Pages, cookies, logins and element ids are not shared: DevTools `uid=` values only work with DevTools tools, `[ref=]` values only with `browser_*` tools, and a DevTools tool only sees pages opened with `navigate_page`/`new_page`. PlayGuard says this in the server `instructions` and on `new_page`, `navigate_page` and `list_pages`, and points the agent at `browser_network_requests` / `browser_console_messages` for a page driven by `browser_*` tools.

By default the upstream keeps a persistent profile in `~/.cache/chrome-devtools-mcp/`. A second chrome-devtools-mcp instance on the same profile (another agent, another client) fails with `The browser is already running for … Use --isolated to run multiple browser instances.` — pass `--isolated` in `DEVTOOLS_MCP_ARGS` for a throwaway profile.

**Advanced: one shared Chrome.** To make both upstreams drive the same browser, start Chrome yourself with remote debugging and point both at it:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/pg-chrome
```

```json
"env": {
  "PLAYWRIGHT_MCP_ARGS": "--cdp-endpoint http://127.0.0.1:9222",
  "DEVTOOLS_MCP_CMD": "npx -y chrome-devtools-mcp@latest",
  "DEVTOOLS_MCP_ARGS": "--browserUrl http://127.0.0.1:9222"
}
```

Pages and cookies are then shared, but ids still are not (each upstream numbers elements its own way). Nobody owns the browser any more: if it crashes or you close it, PlayGuard's Playwright session recovery cannot relaunch it, and neither can chrome-devtools-mcp. The flags exist in `@playwright/mcp` 0.0.76 (`--cdp-endpoint`) and `chrome-devtools-mcp` 1.12 (`--browserUrl`).

#### What PlayGuard changes

| Tool | Change | Get the upstream response |
|------|--------|---------------------------|
| `tools/list` | Drops `$schema` from every schema; adds the `raw` param; adds the two-browser note to the navigation tools and a summary note to `list_network_requests` | `PLAYGUARD_DEVTOOLS_OPTIMIZE=false` |
| `take_snapshot` (and any action with `includeSnapshot: true`) | Same-origin urls become paths, image urls are dropped (kept with `verbose: true`), text/image leaves that repeat their parent's name are dropped — every uid of an interactive node survives. A repeat of an unchanged page is one `[PlayGuard: UNCHANGED …]` line; a small change is `ADDED:`/`REMOVED:` lines only. Any non-read-only call clears the `UNCHANGED` shortcut | `raw: true`, or `PLAYGUARD_COMPACT=false` / `PLAYGUARD_DELTA=false` |
| `list_network_requests` | Without `pageSize`/`pageIdx`/`resourceTypes`/`includePreservedRequests`, a list longer than `PLAYGUARD_DEVTOOLS_NETWORK_MAX` (30) rows becomes a summary: the main document, failed (4xx/5xx/`net::ERR_*`) and pending rows, per-host counts, and how to page | Pass any of those params, e.g. `pageSize: 100` |
| `get_network_request` | Noisy headers (`accept*`, `user-agent`, `sec-ch-ua*`, `sec-fetch-*`, `report-to`, `alt-svc`, …) collapse to one line; a CSP over 200 chars is replaced by its length; a non-JSON body over `PLAYGUARD_DEVTOOLS_BODY_MAX` (3000) chars is cut with a pointer to `responseFilePath`. Cookies, `location`, `content-type`, `cache-control`, `authorization` and every `x-*` header are kept. JSON bodies are never cut (upstream already caps bodies at 10K) | `raw: true` |
| `performance_start_trace` / `performance_stop_trace` | Drops "example question" lines and markdown link targets; insight set ids and names stay | `raw: true` |
| `take_screenshot` | `PLAYGUARD_SCREENSHOTS` applies. In `redirect` mode the call becomes `take_snapshot` unless it passes `visual: true`, `filePath`, `uid` or `fullPage` | `visual: true` |
| Errors | Five opaque upstream errors (element not interactive, stale uid, no page selected, path outside the workspace, unknown reqid) get a one-line `[PlayGuard]` hint with the next step | `PLAYGUARD_DEVTOOLS_OPTIMIZE=false` |

`raw` is a PlayGuard-only param on `take_snapshot`, `get_network_request` and the two trace tools; it is stripped before the call reaches the upstream. `PLAYGUARD_DEVTOOLS_OPTIMIZE=false` turns off every rewrite above (screenshot policy and the restart notices still apply).

Measured with chrome-devtools-mcp 1.12 on real sites (upstream → sent):

| Response | Saving |
|----------|--------|
| `list_network_requests` | Shopify store 34K → ~1K chars (−97%); Wikipedia 7.6K → ~0.6K (−92–95%). Lists of ≤30 rows are untouched |
| `get_network_request`, HTML document | −63–72% |
| `get_network_request`, JSON body | ~−20% (headers only) |
| `take_snapshot` | −3% (small clean page) to −40% (image-heavy store). A repeated unchanged snapshot: one ~40-char line instead of 10–46K. After a small change: only the added/removed lines |
| Performance trace | −13% |
| DevTools `tools/list` | 26.4K vs 28.9K chars: −3% from schema cleanup, plus `--no-page-id-routing` removes `pageId` from 30 of 32 tools |

#### Launch defaults and privacy

Unless the same option is already in `DEVTOOLS_MCP_CMD`/`DEVTOOLS_MCP_ARGS` (any spelling: `--x`, `--no-x`, `--x=false`, camelCase), PlayGuard appends:

- `--no-usage-statistics` — upstream otherwise sends usage statistics to Google
- `--no-performance-crux` — upstream otherwise sends every traced URL to Google's CrUX API
- `--no-page-id-routing` — removes the required `pageId` param from 30 of 32 tools; a single agent behind one proxy does not need it
- `--workspace <project root>` (plus `--workspace <output dir>/.qa` when `PLAYGUARD_OUTPUT_DIR` is outside the project) — unless `--workspace`, `--filesystemRoot` or `--allowUnrestrictedPaths` is already given. Without it, chrome-devtools-mcp only lets file tools touch the OS temp dir

To keep an upstream default, pass the flag yourself (e.g. `--usage-statistics`), or set `PLAYGUARD_DEVTOOLS_DEFAULTS=false` to append none of the above (workspace included). Options set in a `--config` JSON file are not detected, and the appended CLI flags win over them.

The upstream process also gets:

- **A filtered environment.** Only the MCP SDK's default set (`PATH`, `HOME`, …) plus `CHROME_DEVTOOLS_MCP_*`, `PUPPETEER_*`, `npm_config_*`, `XDG_*`, `LC_*`, proxy (`HTTP(S)_PROXY`, `NO_PROXY`), display and temp-dir variables. API keys and cloud credentials in PlayGuard's environment (`FIGMA_API_KEY`, …) are not forwarded.
- **`CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`**, which turns off the upstream's own daily npm check. Set it to an empty string in PlayGuard's `env` to re-enable it.

#### Files, timeouts, recovery

- **Paths.** The upstream runs with `.playguard/.qa` as its working directory, so a relative `filePath`/`responseFilePath`/`requestFilePath` lands there. Absolute paths must be inside the project or the OS temp dir.
- **Timeouts.** `lighthouse_audit`, `performance_start_trace`, `performance_stop_trace` and `take_heapsnapshot` get a 180 s request timeout instead of the SDK's 60 s.
- **Upstream process died** (between calls or mid-call): PlayGuard respawns it once, reopens the last URL opened with `navigate_page`/`new_page`, retries the call, and prepends a notice that cookies, logins and page state are lost.
- **Chrome restarted by the upstream** (chrome-devtools-mcp relaunches a crashed Chrome itself): nothing to respawn, but cached snapshot state is cleared and the response names the last URL so the agent can `navigate_page` back.

Every DevTools call is logged with `server: "devtools"`; `npm run analyze` reports them in their own section.

### Documentation MCPs: Shopify Dev and Context7 (optional)

Two read-only documentation upstreams, each enabled by its own command (stdio only; remote/HTTP endpoints are not supported yet):

```json
"env": {
  "SHOPIFY_DEV_MCP_CMD": "npx -y @shopify/dev-mcp@latest",
  "CONTEXT7_MCP_CMD": "npx -y @upstash/context7-mcp@latest"
}
```

Optional `SHOPIFY_DEV_MCP_ARGS` / `CONTEXT7_MCP_ARGS` are appended the same way as `DEVTOOLS_MCP_ARGS`. Their tools are merged into the tool list and routed to them; both start lazily, and a failing one leaves every other upstream working; calling one of its tools then returns `[PlayGuard] … MCP is not running: <error>` with what to check. A tool name already taken by another upstream stays there (a warning goes to stderr).

- **Context7** needs Node.js ≥ 20.18.1, the same minimum as PlayGuard. Without a key it allows ~200 calls/day per IP; set `CONTEXT7_API_KEY` (free at context7.com/dashboard) to raise it.
- **Shopify Dev** sends tool inputs and results to shopify.dev by default; PlayGuard starts it with `OPT_OUT_INSTRUMENTATION=true` unless you set that variable yourself.
- **Environment.** Each gets the MCP SDK's default set plus npm, proxy, locale and temp-dir variables. Context7 also gets `CONTEXT7_API_KEY`/`CONTEXT7_API_URL`; Shopify gets `LIQUID_VALIDATION_MODE`, `OPT_OUT_INSTRUMENTATION`, `DO_NOT_TRACK`, `STOREFRONT_WEB_COMPONENTS`, `USE_LEGACY_SEARCH`, `SHOPIFY_AI_TOOLKIT_OPT_OUT_FILE`. Other API keys and host session ids (`CLAUDE_CODE_*`) are not forwarded. Keys never reach the call log or the cache.

#### What PlayGuard changes

| Tool | Change | Measured on recorded output |
|------|--------|-----------------------------|
| `search_docs_chunks` | Indented JSON → `## title` / url / content blocks; drops `score`/`domain`, exact duplicate chunks, and a byte-identical chunk whose URL differs only in the API version (its URL goes on an `also:` line; content that differs at all is kept). Content is never cut | −19% to −20% |
| `learn_shopify_api` | Escaped ``\` `` fences are unescaped. Always returned whole, even on a repeat: it is the routing guide | −254 chars on `liquid` |
| `validate`, `validate_theme` | Never rewritten, never cached | — |
| Shopify `tools/list` | Hides `feedback` (telemetry only), drops the telemetry params `model`/`user_prompt`, makes `conversationId` optional — PlayGuard fills in one id per process when it is omitted | 26.6K → 21.3K chars (−20%) |
| `resolve-library-id` | One line per library: id, title, snippets, reputation, benchmark, versions (minus `__branch__*` junk), description cut to ~90 chars. Every id and the order are kept | −48% to −50% |
| `query-docs` | GitHub `Source:` URLs become `org/repo@ref:path`; an exact duplicate snippet is dropped. Split only on the 32-dash separator; code is never touched | −1% to −2% |
| Context7 `tools/list` + instructions | Shorter descriptions; all params, types, required lists and annotations kept | 5.9K → 2.6K chars (−56%) |

Every rewrite checks the format first and passes the response through unchanged when it doesn't recognise it (logged as `parseSkip`). `PLAYGUARD_DOCS_OPTIMIZE=false` turns all of them off; `raw: true` on `search_docs_chunks`, `learn_shopify_api`, `resolve-library-id` and `query-docs` skips them for one call (stripped before forwarding).

#### Cache

`search_docs_chunks`, `resolve-library-id` and `query-docs` results are cached on disk in `.playguard/.cache/docs/` for `PLAYGUARD_DOCS_CACHE_TTL` seconds (24 h; a version-pinned Context7 id like `/vercel/next.js/v16.2.9` keeps 7×). The key is the tool and its arguments (minus `conversationId`); errors are never cached. An identical call to one of these three repeated within the same PlayGuard process returns a one-line `UNCHANGED` note instead of the whole answer again. The process outlives `/compact` and `/clear` and is shared by subagents, so the note tells the agent to call again with `raw: true` if it no longer has the earlier answer. Cache files are written atomically; expired ones are not swept.

Every call is logged with `server: "shopify-dev"` or `"context7"` (`cached: true` on a cache hit, `repeat: true` on an UNCHANGED note); `npm run analyze` reports per-tool savings for each.

---

## Requirements

- Node.js 20.18.1+
- npm

---

## Installation

No install needed — run via `npx`. For local development instead:

```bash
git clone https://github.com/ZenyaDAR/PlayGuard.git
cd playguard
npm install
npm run build
```

---

## Usage

### Claude Code

Add to `.mcp.json` in your project root, or register the server for all projects with `claude mcp add --scope user`:

**Playwright only:**

```json
{
  "mcpServers": {
    "playguard": {
      "command": "npx",
      "args": ["-y", "playguard@latest"],
      "env": {
        "PLAYGUARD_SCREENSHOTS": "redirect"
      }
    }
  }
}
```

**Playwright + Figma (Framelink):**

```json
{
  "mcpServers": {
    "playguard": {
      "command": "npx",
      "args": ["-y", "playguard@latest"],
      "env": {
        "PLAYGUARD_SCREENSHOTS": "redirect",
        "FIGMA_MCP_CMD": "npx",
        "FIGMA_MCP_ARGS": "-y figma-developer-mcp --stdio",
        "FIGMA_API_KEY": "your-figma-api-key",
        "FIGMA_CACHE_TTL": "60000"
      }
    }
  }
}
```

Do **not** add Playwright MCP separately — PlayGuard spawns it automatically from its bundled dependency.

Running from a local clone instead? Use `"command": "node", "args": ["/path/to/playguard/dist/index.js"]`.

### Staying up to date

Keep the `@latest` in `"args": ["-y", "playguard@latest"]`. Without it, npx may keep
running whatever copy it cached first (older npm versions never re-check the registry for a
bare package name), and a global or project-local install of `playguard` is used instead
of the npx copy. With `@latest`, npx checks npm on every start and fetches new releases.

New versions are picked up when the MCP client restarts the server: restart Claude Code /
Cursor / Claude Desktop after an update.

On startup PlayGuard also asks npm for the latest version (in the background, 3 s timeout).
If the running copy is older, it prints how to update to stderr and prepends the same notice
to the first tool result, so the agent tells you. Disable with `PLAYGUARD_UPDATE_CHECK=false`.

Still on an old version? Remove stale copies, then restart the client:

```bash
npm rm -g playguard          # if it was ever installed globally
npx clear-npx-cache          # or delete the _npx folder in your npm cache
```

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
| `PLAYGUARD_PREFETCH_SNAPSHOT` | `false` | Set `true` to prefetch a snapshot in the background after `browser_navigate` |
| `PLAYGUARD_CODEGEN` | — | Set `keep` to stop PlayGuard adding `--codegen none` to the bundled Playwright MCP |
| `PLAYGUARD_HINTS` | `true` | Set `false` to stop appending batching hints to tool descriptions |
| `PLAYGUARD_SMART_WAIT` | `false` | Set `1`/`true` to retry a snapshot that looks mid-load (few refs + a loading/spinner indicator) instead of returning it as-is |
| `PLAYGUARD_SMART_WAIT_MS` | `1000` | Delay between smart-wait retries, in ms |
| `PLAYGUARD_SMART_WAIT_MAX_RETRIES` | `3` | Max smart-wait retries before giving up and returning the snapshot with a warning |
| `PLAYGUARD_SMART_WAIT_MIN_REFS` | `5` | A snapshot with at least this many `[ref=]` elements is never considered "still loading" |
| `PLAYGUARD_EVAL_CACHE_TTL` | `500` | `browser_evaluate` cache TTL in ms. `0` = off |
| `PLAYGUARD_EVAL_COMPACT` | `10000` | Max characters for eval output. `0` = off |
| `PLAYWRIGHT_MCP_CMD` | bundled binary | Override the Playwright MCP command |
| `PLAYWRIGHT_MCP_ARGS` | — | Extra arguments passed to Playwright MCP (space-separated; wrap an argument in `"..."` or `'...'` if it contains a space, e.g. a path). Passing `--output-dir` here takes precedence over `PLAYGUARD_OUTPUT_DIR` |
| `PLAYGUARD_OUTPUT_DIR` | `.playguard/` | Where all on-disk artifacts go, split by origin: `.playguard/.qa/` for everything from the site under test (screenshots, traces, PDFs, downloads, session) and `.playguard/.figma/` for Figma image exports. Defaults to `.playguard/` in the project root instead of the upstream's `.playwright-mcp/` |
| `PLAYGUARD_PROJECT_ROOT` | nearest `.git`/`package.json` above `cwd` | The root `.playguard/` is created in. `process.cwd()` is whatever the MCP client spawned the server with, so it is not trusted; set this to pin the location outright |
| `PLAYGUARD_LOG_DIR` | `logs/` | Override the NDJSON analytics log directory |
| `PLAYGUARD_UPDATE_CHECK` | `true` | Set `false` to skip the startup check for a newer version on npm (offline, CI) |

### Figma

| Variable | Default | Description |
|----------|---------|-------------|
| `FIGMA_MCP_CMD` | — | Figma MCP launch command (Framelink). Unset (and no `FIGMA_MCP_URL`) = Figma disabled |
| `FIGMA_MCP_URL` | — | Official Figma desktop MCP server, `http://127.0.0.1:3845/mcp`. No key needed; wins over `FIGMA_MCP_CMD`. `mcp.figma.com` is refused (catalog-only) |
| `FIGMA_MCP_ARGS` | — | Extra arguments for Figma MCP (space-separated; wrap an argument in `"..."` or `'...'` if it contains a space) |
| `FIGMA_CACHE_TTL` | `0` | Figma response cache TTL in ms. `0` = off. Framelink only |
| `FIGMA_SVG_REFS` | `true` | Set `false` to keep SVG geometry inline |
| `FIGMA_TEXT_COMPACT` | `10000` | Max characters for the Figma text response. When the optimizer parsed the tree, an over-budget response is trimmed structurally (Module 7) — branches collapse to `{id,name,type}` stubs, never silently disappear. Only falls back to a raw text slice if the response never parsed (`parseSkip`). `0` = off |
| `FIGMA_API_KEY` | — | Forwarded to the Figma MCP child process |
| `OUTPUT_FORMAT` | `json` | Output format requested from Framelink (`figma-developer-mcp`). Must be `json` or `yaml` for the optimizer and Design Diff to parse it |

### Chrome DevTools

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVTOOLS_MCP_CMD` | — | Chrome DevTools MCP launch command, e.g. `npx -y chrome-devtools-mcp@latest`. Unset = DevTools disabled |
| `DEVTOOLS_MCP_ARGS` | — | Extra arguments for chrome-devtools-mcp (space-separated; wrap an argument in `"..."` or `'...'` if it contains a space), e.g. `--headless --isolated` |
| `PLAYGUARD_DEVTOOLS_OPTIMIZE` | `true` | Set `false` for a pure passthrough: no response rewriting, no `tools/list` compaction, no error hints |
| `PLAYGUARD_DEVTOOLS_DEFAULTS` | `true` | Set `false` to stop appending `--no-usage-statistics`, `--no-performance-crux`, `--no-page-id-routing` and `--workspace` to the upstream argv |
| `PLAYGUARD_DEVTOOLS_NETWORK_MAX` | `30` | `list_network_requests` with more rows than this (and no paging/filter params) is summarized. `0` = off |
| `PLAYGUARD_DEVTOOLS_BODY_MAX` | `3000` | Max characters of a non-JSON request/response body in `get_network_request`. `0` = off |
| `PLAYGUARD_LIST_WAIT_MS` | `6000` | How long `tools/list` waits for an optional upstream (Figma, DevTools, Shopify Dev, Context7) before listing without it; its tools follow via `tools/list_changed` |

`PLAYGUARD_SCREENSHOTS`, `PLAYGUARD_COMPACT`, `PLAYGUARD_DELTA` and `PLAYGUARD_DELTA_THRESHOLD` apply to DevTools `take_screenshot`/`take_snapshot` too.

### Shopify Dev and Context7

| Variable | Default | Description |
|----------|---------|-------------|
| `SHOPIFY_DEV_MCP_CMD` | — | Shopify Dev MCP launch command, e.g. `npx -y @shopify/dev-mcp@latest`. Unset = disabled |
| `SHOPIFY_DEV_MCP_ARGS` | — | Extra arguments for it |
| `CONTEXT7_MCP_CMD` | — | Context7 MCP launch command, e.g. `npx -y @upstash/context7-mcp@latest` (Node.js ≥ 20.18.1). Unset = disabled |
| `CONTEXT7_MCP_ARGS` | — | Extra arguments for it |
| `CONTEXT7_API_KEY` | — | Forwarded to Context7 only; raises the anonymous ~200 calls/day limit |
| `PLAYGUARD_DOCS_OPTIMIZE` | `true` | Set `false` for a pure passthrough of both: no response rewriting, no repeat notes, no `tools/list` compaction |
| `PLAYGUARD_DOCS_CACHE_TTL` | `86400` | Seconds a doc lookup stays in `.playguard/.cache/docs/` (7× for a version-pinned Context7 id). `0` = off |

### Design Diff

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYGUARD_DESIGN_DIFF_TOLERANCE_PX` | `2` | Size difference, in px, still counted as a match |
| `PLAYGUARD_DESIGN_DIFF_TOLERANCE_COLOR` | `5` | Per-channel RGB difference still counted as a match |

---

## Configuration Examples

**Headless browser + Figma with cache:**
```json
"env": {
  "PLAYWRIGHT_MCP_ARGS": "--headless",
  "FIGMA_MCP_CMD": "npx",
  "FIGMA_MCP_ARGS": "-y figma-developer-mcp --stdio",
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

**Browser + Chrome DevTools (network, performance, Lighthouse):**
```json
"env": {
  "PLAYGUARD_SCREENSHOTS": "redirect",
  "DEVTOOLS_MCP_CMD": "npx -y chrome-devtools-mcp@latest",
  "DEVTOOLS_MCP_ARGS": "--headless --isolated"
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

── Chrome DevTools MCP ───────────────────────────────────
  Calls:       38 total  (2 errors, 1 raw:true)
  Tokens in:   ~61 000  →  out: ~35 400  (saved ~25 600, -42%)
  Snapshots:   9  (3 UNCHANGED, 2 delta)
  network lists summarized   2
  request details trimmed    4

── Latency by tool ───────────────────────────────────────
| tool              | count | errors | err% | intercepted | avg ms | p50 | p95 |
```

Each NDJSON line includes all fields for downstream analysis:
- **Playwright:** `rawBytes`, `keptBytes`, `savedBytes`, `delta`, `cacheHit`, `prefetchHit`, `snapCount`, `scriptHash`; on errors `errText` (≤200 chars) and `thrown` for exceptions; `waitKind`/`waitTime` for `browser_wait_for`; `codeChars`/`codeHash`/`codeSleeps` for `browser_run_code_unsafe`; `fullPage`/`type` for screenshots
- **Figma:** `fileKey`, `nodeId`, `inBytes`, `outBytes`, `savedTokens`, `metaKeysDeleted`, `invisiblePruned`, `svgRefsReplaced`, `instancesCollapsed`, `layoutCoordsRemoved`
- **Chrome DevTools:** `server: "devtools"`, `url`, `rawBytes`/`keptBytes` (every rewritten response, not only snapshots), `cacheHit`, `delta`/`deltaAdded`/`deltaRemoved`, `summarized`/`rows`, `trimmed`, `raw`, `redirected`/`visual`/`blocked`, `hinted`, `retried`/`revived`, `chromeRestarted`, `screenshotBytes`

The DevTools counts in the sample are illustrative. For reference, one full end-to-end DevTools session on a pre-release build reported −42% — indicative, not a benchmark; your ratio depends on which tools the agent calls.

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

Covers `collapseRuns`, `compactSnap` (including token budget boundary), the full Figma optimizer pipeline (`optimizeFigmaResponse`), the structural budget trim (`budgetTrimFigma`), and the artifact-path plumbing — `withOutputDir`, `figmaLocalPath`, and `resolveUpstream`, which locates the Playwright MCP through the module graph — in `test/playguard.test.mjs`, plus `dead()` crash detection, `splitArgs()` quoting, the shared `ttlCache()` helper, the `decideSnapshot()` cache/delta/hint decision logic, the `section`/`around`/`depth` snapshot filtering, the `looksLikeLoading()` smart-wait heuristic, the `sortDeep()` Figma cache-key normalization, and the Module 8 Framelink-shape optimizations in `test/playguard-core.test.mjs`. `test/design-diff.test.mjs` covers the design-diff side: property extraction from both upstream Figma shapes (REST and Framelink), colour/border/typography normalization, node resolution including the not-found case, the comparison and tolerance rules, and the generated auto-map and eval scripts. `test/proxy.test.mjs` drives the built `dist/index.js` over stdio against a fake upstream (`test/fixtures/fake-pw.mjs`), covering the CallTool path end to end: call logging (`errText`, `thrown`, argument shape), the eval cache, snapshot compaction, dead-browser revive, screenshot redirect, prefetch on/off, `--codegen` handling and the batching hints.

The Chrome DevTools side is covered by `test/devtools.test.mjs` (launch defaults, `tools/list` rewrite, network summary, request trim, trace trim, error hints), `test/devtools-snapshot.test.mjs` (snapshot compaction keeps every interactive uid, `UNCHANGED`/delta decisions) and `test/upstream.test.mjs` (lazy spawn and single-flight revive), plus the `devtools:` cases in `test/proxy.test.mjs` against a fake upstream (`test/fixtures/fake-devtools.mjs`): routing, env allowlist, workspace/cwd, the bounded `tools/list` wait, timeouts, screenshot policy, revive and passthrough.

`node bench/smoke-codegen.mjs` (after `npm run build`, needs a browser, not part of `npm test`) checks against the real Playwright MCP that responses carry no codegen block and evaluate results still parse.

`test/a11y.test.mjs` runs the generated axe page script against a stub axe and checks the report; `test/proxy.test.mjs` covers the audit's routing and the official Figma upstream against an in-process HTTP fake (`test/fixtures/fake-figma-http.mjs`): routing, whole passthrough, the unreachable-app error and the refused remote URL. `node bench/smoke-a11y.mjs` (after `npm run build`, needs a browser) audits a local page with known violations through the real Playwright MCP and axe-core.

`node bench/smoke-devtools.mjs` (after `npm run build`, needs Chrome and network, not part of `npm test`) drives PlayGuard against the real chrome-devtools-mcp (`DEVTOOLS_MCP_CMD`, default `npx -y chrome-devtools-mcp@1.12.0`): it acts only on uids read from the compacted snapshot, fills and submits a form, checks `UNCHANGED`/delta, and prints upstream vs sent bytes per tool. Run it with `PLAYGUARD_DEVTOOLS_OPTIMIZE=false` for the passthrough baseline.

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
| Several MCPs in agent config (Playwright, Figma, DevTools, Shopify Dev, Context7) | One server entry per MCP, each with its own tool list | One PlayGuard entry, one connection |
| Chrome DevTools `list_network_requests` on a busy page | 7–34K chars | ~0.6–1K chars summary |
| Repeated documentation lookup (Shopify Dev, Context7) | Network call every time | Disk cache or one-line `UNCHANGED` note |
| Failing optional upstream | Its own error, per server | Only its tools go away; the rest keep working |
| Proxy overhead | None | ~1–3 ms per Playwright call |

---

## Project Structure

```
playguard/
├── src/
│   ├── index.ts                    MCP server: tool routing, proxying, caches
│   ├── config.ts                   Env-derived settings, resolved paths, upstream commands
│   ├── snapshot.ts                 Snapshot compaction and the cache/delta decision
│   ├── figma-optimize.ts           Figma response optimizer (Modules 1–8)
│   ├── design-diff.ts              Figma ↔ browser property extraction and diffing
│   ├── a11y.ts                     axe-core page script and report for playguard_a11y_audit
│   ├── devtools.ts                 Chrome DevTools launch defaults, tools/list, network/trace/error rewrites
│   ├── devtools-snapshot.ts        Chrome DevTools snapshot compaction and UNCHANGED/delta decision
│   ├── docs-optimize.ts            Shopify Dev / Context7 tools/list and response rewrites
│   ├── docs-cache.ts               On-disk cache for documentation lookups
│   └── upstream.ts                 Lazy, self-healing upstream client (DevTools, Shopify Dev, Context7)
├── dist/                           Compiled output (generated by npm run build)
├── bench/
│   ├── run.mjs                     Benchmark: latency, token savings, crash recovery
│   ├── analyze.mjs                 Analytics report from NDJSON logs
│   ├── smoke-codegen.mjs           Real-browser check that --codegen none keeps evaluate parseable
│   ├── smoke-a11y.mjs              Real-browser check of playguard_a11y_audit against a page with known violations
│   ├── smoke-devtools.mjs          Real chrome-devtools-mcp check: compacted uids, UNCHANGED/delta, bytes per tool
│   ├── smoke-docs.mjs              Real Shopify Dev / Context7 check: rewrites, cache, UNCHANGED repeats
│   ├── probe-shopify-dev.mjs       Records raw Shopify Dev MCP responses (fixtures, measurements)
│   └── probe-context7.mjs          Records raw Context7 responses (fixtures, measurements)
├── test/
│   ├── playguard.test.mjs          Compact/Figma optimizer, output-dir routing, upstream resolution
│   ├── playguard-core.test.mjs     Crash detection, arg parsing, caching, snapshot decision
│   ├── design-diff.test.mjs        Property extraction, comparison, auto-map
│   ├── devtools.test.mjs           DevTools launch defaults, tools/list, network/trace/error rewrites
│   ├── devtools-snapshot.test.mjs  DevTools snapshot compaction, UNCHANGED/delta
│   ├── upstream.test.mjs           Lazy spawn and revive of an upstream
│   ├── docs-optimize.test.mjs      Shopify Dev / Context7 rewrites against recorded responses, disk cache
│   ├── a11y.test.mjs               axe page script and report against a stub axe
│   ├── proxy.test.mjs              CallTool path end to end against fake upstreams
│   └── fixtures/                   fake-pw.mjs, fake-devtools.mjs, fake-docs.mjs, fake-figma-http.mjs, recorded upstream responses
├── .github/workflows/ci.yml        Runs npm test on push/PR
├── logs/                           Per-day NDJSON call logs (auto-created at runtime)
├── .playguard/                     Auto-created artifact root
│   ├── .qa/                        Screenshots, traces, PDFs, downloads from the site under test
│   └── .figma/                     Figma image exports
├── package.json
└── tsconfig.json
```

---

## License

MIT
