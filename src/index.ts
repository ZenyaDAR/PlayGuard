import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { createHash } from "crypto";
import { appendFile, mkdirSync, readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";

type ToolArgs = Record<string, unknown>;
type ContentItem = { type?: string; text?: string; data?: string };

// Splits a command-line string on spaces, respecting "..."/'...' quoting so
// paths like `--storage-state "C:/path with spaces/state.json"` survive.
export function splitArgs(s: string): string[] {
  const parts = s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  // Strip quotes only when they actually pair up — an unclosed quote (matched by \S+)
  // must survive literally instead of losing its first and last characters.
  return parts.map(a =>
    a.length >= 2 && ((a[0] === '"' && a.endsWith('"')) || (a[0] === "'" && a.endsWith("'")))
      ? a.slice(1, -1) : a);
}

const SCREENSHOTS = process.env.PLAYGUARD_SCREENSHOTS ?? "warn"; // block | warn | allow | redirect
// ponytail: compact on by default — strips non-interactive lines, set =false to get raw snapshots
const COMPACT = process.env.PLAYGUARD_COMPACT !== "false";
const TOKEN_BUDGET = parseInt(process.env.PLAYGUARD_TOKEN_BUDGET ?? "0"); // 0 = off
const EVAL_CACHE_TTL = parseInt(process.env.PLAYGUARD_EVAL_CACHE_TTL ?? "500"); // ms; 0 = off
const PREFETCH_SNAPSHOT = process.env.PLAYGUARD_PREFETCH_SNAPSHOT !== "false"; // default on
const EVAL_COMPACT_THRESHOLD = parseInt(process.env.PLAYGUARD_EVAL_COMPACT ?? "10000"); // chars; 0 = off
const FIGMA_MCP_CMD = process.env.FIGMA_MCP_CMD; // undefined = Figma disabled
const FIGMA_CACHE_TTL = parseInt(process.env.FIGMA_CACHE_TTL ?? "0"); // ms; 0 = off
const FIGMA_SVG_REFS = process.env.FIGMA_SVG_REFS !== "false"; // default on: replace inline SVG with lightweight refs
// Some Figma MCPs (e.g. Framelink figma-developer-mcp) pre-simplify to YAML/markdown text
// instead of raw REST-API JSON, so optimizeFigmaResponse's modules never fire on them —
// this is the fallback that still saves tokens on that path. chars; 0 = off
const FIGMA_TEXT_COMPACT = parseInt(process.env.FIGMA_TEXT_COMPACT ?? "10000");

const __dir = dirname(fileURLToPath(import.meta.url));

const VERSION: string = JSON.parse(readFileSync(resolve(__dir, "..", "package.json"), "utf8")).version;

const LOG_DIR = process.env.PLAYGUARD_LOG_DIR || resolve(__dir, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });
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

const localBin = resolve(__dir, "..", "node_modules", ".bin",
  process.platform === "win32" ? "playwright-mcp.cmd" : "playwright-mcp");

const rawCmd = process.env.PLAYWRIGHT_MCP_CMD ?? localBin;
const extraArgs = process.env.PLAYWRIGHT_MCP_ARGS ? splitArgs(process.env.PLAYWRIGHT_MCP_ARGS) : [];
const [PW_CMD, PW_ARGS]: [string, string[]] = process.platform === "win32"
  ? ["cmd", ["/c", rawCmd, ...extraArgs]]
  : [rawCmd, extraArgs];

const figmaExtraArgs = process.env.FIGMA_MCP_ARGS ? splitArgs(process.env.FIGMA_MCP_ARGS) : [];
const [FIGMA_CMD, FIGMA_ARGS]: [string, string[]] = FIGMA_MCP_CMD
  ? process.platform === "win32"
    ? ["cmd", ["/c", FIGMA_MCP_CMD, ...figmaExtraArgs]]
    : (() => { const p = splitArgs(FIGMA_MCP_CMD); return [p[0], [...p.slice(1), ...figmaExtraArgs]] as [string, string[]]; })()
  : ["", []];

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

