#!/usr/bin/env node
// PlayGuard: a proxy MCP. One server in the client config runs several upstream MCPs
// (Playwright, Figma, Chrome DevTools, Shopify Dev, Context7), exposes their tools over one
// connection and optimizes the responses. Env vars decide which upstreams start.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolve, isAbsolute, sep } from "path";
import { createHash, randomUUID } from "crypto";
import { appendFile, mkdirSync, existsSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { extractFigmaProperties, buildBrowserEvalScript, normalizeBrowserResponse,
  compareProperties, formatDiffResult, formatBatchResult, autoSelectProperties,
  collectMappableNodes, buildAutoMapScript, resolveFigmaNode, ALL_PROPERTIES, MAX_AUTO_MAP,
  type DesignDiffArgs, type DesignPair, type DesignDiffResult } from "./design-diff.js";
import {
  splitArgs, VERSION, LOG_DIR, __dir, UPDATE_CHECK, FIGMA_DIR, PW_CMD, PW_ARGS, FIGMA_CMD, FIGMA_ARGS,
  SCREENSHOTS, COMPACT, EVAL_CACHE_TTL, PREFETCH_SNAPSHOT,
  SMART_WAIT, SMART_WAIT_MS, SMART_WAIT_MAX_RETRIES, EVAL_COMPACT_THRESHOLD,
  FIGMA_MCP_URL, FIGMA_ENABLED, FIGMA_REMOTE_REFUSED, FIGMA_URL_INVALID, FIGMA_URL_SAFE, FIGMA_CACHE_TTL, FIGMA_TEXT_COMPACT,
  DESIGN_DIFF_TOLERANCE_PX, DESIGN_DIFF_TOLERANCE_COLOR,
  DELTA_THRESHOLD, DELTA_ENABLED, HINT_THRESHOLD, HINTS,
  DEVTOOLS_MCP_CMD, DEVTOOLS_CMD, DEVTOOLS_ARGS, DEVTOOLS_OPTIMIZE, DEVTOOLS_NETWORK_MAX, DEVTOOLS_BODY_MAX,
  LIST_WAIT_MS, QA_DIR,
  SHOPIFY_DEV_MCP_CMD, SHOPIFY_DEV_CMD, SHOPIFY_DEV_ARGS, CONTEXT7_MCP_CMD, CONTEXT7_CMD, CONTEXT7_ARGS,
  DOCS_OPTIMIZE, DOCS_CACHE_TTL, DOCS_CACHE_DIR,
} from "./config.js";
import { lazyUpstream } from "./upstream.js";
import {
  SHOPIFY_RAW_TOOLS, compactShopifyTools, fillShopifyArgs, shopifyKeyArgs, compactShopifySearch, unescapeLearn,
  CONTEXT7_RAW_TOOLS, CONTEXT7_INSTRUCTIONS, compactContext7Tools, context7KeyArgs, isPinnedLibraryId,
  compactResolve, trimDocs, type Rewrite,
} from "./docs-optimize.js";
import { docsCacheKey, readDocsCache, writeDocsCache } from "./docs-cache.js";
import {
  DEVTOOLS_READ_ONLY, DEVTOOLS_RAW_TOOLS, compactDevtoolsTools, summarizeNetworkList,
  trimNetworkRequest, trimPerfTrace, devtoolsErrorHint,
} from "./devtools.js";
import { processSnapshotResponse, invalidateDtSnap, emptyDtSnapState, type DtSnapState } from "./devtools-snapshot.js";
import {
  STRUCTURAL_RE, hashContent, compactSnap, collapseRuns, decideSnapshot, looksLikeLoading,
  emptySnapState, type SnapState, type SnapshotMeta,
} from "./snapshot.js";
import { optimizeFigmaResponse, budgetTrimFigma, type FigmaOptStats } from "./figma-optimize.js";
import { loadAxeSource, buildAxeScript, formatAxe, DEFAULT_TAGS, type AxeSummary } from "./a11y.js";

// Re-exported so tests (and downstream importers) can reach the pure helpers
// straight off dist/index.js, unchanged by the module split.
export { splitArgs, withOutputDir, withCodegenOff } from "./config.js";
export { compactSnap, collapseRuns, decideSnapshot, looksLikeLoading, emptySnapState } from "./snapshot.js";
export type { SnapState } from "./snapshot.js";
export { optimizeFigmaResponse, budgetTrimFigma } from "./figma-optimize.js";

type ToolArgs = Record<string, unknown>;
type ContentItem = { type?: string; text?: string; data?: string };

// Key order must not decide cache identity. JSON.stringify's array replacer can't do
// this: it is a property allowlist applied at every depth, so it drops nested keys
// entirely and collapses `nodes: [{nodeId: "1:2"}]` and `nodes: [{nodeId: "9:9"}]`
// into the same `[{}]` — different calls sharing one cache entry.
export function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortDeep((v as ToolArgs)[k])]));
  }
  return v;
}

