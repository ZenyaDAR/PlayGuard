#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolve, isAbsolute } from "path";
import { createHash } from "crypto";
import { appendFile, mkdirSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { extractFigmaProperties, buildBrowserEvalScript, normalizeBrowserResponse,
  compareProperties, formatDiffResult, formatBatchResult, autoSelectProperties,
  collectMappableNodes, buildAutoMapScript, ALL_PROPERTIES, MAX_AUTO_MAP,
  type DesignDiffArgs, type DesignPair, type DesignDiffResult } from "./design-diff.js";
import {
  splitArgs, VERSION, LOG_DIR, OUTPUT_DIR, PW_CMD, PW_ARGS, FIGMA_CMD, FIGMA_ARGS,
  SCREENSHOTS, COMPACT, EVAL_CACHE_TTL, PREFETCH_SNAPSHOT,
  SMART_WAIT, SMART_WAIT_MS, SMART_WAIT_MAX_RETRIES, EVAL_COMPACT_THRESHOLD,
  FIGMA_MCP_CMD, FIGMA_CACHE_TTL, FIGMA_TEXT_COMPACT,
  DESIGN_DIFF_TOLERANCE_PX, DESIGN_DIFF_TOLERANCE_COLOR,
  DELTA_THRESHOLD, DELTA_ENABLED, HINT_THRESHOLD,
} from "./config.js";
import {
  STRUCTURAL_RE, hashContent, compactSnap, collapseRuns, decideSnapshot, looksLikeLoading,
  emptySnapState, type SnapState, type SnapshotMeta,
} from "./snapshot.js";
import { optimizeFigmaResponse, budgetTrimFigma, type FigmaOptStats } from "./figma-optimize.js";

// Re-exported so tests (and downstream importers) can reach the pure helpers
// straight off dist/index.js, unchanged by the module split.
export { splitArgs, withOutputDir } from "./config.js";
export { compactSnap, collapseRuns, decideSnapshot, looksLikeLoading, emptySnapState } from "./snapshot.js";
export type { SnapState } from "./snapshot.js";
export { optimizeFigmaResponse, budgetTrimFigma } from "./figma-optimize.js";

type ToolArgs = Record<string, unknown>;
type ContentItem = { type?: string; text?: string; data?: string };

// Random per-process id on every log line: caches are in-memory, so a "miss" on
// identical args is only a bug if both calls came from the same instance.
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
let logWriteFailed = false;
function logCall(tool: string, ms: number, err: boolean, extra?: object) {
  const line = JSON.stringify({ ts: Date.now(), inst: INSTANCE_ID, tool, ms, err, ...extra });
  appendFile(resolve(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.ndjson`), line + "\n", (e) => {
    if (e && !logWriteFailed) { logWriteFailed = true; process.stderr.write(`[PlayGuard] analytics log write failed, disabling further warnings: ${e}\n`); }
  });
}

const DEAD_RE = /Target.*closed|Browser.*closed|page.*closed|connect ECONNREFUSED|crashed|Navigation failed because page|Protocol error.*Target/i;

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

// ponytail: generic TTL cache — evalCache and figmaCache both need the same
// get-with-ttl + clear-whole-map-when-full shape, so it's written once.
export function ttlCache<T>(maxEntries: number) {
  const map = new Map<string, { result: T; ts: number }>();
  return {
    get(key: string, ttlMs: number): T | undefined {
      const hit = map.get(key);
      return hit && Date.now() - hit.ts < ttlMs ? hit.result : undefined;
    },
    set(key: string, result: T): void {
      if (map.size >= maxEntries) map.clear();
      map.set(key, { result, ts: Date.now() });
    },
    clear(): void { map.clear(); },
  };
}

// Eval deduplication cache — keyed by hash(url + script), TTL = EVAL_CACHE_TTL ms
// ponytail: unbounded long-running sessions would grow this forever; cap by size instead of an LRU
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
  await c.connect(t);
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

// ponytail: fire-and-forget — races don't matter, worst case next snapshot call is a miss
async function prefetchSnapshot(): Promise<void> {
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
    if (!r.isError) cacheSnapshot(r.content as Array<{ text?: string }>, true);
  } catch {}
}

// ── Figma connection ───────────────────────────────────────────────────────────

async function spawnFigmaConn(): Promise<Client> {
  // Forward all FIGMA_* env vars (e.g. FIGMA_API_KEY) to the child process
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("FIGMA_") && v) env[k] = v;
  }
  const t = new StdioClientTransport({ command: FIGMA_CMD, args: FIGMA_ARGS, env: Object.keys(env).length ? env : undefined });
  const c = new Client({ name: "playguard-figma", version: VERSION });
  await c.connect(t);
  return c;
}

async function getFigmaConn(): Promise<Client> {
  if (figmaConn) return figmaConn;
  if (!figmaPending) {
    figmaPending = spawnFigmaConn()
      .then(c => { figmaConn = c; figmaPending = null; return c; })
      .catch(e => { figmaPending = null; throw e; });
  }
  return figmaPending;
}

// Figma image downloads write to a caller-supplied directory (Framelink's
// download_figma_images uses `localPath`). A relative one lands in the child's cwd
// (project root); anchor it under OUTPUT_DIR/figma so images join the rest.
// Returns null when the arg should be passed through untouched — an absolute path
// is the caller being explicit, and a missing/empty one leaves the upstream default.
export function figmaLocalPath(localPath: unknown, outputDir: string): string | null {
  if (typeof localPath !== "string" || !localPath || isAbsolute(localPath)) return null;
  return resolve(outputDir, "figma", localPath);
}

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
  const text = (r.content as ContentItem[]).find(c => c.type === "text")?.text ?? "{}";

  let dataStr = text;
  if (text.includes("### Result")) {
    const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n###|$)/);
    if (match) dataStr = match[1].trim();
  } else if (text.includes("```json")) {
    const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (match) dataStr = match[1].trim();
  }

  try {
    return { data: JSON.parse(dataStr) };
  } catch {
    // fallback: find the first { ... } block
    const match = text.match(/\{[\s\S]*\}/);
    try {
      if (match) return { data: JSON.parse(match[0]) };
    } catch {}
    return { data: {} };
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

const server = new Server(
  { name: "playguard", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await getConn().then((c) => c.listTools());
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
  if (FIGMA_MCP_CMD) {
    try {
      const figmaResult = await getFigmaConn().then(c => c.listTools());
      (figmaResult.tools as Tool[]).forEach((t) => figmaToolNames.add(t.name));
      (result.tools as Tool[]).push(...(figmaResult.tools as Tool[]));
      (result.tools as Tool[]).push({
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
  return result;
});

server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const t0 = Date.now();
  const url = lastUrl || undefined;

  // ── Design diff tool ─────────────────────────────────────────────────────
  if (name === "playguard_compare_design") {
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
  if (FIGMA_MCP_CMD && figmaToolNames.has(name)) {
    const t0f = Date.now();
    // Normalized key: sorted arg order, and nodeId "39-327" ≡ "39:327" (Figma accepts both,
    // agents emit both) — otherwise the same logical call misses the cache.
    const normArgs: ToolArgs = { ...args };
    if (typeof normArgs.nodeId === "string") normArgs.nodeId = normArgs.nodeId.replace(/-/g, ":");
    const cacheKey = name + "\0" + JSON.stringify(normArgs, Object.keys(normArgs).sort());
    // argsHash in every figma log line proves whether two calls were byte-identical —
    // the difference between "cache is broken" and "the agent varied depth".
    const argsHash = createHash("sha256").update(cacheKey).digest("hex").slice(0, 8);
    const figmaLogBase = {
      figma: true, argsHash,
      fileKey: (args as ToolArgs).fileKey, nodeId: (args as ToolArgs).nodeId,
      depth: (args as ToolArgs).depth,
    };
    if (FIGMA_CACHE_TTL > 0) {
      const hit = figmaCache.get(cacheKey, FIGMA_CACHE_TTL);
      if (hit !== undefined) {
        logCall(name, 0, false, { ...figmaLogBase, cacheHit: true });
        return hit as Awaited<ReturnType<Client["callTool"]>>;
      }
    }
    try {
      const c = await getFigmaConn();
      let callArgs = args;
      const figmaDir = figmaLocalPath((args as ToolArgs).localPath, OUTPUT_DIR);
      if (figmaDir) {
        mkdirSync(figmaDir, { recursive: true });
        callArgs = { ...args, localPath: figmaDir };
      }
      const r = await c.callTool({ name, arguments: callArgs });
      let out = r;
      let figmaStats: FigmaOptStats | undefined;
      let textTruncated = false;
      let textFullChars: number | undefined;
      let textStubbed = 0;
      let parsedData: any;
      // Why the response wasn't optimized — surfaces the upstream/format mismatch
      // (Framelink defaults to YAML; this optimizer expects raw REST-API JSON) instead
      // of swallowing it. If this is consistently set, the optimizer is a no-op.
      let parseSkip: "no-json-item" | "parse-error" | undefined;
      if (!r.isError) {
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

        if (FIGMA_CACHE_TTL > 0) figmaCache.set(cacheKey, out);
      }
      logCall(name, Date.now() - t0f, !!r.isError, {
        ...figmaLogBase,
        cacheHit: false,
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
      logCall(name, Date.now() - t0f, true, { ...figmaLogBase, error: String(e) });
      throw e;
    }
  }

  // ── Screenshot → snapshot redirect ─────────────────────────────────────────
  if (name === "browser_take_screenshot" && SCREENSHOTS === "redirect" && !(args as ToolArgs).visual) {
    if (snapState.hash && snapState.compact && Date.now() - snapState.ts < 10_000) {
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
    scriptHash = createHash("sha256").update(script).digest("hex").slice(0, 8);
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
          snapState = { ...snapState, hash: null, compact: null };
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

  const result = await invoke();

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
  } else if (name === "browser_take_screenshot" && !result.isError) {
    const screenshotBytes = (result.content as Array<{ type?: string; data?: string }>)
      .reduce((s, c) => s + (c.data ? Math.round(c.data.length * 3 / 4) : 0), 0);
    if (screenshotBytes > 0) extra.screenshotBytes = screenshotBytes;
    // Distinguishes "agent explicitly wanted pixels" from "redirect wasn't active".
    if ((args as ToolArgs).visual) extra.visual = true;
  }

  logCall(name, Date.now() - t0, !!result.isError, extra);
  return result;
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
if (FIGMA_MCP_CMD) initFigmaTools();

// PLAYGUARD_NO_SERVE=1 lets tests import the pure helpers without opening the stdio transport.
if (process.env.PLAYGUARD_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