// Structural landmarks: keep for navigation context even without [ref=]
const STRUCTURAL_RE = /^\s*- (document|main|nav|navigation|header|footer|form|article|section|dialog|banner|region|complementary|contentinfo|heading)\b/i;

let conn: Client | null = null;
let pending: Promise<Client> | null = null;
let reviving: Promise<Client> | null = null;
let lastUrl = "";
// Pushed on every browser_navigate, popped on browser_navigate_back — keeps lastUrl
// correct for the one other navigation tool we route. Clicks/form submits that navigate
// still go untracked (Playwright MCP doesn't report the resulting URL in tool output).
const urlHistory: string[] = [];

// Snapshot cache — cleared whenever a MUTATING tool succeeds
export interface SnapState {
  hash: string | null;
  ts: number;
  compact: string | null;
  rawBytes: number;
  prefetched: boolean; // was cache last populated by prefetch?
  lines: Set<string> | null;
  url: string;
  withoutAction: number;
}
export const emptySnapState: SnapState = {
  hash: null, ts: 0, compact: null, rawBytes: 0,
  prefetched: false, lines: null, url: "", withoutAction: 0,
};
let snapState: SnapState = { ...emptySnapState };

const DELTA_THRESHOLD = parseFloat(process.env.PLAYGUARD_DELTA_THRESHOLD ?? "0.4");
const DELTA_ENABLED = process.env.PLAYGUARD_DELTA !== "false";
const HINT_THRESHOLD = parseInt(process.env.PLAYGUARD_HINT_THRESHOLD ?? "4");

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

function hashContent(content: Array<{ text?: string }>): string {
  return createHash("sha256")
    .update(content.map((c) => c.text ?? "").join(""))
    .digest("hex")
    .slice(0, 16);
}

// Keep only lines that Claude can act on:
// [ref=] lines are interactive elements; structural landmarks give context.
// Paragraphs, decorative images, static text have no refs and aren't needed.
export function compactSnap(content: Array<{ text?: string }>): { text: string; rawBytes: number; keptBytes: number } {
  const rawText = content.map((c) => c.text ?? "").join("");
  const lines = rawText.split("\n");
  const kept = lines.filter((l) => l.includes("[ref=") || STRUCTURAL_RE.test(l) || l.trim() === "");
  const collapsed = COMPACT ? collapseRuns(kept) : kept;
  const keptText = collapsed.join("\n");
  const rawBytes = Buffer.byteLength(rawText);
  const keptBytes = Buffer.byteLength(keptText);
  const pct = lines.length > 0 ? Math.round((1 - kept.length / lines.length) * 100) : 0;
  const result = {
    text: `[PlayGuard compact: ${kept.length}/${lines.length} lines, ~${pct}% removed, ${(rawBytes / 1024).toFixed(1)}KB→${(keptBytes / 1024).toFixed(1)}KB]\n` + keptText,
    rawBytes,
    keptBytes,
  };
  if (TOKEN_BUDGET > 0) {
    const charLimit = TOKEN_BUDGET * 4;
    if (result.text.length > charLimit) {
      // Cut on a line boundary so we never split mid-`[ref=` and hand the agent a broken ref.
      const nl = result.text.lastIndexOf("\n", charLimit);
      const cut = nl > 0 ? nl : charLimit;
      const truncated = result.text.slice(0, cut);
      const remaining = result.text.slice(cut).split("\n").filter(l => l.includes("[ref=")).length;
      return {
        text: truncated + `\n[PlayGuard: truncated at ${TOKEN_BUDGET} tokens, ~${remaining} interactive elements omitted]`,
        rawBytes,
        keptBytes: Buffer.byteLength(truncated),
      };
    }
  }
  return result;
}

const COLLAPSE_MIN = 5;

function fingerprint(line: string) {
  return line.replace(/\[ref=\d+\]/, "[ref=?]").replace(/"[^"]*"/g, '"?"');
}