// Random per-process id on every log line: caches are in-memory, so a "miss" on
// identical args is only a bug if both calls came from the same instance.
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
let logWriteFailed = false;
function logCall(tool: string, ms: number, err: boolean, extra?: object) {
  // `ver` shows which build actually served each call — a stale npx cache once ran
  // 0.5.x for weeks while 0.6–0.8 were published, and nothing in the logs said so.
  const line = JSON.stringify({ ts: Date.now(), inst: INSTANCE_ID, ver: VERSION, tool, ms, err, ...extra });
  appendFile(resolve(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.ndjson`), line + "\n", (e) => {
    if (e && !logWriteFailed) { logWriteFailed = true; process.stderr.write(`[PlayGuard] analytics log write failed, disabling further warnings: ${e}\n`); }
  });
}

// One-line, length-capped error reason for the log: tool content or a thrown value.
// ponytail: not masked — logs are local and 200 chars is enough for the error type.
export function errSummary(v: unknown): string {
  const s = Array.isArray(v) ? v.map((c: ContentItem) => c?.text ?? "").join(" ") : v == null ? "" : String(v);
  // ANSI color codes and `### Error` headers from Playwright's call log would otherwise
  // eat the 200 chars before the useful part (why the locator didn't resolve).
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/^### \w+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ── Update check ───────────────────────────────────────────────────────────────
// True when `latest` is a higher x.y.z than `current`. Numeric per part, so 0.10.0 > 0.9.1.
// ponytail: prerelease tags are ignored (`latest` on npm is never a prerelease here).
export function isNewer(latest: string, current: string): boolean {
  const p = (v: string) => v.split("-")[0].split(".").map(n => parseInt(n, 10) || 0);
  const [a, b] = [p(latest), p(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// The fix depends on where this copy runs from: an npx cache entry is refreshed by asking
// for `@latest`; an installed copy (global or project node_modules) shadows npx entirely.
export function updateNotice(current: string, latest: string, dir: string): string {
  const where = /[\\/]_npx[\\/]/.test(dir)
    ? `Set "args": ["-y", "playguard@latest"] in the MCP config so npx always fetches the newest release`
    : /[\\/]node_modules[\\/]/.test(dir)
      ? `An installed copy is running (${dir}). Run \`npm i -g playguard@latest\`, or uninstall it and use "args": ["-y", "playguard@latest"]`
      : `Local checkout (${dir}): git pull && npm run build`;
  return `[PlayGuard] Update available: ${current} → ${latest}. ${where}, then restart the MCP client. ` +
    `Tell the user about this update.`;
}

// Shown once: prepended to the first tool result after the check resolves, and on stderr.
let pendingNotice: string | null = null;
async function checkForUpdate(): Promise<void> {
  try {
    // npx passes the user's configured registry down as npm_config_registry (mirrors, proxies).
    const registry = (process.env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/?$/, "/");
    const res = await fetch(registry + "playguard/latest", { signal: AbortSignal.timeout(3000) });
    const { version } = await res.json() as { version?: string };
    if (version && isNewer(version, VERSION)) {
      pendingNotice = updateNotice(VERSION, version, __dir);
      process.stderr.write(pendingNotice + "\n");
    }
  } catch {} // offline / registry down — never worth failing over
}

const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// Appended to tool descriptions: every evaluate/run_code pays Playwright MCP's fixed
// settle wait (≥0.5 s), so fewer, bigger calls are the only way to cut that time.
const TOOL_HINTS: Record<string, string> = {
  browser_evaluate: "[PlayGuard] Each call waits ≥0.5–1.5 s for the page to settle. Combine related checks into one function that returns an object instead of calling this repeatedly.",
  browser_run_code_unsafe: "[PlayGuard] Each call waits for the page to settle. Prefer one script that loops over viewports/states over several calls.",
  browser_wait_for: "[PlayGuard] Prefer waiting for text over a fixed time.",
};
export function annotateTools(tools: Tool[]): Tool[] {
  for (const t of tools) {
    const hint = TOOL_HINTS[t.name];
    if (hint && !t.description?.includes(hint)) t.description = (t.description ? t.description + "\n" : "") + hint;
  }
  return tools;
}

const DEAD_RE =/Target.*closed|Browser.*closed|page.*closed|connect ECONNREFUSED|crashed|Navigation failed because page|Protocol error.*Target/i;

// Tools that change page state — invalidate snapshot cache after these succeed
const MUTATING = new Set([
  "browser_navigate", "browser_navigate_back", "browser_click", "browser_type",
  "browser_fill", "browser_press_key", "browser_fill_form", "browser_select_option",
  "browser_drag", "browser_drop", "browser_evaluate", "browser_run_code_unsafe",
  "browser_file_upload",
]);

// Structural DOM mutations — also invalidate eval cache
// ponytail: browser_evaluate excluded so polling loops get cache hits within TTL
const EVAL_INVALIDATING = new Set([
  "browser_navigate", "browser_navigate_back", "browser_click", "browser_type",
  "browser_fill", "browser_press_key", "browser_fill_form", "browser_select_option",
  "browser_drag", "browser_drop", "browser_file_upload", "browser_run_code_unsafe",
]);

let conn: Client | null = null;
let pending: Promise<Client> | null = null;
let reviving: Promise<Client> | null = null;
let lastUrl = "";
// Pushed on every browser_navigate, popped on browser_navigate_back — keeps lastUrl
// correct for the one other navigation tool we route. Clicks/form submits that navigate
// still go untracked (Playwright MCP doesn't report the resulting URL in tool output).
const urlHistory: string[] = [];

let snapState: SnapState = { ...emptySnapState };
// Bumped on every mutating tool, so an in-flight prefetch can tell whether the page
// it snapshotted is still the page we're on.
let snapGen = 0;

// ponytail: generic TTL + LRU cache — evalCache and figmaCache both need the same
// shape, so it's written once. LRU comes free from Map's insertion order: re-inserting
// on hit moves a key to the back, so keys().next() is always the least recently used.
export function ttlCache<T>(maxEntries: number) {
  const map = new Map<string, { result: T; ts: number }>();
  return {
    get(key: string, ttlMs: number): T | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      if (Date.now() - hit.ts >= ttlMs) return undefined; // expired: dropped, not refreshed
      map.set(key, hit);
      return hit.result;
    },
    set(key: string, result: T): void {
      map.delete(key);
      if (map.size >= maxEntries) map.delete(map.keys().next().value as string);
      map.set(key, { result, ts: Date.now() });
    },
    clear(): void { map.clear(); },
  };
}

// Eval deduplication cache — keyed by hash(url + script), TTL = EVAL_CACHE_TTL ms
// ponytail: unbounded long-running sessions would grow this forever; capped by size, LRU eviction
const CACHE_MAX_ENTRIES = 500;
const evalCache = ttlCache<Awaited<ReturnType<Client["callTool"]>>>(CACHE_MAX_ENTRIES);

// ── Figma upstream state ───────────────────────────────────────────────────────
let figmaConn: Client | null = null;
let figmaPending: Promise<Client> | null = null;
const figmaToolNames = new Set<string>();
const figmaCache = ttlCache<unknown>(CACHE_MAX_ENTRIES);

async function spawnConn(): Promise<Client> {
  const t = new StdioClientTransport({ command: PW_CMD, args: PW_ARGS });
  const c = new Client({ name: "playguard", version: VERSION });
  // A failed handshake must not leave the child running: every retry would add another.
  await c.connect(t).catch(async (e) => { await t.close().catch(() => {}); throw e; });
  return c;
}

async function getConn(): Promise<Client> {
  if (conn) return conn;
  if (!pending) {
    pending = spawnConn()
      .then((c) => { conn = c; pending = null; return c; })
      .catch((e) => { pending = null; throw e; });
  }
  return pending;
}

async function revive(): Promise<Client> {
  if (reviving) return reviving;
  reviving = (async () => {
    try { await conn?.close(); } catch {}
    conn = null;
    // Dead session's snapshot cache is stale — clear it so the next snapshot rebuilds
    // instead of returning UNCHANGED against a tree from the crashed page.
    snapState = { ...emptySnapState };
    const c = await spawnConn();
    conn = c;
    if (lastUrl) await c.callTool({ name: "browser_navigate", arguments: { url: lastUrl } }).catch(() => {});
    return c;
  })().finally(() => { reviving = null; });
  return reviving;
}

export function dead(v: unknown): boolean {
  return DEAD_RE.test(v instanceof Error ? v.message : String(v));
}

// Populate snap cache from raw snapshot content — used by redirect and prefetch paths
function cacheSnapshot(content: Array<{ text?: string }>, fromPrefetch = false): { text: string; rawBytes: number; keptBytes: number } {
  const summary = compactSnap(content, { compact: COMPACT });
  const newLines = summary.text.split("\n").filter(l => l.includes("[ref=") || STRUCTURAL_RE.test(l));
  snapState = {
    hash: hashContent(content), lines: new Set(newLines), url: lastUrl,
    ts: Date.now(), compact: summary.text, rawBytes: summary.rawBytes,
    prefetched: fromPrefetch, withoutAction: snapState.withoutAction,
    filterKey: JSON.stringify({}),
  };
  return summary;
}

// ponytail: fire-and-forget — a lost prefetch only costs a cache miss, but a LATE one
// costs correctness, so it's fenced by snapGen instead of left to race.
async function prefetchSnapshot(): Promise<void> {
  const gen = snapGen;
  try {
    const c = await getConn();
    let r = await c.callTool({ name: "browser_snapshot", arguments: {} });
    if (!r.isError && SMART_WAIT) {
      let attempts = 0;
      while (attempts < SMART_WAIT_MAX_RETRIES && looksLikeLoading(r.content as Array<{ text?: string }>)) {
        await new Promise(res => setTimeout(res, SMART_WAIT_MS));
        r = await c.callTool({ name: "browser_snapshot", arguments: {} });
        attempts++;
      }
    }
    // A mutating tool ran while this was in flight: the page has moved on, and writing
    // this snapshot back would restore pre-action DOM with a fresh timestamp — which the
    // UNCHANGED shortcut and the 10s screenshot redirect would then serve as current.
    if (!r.isError && gen === snapGen) cacheSnapshot(r.content as Array<{ text?: string }>, true);
  } catch {}
}

// ── Figma connection ───────────────────────────────────────────────────────────

export const FIGMA_REMOTE_MSG =
  "[PlayGuard] Figma's remote MCP server (mcp.figma.com) only accepts clients from Figma's MCP catalog, so PlayGuard cannot connect to it. " +
  "Either set FIGMA_MCP_URL=http://127.0.0.1:3845/mcp (Figma desktop app: Dev Mode → Inspect panel → \"Enable desktop MCP server\"; needs a Dev or Full seat on a paid plan), " +
  "or remove FIGMA_MCP_URL and add the remote server to the MCP client directly, next to PlayGuard " +
  "(Claude Code: claude mcp add --transport http figma https://mcp.figma.com/mcp).";

// `http://user:pass@host` → `http://host` in anything we show or log (fetch errors echo the URL).
export const redactUrlCreds = (s: string) => s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1");

// Official Figma MCP: an HTTP server, no child process and no key to forward.
async function connectFigmaHttp(url: string): Promise<Client> {
  if (FIGMA_REMOTE_REFUSED) throw new Error(FIGMA_REMOTE_MSG);
  if (FIGMA_URL_INVALID) throw new Error(`[PlayGuard] FIGMA_MCP_URL is not a usable URL: "${FIGMA_URL_SAFE}" — it must be http(s)://host:port/path with no user:password. Use http://127.0.0.1:3845/mcp`);
  const t = new StreamableHTTPClientTransport(new URL(url));
  const c = new Client({ name: "playguard-figma", version: VERSION });
  await c.connect(t).catch(async (e) => {
    await t.close().catch(() => {});
    throw new Error(`[PlayGuard] Figma MCP at ${FIGMA_URL_SAFE} is not reachable (${redactUrlCreds(String(e?.message ?? e))}). Open the Figma desktop app, switch to Dev Mode (Shift+D) and click "Enable desktop MCP server" in the Inspect panel.`);
  });
  return c;
}

// The desktop app may start long after PlayGuard (startup retries and tools/list long gave up):
// the first connection that works registers its tools and tells the client to re-list.
function announceFigmaTools(c: Client): void {
  if (figmaToolNames.size) return;
  c.listTools().then(({ tools }) => {
    if (figmaToolNames.size) return;
    (tools as Tool[]).forEach(t => figmaToolNames.add(t.name));
    server.sendToolListChanged().catch(() => {});
  }, () => {});
}

// Transport-level failures (app closed or restarted, stale session) — not an error the server
// returned for one call. Only these drop the shared connection; anything else would abort
// every other Figma call in flight on it.
const FIGMA_TRANSPORT_RE = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Connection closed|session not found|Streamable HTTP error|Error POSTing|not reachable/i;

// Retried only when the request certainly never ran: refused connection or a stale session.
// A reset mid-response may come after the server already executed the call.
const FIGMA_RETRY_RE = /ECONNREFUSED|session not found|HTTP 404/i;
const errText = (e: unknown) => `${(e as Error)?.message ?? e} ${(e as { cause?: { code?: string } })?.cause?.code ?? ""}`;

async function callFigmaHttp(name: string, args: ToolArgs): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  for (let attempt = 0; ; attempt++) {
    const c = await getFigmaConn();
    try {
      return await c.callTool({ name, arguments: args });
    } catch (e) {
      const transport = FIGMA_TRANSPORT_RE.test(errText(e));
      // Only the connection this call used — a late failure must not close a fresh one.
      if (transport && figmaConn === c) { figmaConn = null; c.close().catch(() => {}); }
      if (!transport || attempt || !FIGMA_RETRY_RE.test(errText(e))) throw e; // one retry: the first call after an app restart
    }
  }
}

const FIGMA_OFFICIAL_TOOLS = new Set(["get_design_context", "get_variable_defs", "get_metadata", "get_screenshot",
  "get_code_connect_map", "create_design_system_rules", "get_figjam", "whoami"]);

async function spawnFigmaConn(): Promise<Client> {
  if (FIGMA_MCP_URL) return connectFigmaHttp(FIGMA_MCP_URL);
  // Forward all FIGMA_* env vars (e.g. FIGMA_API_KEY) to the child process
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("FIGMA_") && v) env[k] = v;
  }
  // Framelink >=0.13 defaults to a "tree" text format that is neither JSON nor YAML, so the
  // optimizer silently skipped every response (parseSkip: "parse-error"). Ask for JSON unless
  // the user chose a format; other Figma MCPs ignore this variable.
  env.OUTPUT_FORMAT = process.env.OUTPUT_FORMAT || "json";
  const t = new StdioClientTransport({ command: FIGMA_CMD, args: FIGMA_ARGS, env });
  const c = new Client({ name: "playguard-figma", version: VERSION });
  await c.connect(t).catch(async (e) => { await t.close().catch(() => {}); throw e; });
  return c;
}

async function getFigmaConn(): Promise<Client> {
  if (figmaConn) return figmaConn;
  if (!figmaPending) {
    figmaPending = spawnFigmaConn()
      .then(c => { figmaConn = c; figmaPending = null; if (FIGMA_MCP_URL) announceFigmaTools(c); return c; })
      .catch(e => { figmaPending = null; throw e; });
  }
  return figmaPending;
}

// Figma image downloads write to a caller-supplied directory (Framelink's
// download_figma_images uses `localPath`). A relative one lands in the child's cwd —
// wherever the client happened to spawn us — so anchor it under `.playguard/.figma`.
// A missing/empty arg is the same problem, and gets the bare figma dir. Returns null
// only for an absolute path: that's the caller being explicit, so it passes through.
export function figmaLocalPath(localPath: unknown, figmaDir: string): string | null {
  // Normalize the base first: the containment check below is a string compare, and
  // `/out/.figma` vs `C:\out\.figma` would fail it and clamp every legitimate path.
  const base = resolve(figmaDir);
  if (typeof localPath !== "string" || !localPath) return base;
  if (isAbsolute(localPath)) return null;
  // `../../x` resolves clean out of the artifact dir and back into the project — an
  // agent-supplied relative path must not be able to write outside `.figma`.
  const out = resolve(base, localPath);
  return out === base || out.startsWith(base + sep) ? out : base;
}

// ── Chrome DevTools MCP upstream ───────────────────────────────────────────────
// A separate Chrome from Playwright's, with its own uids, snapshot state and last URL.
const dtToolNames = new Set<string>();
let dtSnapState: DtSnapState = { ...emptyDtSnapState };
let dtLastUrl = "";
let dtNavHasPageId = false; // replay the last navigate with pageId when the agent used one

let dtRevivals = 0; // bumped per respawn, so a call can tell it ran in a fresh browser
let dtRevivedUrl = ""; // what the last respawn reopened ("" = nothing)

// The upstream usually runs as `npx …@latest`, so it gets the SDK's minimal default env
// (PATH, HOME, …) plus what npm, a proxy and Chrome need — never API tokens or cloud keys.
const DT_ENV_ALLOW = /^(CHROME_DEVTOOLS_MCP_|PUPPETEER_|npm_config_|XDG_|LC_|PROGRAMFILES)|^(HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CI|DISPLAY|WAYLAND_DISPLAY|LANG|TMP|TEMP|TMPDIR|LOCALAPPDATA|SYSTEMROOT)$/i;
function devtoolsEnv(): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && DT_ENV_ALLOW.test(k)) env[k] = v;
  // Upstream otherwise spawns a daily npm registry check of its own.
  env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS ??= "1";
  return env;
}

