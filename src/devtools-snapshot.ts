// Chrome DevTools MCP snapshot handling: lossless compaction of the a11y text tree plus
// the UNCHANGED / delta / full decision. Pure (state in, state out), like snapshot.ts.
//
// Upstream format (chrome-devtools-mcp SnapshotFormatter): one node per line,
// `<2*depth spaces>uid=<id> [role] ["name"] [attr="v" | flag]... [selected marker]`.
// Names and attribute values are NOT escaped, so a name may contain quotes or newlines;
// a node therefore spans every line up to the next `uid=` line.
import { createHash } from "crypto";

export interface DtSnapState {
  hash: string | null;          // hash of the last RAW snapshot section (compaction can hide a change)
  fresh: boolean;               // false after a mutating call: no UNCHANGED shortcut until the next snapshot
  lines: Set<string> | null;    // compacted lines of the last snapshot, the delta baseline
  key: string | null;           // page + options identity (root url, verbose); delta/UNCHANGED only within one key
  ts: number;
}
export const emptyDtSnapState: DtSnapState = { hash: null, fresh: false, lines: null, key: null, ts: 0 };

export interface DtSnapMeta {
  cacheHit: boolean;            // answered UNCHANGED
  delta: boolean;               // answered with ADDED/REMOVED only
  deltaAdded?: number;
  deltaRemoved?: number;
  rawBytes: number;             // snapshot section as received from upstream
  keptBytes: number;            // snapshot section as sent to the agent
}

export interface DtSnapOptions {
  compact: boolean;             // PLAYGUARD_COMPACT
  deltaEnabled: boolean;        // PLAYGUARD_DELTA
  deltaThreshold: number;       // PLAYGUARD_DELTA_THRESHOLD
  verbose: boolean;             // take_snapshot was called with verbose:true
}

export const DT_SNAP_HEADER = "## Latest page snapshot";

interface DtNode {
  depth: number;
  text: string;                 // the node exactly as it will be emitted (may span lines)
  parsed: boolean;              // false → unparseable, emitted verbatim and never transformed
  uid?: string;
  role?: string;
  name?: string;
  attrs?: string;               // ` key="v" flag ...`, leading space included
  tail?: string;                // ` [selected in the DevTools Elements panel]`
}