export function collapseRuns(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fp = fingerprint(lines[i]);
    let j = i + 1;
    while (j < lines.length && fingerprint(lines[j]) === fp) j++;
    const run = j - i;
    if (run >= COLLAPSE_MIN) {
      out.push(...lines.slice(i, i + 3));
      const refs = lines.slice(i + 3, j).map(l => l.match(/\[ref=(\d+)\]/)?.[1]).filter(Boolean);
      // A run without refs (e.g. blank lines left adjacent after filtering) has no range to show.
      out.push(refs.length
        ? `  [×${run - 3} more similar elements, refs ${refs[0]}–${refs.at(-1)}]`
        : `  [×${run - 3} more similar lines]`);
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out;
}

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
  const summary = compactSnap(content);
  const newLines = summary.text.split("\n").filter(l => l.includes("[ref=") || STRUCTURAL_RE.test(l));
  snapState = {
    hash: hashContent(content), lines: new Set(newLines), url: lastUrl,
    ts: Date.now(), compact: summary.text, rawBytes: summary.rawBytes,
    prefetched: fromPrefetch, withoutAction: snapState.withoutAction,
  };
  return summary;
}

export interface SnapshotMeta {
  cacheHit: boolean;
  prefetchHit?: boolean;
  delta: boolean;
  deltaAdded?: number;
  deltaRemoved?: number;
  savedBytes?: number;
  rawBytes?: number;
  keptBytes?: number;
  hinted: boolean;
  snapCount: number;
}

export interface SnapshotDecision {
  responseText: string;
  state: SnapState;
  meta: SnapshotMeta;
}

export interface SnapshotOptions {
  deltaEnabled: boolean;
  deltaThreshold: number;
  hintThreshold: number;
  compact: boolean;
}

// Pure decision logic for browser_snapshot: UNCHANGED (cache hit) vs delta vs full compact.
// Kept side-effect-free (state in, state out) so cache/delta behavior is unit-testable
// without a live Playwright connection.
export function decideSnapshot(
  content: Array<{ text?: string }>,
  state: SnapState,
  currentUrl: string,
  opts: SnapshotOptions,
): SnapshotDecision {
  const hash = hashContent(content);

  if (state.hash && hash === state.hash && state.url === currentUrl) {
    const withoutAction = state.withoutAction + 1;
    const header = state.compact!.split("\n")[0];
    return {
      responseText: `[PlayGuard: UNCHANGED since ${Date.now() - state.ts}ms ago] ${header}`,
      state: { ...state, withoutAction },
      meta: { cacheHit: true, prefetchHit: state.prefetched || undefined, delta: false, savedBytes: state.rawBytes, hinted: false, snapCount: withoutAction },
    };
  }

  const summary = compactSnap(content);
  const newLines = summary.text.split("\n").filter(l => l.includes("[ref=") || STRUCTURAL_RE.test(l));
  const newSet = new Set(newLines);

  if (opts.deltaEnabled && state.lines && state.url === currentUrl) {
    const added = newLines.filter(l => !state.lines!.has(l));
    const removed = [...state.lines].filter(l => !newSet.has(l));
    const ratio = (added.length + removed.length) / (newLines.length || 1);

    if (ratio < opts.deltaThreshold) {
      const withoutAction = state.withoutAction + 1;
      const deltaText = [
        `[PlayGuard delta: +${added.length} added, ${removed.length} removed, ~${Math.round((1 - ratio) * 100)}% saved]`,
        added.length ? "ADDED:\n" + added.map(l => "  " + l.trim()).join("\n") : "",
        removed.length ? "REMOVED:\n" + removed.map(l => "  " + l.trim()).join("\n") : "",
      ].filter(Boolean).join("\n");
      return {
        responseText: deltaText,
        state: { hash, lines: newSet, url: currentUrl, ts: Date.now(), compact: summary.text, rawBytes: summary.rawBytes, prefetched: false, withoutAction },
        meta: { cacheHit: false, delta: true, deltaAdded: added.length, deltaRemoved: removed.length, hinted: false, snapCount: withoutAction },
      };
    }
  }

  const hinted = opts.hintThreshold > 0 && state.withoutAction >= opts.hintThreshold;
  let finalText = opts.compact ? summary.text : content.map((c) => c.text ?? "").join("");
  if (hinted) {
    const interactiveRefs = newLines.slice(0, 5).map(l => l.trim()).join("\n  ");
    finalText = `[PlayGuard hint: ${state.withoutAction} snapshots without action. Interactive elements available:\n  ${interactiveRefs}]\n` + finalText;
  }
  const withoutAction = state.withoutAction + 1;

  return {
    responseText: finalText,
    state: { hash, lines: newSet, url: currentUrl, ts: Date.now(), compact: summary.text, rawBytes: summary.rawBytes, prefetched: false, withoutAction },
    meta: { cacheHit: false, delta: false, rawBytes: summary.rawBytes, keptBytes: summary.keptBytes, hinted, snapCount: withoutAction },
  };
}