const dtUp = lazyUpstream(async () => {
  const t = new StdioClientTransport({
    command: DEVTOOLS_CMD, args: DEVTOOLS_ARGS, env: devtoolsEnv(),
    // Relative file paths (take_snapshot filePath, responseFilePath, …) land in .playguard/.qa.
    cwd: existsSync(QA_DIR) ? QA_DIR : undefined,
  });
  const c = new Client({ name: "playguard-devtools", version: VERSION });
  await c.connect(t).catch(async (e) => { await t.close().catch(() => {}); throw e; });
  return c;
}, async (c) => {
  dtRevivals++;
  // A fresh process means a fresh Chrome: old uids are gone and page ids restart at 1.
  dtSnapState = { ...emptyDtSnapState };
  dtRevivedUrl = "";
  if (dtLastUrl) {
    const r = await c.callTool({ name: "navigate_page", arguments: { type: "url", url: dtLastUrl, ...(dtNavHasPageId ? { pageId: 1 } : {}) } }).catch(() => null);
    if (r && !r.isError) dtRevivedUrl = dtLastUrl;
  }
});

// The upstream process died (before or during the call): the SDK reports it this way.
const DT_GONE_RE = /Not connected|Connection closed/i;
// chrome-devtools-mcp relaunches a crashed Chrome by itself and says so in the error.
const DT_RESTARTED_RE = /browser was restarted or reconnected/i;

const DEVTOOLS_INSTRUCTIONS =
  "The Chrome DevTools tools (take_snapshot, list_network_requests, performance_*, lighthouse_audit, …) drive a separate Chrome and only see pages opened there with navigate_page/new_page; never mix their uids with browser_* refs. " +
  "For a page driven by browser_* tools, use browser_network_requests and browser_console_messages instead.";

// Traces, audits and heap snapshots routinely outlive the SDK's 60 s request default.
// (chrome-devtools-mcp 1.12 sends no progress; the no-op onprogress asks for it, so a
// version that does keeps extending the deadline.)
const DT_SLOW_TOOLS = new Set(["lighthouse_audit", "performance_start_trace", "performance_stop_trace", "take_heapsnapshot"]);
const DT_SLOW_OPTS = { timeout: 180_000, resetTimeoutOnProgress: true, onprogress: () => {} };

async function callDevtools(name: string, args: ToolArgs): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const t0 = Date.now();
  const revivals = dtRevivals;
  const raw = DEVTOOLS_RAW_TOOLS.has(name) && args.raw === true;
  const extra: Record<string, unknown> = { server: "devtools", url: dtLastUrl || undefined };
  if (raw) extra.raw = true;

  // PlayGuard-only params never reach the upstream.
  let callName = name;
  let fwd: ToolArgs = { ...args };
  if (DEVTOOLS_RAW_TOOLS.has(name)) delete fwd.raw;
  if (name === "take_screenshot") {
    delete fwd.visual;
    if (SCREENSHOTS === "block") {
      logCall(name, Date.now() - t0, true, { ...extra, blocked: true });
      return { content: [{ type: "text", text: "[PlayGuard] screenshots blocked. Set PLAYGUARD_SCREENSHOTS=allow to enable." }], isError: true };
    }
    if (SCREENSHOTS === "warn") process.stderr.write("[PlayGuard] screenshot called — prefer take_snapshot for structured interaction\n");
    if (SCREENSHOTS === "redirect") {
      // A file to write, one element or the full page only make sense as pixels: a
      // snapshot would silently drop them.
      if (args.visual || args.filePath !== undefined || args.uid !== undefined || args.fullPage) extra.visual = true;
      else {
        callName = "take_snapshot";
        fwd = args.pageId !== undefined ? { pageId: args.pageId } : {};
        extra.redirected = true;
      }
    }
  }

  const send = async (c: Client) => c.callTool({ name: callName, arguments: fwd }, undefined, DT_SLOW_TOOLS.has(callName) ? DT_SLOW_OPTS : undefined);
  let r: Awaited<ReturnType<Client["callTool"]>>;
  try {
    try {
      r = await send(await dtUp.get());
    } catch (e) {
      if (!DT_GONE_RE.test(String(e))) throw e;
      extra.retried = true;
      r = await send(await dtUp.revive());
    }
    if (extra.redirected && r.isError) {
      process.stderr.write("[PlayGuard] snapshot failed during redirect, taking real screenshot\n");
      callName = name;
      fwd = { ...args };
      delete fwd.visual;
      extra.redirected = undefined;
      r = await send(await dtUp.get());
    }
  } catch (e) {
    logCall(name, Date.now() - t0, true, { ...extra, errText: errSummary(e), thrown: true });
    throw e;
  }

  const items = r.content as ContentItem[];
  const textBytes = (cs: ContentItem[]) => cs.reduce((s, c) => s + (c.type === "text" && c.text ? Buffer.byteLength(c.text) : 0), 0);
  let content = items;
  const allText = items.map(c => c.text ?? "").join("\n");

  // Upstream relaunched a crashed Chrome on its own (as an error with page-id routing, as a
  // success on about:blank without it) — nothing to revive, but every cached uid is gone.
  // The note is skipped when this call was itself a navigation: the agent is already moving on.
  const lostUrl = DT_RESTARTED_RE.test(allText) ? dtLastUrl : null;
  if (lostUrl !== null) {
    dtSnapState = { ...emptyDtSnapState };
    extra.chromeRestarted = true;
  }

  if (r.isError) {
    extra.errText = errSummary(items);
    const hint = DEVTOOLS_OPTIMIZE ? devtoolsErrorHint(allText) : null;
    if (hint) { content = [...content, { type: "text", text: hint }]; extra.hinted = true; }
  } else {
    // Invalidate before reading any snapshot in this response: an action called with
    // includeSnapshot:true returns the post-action tree, which is a valid new baseline.
    if (!DEVTOOLS_READ_ONLY.has(callName)) dtSnapState = invalidateDtSnap(dtSnapState);
    if (DEVTOOLS_OPTIMIZE && !raw) {
      content = items.map((c) => {
        if (c.type !== "text" || !c.text) return c;
        let t = c.text;
        const snap = processSnapshotResponse(t, dtSnapState, {
          compact: COMPACT, deltaEnabled: DELTA_ENABLED, deltaThreshold: DELTA_THRESHOLD, verbose: !!args.verbose,
        });
        if (snap) {
          dtSnapState = snap.state;
          t = snap.text;
          Object.assign(extra, { cacheHit: snap.meta.cacheHit, delta: snap.meta.delta, deltaAdded: snap.meta.deltaAdded, deltaRemoved: snap.meta.deltaRemoved });
        }
        if (callName === "list_network_requests") {
          const n = summarizeNetworkList(t, args, DEVTOOLS_NETWORK_MAX);
          t = n.text;
          if (n.summarized) Object.assign(extra, { summarized: true, rows: n.rows });
        } else if (callName === "get_network_request") {
          const n = trimNetworkRequest(t, DEVTOOLS_BODY_MAX);
          t = n.text;
          if (n.trimmed) extra.trimmed = true;
        } else if (callName === "performance_start_trace" || callName === "performance_stop_trace") {
          t = trimPerfTrace(t);
        }
        return t === c.text ? c : { ...c, text: t };
      });
    }
    if (extra.redirected) {
      content = [{ type: "text", text: "[PlayGuard: snapshot served instead of screenshot. Call with {visual:true} for actual pixels.]\n" + content.map(c => c.text ?? "").join("\n") }];
    }
    if ((name === "navigate_page" && args.type === "url" && typeof args.url === "string") || (name === "new_page" && typeof args.url === "string")) {
      dtLastUrl = args.url as string;
      dtNavHasPageId = args.pageId !== undefined;
    }
  }

  if (lostUrl && DEVTOOLS_OPTIMIZE && dtLastUrl === lostUrl) {
    content = [...content, { type: "text", text: `[PlayGuard] Chrome was restarted; the last page you opened here was ${lostUrl}. navigate_page to it if you still need it.` }];
  }
  // PlayGuard respawned the upstream for this call: the agent must know its session is gone.
  // Not gated on DEVTOOLS_OPTIMIZE — the restart is ours, not a rewrite of upstream output.
  if (dtRevivals !== revivals) {
    extra.revived = true;
    const replayed = dtRevivedUrl ? `; ${dtRevivedUrl} was reopened` : "";
    content = [{ type: "text", text: `[PlayGuard] The DevTools browser was restarted: cookies, logins and page state are lost${replayed}. Take a fresh snapshot before using uids.` }, ...content];
  }

  extra.url = dtLastUrl || undefined; // after the call: a navigation logs where it went
  extra.rawBytes = textBytes(items);
  extra.keptBytes = textBytes(content);
  if (name === "take_screenshot" && !extra.redirected) {
    const shot = items.reduce((s, c) => s + (c.data ? Math.round(c.data.length * 3 / 4) : 0), 0);
    if (shot > 0) extra.screenshotBytes = shot;
  }
  logCall(name, Date.now() - t0, !!r.isError, extra);
  // New object: never mutate what the SDK handed us.
  return content === items ? r : { ...r, content } as Awaited<ReturnType<Client["callTool"]>>;
}