// Lazy name: the shortest name after which the rest still reads as attributes.
// A value that defeats this (quotes inside an attribute) leaves the node unparsed — safe.
const NODE_RE = /^( *)uid=(\S+)(?: ([A-Za-z]+))?(?: "(.*?)")?((?: [A-Za-z]+(?:="[^"]*")?)*)( \[selected in the DevTools Elements panel\])?$/s;
const NODE_START_RE = /^ *uid=\S/;
const NESTED_ROOT_RE = /^ *uid=\S+ RootWebArea\b/;
// NODE_RE backtracks quadratically on a huge name with many `x="` runs; such a node is
// emitted verbatim instead (96KB name: 1.3s → 0).
const MAX_PARSE = 2000;

function parseNode(text: string): DtNode {
  const depth = Math.floor((text.length - text.trimStart().length) / 2);
  const m = text.length > MAX_PARSE ? null : NODE_RE.exec(text);
  if (!m) return { depth, text, parsed: false };
  return { depth, text, parsed: true, uid: m[2], role: m[3], name: m[4], attrs: m[5], tail: m[6] };
}

function render(n: DtNode): string {
  return `${"  ".repeat(n.depth)}uid=${n.uid}${n.role ? " " + n.role : ""}${n.name !== undefined ? ` "${n.name}"` : ""}${n.attrs}${n.tail ?? ""}`;
}

// Splits the section body into preamble lines (the "selected element" note) and nodes.
// Verbose snapshots also contain a few nodes without a uid (`"+"`, `ignored`); they ride
// along with the preceding node, which then fails NODE_RE and is emitted verbatim.
function splitNodes(body: string): { pre: string[]; nodes: DtNode[] } {
  const pre: string[] = [];
  const chunks: string[] = [];
  for (const line of body.split("\n")) {
    if (NODE_START_RE.test(line)) chunks.push(line);
    else if (chunks.length) chunks[chunks.length - 1] += "\n" + line;
    else pre.push(line);
  }
  return { pre, nodes: chunks.map(parseNode) };
}

// Read from the root's first physical line, so a uid-less line riding along with the root
// (which makes it unparseable) does not lose the page identity.
function rootUrl(nodes: DtNode[]): string {
  return nodes[0]?.text.split("\n", 1)[0].match(/ url="([^"]*)"/)?.[1] ?? "";
}

// The lossless-ish rewrite. Every uid of a node with a role other than text/image/LineBreak
// survives; a leaf without attributes is dropped only when its name repeats its parent's
// or (text only) a same-named control's just before it. `stripImgUrls` reports whether
// image urls went.
export function compactDtNodes(nodes: DtNode[], verbose = false): { nodes: DtNode[]; stripImgUrls: boolean } {
  let origin = "";
  try { origin = new URL(rootUrl(nodes)).origin; } catch { /* about:blank etc. — no rewrite */ }
  const out: DtNode[] = [];
  const lastAt: DtNode[] = [];   // last node seen per depth (original order): parent/prev-sibling lookup
  let nestedDepth = Infinity;    // depth of the nested RootWebArea (iframe) we are inside, if any
  let stripImgUrls = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = { ...nodes[i] };
    const parent = n.depth > 0 ? lastAt[n.depth - 1] : undefined;
    const prev = lastAt[n.depth];
    lastAt.length = n.depth;
    lastAt[n.depth] = n;
    // URLs inside an iframe's document are relative to another origin: leave them absolute.
    if (n.depth <= nestedDepth) nestedDepth = Infinity;
    if (i > 0 && nestedDepth === Infinity && NESTED_ROOT_RE.test(n.text)) nestedDepth = n.depth;
    if (!n.parsed) { out.push(n); continue; }

    if (n.role === "image") {
      if (!verbose && / url="/.test(n.attrs!)) { n.attrs = n.attrs!.replace(/ url="[^"]*"/, ""); stripImgUrls = true; }
    } else if (origin && i > 0 && nestedDepth === Infinity) {
      n.attrs = n.attrs!.replace(/ url="([^"]*)"/, (all, u: string) =>
        u === origin || u.startsWith(origin + "/") || u.startsWith(origin + "?") || u.startsWith(origin + "#")
          ? ` url="${u.slice(origin.length) || "/"}"` : all);
    }
    // "X X" → "X" only for the real case: a link whose name doubles because it wraps an
    // image (or text) named X. A legit "Bye Bye" has no such child and is kept.
    const half = n.name !== undefined && n.name.length % 2 === 1 ? n.name.slice(0, (n.name.length - 1) / 2) : "";
    if (half && n.name === `${half} ${half}`) {
      for (let j = i + 1; j < nodes.length && nodes[j].depth > n.depth; j++) {
        if (nodes[j].depth === n.depth + 1 && nodes[j].name === half) { n.name = half; break; }
      }
    }
    n.text = render(n);

    const leaf = (nodes[i + 1]?.depth ?? -1) <= n.depth;
    if (!leaf || n.tail || n.attrs) { out.push(n); continue; }
    if (n.role === "LineBreak") continue;
    const plain = n.role === undefined || n.role === "image";
    // Text after a same-named control (radio "Small" + "Small") is its label; text after
    // same text ("★" "★" "★") is content and stays.
    const labelOfPrev = n.role === undefined && prev?.parsed && prev.role !== undefined && n.name === prev.name;
    if (plain && n.name !== undefined && (n.name === parent?.name || labelOfPrev)) continue;
    out.push(n);
  }
  return { nodes: out, stripImgUrls };
}

// Locates the snapshot section: [start of body, end of body). The body runs to the next
// `## ` section header or the end of the text.
// ponytail: a multi-line name containing "\n## " would end the section early; never seen.
function findSection(text: string): { bodyStart: number; end: number } | null {
  const first = text.startsWith(DT_SNAP_HEADER + "\n");
  const at = first ? 0 : text.indexOf("\n" + DT_SNAP_HEADER + "\n") + 1;
  if (!first && at === 0) return null;
  const bodyStart = at + DT_SNAP_HEADER.length + 1;
  const next = text.indexOf("\n## ", bodyStart);
  return { bodyStart, end: next < 0 ? text.length : next + 1 };
}

const kb = (n: number) => (n / 1024).toFixed(1);

