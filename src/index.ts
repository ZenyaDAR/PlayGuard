import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { createHash } from "crypto";
import { appendFileSync, mkdirSync } from "fs";
import { load as yamlLoad } from "js-yaml";

const SCREENSHOTS = process.env.PLAYGUARD_SCREENSHOTS ?? "warn"; // block | warn | allow | redirect
// ponytail: compact on by default — strips non-interactive lines, set =false to get raw snapshots
const COMPACT = process.env.PLAYGUARD_COMPACT !== "false";
const TOKEN_BUDGET = parseInt(process.env.PLAYGUARD_TOKEN_BUDGET ?? "0"); // 0 = off
const EVAL_CACHE_TTL = parseInt(process.env.PLAYGUARD_EVAL_CACHE_TTL ?? "500"); // ms; 0 = off
const PREFETCH_SNAPSHOT = process.env.PLAYGUARD_PREFETCH_SNAPSHOT !== "false"; // default on
const EVAL_COMPACT_THRESHOLD = parseInt(process.env.PLAYGUARD_EVAL_COMPACT ?? "8000"); // chars; 0 = off
const FIGMA_MCP_CMD = process.env.FIGMA_MCP_CMD; // undefined = Figma disabled
const FIGMA_CACHE_TTL = parseInt(process.env.FIGMA_CACHE_TTL ?? "0"); // ms; 0 = off
const FIGMA_SVG_REFS = process.env.FIGMA_SVG_REFS !== "false"; // default on: replace inline SVG with lightweight refs

const __dir = dirname(fileURLToPath(import.meta.url));