// ── Documentation upstreams (Shopify Dev MCP, Context7) ────────────────────────
// Both are read-only and stateless, so they share one shape: lazy spawn, an allowlisted
// env, tools/list merge, a routing set, and an on-disk cache for lookups (an identical repeat
// within the process gets a short note). A dead or failing one only costs its own tools.
type CallResult = Awaited<ReturnType<Client["callTool"]>>;
type DocsSpec = {
  server: "shopify-dev" | "context7";
  label: string;
  cmd: string;
  args: string[];
  env: () => Record<string, string>;
  // Read-only lookups kept on disk for DOCS_CACHE_TTL; an identical repeat in this process
  // gets a short note instead of the whole answer.
  cacheTools: Set<string>;
  knownTools: Set<string>; // routed even before the upstream ever listed them, for a clear "not running" error
  startHint: string;
  rawTools: Set<string>;
  keyArgs: (args: ToolArgs) => ToolArgs;
  fillArgs?: (args: ToolArgs) => ToolArgs;
  ttlMs: (args: ToolArgs) => number;
  compactTools: (tools: Tool[]) => Tool[];
  rewrite: (tool: string, text: string) => Rewrite | null;
};

// SDK default env (PATH, HOME, …) plus what npm and a proxy need. Each upstream adds its own
// variables; API keys of other upstreams and host session ids (CLAUDE_CODE_*) never pass.
const DOCS_ENV_ALLOW = /^(npm_config_|XDG_|LC_|PROGRAMFILES)|^(HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CI|LANG|TMP|TEMP|TMPDIR|LOCALAPPDATA|SYSTEMROOT)$/i;
function docsEnv(own: RegExp, defaults: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (DOCS_ENV_ALLOW.test(k) || own.test(k))) env[k] = v;
  for (const [k, v] of Object.entries(defaults)) env[k] ??= v;
  return env;
}

const DOCS_SESSION_ID = randomUUID();

function docsUpstream(spec: DocsSpec) {
  const names = new Set<string>();
  const sent = new Map<string, number>(); // repeat key → chars sent the first time
  const up = lazyUpstream(async () => {
    const t = new StdioClientTransport({ command: spec.cmd, args: spec.args, env: spec.env() });
    const c = new Client({ name: `playguard-${spec.server}`, version: VERSION });
    await c.connect(t).catch(async (e) => { await t.close().catch(() => {}); throw e; });
    return c;
  });

  async function call(name: string, args: ToolArgs): Promise<CallResult> {
    const t0 = Date.now();
    const raw = spec.rawTools.has(name) && args.raw === true;
    const extra: Record<string, unknown> = { server: spec.server };
    if (raw) extra.raw = true;
    let fwd: ToolArgs = { ...args };
    if (spec.rawTools.has(name)) delete fwd.raw;
    if (DOCS_OPTIMIZE && spec.fillArgs) fwd = spec.fillArgs(fwd);

    const key = spec.cacheTools.has(name) ? docsCacheKey(spec.server, name, spec.keyArgs(args)) : "";
    // The MCP process outlives /compact and /clear and is shared by subagents, so the agent
    // reading this may never have seen the first answer: the note says how to get it back.
    if (DOCS_OPTIMIZE && !raw && key && sent.has(key)) {
      const text = `[PlayGuard] UNCHANGED: identical ${name} call already answered earlier in this session (${sent.get(key)} chars). If you no longer have it in context, call again with raw: true.`;
      logCall(name, Date.now() - t0, false, { ...extra, repeat: true, keptBytes: Buffer.byteLength(text) });
      return { content: [{ type: "text", text }] };
    }

    let r = spec.cacheTools.has(name) ? readDocsCache<CallResult>(DOCS_CACHE_DIR, key, spec.ttlMs(args)) : null;
    if (r) extra.cached = true;
    else {
      const send = async (c: Client) => c.callTool({ name, arguments: fwd });
      let conn: Client;
      try {
        conn = await up.get();
      } catch (e) {
        // Spawn/handshake failed: say which upstream and how to fix it, not "Tool not found".
        const text = `[PlayGuard] ${spec.label} MCP is not running: ${errSummary(e).slice(0, 160)}. ${spec.startHint}`;
        logCall(name, Date.now() - t0, true, { ...extra, errText: errSummary(e), down: true });
        return { content: [{ type: "text", text }], isError: true };
      }
      try {
        try {
          r = await send(conn);
        } catch (e) {
          if (!DT_GONE_RE.test(String(e))) throw e;
          extra.retried = true;
          r = await send(await up.revive());
        }
      } catch (e) {
        logCall(name, Date.now() - t0, true, { ...extra, errText: errSummary(e), thrown: true });
        throw e;
      }
      if (spec.cacheTools.has(name) && !r.isError && spec.ttlMs(args) > 0) writeDocsCache(DOCS_CACHE_DIR, key, r);
    }

    const items = r.content as ContentItem[];
    const textBytes = (cs: ContentItem[]) => cs.reduce((s, c) => s + (c.type === "text" && c.text ? Buffer.byteLength(c.text) : 0), 0);
    let content = items;
    if (r.isError) extra.errText = errSummary(items);
    else if (DOCS_OPTIMIZE && !raw) {
      content = items.map((c) => {
        if (c.type !== "text" || !c.text) return c;
        const w = spec.rewrite(name, c.text);
        if (!w) return c;
        if (w.skip) { extra.parseSkip = w.skip; process.stderr.write(`[PlayGuard] ${spec.label} optimizer skipped (${w.skip}) for ${name}\n`); }
        return w.text === c.text ? c : { ...c, text: w.text };
      });
      if (key) sent.set(key, content.reduce((s, c) => s + (c.text?.length ?? 0), 0));
    }
    extra.rawBytes = textBytes(items);
    extra.keptBytes = textBytes(content);
    logCall(name, Date.now() - t0, !!r.isError, extra);
    return content === items ? r : { ...r, content } as CallResult;
  }

  // tools/list: undefined when the upstream is slow (re-listed later) or failed.
  async function list(): Promise<Tool[] | undefined> {
    try {
      const l = await listOrLater(spec.label, up.get().then(c => c.listTools()));
      if (!l) throw new Error(`no answer within ${LIST_WAIT_MS} ms, will re-list when it is up`);
      return l.tools as Tool[];
    } catch (e) {
      process.stderr.write(`[PlayGuard] ${spec.label} MCP listTools failed: ${e}\n`);
      return undefined;
    }
  }

  // A name already listed by another upstream stays there; this one skips it.
  function merge(tools: Tool[] | undefined, into: Tool[]): void {
    if (!tools) return;
    const taken = new Set(into.map(t => t.name));
    const own = tools.filter((t) => {
      if (!taken.has(t.name)) return true;
      names.delete(t.name);
      process.stderr.write(`[PlayGuard] ${spec.label} tool "${t.name}" collides with an existing tool — skipped\n`);
      return false;
    });
    own.forEach(t => names.add(t.name));
    into.push(...(DOCS_OPTIMIZE ? spec.compactTools(own) : own));
  }

  // Routing needs `names` even if the client never calls tools/list (same as DevTools).
  function init(claimed: (name: string) => boolean, attempt = 1): void {
    up.get()
      .then(c => c.listTools())
      .then(({ tools }) => (tools as Tool[]).forEach((t) => { if (!claimed(t.name)) names.add(t.name); }))
      .catch(e => {
        process.stderr.write(`[PlayGuard] ${spec.label} MCP init failed (attempt ${attempt}): ${e}\n`);
        if (attempt === 1) setTimeout(() => init(claimed, 2), 3000);
      });
  }

  return { names, known: spec.knownTools, call, list, merge, init };
}

const docsTtlMs = DOCS_CACHE_TTL * 1000;
const docsUps = [
  SHOPIFY_DEV_MCP_CMD && docsUpstream({
    server: "shopify-dev", label: "Shopify Dev", cmd: SHOPIFY_DEV_CMD, args: SHOPIFY_DEV_ARGS,
    // Upstream telemetry (tool inputs and results, posted to shopify.dev) is on by default.
    env: () => docsEnv(/^(LIQUID_VALIDATION_MODE|OPT_OUT_INSTRUMENTATION|DO_NOT_TRACK|STOREFRONT_WEB_COMPONENTS|USE_LEGACY_SEARCH|SHOPIFY_AI_TOOLKIT_OPT_OUT_FILE)$/i, { OPT_OUT_INSTRUMENTATION: "true" }),
    // validate / validate_theme are never cached or rewritten: random artifact ids, files on disk.
    cacheTools: new Set(["search_docs_chunks"]),
    knownTools: new Set(["learn_shopify_api", "search_docs_chunks", "validate", "validate_theme"]),
    startHint: "Check SHOPIFY_DEV_MCP_CMD (e.g. npx -y @shopify/dev-mcp@latest).",
    rawTools: SHOPIFY_RAW_TOOLS,
    keyArgs: shopifyKeyArgs,
    fillArgs: (a) => fillShopifyArgs(a, DOCS_SESSION_ID),
    ttlMs: () => docsTtlMs,
    compactTools: compactShopifyTools,
    rewrite: (tool, text) => tool === "search_docs_chunks" ? compactShopifySearch(text)
      : tool === "learn_shopify_api" ? unescapeLearn(text) : null,
  }),
  CONTEXT7_MCP_CMD && docsUpstream({
    server: "context7", label: "Context7", cmd: CONTEXT7_CMD, args: CONTEXT7_ARGS,
    env: () => docsEnv(/^CONTEXT7_API_(KEY|URL)$/i),
    cacheTools: CONTEXT7_RAW_TOOLS,
    knownTools: CONTEXT7_RAW_TOOLS,
    startHint: "Check CONTEXT7_MCP_CMD (Context7 needs Node >=20.18.1).",
    rawTools: CONTEXT7_RAW_TOOLS,
    keyArgs: context7KeyArgs,
    ttlMs: (a) => isPinnedLibraryId(a.libraryId) ? docsTtlMs * 7 : docsTtlMs,
    compactTools: compactContext7Tools,
    rewrite: (tool, text) => tool === "resolve-library-id" ? compactResolve(text)
      : tool === "query-docs" ? trimDocs(text) : null,
  }),
].filter(<T>(d: T | "" | undefined): d is T => !!d);

// ── Design diff ────────────────────────────────────────────────────────────────