// ponytail: fire-and-forget — races don't matter, worst case next snapshot call is a miss
async function prefetchSnapshot(): Promise<void> {
  try {
    const c = await getConn();
    const r = await c.callTool({ name: "browser_snapshot", arguments: {} });
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

// ── Figma Optimizer ────────────────────────────────────────────────────────────

const FIGMA_DROP_KEYS = new Set([
  "createdAt", "updatedAt", "lastModified", "creator", "version", "thumbnailUrl",
  "pluginData", "sharedPluginData", "exportSettings",
  "reactions", "interactions", "documentationLinks",
  "transitionNodeID", "transitionDuration", "transitionEasing",
]);

function walkNodes(node: unknown, fn: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => walkNodes(n, fn)); return; }
  fn(node as Record<string, unknown>);
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.children)) walkNodes(n.children, fn);
  if (n.document) walkNodes(n.document, fn);
  if (Array.isArray(n.nodes)) walkNodes(n.nodes, fn); // Framelink top-level shape
}

interface FigmaOptStats {
  inBytes: number; outBytes: number;
  metaKeysDeleted: number; invisiblePruned: number;
  svgRefsReplaced: number; instancesCollapsed: number;
  uniqueComponents: number; layoutCoordsRemoved: number;
  siblingsCollapsed: number; structSiblingsCollapsed: number;
  emptyStylesDropped: number; floatsRounded: number;
}

function pruneInvisible(nodes: any[], st: FigmaOptStats): any[] {
  return nodes
    .filter(n => {
      if (n.visible === false || (n.opacity ?? 1) <= 0) { st.invisiblePruned++; return false; }
      return true;
    })
    .map(n => n.children ? { ...n, children: pruneInvisible(n.children, st) } : n);
}

function compressLayout(node: any, st: FigmaOptStats, parentIsAL = false): void {
  if (!node || typeof node !== "object") return;
  if (parentIsAL && node.layoutPositioning !== "ABSOLUTE") {
    if ("x" in node || "y" in node) st.layoutCoordsRemoved++;
    delete node.x;
    delete node.y;
  }
  const isAL = node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
  (node.children ?? []).forEach((c: any) => compressLayout(c, st, isAL));
}

function deduplicateComponents(node: any, seen: Map<string, true>, st: FigmaOptStats): any {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(n => deduplicateComponents(n, seen, st));
  const compId = node.componentId;
  if (compId && node.type === "INSTANCE") {
    if (seen.has(compId)) {
      st.instancesCollapsed++;
      return {
        type: "INSTANCE", name: node.name, id: node.id, _ref: compId,
        ...(node.overrides?.length ? { overrides: node.overrides } : {}),
      };
    }
    // Only a clean instance becomes the base definition: refs point at the first
    // full instance, so an overridden base would leak its overrides into every ref.
    // ponytail: a component whose every instance is overridden never dedupes.
    if (!node.overrides?.length) {
      seen.set(compId, true);
      st.uniqueComponents++;
    }
  }
  const result = { ...node };
  if (Array.isArray(result.children)) result.children = deduplicateComponents(result.children, seen, st);
  return result;
}