const LOG_DIR = resolve(__dir, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });
function logCall(tool: string, ms: number, err: boolean, extra?: object) {
  const line = JSON.stringify({ ts: Date.now(), tool, ms, err, ...extra });
  try { appendFileSync(resolve(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.ndjson`), line + "\n"); } catch {}
}

const localBin = resolve(__dir, "..", "node_modules", ".bin",
  process.platform === "win32" ? "playwright-mcp.cmd" : "playwright-mcp");

const rawCmd = process.env.PLAYWRIGHT_MCP_CMD ?? localBin;
const extraArgs = process.env.PLAYWRIGHT_MCP_ARGS?.split(" ") ?? [];
const [PW_CMD, PW_ARGS]: [string, string[]] = process.platform === "win32"
  ? ["cmd", ["/c", rawCmd, ...extraArgs]]
  : [rawCmd, extraArgs];

const figmaExtraArgs = process.env.FIGMA_MCP_ARGS?.split(" ") ?? [];
const [FIGMA_CMD, FIGMA_ARGS]: [string, string[]] = FIGMA_MCP_CMD
  ? process.platform === "win32"
    ? ["cmd", ["/c", FIGMA_MCP_CMD, ...figmaExtraArgs]]
    : (() => { const p = FIGMA_MCP_CMD.split(" "); return [p[0], [...p.slice(1), ...figmaExtraArgs]] as [string, string[]]; })()
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

// Snapshot cache — cleared whenever a MUTATING tool succeeds
let snapHash: string | null = null;
let snapTs = 0;
let snapCompact: string | null = null;
let snapRawBytes = 0;
let snapPrefetched = false; // was cache last populated by prefetch?

const DELTA_THRESHOLD = parseFloat(process.env.PLAYGUARD_DELTA_THRESHOLD ?? "0.4");
const DELTA_ENABLED = process.env.PLAYGUARD_DELTA !== "false";

let snapLines: Set<string> | null = null;
let snapUrl = "";
let snapWithoutAction = 0;
const HINT_THRESHOLD = parseInt(process.env.PLAYGUARD_HINT_THRESHOLD ?? "4");

// Eval deduplication cache — keyed by hash(url + script), TTL = EVAL_CACHE_TTL ms
const evalCache = new Map<string, { result: Awaited<ReturnType<Client["callTool"]>>; ts: number }>();

// ── Figma upstream state ───────────────────────────────────────────────────────
let figmaConn: Client | null = null;
let figmaPending: Promise<Client> | null = null;
const figmaToolNames = new Set<string>();
const figmaCache = new Map<string, { result: unknown; ts: number }>();

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
      out.push(`  [×${run - 3} more similar elements, refs ${refs[0]}–${refs.at(-1)}]`);
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out;
}

async function spawnConn(): Promise<Client> {
  const t = new StdioClientTransport({ command: PW_CMD, args: PW_ARGS });
  const c = new Client({ name: "playguard", version: "0.1.0" });
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
    snapHash = null; snapLines = null; snapCompact = null; snapWithoutAction = 0; snapPrefetched = false;
    const c = await spawnConn();
    conn = c;
    if (lastUrl) await c.callTool({ name: "browser_navigate", arguments: { url: lastUrl } }).catch(() => {});
    return c;
  })().finally(() => { reviving = null; });
  return reviving;
}

function dead(v: unknown): boolean {
  return DEAD_RE.test(v instanceof Error ? v.message : String(v));
}

// Populate snap cache from raw snapshot content — used by redirect and prefetch paths
function cacheSnapshot(content: Array<{ text?: string }>, fromPrefetch = false): { text: string; rawBytes: number; keptBytes: number } {
  const summary = compactSnap(content);
  const newLines = summary.text.split("\n").filter(l => l.includes("[ref=") || STRUCTURAL_RE.test(l));
  snapHash = hashContent(content);
  snapLines = new Set(newLines);
  snapUrl = lastUrl;
  snapTs = Date.now();
  snapCompact = summary.text;
  snapRawBytes = summary.rawBytes;
  snapPrefetched = fromPrefetch;
  return summary;
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
  const c = new Client({ name: "playguard-figma", version: "0.1.0" });
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
  "createdAt", "updatedAt", "lastModified", "creator", "version",
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
}

interface FigmaOptStats {
  inBytes: number; outBytes: number;
  metaKeysDeleted: number; invisiblePruned: number;
  svgRefsReplaced: number; instancesCollapsed: number;
  uniqueComponents: number; layoutCoordsRemoved: number;
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
    seen.set(compId, true);
    st.uniqueComponents++;
  }
  const result = { ...node };
  if (Array.isArray(result.children)) result.children = deduplicateComponents(result.children, seen, st);
  return result;
}

export function optimizeFigmaResponse(parsed: any): { data: any; stats: FigmaOptStats } {
  const st: FigmaOptStats = {
    inBytes: Buffer.byteLength(JSON.stringify(parsed)), outBytes: 0,
    metaKeysDeleted: 0, invisiblePruned: 0,
    svgRefsReplaced: 0, instancesCollapsed: 0,
    uniqueComponents: 0, layoutCoordsRemoved: 0,
  };
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
  st.outBytes = Buffer.byteLength(JSON.stringify(parsed));
  return { data: parsed, stats: st };
}

const server = new Server(
  { name: "playguard", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await getConn().then((c) => c.listTools());
  if (SCREENSHOTS === "redirect") {
    const shot = (result.tools as any[])?.find((t: any) => t.name === "browser_take_screenshot");
    if (shot) {
      shot.description = (shot.description ?? "") +
        "\n[PlayGuard] Returns a snapshot by default (cheaper, structured). Pass {visual:true} if you need actual pixels (colors, layout bugs, visual glitches).";
      if (shot.inputSchema?.properties) {
        (shot.inputSchema.properties as any).visual = {
          type: "boolean",
          description: "Set true to get a real screenshot instead of a snapshot.",
        };
      }
    }
  }
  if (FIGMA_MCP_CMD) {
    try {
      const figmaResult = await getFigmaConn().then(c => c.listTools());
      figmaResult.tools.forEach((t: any) => figmaToolNames.add(t.name));
      (result.tools as any[]).push(...figmaResult.tools);
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
    const cacheKey = name + "\0" + JSON.stringify(args);
    if (FIGMA_CACHE_TTL > 0) {
      const hit = figmaCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < FIGMA_CACHE_TTL) {
        logCall(name, 0, false, { figma: true, cacheHit: true, fileKey: (args as any).fileKey, nodeId: (args as any).nodeId });
        return hit.result as Awaited<ReturnType<Client["callTool"]>>;
      }
    }
    try {
      const c = await getFigmaConn();
      const r = await c.callTool({ name, arguments: args });
      let out = r;
      let figmaStats: FigmaOptStats | undefined;
      // Why the response wasn't optimized — surfaces the upstream/format mismatch
      // (Framelink defaults to YAML; this optimizer expects raw REST-API JSON) instead
      // of swallowing it. If this is consistently set, the optimizer is a no-op.
      let parseSkip: "no-json-item" | "parse-error" | undefined;
      if (!r.isError) {
        const textItem = (r.content as Array<{ type?: string; text?: string }>)
          .find(c => c.type === "text" && c.text && c.text.trim().length > 0);
        if (textItem?.text) {
          try {
            const raw = textItem.text;
            const parsed = raw.trimStart().startsWith("{") ? JSON.parse(raw) : yamlLoad(raw);
            const { data, stats: st } = optimizeFigmaResponse(parsed);
            figmaStats = st;
            const pct = Math.round((1 - st.outBytes / st.inBytes) * 100);
            out = {
              ...r,
              content: [
                { type: "text", text: `[PlayGuard figma: -${pct}% (${(st.inBytes / 1024).toFixed(1)}KB→${(st.outBytes / 1024).toFixed(1)}KB)]\n` + JSON.stringify(data) },
                ...(r.content as any[]).slice(1),
              ],
            };
          } catch { parseSkip = "parse-error"; }
        } else {
          parseSkip = "no-json-item";
        }
        if (parseSkip) process.stderr.write(`[PlayGuard] figma optimizer skipped (${parseSkip}) for ${name} — upstream not raw JSON?\n`);
        if (FIGMA_CACHE_TTL > 0) figmaCache.set(cacheKey, { result: out, ts: Date.now() });
      }
      logCall(name, Date.now() - t0f, !!r.isError, {
        figma: true,
        fileKey: (args as any).fileKey,
        nodeId: (args as any).nodeId,
        cacheHit: false,
        parseSkip,
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
        } : {}),
      });
      return out;
    } catch (e) {
      logCall(name, Date.now() - t0f, true, { figma: true, fileKey: (args as any).fileKey, error: String(e) });
      throw e;
    }
  }

  // ── Screenshot → snapshot redirect ─────────────────────────────────────────
  if (name === "browser_take_screenshot" && SCREENSHOTS === "redirect" && !(args as any).visual) {
    if (snapHash && snapCompact && Date.now() - snapTs < 10_000) {
      logCall(name, Date.now() - t0, false, { url, redirected: true, cacheHit: true });
      return { content: [{ type: "text", text: "[PlayGuard: snapshot served instead of screenshot (cached). Call with {visual:true} for actual pixels.]\n" + snapCompact }] };
    }
    try {
      const c = await getConn();
      const r = await c.callTool({ name: "browser_snapshot", arguments: {} });
      if (!r.isError) {
        const summary = cacheSnapshot(r.content as Array<{ text?: string }>);
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
    const script = (args as any).code ?? (args as any).expression ?? JSON.stringify(args);
    scriptHash = createHash("sha256").update(script).digest("hex").slice(0, 8);
    if (EVAL_CACHE_TTL > 0) {
      evalKey = createHash("sha256").update(lastUrl + "\0" + script).digest("hex").slice(0, 16);
      const hit = evalCache.get(evalKey);
      if (hit && Date.now() - hit.ts < EVAL_CACHE_TTL) {
        logCall(name, 0, false, { url, evalCacheHit: true, scriptHash });
        return hit.result;
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
          const content = r.content as Array<{ text?: string }>;
          const hash = hashContent(content);

          if (snapHash && hash === snapHash) {
            snapWithoutAction++;
            const header = snapCompact!.split("\n")[0];
            return {
              content: [{
                type: "text",
                text: `[PlayGuard: UNCHANGED since ${Date.now() - snapTs}ms ago] ${header}`,
              }],
              _savedBytes: snapRawBytes,
              _prefetchHit: snapPrefetched,
            } as Awaited<ReturnType<Client["callTool"]>>;
          }

          const summary = compactSnap(content);
          const newLines = summary.text.split("\n").filter(l => l.includes("[ref=") || STRUCTURAL_RE.test(l));
          const newSet = new Set(newLines);

          if (DELTA_ENABLED && snapLines && snapUrl === lastUrl) {
            const added = newLines.filter(l => !snapLines!.has(l));
            const removed = [...snapLines].filter(l => !newSet.has(l));
            const ratio = (added.length + removed.length) / (newLines.length || 1);

            if (ratio < DELTA_THRESHOLD) {
              snapHash = hash; snapLines = newSet; snapUrl = lastUrl;
              snapTs = Date.now(); snapCompact = summary.text; snapRawBytes = summary.rawBytes;
              snapPrefetched = false;
              const saved = Math.round((1 - ratio) * 100);
              const deltaText = [
                `[PlayGuard delta: +${added.length} added, ${removed.length} removed, ~${saved}% saved]`,
                added.length ? "ADDED:\n" + added.map(l => "  " + l.trim()).join("\n") : "",
                removed.length ? "REMOVED:\n" + removed.map(l => "  " + l.trim()).join("\n") : "",
              ].filter(Boolean).join("\n");
              snapWithoutAction++;
              return { content: [{ type: "text", text: deltaText }], _delta: true, _deltaAdded: added.length, _deltaRemoved: removed.length, _snapCount: snapWithoutAction } as Awaited<ReturnType<Client["callTool"]>>;
            }
          }

          snapHash = hash; snapLines = newSet; snapUrl = lastUrl;
          snapTs = Date.now(); snapCompact = summary.text; snapRawBytes = summary.rawBytes;
          snapPrefetched = false;

          let finalText = COMPACT ? summary.text : content.map((c) => c.text ?? "").join("");

          if (HINT_THRESHOLD > 0 && snapWithoutAction >= HINT_THRESHOLD) {
            const interactiveRefs = newLines.slice(0, 5).map(l => l.trim()).join("\n  ");
            finalText = `[PlayGuard hint: ${snapWithoutAction} snapshots without action. Interactive elements available:\n  ${interactiveRefs}]\n` + finalText;
          }

          const hinted = HINT_THRESHOLD > 0 && snapWithoutAction >= HINT_THRESHOLD;
          snapWithoutAction++;
          return {
            content: [{ type: "text", text: finalText }],
            _rawBytes: summary.rawBytes,
            _keptBytes: summary.keptBytes,
            _hinted: hinted,
            _snapCount: snapWithoutAction,
          } as Awaited<ReturnType<Client["callTool"]>>;
        }

        if (MUTATING.has(name)) {
          snapHash = null; snapLines = null; snapCompact = null; snapWithoutAction = 0; snapPrefetched = false;
        }
        if (EVAL_INVALIDATING.has(name)) {
          evalCache.clear();
        }

        if (name === "browser_navigate") {
          lastUrl = (args as { url?: string }).url ?? lastUrl;
          // ponytail: no await — runs in background, worst case next snapshot call misses
          if (PREFETCH_SNAPSHOT) prefetchSnapshot();
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
    if (evalKey && EVAL_CACHE_TTL > 0) evalCache.set(evalKey, { result, ts: Date.now() });
    if (EVAL_COMPACT_THRESHOLD > 0) {
      const text = (result.content as Array<{ text?: string }>).map(c => c.text ?? "").join("");
      evalOutputBytes = text.length;
      if (text.length > EVAL_COMPACT_THRESHOLD) {
        evalTruncated = true;
        (result as any).content = [{
          type: "text",
          text: `[PlayGuard: eval output truncated (${text.length}→${EVAL_COMPACT_THRESHOLD} chars)]\n` + text.slice(0, EVAL_COMPACT_THRESHOLD),
        }];
      }
    }
  }

  // ── Build logCall extra fields ─────────────────────────────────────────────
  const r = result as typeof result & {
    _rawBytes?: number; _keptBytes?: number; _savedBytes?: number;
    _delta?: boolean; _deltaAdded?: number; _deltaRemoved?: number;
    _hinted?: boolean; _snapCount?: number; _prefetchHit?: boolean;
  };

  let extra: Record<string, unknown> = { url };
  if (wasRetried) extra.retried = true;

  if (name === "browser_snapshot") {
    extra = {
      ...extra,
      cacheHit: r._savedBytes !== undefined,
      prefetchHit: r._savedBytes !== undefined ? (r._prefetchHit || undefined) : undefined,
      delta: r._delta ?? false,
      deltaAdded: r._deltaAdded,
      deltaRemoved: r._deltaRemoved,
      savedBytes: r._savedBytes,
      rawBytes: r._rawBytes,
      keptBytes: r._keptBytes,
      hinted: r._hinted ?? false,
      snapCount: r._snapCount,
    };
  } else if (name === "browser_evaluate") {
    extra = { ...extra, scriptHash, outputBytes: evalOutputBytes, truncated: evalTruncated };
  } else if (name === "browser_take_screenshot" && !result.isError) {
    const screenshotBytes = (result.content as Array<{ type?: string; data?: string }>)
      .reduce((s, c) => s + (c.data ? Math.round(c.data.length * 3 / 4) : 0), 0);
    if (screenshotBytes > 0) extra.screenshotBytes = screenshotBytes;
  }

  logCall(name, Date.now() - t0, !!result.isError, extra);
  return result;
});

if (FIGMA_MCP_CMD) {
  getFigmaConn()
    .then(c => c.listTools())
    .then(({ tools }) => (tools as any[]).forEach(t => figmaToolNames.add(t.name)))
    .catch(e => process.stderr.write(`[PlayGuard] Figma MCP init: ${e}\n`));
}

// PLAYGUARD_NO_SERVE=1 lets tests import the pure helpers without opening the stdio transport.
if (process.env.PLAYGUARD_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