// Fetches a Figma node (with its subtree). Returns the parsed upstream response —
// both formats keep the descendants, so auto-map fetches the component once and
// resolves every child out of that same tree.
async function fetchFigmaNode(fileKey: string, nodeId: string): Promise<{ data?: unknown; error?: string }> {
  const fc = await getFigmaConn();
  if (figmaToolNames.size === 0) {
    try {
      const { tools } = await fc.listTools();
      (tools as Tool[]).forEach((t) => figmaToolNames.add(t.name));
    } catch (e) {
      process.stderr.write(`[PlayGuard] lazy Figma listTools failed: ${e}\n`);
    }
  }
  // Upstreams disagree on the node-fetch tool's name and arg shape.
  let figmaToolName = "get_file_nodes";
  if (figmaToolNames.has("get_node")) figmaToolName = "get_node";
  else if (figmaToolNames.has("figma_get_node")) figmaToolName = "figma_get_node";
  else if (figmaToolNames.has("get_file_nodes")) figmaToolName = "get_file_nodes";
  else if (figmaToolNames.has("figma_get_file_nodes")) figmaToolName = "figma_get_file_nodes";
  else if (figmaToolNames.has("get_figma_data")) figmaToolName = "get_figma_data";
  else {
    return { error: `No compatible Figma tool found. Available upstream tools: ${Array.from(figmaToolNames).join(", ")}` };
  }

  const figmaArgs = (figmaToolName === "get_file_nodes" || figmaToolName === "figma_get_file_nodes")
    ? { fileKey, nodeIds: nodeId }
    : { fileKey, nodeId };
  const r = await fc.callTool({ name: figmaToolName, arguments: figmaArgs });
  if (r.isError) {
    return { error: `Figma fetch failed: ${(r.content as ContentItem[])[0]?.text ?? "unknown error"}` };
  }
  const text = (r.content as ContentItem[]).find(c => c.type === "text")?.text ?? "";
  try {
    const data = text.trimStart().startsWith("{") ? JSON.parse(text) : yamlLoad(text);
    return data ? { data } : { error: "failed to parse Figma response" };
  } catch {
    return { error: "failed to parse Figma response" };
  }
}

// Runs one browser_evaluate expression and returns its parsed JSON result.
async function browserEval(expression: string): Promise<{ data?: any; error?: string }> {
  const bc = await getConn();
  const r = await bc.callTool({ name: "browser_evaluate", arguments: { function: expression } });
  if (r.isError) {
    return { error: `browser error: ${(r.content as ContentItem[])[0]?.text ?? "unknown error"}` };
  }
  return { data: parseEvalText((r.content as ContentItem[]).find(c => c.type === "text")?.text ?? "{}") };
}

// Pulls the JSON value out of a browser_evaluate response, with or without the trailing
// `### Ran Playwright code` block (absent under --codegen none).
export function parseEvalText(text: string): any {
  let dataStr = text;
  if (text.includes("### Result")) {
    const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n###|$)/);
    if (match) dataStr = match[1].trim();
  } else if (text.includes("```json")) {
    const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (match) dataStr = match[1].trim();
  }

  try {
    return JSON.parse(dataStr);
  } catch {
    // fallback: find the first { ... } block
    const match = text.match(/\{[\s\S]*\}/);
    try {
      if (match) return JSON.parse(match[0]);
    } catch {}
    return {};
  }
}

// Diffs one Figma node against one browser element. Never throws for a pair-level
// failure — it returns a result carrying `error`, so one bad selector in a batch
// doesn't sink the pairs that worked. `explicitProps` omitted ⇒ the property set is
// auto-selected from the node itself (Phase 3); `prefetched` reuses a Figma response
// already in hand.
async function comparePair(
  fileKey: string, pair: DesignPair, explicitProps?: string[], prefetched?: unknown,
): Promise<DesignDiffResult> {
  const label = `${pair.figmaNodeId} → ${pair.browserSelector}`;
  const blank: DesignDiffResult = { matches: 0, mismatches: 0, skipped: 0, comparisons: [], warnings: [], label };

  let figmaData = prefetched;
  if (figmaData === undefined) {
    const fetched = await fetchFigmaNode(fileKey, pair.figmaNodeId);
    if (fetched.error) return { ...blank, error: fetched.error };
    figmaData = fetched.data;
  }

  // Without this the resolver falls back to the response root (typically the containing
  // page) and every comparison below reports confident MATCH/MISMATCH rows for an
  // element the caller never asked about.
  if (!resolveFigmaNode(figmaData, pair.figmaNodeId).found) {
    return { ...blank, error: `Figma node ${pair.figmaNodeId} not found in the fetched response` };
  }

  const properties = explicitProps ?? autoSelectProperties(figmaData, pair.figmaNodeId);
  if (!properties.length) {
    return { ...blank, error: "no comparable properties found on this Figma node" };
  }
  const figmaProps = extractFigmaProperties(figmaData, properties, pair.figmaNodeId);

  const evaluated = await browserEval(buildBrowserEvalScript(pair.browserSelector, properties));
  if (evaluated.error) return { ...blank, error: evaluated.error };
  const browserData = evaluated.data;
  if (browserData._error) return { ...blank, error: String(browserData._error) };

  const diff = compareProperties(
    figmaProps, normalizeBrowserResponse(browserData, properties),
    DESIGN_DIFF_TOLERANCE_PX, DESIGN_DIFF_TOLERANCE_COLOR,
  );
  if (browserData._viewport) {
    try { diff.viewport = JSON.parse(browserData._viewport); } catch {}
  }
  return { ...diff, label };
}

// Maps the layers under a Figma node onto DOM elements by data-figma-id /
// data-testid / id / class conventions, falling back to exact text for TEXT layers.
// Returns the pairs it could resolve plus a note about the ones it could not.
async function autoMapPairs(
  fileKey: string, rootNodeId: string,
): Promise<{ figmaData?: unknown; pairs: DesignPair[]; warnings: string[]; error?: string }> {
  const fetched = await fetchFigmaNode(fileKey, rootNodeId);
  if (fetched.error) return { pairs: [], warnings: [], error: fetched.error };

  const candidates = collectMappableNodes(fetched.data, rootNodeId);
  if (!candidates.length) return { figmaData: fetched.data, pairs: [], warnings: [], error: "no mappable layers found under this Figma node" };

  const evaluated = await browserEval(buildAutoMapScript(candidates));
  if (evaluated.error) return { figmaData: fetched.data, pairs: [], warnings: [], error: evaluated.error };

  const resolved: Record<string, string | null> = evaluated.data ?? {};
  const pairs: DesignPair[] = [];
  const unmapped: string[] = [];
  for (const c of candidates) {
    const selector = resolved[c.figmaNodeId];
    if (selector) pairs.push({ figmaNodeId: c.figmaNodeId, browserSelector: selector });
    else unmapped.push(`${c.name} (${c.figmaNodeId})`);
  }

  const warnings = unmapped.length
    ? [`${unmapped.length} of ${candidates.length} layer(s) had no unique browser element and were skipped: ${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? ", …" : ""}. Add data-figma-id or data-testid to map them.`]
    : [];
  return { figmaData: fetched.data, pairs, warnings };
}

if (FIGMA_REMOTE_REFUSED) process.stderr.write(FIGMA_REMOTE_MSG + "\n");
const instructions = [FIGMA_REMOTE_REFUSED && FIGMA_REMOTE_MSG + " Tell the user.", DEVTOOLS_MCP_CMD && DEVTOOLS_INSTRUCTIONS, CONTEXT7_MCP_CMD && CONTEXT7_INSTRUCTIONS].filter(Boolean).join("\n\n");
const server = new Server(
  { name: "playguard", version: VERSION },
  { capabilities: { tools: { listChanged: true } }, ...(instructions ? { instructions } : {}) },
);

// tools/list must not hang on a slow optional upstream (a first `npx` download, an
// initialize that never answers): after LIST_WAIT_MS list without it, let it keep
// starting, and ask the client to re-list once its tools are in. undefined = too slow.
const relistPending = new Set<string>();
async function listOrLater(label: string, list: Promise<{ tools: Tool[] }>): Promise<{ tools: Tool[] } | undefined> {
  // Already known to be slow and a re-list is queued — don't make every tools/list wait again.
  if (relistPending.has(label)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((res) => { timer = setTimeout(() => res(undefined), LIST_WAIT_MS); });
  const r = await Promise.race([list, late]).finally(() => clearTimeout(timer));
  if (r === undefined && !relistPending.has(label)) {
    relistPending.add(label);
    list.then(() => server.sendToolListChanged(), () => {})
      .catch(() => {})
      .finally(() => relistPending.delete(label));
  }
  return r;
}

const A11Y_TOOL: Tool = {
  name: "playguard_a11y_audit",
  description: "Run an axe-core accessibility audit on the page currently open in the browser_* browser. " +
    "Returns WCAG violations grouped by rule, most severe first, with CSS selectors, a short html excerpt and the fix for each element. " +
    "Navigate first; re-run after a click/state change to audit dialogs or menus.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "Audit only this part of the page (CSS selector, e.g. 'main', '#cart-drawer'). Default: whole page." },
      tags: {
        type: "array", items: { type: "string" },
        description: `axe rule tags to run. Replaces the default (${DEFAULT_TAGS.join(", ")}) — to add "best-practice" or "wcag2aaa", pass the defaults plus it.`,
      },
    },
  },
  annotations: { readOnlyHint: true },
};