// Module 8: Framelink-shape ({metadata, nodes[], globalVars.styles}) optimizations.
// Framelink pre-simplifies upstream, so Modules 2/4/6 never fire on it — the fields they
// target are already gone. Measured on real responses, what's actually left:
//   8a: exact-duplicate sibling subtrees (~2%) → collapse to {id, name, _sameAs: firstId}
//   8a+: structural copies (same tree/styles, different text/name/coords) → same stub
//        plus _textDiff; on card grids this is the dominant module (up to ~-30% extra)
//   8b: layout styles that say nothing ({mode:"none", sizing:{}}) plus their node refs (~1%)
//   8c: float noise in styles ("1.3999999364217122em" → "1.4em") (~1%)
function roundFloats(v: unknown, st: FigmaOptStats): unknown {
  if (typeof v === "number" && !Number.isInteger(v)) { st.floatsRounded++; return Math.round(v * 100) / 100; }
  if (typeof v === "string")
    return v.replace(/-?\d+\.\d{3,}/g, m => { st.floatsRounded++; return String(Math.round(parseFloat(m) * 100) / 100); });
  if (Array.isArray(v)) return v.map(x => roundFloats(x, st));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = roundFloats(o[k], st);
  }
  return v;
}

// 8a+ — keys that don't change a subtree's *structure*: per-copy content (text, layer
// name — designers name grid copies "1".."10") and per-copy position. Everything else
// (fills, styles, layout refs, types, child shape) stays in the fingerprint, so copies
// with different colors/styles never collapse. The stub keeps its own id+name, and text
// differences survive in _textDiff; inner layer names of a collapsed copy are the only loss.
const STRUCT_IGNORE_KEYS = new Set(["id", "name", "text", "x", "y", "boundingBox", "dimensions"]);

function textsOf(n: any, out: string[] = []): string[] {
  if (typeof n?.text === "string") out.push(n.text);
  if (Array.isArray(n?.children)) for (const c of n.children) textsOf(c, out);
  return out;
}

function optimizeFramelink(parsed: any, st: FigmaOptStats): void {
  // 8a — dedupe siblings identical except for ids (id filtered at every depth)
  const fpOf = (n: unknown) => JSON.stringify(n, (k, v) => (k === "id" ? undefined : v));
  // 8a+ — same, but also ignoring text/coords: structural copies (card grids, list rows)
  const structFpOf = (n: unknown) => JSON.stringify(n, (k, v) => (STRUCT_IGNORE_KEYS.has(k) ? undefined : v));
  const dedupeSiblings = (node: any): void => {
    if (!Array.isArray(node.children)) return;
    const seen = new Map<string, any>();
    const seenStruct = new Map<string, any>();
    node.children = node.children.map((c: any) => {
      const fp = fpOf(c);
      const first = seen.get(fp);
      if (first) { st.siblingsCollapsed++; return { id: c.id, name: c.name, _sameAs: first.id }; }
      seen.set(fp, c);
      const sFirst = seenStruct.get(structFpOf(c));
      if (sFirst) {
        // structure identical ⇒ same text-node count/order; diff is keyed by text index in the reference
        const ref = textsOf(sFirst), own = textsOf(c);
        const diff: Record<number, string> = {};
        own.forEach((t, i) => { if (t !== ref[i]) diff[i] = t; });
        const stub: any = { id: c.id, name: c.name, _sameAs: sFirst.id };
        if (Object.keys(diff).length) stub._textDiff = diff;
        if (JSON.stringify(stub).length < JSON.stringify(c).length) {
          st.structSiblingsCollapsed++;
          return stub;
        }
      } else {
        seenStruct.set(structFpOf(c), c);
      }
      return c;
    });
    node.children.forEach(dedupeSiblings);
  };
  parsed.nodes.forEach(dedupeSiblings);

  // 8b — drop no-op layout styles and the node refs pointing at them
  const styles = parsed.globalVars?.styles;
  if (styles && typeof styles === "object") {
    const isNoop = (v: any) => v && typeof v === "object" && v.mode === "none" &&
      Object.entries(v).every(([k, val]) => k === "mode" || (val && typeof val === "object" && !Object.keys(val as object).length));
    const dropped = new Set<string>();
    for (const [k, v] of Object.entries(styles)) {
      if (k.startsWith("layout_") && isNoop(v)) { delete styles[k]; dropped.add(k); st.emptyStylesDropped++; }
    }
    if (dropped.size) walkNodes(parsed.nodes, n => { if (dropped.has(n.layout as string)) delete n.layout; });
    // 8c — styles only: node.text is user content, rounding "3.14159" there would corrupt it
    roundFloats(styles, st);
  }
}

