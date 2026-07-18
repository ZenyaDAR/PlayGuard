// Figma response optimizer: strips metadata, prunes invisible layers, dedupes
// component instances / sibling subtrees, and structurally trims to a char budget.
// Pure transforms over the parsed upstream tree — no I/O.
import { FIGMA_SVG_REFS } from "./config.js";

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

export interface FigmaOptStats {
  inBytes: number; outBytes: number;
  metaKeysDeleted: number; invisiblePruned: number;
  svgRefsReplaced: number; instancesCollapsed: number;
  uniqueComponents: number;
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
    uniqueComponents: 0,
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