async function a11yAudit(args: ToolArgs) {
  const t0 = Date.now();
  const selector = typeof args.selector === "string" && args.selector ? args.selector : undefined;
  const given = typeof args.tags === "string" ? [args.tags] : args.tags;
  const fail = (msg: string, extra: object = {}) => {
    logCall("playguard_a11y_audit", Date.now() - t0, true, { url: lastUrl || undefined, errText: msg.slice(0, 200), ...extra });
    return { content: [{ type: "text", text: `[PlayGuard a11y] ${msg}` }], isError: true };
  };
  if (given !== undefined && (!Array.isArray(given) || given.some(t => typeof t !== "string" || !t)))
    return fail("tags must be an array of axe tag strings, e.g. [\"wcag2a\", \"wcag2aa\"]");
  const tags: string[] = given?.length ? given : DEFAULT_TAGS;
  const run = async () => {
    try { return await browserEval(buildAxeScript(loadAxeSource(), { selector, tags })); }
    catch (e) { return { error: String((e as Error)?.message ?? e), data: undefined }; }
  };
  let ev = await run();
  // Same recovery as every browser_* call: a dead browser is relaunched on the last url.
  if (ev.error && dead(ev.error)) {
    try { await revive(); } catch (e) { return fail(`browser restart failed: ${e}`); }
    ev = await run();
  }
  if (ev.error) return fail(ev.error);
  const r = ev.data as AxeSummary;
  if (r?._error) return fail(`axe failed: ${r._error}${selector ? ` (selector: ${selector})` : ""}`);
  if (!r || !Array.isArray(r.v)) return fail("could not read the axe result from the page");
  if (!r.url || r.url === "about:blank") return fail("no page is open — call browser_navigate first");
  const text = formatAxe(r, tags);
  logCall("playguard_a11y_audit", Date.now() - t0, false, {
    url: r.url, selector, tags: given?.length ? tags : undefined, violations: r.v.length,
    elements: r.v.reduce((n, x) => n + x.n, 0), incomplete: r.incomplete.length, keptBytes: Buffer.byteLength(text),
  });
  return { content: [{ type: "text", text }] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Every optional upstream starts listing now, so their LIST_WAIT_MS waits overlap instead of
  // adding up. Settled up front: a rejection must not go unhandled while Playwright lists.
  const settle = <T>(p: Promise<T>) => p.then((r): { r: T | undefined; e?: unknown } => ({ r }), (e: unknown) => ({ r: undefined, e }));
  const figmaP = FIGMA_ENABLED ? settle(listOrLater("Figma", getFigmaConn().then(c => c.listTools()))) : null;
  const dtP = DEVTOOLS_MCP_CMD ? settle(listOrLater("DevTools", dtUp.get().then(c => c.listTools()))) : null;
  const docsP = Promise.all(docsUps.map(d => d.list()));
  const result = await getConn().then((c) => c.listTools());
  if (HINTS) annotateTools(result.tools as Tool[]);
  if (SCREENSHOTS === "redirect") {
    const shot = (result.tools as Tool[]).find((t) => t.name === "browser_take_screenshot");
    if (shot) {
      shot.description = (shot.description ?? "") +
        "\n[PlayGuard] Returns a snapshot by default (cheaper, structured). Pass {visual:true} if you need actual pixels (colors, layout bugs, visual glitches).";
      if (shot.inputSchema?.properties) {
        (shot.inputSchema.properties as Record<string, unknown>).visual = {
          type: "boolean",
          description: "Set true to get a real screenshot instead of a snapshot.",
        };
      }
    }
  }
  const snap = (result.tools as Tool[]).find((t) => t.name === "browser_snapshot");
  if (snap?.inputSchema?.properties) {
    (snap.inputSchema.properties as Record<string, unknown>).section = {
      type: "string",
      description: "Return only the subtree under this landmark (e.g. 'form', 'main', 'navigation \"Footer\"'). Reduces output by 90%+.",
    };
    (snap.inputSchema.properties as Record<string, unknown>).around = {
      type: "number",
      description: "Return only the landmark subtree containing this ref number. Use when you know a specific element's ref.",
    };
    (snap.inputSchema.properties as Record<string, unknown>).depth = {
      type: "number",
      description: "Max depth of the returned subtree. Use with section/around to get a high-level overview first.",
    };
  }
  (result.tools as Tool[]).push(A11Y_TOOL);
  if (FIGMA_ENABLED) {
    try {
      const { r: figmaResult, e: figmaErr } = await figmaP!;
      if (figmaErr) throw figmaErr;
      if (!figmaResult) throw new Error(`no answer within ${LIST_WAIT_MS} ms, will re-list when it is up`);
      (figmaResult.tools as Tool[]).forEach((t) => figmaToolNames.add(t.name));
      (result.tools as Tool[]).push(...(figmaResult.tools as Tool[]));
      // The official server returns generated code, not the JSON style tree design diff reads.
      if (!FIGMA_MCP_URL) (result.tools as Tool[]).push({
        name: "playguard_compare_design",
        description: "Compare visual properties of Figma design elements against live browser elements. " +
          "Returns a structured diff showing exact mismatches. Three modes: one element (figmaNodeId + browserSelector), " +
          "several at once (pairs[]), or autoMap — point figmaNodeId at a component and it maps the layers underneath " +
          "onto DOM elements by data-figma-id / data-testid / id / class, or by exact text for text layers. " +
          "Properties are auto-selected from each Figma node unless you pass properties[].",
        inputSchema: {
          type: "object",
          properties: {
            figmaFileKey: { type: "string", description: "Figma file key (from URL: figma.com/file/<key>/...)" },
            figmaNodeId: { type: "string", description: "Figma node ID (e.g. '42:1337'). The element to compare, or the component to map when autoMap is set." },
            browserSelector: { type: "string", description: "CSS selector for the browser element (e.g. '[data-testid=\"login-btn\"]'). Omit when using pairs or autoMap." },
            autoMap: {
              type: "boolean",
              description: `Map the layers under figmaNodeId onto DOM elements automatically (max ${MAX_AUTO_MAP}). Layers with no unique match are reported, not guessed.`,
            },
            pairs: {
              type: "array",
              description: "Batch mode: compare several (Figma node, browser element) pairs in one call.",
              items: {
                type: "object",
                properties: {
                  figmaNodeId: { type: "string" },
                  browserSelector: { type: "string" },
                },
                required: ["figmaNodeId", "browserSelector"],
              },
            },
            properties: {
              type: "array", items: { type: "string", enum: ALL_PROPERTIES },
              description: "Properties to compare. Default: auto-selected from each Figma node (a TEXT layer gets its typography and color; a container gets backgroundColor/padding/borderRadius/boxShadow). Pass explicitly to override. width/height are never auto-selected — they depend on the viewport.",
            },
          },
          required: ["figmaFileKey"],
        },
      });
    } catch (e) {
      process.stderr.write(`[PlayGuard] Figma MCP listTools failed: ${e}\n`);
    }
  }
  if (DEVTOOLS_MCP_CMD) {
    // A DevTools failure only costs its own tools — Playwright/Figma still list.
    try {
      const { r: dtList, e: dtErr } = await dtP!;
      if (dtErr) throw dtErr;
      if (!dtList) throw new Error(`no answer within ${LIST_WAIT_MS} ms, will re-list when it is up`);
      const { tools } = dtList;
      const taken = new Set((result.tools as Tool[]).map(t => t.name));
      const own = (tools as Tool[]).filter((t) => {
        if (!taken.has(t.name)) return true;
        dtToolNames.delete(t.name);
        process.stderr.write(`[PlayGuard] DevTools tool "${t.name}" collides with an existing tool — skipped\n`);
        return false;
      });
      own.forEach(t => dtToolNames.add(t.name));
      const listed = DEVTOOLS_OPTIMIZE ? compactDevtoolsTools(own, { networkMax: DEVTOOLS_NETWORK_MAX }) : own;
      if (SCREENSHOTS === "redirect") {
        const shot = listed.find(t => t.name === "take_screenshot");
        if (shot) {
          // compactDevtoolsTools returns new objects; with OPTIMIZE off these came from a fresh listTools.
          shot.description = (shot.description ?? "") +
            "\n[PlayGuard] Returns a snapshot by default (cheaper, structured). Pass {visual:true} if you need actual pixels.";
          shot.inputSchema = {
            ...shot.inputSchema,
            properties: { ...shot.inputSchema.properties, visual: { type: "boolean", description: "Set true to get a real screenshot instead of a snapshot." } },
          };
        }
      }
      (result.tools as Tool[]).push(...listed);
    } catch (e) {
      process.stderr.write(`[PlayGuard] DevTools MCP listTools failed: ${e}\n`);
    }
  }
  // Merged in a fixed order: a collision always resolves the same way.
  const docsLists = await docsP;
  docsUps.forEach((d, i) => d.merge(docsLists[i], result.tools as Tool[]));
  return result;
});