// Rewrites the "## Latest page snapshot" section of any DevTools response (take_snapshot,
// or an action called with includeSnapshot:true). Text outside that section is untouched.
// Returns null when the response carries no snapshot section — caller passes it through.
export function processSnapshotResponse(
  responseText: string, state: DtSnapState, opts: DtSnapOptions,
): { text: string; state: DtSnapState; meta: DtSnapMeta } | null {
  const sec = findSection(responseText);
  if (!sec) return null;
  const rawBody = responseText.slice(sec.bodyStart, sec.end);
  // Keep the trailing blank line(s) that separate this section from the next one.
  const trailing = rawBody.match(/\n*$/)![0];
  const rawText = rawBody.slice(0, rawBody.length - trailing.length);
  const { pre, nodes } = splitNodes(rawText);
  const { nodes: kept, stripImgUrls } = opts.compact ? compactDtNodes(nodes, opts.verbose) : { nodes, stripImgUrls: false };
  const fullBody = [...pre, ...kept.map((n) => n.text)].join("\n");
  const rawBytes = Buffer.byteLength(rawBody);
  const rawLines = rawBody.split("\n").length - trailing.length;
  const marker = `[PlayGuard compact: ${fullBody.split("\n").length}/${rawLines} lines, ${kb(rawBytes)}KB→${kb(Buffer.byteLength(fullBody))}KB`
    + `${stripImgUrls ? "; img urls dropped, raw:true for full" : ""}]`;

  // UNCHANGED compares the raw section: a change compaction removes (an image url) is still a change.
  const hash = createHash("sha256").update(rawText).digest("hex").slice(0, 16);
  const key = JSON.stringify({ u: rootUrl(nodes), v: opts.verbose });
  const lines = kept.map((n) => n.text);
  const lineSet = new Set(lines);
  const now = Date.now();
  const wrap = (body: string, meta: Omit<DtSnapMeta, "rawBytes" | "keptBytes">, next: DtSnapState) => ({
    text: responseText.slice(0, sec.bodyStart) + body + trailing + responseText.slice(sec.end),
    state: next,
    meta: { ...meta, rawBytes, keptBytes: Buffer.byteLength(body + trailing) },
  });

  if (state.fresh && state.hash === hash && state.key === key) {
    return wrap(`[PlayGuard: UNCHANGED since ${now - state.ts}ms ago]`, { cacheHit: true, delta: false }, state);
  }

  const fresh: DtSnapState = { hash, fresh: true, lines: lineSet, key, ts: now };
  // Delta: set difference over whole node lines. uids are stable across snapshots and
  // part of each line, so a line names exactly one element and is actionable on its own
  // (the agent clicks by uid); each line keeps its indentation so what nests in a new
  // dialog stays visible. A node that moved or changed depth shows as REMOVED + ADDED; a
  // pure sibling reorder changes no line and reports as +0/0 — order never affects a uid action.
  if (opts.deltaEnabled && state.lines && state.key === key) {
    const added = lines.filter((l) => !state.lines!.has(l));
    const removed = [...state.lines].filter((l) => !lineSet.has(l));
    const ratio = (added.length + removed.length) / (lines.length || 1);
    // Raw changed but nothing visible did (compaction hid it): a +0/0 would read as
    // "nothing happened", so fall through to the full snapshot.
    const hidden = hash !== state.hash && added.length + removed.length === 0;
    if (ratio < opts.deltaThreshold && !hidden) {
      const body = [
        `[PlayGuard delta: +${added.length} added, ${removed.length} removed]`,
        added.length ? "ADDED:\n" + added.join("\n") : "",
        removed.length ? "REMOVED:\n" + removed.join("\n") : "",
      ].filter(Boolean).join("\n");
      return wrap(body, { cacheHit: false, delta: true, deltaAdded: added.length, deltaRemoved: removed.length }, fresh);
    }
  }

  // The marker costs bytes too: on a tiny page where compaction saves less than the
  // marker itself, send the section as received.
  const saved = rawBytes - Buffer.byteLength(fullBody + trailing);
  const body = opts.compact && saved > Buffer.byteLength(marker) + 1 ? marker + "\n" + fullBody : rawText;
  return wrap(body, { cacheHit: false, delta: false }, fresh);
}

// After a call that may change the page: drop the UNCHANGED shortcut, keep the delta baseline.
export function invalidateDtSnap(state: DtSnapState): DtSnapState {
  return { ...state, fresh: false };
}