// rawInBytes = size of the upstream response text before parsing. Upstreams that
// pre-simplify to indented YAML (e.g. Framelink figma-developer-mcp) are ~2x heavier
// than the compact JSON we emit, purely from formatting — a real saving that's invisible
// if inBytes is measured from JSON.stringify(parsed) instead of the original text.
export function optimizeFigmaResponse(parsed: any, rawInBytes?: number): { data: any; stats: FigmaOptStats } {
  const st: FigmaOptStats = {
    inBytes: rawInBytes ?? Buffer.byteLength(JSON.stringify(parsed)), outBytes: 0,
    metaKeysDeleted: 0, invisiblePruned: 0,
    svgRefsReplaced: 0, instancesCollapsed: 0,
    uniqueComponents: 0, layoutCoordsRemoved: 0,
    siblingsCollapsed: 0, structSiblingsCollapsed: 0, emptyStylesDropped: 0, floatsRounded: 0,
  };
  // Module 5: drop metadata fields no agent needs (signed preview URL, timestamps)
  // ponytail: only top-level metadata — not walked by walkNodes, which only recurses
  // into document/children, never the sibling "metadata" key Framelink's shape uses.
  if (parsed?.metadata) {
    for (const k of ["thumbnailUrl", "lastModified"]) {
      if (k in parsed.metadata) { delete parsed.metadata[k]; st.metaKeysDeleted++; }
    }
  }
  // Module 1: strip metadata
  walkNodes(parsed, n => { for (const k of FIGMA_DROP_KEYS) if (k in n) { delete n[k]; st.metaKeysDeleted++; } });
  // Module 2: prune invisible layers
  if (parsed?.document?.children) parsed.document.children = pruneInvisible(parsed.document.children, st);
  // Module 4 (V2): replace large SVG geometry with lightweight refs
  if (FIGMA_SVG_REFS) {
    walkNodes(parsed, n => {
      if ((n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION") &&
          Array.isArray(n.fillGeometry) && (n.fillGeometry as any[]).length > 2) {
        n._svgRef = n.id; delete n.fillGeometry; delete n.strokeGeometry;
        st.svgRefsReplaced++;
      }
    });
  }
  // Module 3: deduplicate repeated component instances
  if (parsed?.document) parsed.document = deduplicateComponents(parsed.document, new Map(), st);
  // Module 6: drop redundant x/y inside Auto Layout containers
  if (parsed?.document) compressLayout(parsed.document, st);
  // Module 8: Framelink shape — raw REST /nodes responses have nodes as an object map,
  // Framelink emits an array; the guard keeps this off the REST path.
  if (Array.isArray(parsed?.nodes) && !parsed?.document) optimizeFramelink(parsed, st);
  st.outBytes = Buffer.byteLength(JSON.stringify(parsed));
  return { data: parsed, stats: st };
}

const STUB_BUDGET_MIN = 80; // chars; below this a branch is always stubbed, never partially expanded

// Module 7: when the optimized tree still exceeds FIGMA_TEXT_COMPACT, trim it structurally
// instead of slicing the stringified text — a char slice chops mid-JSON and silently drops
// whatever came later in the tree (later sibling frames, later pages). Budget is allocated
// depth-first, proportional to each branch's own size; a branch that doesn't fit collapses to
// an {id,name,type} stub instead of vanishing, so the agent can see it exists and re-fetch it
// by id in a follow-up call.
function budgetTrimNode(node: any, budget: number, stats: { stubbed: number }): any {
  if (!node || typeof node !== "object") return node;
  const kids = Array.isArray(node.children) ? node.children : undefined;
  if (!kids || !kids.length) return node;

  const shallow = { ...node, children: undefined };
  const shallowSize = JSON.stringify(shallow).length;
  const size = shallowSize + JSON.stringify(kids).length;
  if (size <= budget) return node;

  const childBudget = budget - shallowSize;
  if (childBudget < kids.length * STUB_BUDGET_MIN) {
    stats.stubbed++;
    return { id: node.id, name: node.name, type: node.type, _stub: true, _omittedChildren: kids.length };
  }
  const sizes = kids.map((k: any) => JSON.stringify(k).length);
  const total = sizes.reduce((a: number, b: number) => a + b, 0) || 1;
  return {
    ...shallow,
    children: kids.map((k: any, i: number) =>
      budgetTrimNode(k, Math.max(Math.floor((childBudget * sizes[i]) / total), STUB_BUDGET_MIN), stats)),
  };
}

export function budgetTrimFigma(data: any, budgetChars: number): { data: any; stubbed: number } {
  const stats = { stubbed: 0 };
  const shallow = { ...data };
  const fixedSize = Object.keys(shallow)
    .filter((k) => k !== "document" && k !== "nodes")
    .reduce((s, k) => s + JSON.stringify({ [k]: shallow[k] }).length, 0);
  const remaining = Math.max(budgetChars - fixedSize, STUB_BUDGET_MIN);

  if (shallow.document) {
    shallow.document = budgetTrimNode(shallow.document, remaining, stats);
  } else if (Array.isArray(shallow.nodes)) {
    const sizes = shallow.nodes.map((n: any) => JSON.stringify(n).length);
    const total = sizes.reduce((a: number, b: number) => a + b, 0) || 1;
    shallow.nodes = shallow.nodes.map((n: any, i: number) =>
      budgetTrimNode(n, Math.max(Math.floor((remaining * sizes[i]) / total), STUB_BUDGET_MIN), stats));
  }
  return { data: shallow, stubbed: stats.stubbed };
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
  if (FIGMA_MCP_CMD) {
    try {
      const figmaResult = await getFigmaConn().then(c => c.listTools());
      (figmaResult.tools as Tool[]).forEach((t) => figmaToolNames.add(t.name));
      (result.tools as Tool[]).push(...(figmaResult.tools as Tool[]));
    } catch (e) {
      process.stderr.write(`[PlayGuard] Figma MCP listTools failed: ${e}\n`);
    }
  }
  return result;
});

server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const t0 = Date.now();
  const url = lastUrl || undefined;

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
      const r = await c.callTool({ name, arguments: args });
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
          layoutCoordsRemoved: figmaStats.layoutCoordsRemoved,
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
    const script = String((args as ToolArgs).code ?? (args as ToolArgs).expression ?? JSON.stringify(args));
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
      const r = await c.callTool({ name, arguments: args });
      const bodyText = (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join(" ");
      if (!retry && r.isError && dead(bodyText)) return invoke(true);

      if (!r.isError) {
        if (name === "browser_snapshot") {
          const decision = decideSnapshot(r.content as ContentItem[], snapState, lastUrl, {
            deltaEnabled: DELTA_ENABLED, deltaThreshold: DELTA_THRESHOLD,
            hintThreshold: HINT_THRESHOLD, compact: COMPACT,
          });
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