const handleCall = async ({ params: { name, arguments: args = {} } }: { params: { name: string; arguments?: ToolArgs } }) => {
  const t0 = Date.now();
  const url = lastUrl || undefined;

  if (name === "playguard_a11y_audit") return a11yAudit(args as ToolArgs);

  // ── Design diff tool ─────────────────────────────────────────────────────
  if (name === "playguard_compare_design") {
    if (FIGMA_MCP_URL) {
      logCall(name, 0, true, { error: "official_figma" });
      return { content: [{ type: "text", text: "[PlayGuard design diff: error] needs the Framelink Figma MCP (FIGMA_MCP_CMD); the official server (FIGMA_MCP_URL) returns code, not the style tree it compares." }], isError: true };
    }
    const a = args as unknown as DesignDiffArgs;
    // Omitted `properties` means auto-select per node from what the design
    // actually defines — resolved inside comparePair, which has the node.
    const properties = a.properties?.length ? a.properties : undefined;
    try {
      if (lastUrl) {
        const cur = await browserEval("() => location.href");
        if (cur.error || !cur.data || cur.data === "about:blank") {
          try {
            const bc = await getConn();
            await bc.callTool({ name: "browser_navigate", arguments: { url: lastUrl } });
          } catch (e) {
            process.stderr.write(`[PlayGuard] auto-restore lastUrl failed: ${e}\n`);
          }
        }
      }

      let pairs: DesignPair[];
      let prefetched: unknown;
      let mapWarnings: string[] = [];

      if (a.autoMap) {
        if (!a.figmaNodeId) {
          logCall(name, Date.now() - t0, true, { error: "automap_without_node" });
          return { content: [{ type: "text", text: "[PlayGuard design diff: error] autoMap needs figmaNodeId (the component to map)" }], isError: true };
        }
        const mapped = await autoMapPairs(a.figmaFileKey, a.figmaNodeId);
        if (mapped.error) {
          logCall(name, Date.now() - t0, true, { autoMap: true, error: mapped.error });
          return { content: [{ type: "text", text: `[PlayGuard design diff: autoMap] ${mapped.error}` }], isError: true };
        }
        if (!mapped.pairs.length) {
          logCall(name, Date.now() - t0, true, { autoMap: true, error: "nothing_mapped" });
          return { content: [{ type: "text", text: `[PlayGuard design diff: autoMap] no Figma layer resolved to a unique browser element.\n${mapped.warnings.join("\n")}` }], isError: true };
        }
        pairs = mapped.pairs;
        prefetched = mapped.figmaData; // one fetch covers the whole subtree
        mapWarnings = mapped.warnings;
      } else {
        pairs = a.pairs?.length ? a.pairs
          : a.figmaNodeId && a.browserSelector
            ? [{ figmaNodeId: a.figmaNodeId, browserSelector: a.browserSelector }]
            : [];
        if (!pairs.length) {
          logCall(name, Date.now() - t0, true, { error: "no_pairs" });
          return { content: [{ type: "text", text: "[PlayGuard design diff: error] pass figmaNodeId + browserSelector, a non-empty pairs[], or autoMap with figmaNodeId" }], isError: true };
        }
      }

      // Pairs run sequentially: both upstreams are single stdio connections, and
      // browser_evaluate acts on one page — concurrent calls would interleave.
      const results: DesignDiffResult[] = [];
      for (const p of pairs) {
        results.push(await comparePair(a.figmaFileKey, p, properties, prefetched));
      }
      const batch = pairs.length > 1 || !!a.autoMap;
      const output = batch ? formatBatchResult(results, mapWarnings) : formatDiffResult(results[0]);
      const failed = results.filter(r => r.error).length;
      logCall(name, Date.now() - t0, failed === results.length, {
        pairs: pairs.length, failed, autoMap: a.autoMap || undefined,
        autoProps: properties ? undefined : true,
        unmapped: mapWarnings.length || undefined,
        matches: results.reduce((n, r) => n + r.matches, 0),
        mismatches: results.reduce((n, r) => n + r.mismatches, 0),
        skipped: results.reduce((n, r) => n + r.skipped, 0),
        pairErrors: results.filter(r => r.error).map(r => r.error).length ? results.filter(r => r.error).map(r => r.error) : undefined,
      });
      // A single failing pair keeps Phase 1's isError contract; in a batch one bad
      // selector shouldn't discard the diffs that did succeed.
      return { content: [{ type: "text", text: output }], ...(failed === results.length ? { isError: true } : {}) };
    } catch (e) {
      logCall(name, Date.now() - t0, true, { error: String(e) });
      return { content: [{ type: "text", text: `[PlayGuard design diff: error] ${e}` }], isError: true };
    }
  }

  // ── Figma MCP routing ──────────────────────────────────────────────────────
  // Official tool names still reach Figma while the desktop app is down, so the agent gets
  // "not reachable, open Figma" instead of an unknown-tool error from Playwright.
  if (FIGMA_ENABLED && (figmaToolNames.has(name) || (FIGMA_MCP_URL && !figmaToolNames.size && FIGMA_OFFICIAL_TOOLS.has(name)))) {
    const t0f = Date.now();
    // Normalized key: sorted arg order, and nodeId "39-327" ≡ "39:327" (Figma accepts both,
    // agents emit both) — otherwise the same logical call misses the cache.
    const normArgs: ToolArgs = { ...args };
    if (typeof normArgs.nodeId === "string") normArgs.nodeId = normArgs.nodeId.replace(/-/g, ":");
    const cacheKey = name + "\0" + JSON.stringify(sortDeep(normArgs));
    // argsHash in every figma log line proves whether two calls were byte-identical —
    // the difference between "cache is broken" and "the agent varied depth".
    const argsHash = createHash("sha256").update(cacheKey).digest("hex").slice(0, 8);
    const figmaLogBase = {
      figma: true, argsHash, official: FIGMA_MCP_URL ? true : undefined,
      fileKey: (args as ToolArgs).fileKey, nodeId: (args as ToolArgs).nodeId,
      depth: (args as ToolArgs).depth,
    };
    // Off for the official server: without a nodeId it answers from the live selection in the
    // Figma app, and it reflects edits — a cached answer would be silently stale.
    const useCache = FIGMA_CACHE_TTL > 0 && !FIGMA_MCP_URL;
    if (useCache) {
      const hit = figmaCache.get(cacheKey, FIGMA_CACHE_TTL);
      if (hit !== undefined) {
        logCall(name, 0, false, { ...figmaLogBase, cacheHit: true });
        return hit as Awaited<ReturnType<Client["callTool"]>>;
      }
    }
    try {
      const c = FIGMA_MCP_URL ? null : await getFigmaConn();
      let callArgs = args;
      // Only tools that actually take a localPath get one injected — adding an unknown
      // property to, say, get_figma_data would be rejected by a strict upstream schema.
      const takesLocalPath = (args as ToolArgs)?.localPath !== undefined || /image|download/i.test(name);
      const figmaDir = takesLocalPath ? figmaLocalPath((args as ToolArgs)?.localPath, FIGMA_DIR) : null;
      if (figmaDir) {
        mkdirSync(figmaDir, { recursive: true });
        callArgs = { ...args, localPath: figmaDir };
      }
      const r = c ? await c.callTool({ name, arguments: callArgs }) : await callFigmaHttp(name, callArgs as ToolArgs);
      let out = r;
      let figmaStats: FigmaOptStats | undefined;
      let textTruncated = false;
      let textFullChars: number | undefined;
      let textStubbed = 0;
      let parsedData: any;
      // Why the response wasn't optimized — surfaces the upstream/format mismatch
      // (e.g. Framelink run with OUTPUT_FORMAT=tree, which parses as neither JSON nor YAML) instead
      // of swallowing it. If this is consistently set, the optimizer is a no-op.
      let parseSkip: "no-json-item" | "parse-error" | undefined;
      // The official server answers with generated code/XML: nothing to parse as a tree, and a
      // text slice would cut code mid-statement. Passed through whole (cache still applies).
      if (!r.isError && !FIGMA_MCP_URL) {
        const textItem = (r.content as ContentItem[])
          .find(c => c.type === "text" && c.text && c.text.trim().length > 0);
        if (textItem?.text) {
          const raw = textItem.text;
          let parsed: unknown;
          try {
            parsed = raw.trimStart().startsWith("{") ? JSON.parse(raw) : yamlLoad(raw);
          } catch { parseSkip = "parse-error"; }
          if (parsed !== undefined) {
            // Not caught here: a throw inside the optimizer itself is a real bug, not an
            // upstream format mismatch — let it propagate instead of being mislabeled as parseSkip.
            const { data, stats: st } = optimizeFigmaResponse(parsed, Buffer.byteLength(raw));
            figmaStats = st;
            parsedData = data;
            const pct = Math.round((1 - st.outBytes / st.inBytes) * 100);
            out = {
              ...r,
              content: [
                { type: "text", text: `[PlayGuard figma: -${pct}% (${(st.inBytes / 1024).toFixed(1)}KB→${(st.outBytes / 1024).toFixed(1)}KB)]\n` + JSON.stringify(data) },
                ...(r.content as any[]).slice(1),
              ],
            };
          }
        } else {
          parseSkip = "no-json-item";
        }
        if (parseSkip) process.stderr.write(`[PlayGuard] figma optimizer skipped (${parseSkip}) for ${name} — upstream not raw JSON?\n`);

        // Fallback compaction: when the optimized tree is still too big, trim it
        // structurally (Module 7 / budgetTrimFigma) instead of slicing raw text — every
        // branch keeps at least an {id,name,type} stub, so the agent can see a section
        // exists and re-fetch it by id instead of losing it outright. Only falls back to
        // a boundary-safe text slice when the response never parsed into a tree at all
        // (parseSkip — genuinely malformed upstream, nothing to trim structurally).
        if (FIGMA_TEXT_COMPACT > 0) {
          const firstItem = (out.content as ContentItem[])[0];
          if (firstItem?.type === "text" && firstItem.text && firstItem.text.length > FIGMA_TEXT_COMPACT) {
            const fullLen = firstItem.text.length;
            textTruncated = true; textFullChars = fullLen;
            let newText: string;
            if (parsedData !== undefined) {
              const { data: trimmed, stubbed } = budgetTrimFigma(parsedData, FIGMA_TEXT_COMPACT);
              textStubbed = stubbed;
              newText = JSON.stringify(trimmed);
            } else {
              const nl = firstItem.text.lastIndexOf("\n", FIGMA_TEXT_COMPACT);
              newText = firstItem.text.slice(0, nl > 0 ? nl : FIGMA_TEXT_COMPACT);
            }
            out = {
              ...out,
              content: [
                {
                  type: "text",
                  text: `[PlayGuard: figma output truncated (${fullLen}→${newText.length} chars${textStubbed ? `, ${textStubbed} section(s) stubbed` : ""})]\n` + newText,
                },
                ...(out.content as any[]).slice(1),
              ],
            };
          }
        }

      }
      if (!r.isError && useCache) figmaCache.set(cacheKey, out);
      logCall(name, Date.now() - t0f, !!r.isError, {
        ...figmaLogBase,
        cacheHit: false,
        errText: r.isError ? errSummary(r.content) : undefined,
        parseSkip,
        textTruncated: textTruncated || undefined,
        textFullChars,
        textStubbed: textStubbed || undefined,
        ...(figmaStats ? {
          inBytes: figmaStats.inBytes,
          outBytes: figmaStats.outBytes,
          savedBytes: figmaStats.inBytes - figmaStats.outBytes,
          pct: Math.round((1 - figmaStats.outBytes / figmaStats.inBytes) * 100),
          inTokens: Math.round(figmaStats.inBytes / 4),
          outTokens: Math.round(figmaStats.outBytes / 4),
          savedTokens: Math.round((figmaStats.inBytes - figmaStats.outBytes) / 4),
          metaKeysDeleted: figmaStats.metaKeysDeleted,
          invisiblePruned: figmaStats.invisiblePruned,
          svgRefsReplaced: figmaStats.svgRefsReplaced,
          instancesCollapsed: figmaStats.instancesCollapsed,
          uniqueComponents: figmaStats.uniqueComponents,
          siblingsCollapsed: figmaStats.siblingsCollapsed,
          structSiblingsCollapsed: figmaStats.structSiblingsCollapsed,
          emptyStylesDropped: figmaStats.emptyStylesDropped,
          floatsRounded: figmaStats.floatsRounded,
        } : {}),
      });
      return out;
    } catch (e) {
      const errMsg = redactUrlCreds(String((e as Error)?.message ?? e));
      logCall(name, Date.now() - t0f, true, { ...figmaLogBase, error: FIGMA_MCP_URL ? errMsg : String(e), errText: errSummary(FIGMA_MCP_URL ? errMsg : e) });
      // Our own connect/refusal messages are for the agent to act on: a tool result, not a protocol error.
      if (FIGMA_MCP_URL) return { content: [{ type: "text", text: errMsg }], isError: true };
      throw e;
    }
  }

  // ── Chrome DevTools MCP routing ────────────────────────────────────────────
  if (DEVTOOLS_MCP_CMD && dtToolNames.has(name)) return callDevtools(name, args as ToolArgs);
  // An upstream that never came up has no listed names; its known names still reach it,
  // so the agent gets "not running" (and a fresh spawn attempt) instead of "Tool not found".
  const docs = docsUps.find(d => d.names.has(name)) ?? docsUps.find(d => !d.names.size && d.known.has(name));
  if (docs) return docs.call(name, args as ToolArgs);

  // ── Screenshot → snapshot redirect ─────────────────────────────────────────
  // A file to write, one element or the full page only make sense as pixels — implicit visual.
  const wantsPixels = (a: ToolArgs) => !!(a.visual || a.filename || a.element || a.target || a.ref || a.fullPage);
  if (name === "browser_take_screenshot" && SCREENSHOTS === "redirect" && !wantsPixels(args as ToolArgs)) {
    // filterKey guard: the cached compact may be a section/around/depth subtree, and
    // handing that back for a whole-page screenshot silently answers a different question.
    if (snapState.hash && snapState.compact && snapState.filterKey === "{}" && Date.now() - snapState.ts < 10_000) {
      logCall(name, Date.now() - t0, false, { url, redirected: true, cacheHit: true });
      return { content: [{ type: "text", text: "[PlayGuard: snapshot served instead of screenshot (cached). Call with {visual:true} for actual pixels.]\n" + snapState.compact }] };
    }
    try {
      const c = await getConn();
      const r = await c.callTool({ name: "browser_snapshot", arguments: {} });
      if (!r.isError) {
        const summary = cacheSnapshot(r.content as ContentItem[]);
        logCall(name, Date.now() - t0, false, { url, redirected: true, cacheHit: false, rawBytes: summary.rawBytes, keptBytes: summary.keptBytes });
        return { content: [{ type: "text", text: "[PlayGuard: snapshot served instead of screenshot. Call with {visual:true} for actual pixels.]\n" + summary.text }] };
      }
    } catch {}
    process.stderr.write("[PlayGuard] snapshot failed during redirect, taking real screenshot\n");
  }

  if (name === "browser_take_screenshot") {
    if (SCREENSHOTS === "block") {
      logCall(name, Date.now() - t0, true, { url, blocked: true });
      return {
        content: [{ type: "text", text: "[PlayGuard] screenshots blocked. Set PLAYGUARD_SCREENSHOTS=allow to enable." }],
        isError: true,
      };
    }
    if (SCREENSHOTS === "warn")
      process.stderr.write("[PlayGuard] screenshot called — prefer browser_snapshot for structured interaction\n");
  }

  // ── Evaluate deduplication ─────────────────────────────────────────────────
  let evalKey: string | undefined;
  let scriptHash: string | undefined;
  if (name === "browser_evaluate") {
    const script = String((args as ToolArgs).function ?? (args as ToolArgs).code ?? (args as ToolArgs).expression ?? JSON.stringify(args));
    scriptHash = sha8(script);
    if (EVAL_CACHE_TTL > 0) {
      evalKey = createHash("sha256").update(lastUrl + "\0" + script).digest("hex").slice(0, 16);
      const hit = evalCache.get(evalKey, EVAL_CACHE_TTL);
      if (hit !== undefined) {
        logCall(name, 0, false, { url, evalCacheHit: true, scriptHash });
        return hit;
      }
    }
  }

  let wasRetried = false;
  const invoke = async (retry = false): Promise<Awaited<ReturnType<Client["callTool"]>>> => {
    if (retry) wasRetried = true;
    const c = retry ? await revive() : await getConn();
    try {
      let r = await c.callTool({ name, arguments: args });
      const bodyText = (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join(" ");
      if (!retry && r.isError && dead(bodyText)) return invoke(true);

      if (!r.isError) {
        if (name === "browser_snapshot") {
          if (SMART_WAIT && (!snapState.prefetched || !snapState.hash)) {
            let attempts = 0;
            while (attempts < SMART_WAIT_MAX_RETRIES && looksLikeLoading(r.content as ContentItem[])) {
              await new Promise(res => setTimeout(res, SMART_WAIT_MS));
              const c = await getConn();
              r = await c.callTool({ name: "browser_snapshot", arguments: args });
              attempts++;
            }
          }

          const a = args as ToolArgs;
          const section = typeof a.section === "string" ? a.section : undefined;
          const around = typeof a.around === "number" ? a.around : undefined;
          const depth = typeof a.depth === "number" ? a.depth : undefined;

          const decision = decideSnapshot(r.content as ContentItem[], snapState, lastUrl, {
            deltaEnabled: DELTA_ENABLED, deltaThreshold: DELTA_THRESHOLD,
            hintThreshold: HINT_THRESHOLD, compact: COMPACT,
            section, around, depth
          });

          if (SMART_WAIT && looksLikeLoading(r.content as ContentItem[])) {
             decision.responseText = `[PlayGuard: page may still be loading after waiting (low refs, loading indicator present)]\n` + decision.responseText;
          }

          snapState = decision.state;
          return {
            content: [{ type: "text", text: decision.responseText }],
            _snapMeta: decision.meta,
          } as Awaited<ReturnType<Client["callTool"]>>;
        }

        if (MUTATING.has(name)) {
          // Only invalidate the UNCHANGED/screenshot-redirect shortcuts (both gate on `hash`).
          // Keep `lines`/`url` so the next browser_snapshot can still delta against pre-action state.
          // withoutAction resets here — an action just happened, and without this the counter
          // is really "total snapshots" and the hint it triggers claims something untrue.
          snapState = { ...snapState, hash: null, compact: null, withoutAction: 0 };
          snapGen++;
        }
        if (EVAL_INVALIDATING.has(name)) {
          evalCache.clear();
        }

        if (name === "browser_navigate") {
          urlHistory.push(lastUrl);
          lastUrl = (args as { url?: string }).url ?? lastUrl;
          // ponytail: no await — runs in background, worst case next snapshot call misses
          if (PREFETCH_SNAPSHOT) prefetchSnapshot();
        }
        if (name === "browser_navigate_back") {
          lastUrl = urlHistory.pop() ?? lastUrl;
        }
      }

      return r;
    } catch (e) {
      if (!retry && dead(e)) return invoke(true);
      throw e;
    }
  };

  let result: Awaited<ReturnType<typeof invoke>>;
  try {
    result = await invoke();
  } catch (e) {
    // Without this a thrown upstream error never reached the log at all.
    logCall(name, Date.now() - t0, true, { url, errText: errSummary(e), thrown: true });
    throw e;
  }

  // ── Eval: cache result + compact large output ──────────────────────────────
  let evalOutputBytes: number | undefined;
  let evalTruncated: true | undefined;
  if (name === "browser_evaluate" && !result.isError) {
    if (evalKey && EVAL_CACHE_TTL > 0) evalCache.set(evalKey, result);
    if (EVAL_COMPACT_THRESHOLD > 0) {
      const text = (result.content as ContentItem[]).map(c => c.text ?? "").join("");
      evalOutputBytes = text.length;
      if (text.length > EVAL_COMPACT_THRESHOLD) {
        evalTruncated = true;
        (result as unknown as { content: ContentItem[] }).content = [{
          type: "text",
          text: `[PlayGuard: eval output truncated (${text.length}→${EVAL_COMPACT_THRESHOLD} chars)]\n` + text.slice(0, EVAL_COMPACT_THRESHOLD),
        }];
      }
    }
  }

  // ── Build logCall extra fields ─────────────────────────────────────────────
  const r = result as typeof result & { _snapMeta?: SnapshotMeta };

  let extra: Record<string, unknown> = { url };
  if (wasRetried) extra.retried = true;
  if (result.isError) extra.errText = errSummary(result.content);
  const a = args as ToolArgs;

  if (name === "browser_snapshot") {
    const m = r._snapMeta;
    extra = {
      ...extra,
      cacheHit: m?.cacheHit ?? false,
      prefetchHit: m?.prefetchHit,
      delta: m?.delta ?? false,
      deltaAdded: m?.deltaAdded,
      deltaRemoved: m?.deltaRemoved,
      savedBytes: m?.savedBytes,
      rawBytes: m?.rawBytes,
      keptBytes: m?.keptBytes,
      hinted: m?.hinted ?? false,
      snapCount: m?.snapCount,
      section: m?.section,
      around: m?.around,
      depth: m?.depth,
    };
  } else if (name === "browser_evaluate") {
    extra = { ...extra, scriptHash, outputBytes: evalOutputBytes, truncated: evalTruncated };
  } else if (name === "browser_wait_for") {
    // Shape only — tells a fixed sleep (`time`) from a real condition.
    extra.waitKind = a.time !== undefined ? "time" : a.text !== undefined ? "text" : a.textGone !== undefined ? "textGone" : undefined;
    if (typeof a.time === "number") extra.waitTime = a.time;
  } else if (name === "browser_run_code_unsafe") {
    // Length + hash like evaluate's scriptHash; the code itself stays out of the log.
    const code = String(a.code ?? "");
    Object.assign(extra, { codeChars: code.length, codeHash: sha8(code), codeSleeps: code.split("waitForTimeout(").length - 1 });
  } else if (name === "browser_take_screenshot" && !result.isError) {
    const screenshotBytes = (result.content as Array<{ type?: string; data?: string }>)
      .reduce((s, c) => s + (c.data ? Math.round(c.data.length * 3 / 4) : 0), 0);
    if (screenshotBytes > 0) extra.screenshotBytes = screenshotBytes;
    // Distinguishes "agent explicitly wanted pixels" from "redirect wasn't active".
    if (a.visual) extra.visual = true;
    if (a.fullPage) extra.fullPage = true;
    if (a.type) extra.type = a.type;
  }

  logCall(name, Date.now() - t0, !!result.isError, extra);
  return result;
};

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const r = await handleCall(req);
  if (!pendingNotice) return r;
  const notice = pendingNotice;
  pendingNotice = null;
  // New object, not a mutation: r may be a cached result that later calls get back.
  return { ...r, content: [{ type: "text", text: notice }, ...((r.content as ContentItem[] | undefined) ?? [])] };
});

// One retry on startup: a transient spawn failure would otherwise leave figmaToolNames
// empty forever, silently disabling Figma routing for the rest of the process lifetime.
function initFigmaTools(attempt = 1): void {
  getFigmaConn()
    .then(c => c.listTools())
    .then(({ tools }) => (tools as Tool[]).forEach(t => figmaToolNames.add(t.name)))
    .catch(e => {
      process.stderr.write(`[PlayGuard] Figma MCP init failed (attempt ${attempt}): ${e}\n`);
      if (attempt === 1) setTimeout(() => initFigmaTools(2), 3000);
    });
}
if (FIGMA_ENABLED) initFigmaTools();

// Same idea for DevTools: routing needs dtToolNames even if the client never called
// tools/list, or called it before the upstream was up. Playwright's browser_* names and
// Figma's names win a collision (Figma's may not be known yet — tools/list re-checks).
function initDevtoolsTools(attempt = 1): void {
  dtUp.get()
    .then(c => c.listTools())
    .then(({ tools }) => (tools as Tool[]).forEach((t) => {
      if (!t.name.startsWith("browser_") && t.name !== "playguard_compare_design" && !figmaToolNames.has(t.name)) dtToolNames.add(t.name);
    }))
    .catch(e => {
      process.stderr.write(`[PlayGuard] DevTools MCP init failed (attempt ${attempt}): ${e}\n`);
      if (attempt === 1) setTimeout(() => initDevtoolsTools(2), 3000);
    });
}
if (DEVTOOLS_MCP_CMD) initDevtoolsTools();

// Docs upstreams claim only names nobody else has (an earlier docs upstream included).
for (const d of docsUps) {
  d.init((n) => n.startsWith("browser_") || n === "playguard_compare_design" || figmaToolNames.has(n) ||
    dtToolNames.has(n) || docsUps.some(o => o !== d && o.names.has(n)));
}

// PLAYGUARD_NO_SERVE=1 lets tests import the pure helpers without opening the stdio transport.
if (process.env.PLAYGUARD_NO_SERVE !== "1") {
  if (UPDATE_CHECK) checkForUpdate(); // no await — must never delay startup
  await server.connect(new StdioServerTransport());
}
