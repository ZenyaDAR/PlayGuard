// Figma → Browser visual diff (see DESIGN_DIFF_PLAN.md).
// Extracts visual properties from a Figma node and from a browser element's
// getComputedStyle(), normalizes both into the same CSS-shaped strings, and
// diffs them with px/color tolerance.
//
// Two upstream Figma MCP formats are supported: the raw REST API shape
// (@figma/mcp) and Framelink's pre-simplified shape (figma-developer-mcp),
// which hoists shared styles into a `globalVars.styles` table and leaves
// string references behind on the nodes.

// ── Types ────────────────────────────────────────────────────────────────
export interface DesignPair {
  figmaNodeId: string;
  browserSelector: string;
}

export interface DesignDiffArgs {
  figmaFileKey: string;
  figmaNodeId?: string;
  browserSelector?: string;
  pairs?: DesignPair[];
  properties?: string[];   // omitted ⇒ auto-selected from the node's type and contents
  autoMap?: boolean;       // map the layers under figmaNodeId onto DOM elements
}

export interface PropertyComparison {
  property: string;
  figmaValue: string | null;
  browserValue: string | null;
  match: boolean;
  withinTolerance?: boolean;
  delta?: string;
}

export interface DesignDiffResult {
  matches: number;
  mismatches: number;
  skipped: number;
  comparisons: PropertyComparison[];
  viewport?: { width: number; height: number };
  warnings: string[];
  label?: string;   // "42:1337 → [data-testid='login-btn']" in batch mode
  error?: string;   // pair failed (Figma fetch, selector miss, …) — set instead of comparisons
}

// ── Constants ────────────────────────────────────────────────────────────
export const BIG_FIVE = ["fontSize", "color", "backgroundColor", "padding", "borderRadius"];
export const ALL_PROPERTIES = [...BIG_FIVE, "fontFamily", "fontWeight", "lineHeight",
  "boxShadow", "opacity", "letterSpacing", "width", "height",
  "margin", "borderWidth", "borderStyle", "borderColor", "gap",
  "textAlign", "textDecoration", "textTransform"];

export const FONT_WEIGHT_MAP: Record<string, number> = {
  thin: 100, hairline: 100,
  extralight: 200, ultralight: 200,
  light: 300,
  regular: 400, normal: 400, book: 400,
  medium: 500,
  semibold: 600, demibold: 600,
  bold: 700,
  extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};

// Properties whose Figma value is a fixed design-time size but whose browser
// value depends on the viewport — compared, but always with a warning.
const RESPONSIVE_PROPS = ["width", "height"];
const COLOR_PROPS = ["color", "backgroundColor", "borderColor"];

// What a node type can meaningfully carry. A TEXT node's fills ARE its text
// color, so asking it for a backgroundColor/padding/borderRadius would compare a
// design's letter color against the DOM's (usually transparent) background.
const TEXT_PROPS = ["fontSize", "color", "fontFamily", "fontWeight", "lineHeight", "letterSpacing", "opacity", "textAlign", "textDecoration", "textTransform"];
const CONTAINER_PROPS = ["backgroundColor", "padding", "borderRadius", "boxShadow", "opacity", "margin", "borderWidth", "borderStyle", "borderColor", "gap"];
// Node types worth trying to map onto a DOM element. Vectors/icons have no
// stable DOM counterpart, so auto-mapping skips them.
const MAPPABLE_TYPES = ["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "RECTANGLE", "TEXT"];
// ponytail: a flat cap, not a smart budget — auto-map is a convenience over a
// component, not a whole-page crawler. Raise it if real components run bigger.
export const MAX_AUTO_MAP = 25;
// 4-value box properties: compared side-by-side, never by first value alone.
const BOX_PROPS: Record<string, [string, string, string, string]> = {
  padding: ["top", "right", "bottom", "left"],
  borderRadius: ["tl", "tr", "br", "bl"],
  margin: ["top", "right", "bottom", "left"],
  borderWidth: ["top", "right", "bottom", "left"],
};

// ── Color normalization ──────────────────────────────────────────────────
// Figma's own colors are 0–1 floats.
export function figmaColorToCSS(color: { r: number; g: number; b: number; a?: number }): string {
  return rgba255ToCSS({
    r: Math.round(color.r * 255), g: Math.round(color.g * 255), b: Math.round(color.b * 255),
    a: color.a ?? 1,
  });
}

// Framelink's are hex, i.e. already 0–255 — scaling those by 255 again is how you
// get rgb(6375, 30090, 53550).
function rgba255ToCSS(c: { r: number; g: number; b: number; a?: number }): string {
  const a = c.a ?? 1;
  if (a < 1) return `rgba(${c.r}, ${c.g}, ${c.b}, ${round(a)})`;
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function parseCSSColor(css: string): { r: number; g: number; b: number; a: number } | null {
  const match = css.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([0-9.]+))?\)/);
  if (!match) return null;
  return { r: +match[1], g: +match[2], b: +match[3], a: match[4] ? +match[4] : 1 };
}

export function parseHexColor(hex: string): { r: number; g: number; b: number; a: number } {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

// A colour reaches us in one of three shapes depending on the upstream and the
// field: Figma's 0–1 float object, Framelink's hex string, or an already-CSS
// rgb() string. All three normalize to the rgb()/rgba() form getComputedStyle
// returns — anything else compares as "no value" rather than as a false mismatch.
function toCSSColor(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("#")) return rgba255ToCSS(parseHexColor(s));
    return s.startsWith("rgb") ? s : null;
  }
  if (v && typeof v === "object" && typeof (v as AnyRec).r === "number") {
    return figmaColorToCSS(v as { r: number; g: number; b: number; a?: number });
  }
  return null;
}

// Strips float noise (Figma emits 23.999998) without turning ints into "24.00".
function round(n: number): number {
  return +n.toFixed(2);
}

// ── Box-model normalization ──────────────────────────────────────────────
export function normalizePadding(top: number, right: number, bottom: number, left: number): string {
  return `${round(top)}px ${round(right)}px ${round(bottom)}px ${round(left)}px`;
}

export function normalizeBorderRadius(tl: number, tr: number, br: number, bl: number): string {
  return `${round(tl)}px ${round(tr)}px ${round(br)}px ${round(bl)}px`;
}

// Expands a CSS box shorthand (1/2/3/4 values) into its 4 explicit sides.
// Both sides of a box comparison run through this, so "8px" and
// "8px 8px 8px 8px" compare equal while "8px 8px 0px 0px" does not.
export function parseBoxShorthand(value: string): [number, number, number, number] | null {
  const parts = value.trim().split(/\s+/).map(p => parseFloat(p));
  if (parts.length === 0 || parts.length > 4 || parts.some(isNaN)) return null;
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

// ── Font normalization ───────────────────────────────────────────────────
// Browser: "Inter, sans-serif" → "Inter". Only the first family is comparable;
// Figma has no fallback stack.
export function firstFontFamily(value: string): string {
  return value.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

// Figma emits a numeric weight (400) or a style name ("SemiBold"); CSS computed
// style always resolves to a number. Normalize both to the number as a string.
export function normalizeFontWeight(value: string | number | undefined | null): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const mapped = FONT_WEIGHT_MAP[trimmed.toLowerCase().replace(/[\s_-]/g, "")];
  return mapped ? String(mapped) : null;
}

// ── Figma node resolution ────────────────────────────────────────────────
type AnyRec = Record<string, any>;

// Framelink hoists shared styles into globalVars.styles and leaves a string key
// behind on the node (`fills: "fill_PRIMARY"`). Raw values pass through.
function deref(value: any, globalVars: AnyRec): any {
  if (typeof value === "string" && globalVars?.styles && value in globalVars.styles) {
    return globalVars.styles[value];
  }
  return value;
}

const normId = (id: string) => id.replace(/-/g, ":");

// Unwraps the several envelopes an upstream may return: raw REST
// (`{nodes: {"42:1337": {document: {…}}}}` or `{document: {…}}`) and Framelink
// (`{nodes: [{id, …}], globalVars: {…}}`).
export function resolveFigmaNode(data: any, nodeId?: string): { node: AnyRec; globalVars: AnyRec } {
  const globalVars: AnyRec = (data && typeof data === "object" && data.globalVars) || {};
  if (!data || typeof data !== "object") return { node: {}, globalVars };

  const want = nodeId ? normId(nodeId) : undefined;
  const nodes = data.nodes;
  let picked: any;

  if (Array.isArray(nodes)) {
    picked = (want && nodes.find(n => n && typeof n.id === "string" && normId(n.id) === want)) || nodes[0];
  } else if (nodes && typeof nodes === "object") {
    const keys = Object.keys(nodes);
    const key = (want && keys.find(k => normId(k) === want)) || keys[0];
    picked = key ? nodes[key] : undefined;
  }

  const root = ((picked ?? data).document ?? picked ?? data) as AnyRec;
  // A child's id may only exist deeper in the subtree — auto-map fetches the
  // parent component once and then resolves each descendant out of that one tree.
  if (want && normId(String(root.id ?? "")) !== want) {
    const hit = findNodeById(root, want);
    if (hit) return { node: hit, globalVars };
  }
  return { node: root, globalVars };
}

function findNodeById(node: AnyRec, want: string): AnyRec | null {
  if (!node || typeof node !== "object") return null;
  if (typeof node.id === "string" && normId(node.id) === want) return node;
  for (const child of node.children ?? []) {
    const hit = findNodeById(child, want);
    if (hit) return hit;
  }
  return null;
}

// ── Framelink style accessors ────────────────────────────────────────────
function fmStyles(node: AnyRec, gv: AnyRec): AnyRec {
  const s = deref(node.styles, gv);
  return s && typeof s === "object" ? s : {};
}

function fmTypography(node: AnyRec, gv: AnyRec): AnyRec | null {
  const t = deref(fmStyles(node, gv).typography ?? node.textStyle ?? node.typography, gv);
  return t && typeof t === "object" ? t : null;
}

function fmLayout(node: AnyRec, gv: AnyRec): AnyRec | null {
  const l = deref(fmStyles(node, gv).layout ?? node.layout, gv);
  return l && typeof l === "object" ? l : null;
}

// Framelink fills come as hex strings, either inline or behind a globalVars ref.
// Gradients/images arrive as objects and are skipped — CSS backgroundColor is a
// single solid value.
function fmHexFills(node: AnyRec, gv: AnyRec): string[] {
  const f = deref(fmStyles(node, gv).fills ?? node.fills, gv);
  const arr = Array.isArray(f) ? f : [f];
  return arr.filter(x => typeof x === "string" && x.startsWith("#"));
}

// ── Figma property extractors ────────────────────────────────────────────
function firstSolidFill(node: AnyRec | undefined, isFramelink: boolean, gv: AnyRec): string | null {
  if (!node) return null;
  if (isFramelink) {
    const hex = fmHexFills(node, gv)[0];
    return hex ? rgba255ToCSS(parseHexColor(hex)) : null;
  }
  const fill = Array.isArray(node.fills)
    ? node.fills.find((f: AnyRec) => f?.type === "SOLID" && f.color && f.visible !== false)
    : undefined;
  return fill?.color ? figmaColorToCSS(fill.color) : null;
}

// The one number the typography-derived properties (lineHeight, letterSpacing)
// need to resolve their relative units.
function fontSizeOf(node: AnyRec, isFramelink: boolean, gv: AnyRec): number | null {
  const raw = isFramelink ? fmTypography(node, gv)?.fontSize : node.style?.fontSize;
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  return typeof n === "number" && !isNaN(n) ? n : null;
}

function extractFontSize(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const size = fontSizeOf(node, isFramelink, gv);
  return size === null ? null : `${round(size)}px`;
}

// First TEXT node at any depth. Direct children are not enough: a button is
// routinely a FRAME → wrapper → TEXT, and stopping at depth 1 made the caller
// fall back to the container itself.
export function findTextDescendant(node: AnyRec): AnyRec | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "TEXT") return node;
  for (const c of node.children ?? []) {
    const hit = findTextDescendant(c);
    if (hit) return hit;
  }
  return null;
}

function extractColor(node: AnyRec, isFramelink: boolean, gv: AnyRec, kind: "text" | "fill"): string | null {
  if (kind === "fill") {
    // A TEXT node's fill is the color of its glyphs, not a background.
    return node.type === "TEXT" ? null : firstSolidFill(node, isFramelink, gv);
  }
  // "text" color comes from a TEXT descendant's own fill. With no TEXT anywhere
  // beneath, the answer is "unknown" — falling back to the node's own fill would
  // hand back its BACKGROUND as the text color and mismatch against every page.
  const textNode = findTextDescendant(node);
  return textNode ? firstSolidFill(textNode, isFramelink, gv) : null;
}

function extractPadding(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  if (isFramelink) {
    const p = fmLayout(node, gv)?.padding;
    const parsed = typeof p === "string" ? parseBoxShorthand(p) : null;
    return parsed ? normalizePadding(...parsed) : null;
  }
  const { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l } = node;
  if ([t, r, b, l].every(v => typeof v === "number")) return normalizePadding(t, r, b, l);
  return null;
}

function extractBorderRadius(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  if (isFramelink) {
    // Not a standardized Framelink field — it shows up on the node, in styles,
    // or inside layout depending on version. Accept a number or a CSS shorthand.
    const r = fmStyles(node, gv).borderRadius ?? node.borderRadius ?? fmLayout(node, gv)?.borderRadius;
    if (typeof r === "number") return `${round(r)}px`;
    const parsed = typeof r === "string" ? parseBoxShorthand(r) : null;
    return parsed ? normalizeBorderRadius(...parsed) : null;
  }
  if (typeof node.cornerRadius === "number") return `${round(node.cornerRadius)}px`;
  const { topLeftRadius: tl, topRightRadius: tr, bottomRightRadius: br, bottomLeftRadius: bl } = node;
  if ([tl, tr, br, bl].every(v => typeof v === "number")) return normalizeBorderRadius(tl, tr, br, bl);
  return null;
}

function extractFontFamily(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const fam = isFramelink ? fmTypography(node, gv)?.fontFamily : node.style?.fontFamily;
  return typeof fam === "string" && fam ? firstFontFamily(fam) : null;
}

function extractFontWeight(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const t = isFramelink ? fmTypography(node, gv) : node.style;
  // Figma raw carries the numeric weight in `fontWeight`; the human-readable
  // style name ("SemiBold") only appears on the text style.
  return normalizeFontWeight(t?.fontWeight ?? t?.fontStyle ?? t?.style);
}

// CSS line-height: px stays px, a unitless number is a multiplier of fontSize,
// and a percentage resolves against fontSize too. Figma raw says the same thing
// with lineHeightPx / lineHeightPercent + lineHeightUnit.
function extractLineHeight(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const fs = fontSizeOf(node, isFramelink, gv);
  if (isFramelink) {
    const lh = fmTypography(node, gv)?.lineHeight;
    if (typeof lh === "number") return fs === null ? null : `${round(lh * fs)}px`;
    if (typeof lh !== "string") return null;
    const n = parseFloat(lh);
    if (isNaN(n)) return null;
    if (lh.endsWith("px")) return `${round(n)}px`;
    if (lh.endsWith("em")) return fs === null ? null : `${round(n * fs)}px`;
    if (lh.endsWith("%")) return fs === null ? null : `${round(n * fs / 100)}px`;
    return fs === null ? null : `${round(n * fs)}px`; // unitless multiplier
  }
  const st = node.style;
  if (typeof st?.lineHeightPx === "number") return `${round(st.lineHeightPx)}px`;
  // INTRINSIC_% means "whatever the font says" — there is no px value to compare.
  if (st?.lineHeightUnit === "FONT_SIZE_%" && typeof st.lineHeightPercent === "number" && fs !== null) {
    return `${round(fs * st.lineHeightPercent / 100)}px`;
  }
  return null;
}

// Figma letterSpacing is px, or {value, unit: "PERCENT"} relative to fontSize.
function extractLetterSpacing(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const fs = fontSizeOf(node, isFramelink, gv);
  const ls = isFramelink ? fmTypography(node, gv)?.letterSpacing : node.style?.letterSpacing;
  if (typeof ls === "number") return `${round(ls)}px`;
  if (ls && typeof ls === "object" && typeof ls.value === "number") {
    if (ls.unit === "PERCENT") return fs === null ? null : `${round(fs * ls.value / 100)}px`;
    return `${round(ls.value)}px`;
  }
  if (typeof ls === "string") {
    const n = parseFloat(ls);
    if (isNaN(n)) return null;
    if (ls.endsWith("%")) return fs === null ? null : `${round(fs * n / 100)}px`;
    return `${round(n)}px`;
  }
  return null;
}

// Figma effects → the CSS computed box-shadow shorthand, which puts the color
// first and always spells out all four lengths: "rgba(…) 0px 2px 4px 0px".
function extractBoxShadow(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const raw = isFramelink ? deref(fmStyles(node, gv).effects ?? node.effects, gv) : node.effects;
  // Some Framelink versions pre-render the shadow as a CSS string.
  if (typeof raw === "string") return raw || null;
  if (!Array.isArray(raw)) return null;

  const shadows = raw
    .filter((e: AnyRec) => e && e.visible !== false && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"))
    .map((e: AnyRec) => {
      if (typeof e === "string") return e;
      const color = e.color ? figmaColorToCSS(e.color) : "rgb(0, 0, 0)";
      const x = round(e.offset?.x ?? 0), y = round(e.offset?.y ?? 0);
      const blur = round(e.radius ?? 0), spread = round(e.spread ?? 0);
      const inset = e.type === "INNER_SHADOW" ? " inset" : "";
      return `${color} ${x}px ${y}px ${blur}px ${spread}px${inset}`;
    });
  return shadows.length ? shadows.join(", ") : null;
}

function extractOpacity(node: AnyRec): string | null {
  return typeof node.opacity === "number" ? String(round(node.opacity)) : null;
}

function extractSize(node: AnyRec, isFramelink: boolean, dim: "width" | "height"): string | null {
  const v = isFramelink ? node.dimensions?.[dim] : node.absoluteBoundingBox?.[dim];
  return typeof v === "number" ? `${round(v)}px` : null;
}

function extractTextAlign(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const align = isFramelink ? fmTypography(node, gv)?.textAlign : node.style?.textAlignHorizontal;
  if (!align || typeof align !== "string") return null;
  const a = align.toUpperCase();
  if (a === "LEFT") return "left";
  if (a === "RIGHT") return "right";
  if (a === "CENTER") return "center";
  if (a === "JUSTIFIED") return "justify";
  return null;
}

function extractTextDecoration(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const dec = isFramelink ? fmTypography(node, gv)?.textDecoration : node.style?.textDecoration;
  if (!dec || typeof dec !== "string") return null;
  const d = dec.toUpperCase();
  if (d === "STRIKETHROUGH") return "line-through";
  if (d === "UNDERLINE") return "underline";
  if (d === "NONE") return "none";
  return null;
}

function extractTextTransform(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  const caseVal = isFramelink ? fmTypography(node, gv)?.textCase : node.style?.textCase;
  if (!caseVal || typeof caseVal !== "string") return null;
  const c = caseVal.toUpperCase();
  if (c === "UPPER") return "uppercase";
  if (c === "LOWER") return "lowercase";
  if (c === "TITLE") return "capitalize";
  return null;
}

function extractGap(node: AnyRec, isFramelink: boolean, gv: AnyRec): string | null {
  if (isFramelink) {
    const gap = fmLayout(node, gv)?.gap;
    if (typeof gap === "string") return `${parseFloat(gap)}px`;
    if (typeof gap === "number") return `${round(gap)}px`;
    return null;
  }
  if (typeof node.itemSpacing === "number") return `${round(node.itemSpacing)}px`;
  return null;
}

function extractBorders(node: AnyRec, isFramelink: boolean, gv: AnyRec): { width: string | null, style: string | null, color: string | null } {
  if (isFramelink) {
    const b = deref(fmStyles(node, gv).borders ?? node.borders, gv);
    if (!b) return { width: null, style: null, color: null };
    if (Array.isArray(b) && b[0]) {
       return {
         width: typeof b[0].width === "number" ? `${round(b[0].width)}px` : typeof b[0].width === "string" ? b[0].width : null,
         style: typeof b[0].style === "string" ? b[0].style.toLowerCase() : "solid",
         color: toCSSColor(b[0].color),
       };
    }
    return { width: null, style: null, color: null };
  }
  
  if (!node.strokes || !Array.isArray(node.strokes) || node.strokes.length === 0) {
    return { width: null, style: null, color: null };
  }
  
  const visibleStroke = node.strokes.find((s: AnyRec) => s.visible !== false);
  if (!visibleStroke) return { width: null, style: null, color: null };
  
  const width = typeof node.strokeWeight === "number" ? `${round(node.strokeWeight)}px` : null;
  const style = "solid";
  const color = toCSSColor(visibleStroke.color);

  return { width, style, color };
}

// Which upstream shape a node came from. `node.styles` alone can NOT decide it:
// the raw REST API puts a style-id map (`{text: "9:9"}`) on any node using a
// shared style, so treating that as a Framelink signal sent well-organized REST
// files down the Framelink path and returned null for every property — a silent
// all-SKIPPED diff on exactly the design systems most worth diffing.
export function isFramelinkShape(node: AnyRec, nodeData?: any): boolean {
  // Unambiguous Framelink markers: its envelope, or a globalVars string ref
  // left behind on the node.
  if (nodeData?.globalVars) return true;
  if (typeof node.fills === "string" || typeof node.layout === "string" || typeof node.styles === "string") return true;
  if (node.dimensions) return true;
  // Unambiguous REST markers — checked before the ambiguous `styles` object.
  if (node.absoluteBoundingBox || (node.style && typeof node.style === "object")) return false;
  // An object `styles` is Framelink's only if it holds Framelink's own sections;
  // REST's holds style ids under fill/text/effect/grid/stroke.
  if (node.styles && typeof node.styles === "object") {
    return ["typography", "fills", "layout", "effects", "borders", "strokes"].some(k => k in node.styles);
  }
  return false;
}

export function extractFigmaProperties(nodeData: any, properties: string[], nodeId?: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const { node, globalVars: gv } = resolveFigmaNode(nodeData, nodeId);
  const isFramelink = isFramelinkShape(node, nodeData);
  // Where a container's typography lives depends on the upstream: Framelink
  // hoists the text style onto the FRAME (`styles.typography`), while raw REST
  // leaves it only on the TEXT layer beneath. So neither node is "the" source —
  // ask the node itself first, then its label, and take whichever actually
  // defines the property.
  const label = findTextDescendant(node);
  const typo = (read: (n: AnyRec) => string | null): string | null => {
    const own = read(node);
    if (own !== null) return own;
    return label && label !== node ? read(label) : null;
  };

  for (const prop of properties) {
    switch (prop) {
      case "fontSize": result.fontSize = typo(n => extractFontSize(n, isFramelink, gv)); break;
      case "color": result.color = extractColor(node, isFramelink, gv, "text"); break;
      case "backgroundColor": result.backgroundColor = extractColor(node, isFramelink, gv, "fill"); break;
      case "padding": result.padding = extractPadding(node, isFramelink, gv); break;
      case "borderRadius": result.borderRadius = extractBorderRadius(node, isFramelink, gv); break;
      case "fontFamily": result.fontFamily = typo(n => extractFontFamily(n, isFramelink, gv)); break;
      case "fontWeight": result.fontWeight = typo(n => extractFontWeight(n, isFramelink, gv)); break;
      case "lineHeight": result.lineHeight = typo(n => extractLineHeight(n, isFramelink, gv)); break;
      case "letterSpacing": result.letterSpacing = typo(n => extractLetterSpacing(n, isFramelink, gv)); break;
      case "boxShadow": result.boxShadow = extractBoxShadow(node, isFramelink, gv); break;
      case "opacity": result.opacity = extractOpacity(node); break;
      case "width": result.width = extractSize(node, isFramelink, "width"); break;
      case "height": result.height = extractSize(node, isFramelink, "height"); break;
      case "textAlign": result.textAlign = typo(n => extractTextAlign(n, isFramelink, gv)); break;
      case "textDecoration": result.textDecoration = typo(n => extractTextDecoration(n, isFramelink, gv)); break;
      case "textTransform": result.textTransform = typo(n => extractTextTransform(n, isFramelink, gv)); break;
      case "margin": result.margin = null; break; // Figma doesn't natively model node margin
      case "gap": result.gap = extractGap(node, isFramelink, gv); break;
      case "borderWidth": result.borderWidth = extractBorders(node, isFramelink, gv).width; break;
      case "borderStyle": result.borderStyle = extractBorders(node, isFramelink, gv).style; break;
      case "borderColor": result.borderColor = extractBorders(node, isFramelink, gv).color; break;
      default: result[prop] = null; // unknown property
    }
  }
  return result;
}

// ── Browser evaluate script builder ─────────────────────────────────────
export function buildBrowserEvalScript(selector: string, properties: string[]): string {
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  // Whitelist: `properties` flows from tool arguments straight into generated
  // JS below (`s.${p}`) — an unfiltered value would let a caller break out of
  // the object literal and inject arbitrary code into the page's eval context.
  const known = properties.filter(p => ALL_PROPERTIES.includes(p));

  const propExtractions: string[] = [];
  if (known.includes("padding")) {
    propExtractions.push("paddingTop: s.paddingTop", "paddingRight: s.paddingRight",
      "paddingBottom: s.paddingBottom", "paddingLeft: s.paddingLeft");
  }
  if (known.includes("margin")) {
    propExtractions.push("marginTop: s.marginTop", "marginRight: s.marginRight",
      "marginBottom: s.marginBottom", "marginLeft: s.marginLeft");
  }
  if (known.includes("borderWidth")) {
    propExtractions.push("borderTopWidth: s.borderTopWidth", "borderRightWidth: s.borderRightWidth",
      "borderBottomWidth: s.borderBottomWidth", "borderLeftWidth: s.borderLeftWidth");
  }
  if (known.includes("borderRadius")) {
    propExtractions.push("borderTopLeftRadius: s.borderTopLeftRadius", "borderTopRightRadius: s.borderTopRightRadius",
      "borderBottomRightRadius: s.borderBottomRightRadius", "borderBottomLeftRadius: s.borderBottomLeftRadius");
  }
  const complexProps = ["padding", "margin", "borderWidth", "borderRadius", "width", "height"];
  const simpleProps = known.filter(p => !complexProps.includes(p));
  for (const p of simpleProps) propExtractions.push(`${p}: s.${p}`);
  if (known.includes("width") || known.includes("height")) {
    propExtractions.push("_rect: JSON.stringify(el.getBoundingClientRect())");
  }
  propExtractions.push("_viewport: JSON.stringify({width: window.innerWidth, height: window.innerHeight})");

  return `(() => {
    const el = document.querySelector('${escaped}');
    if (!el) return { _error: 'Element not found: ${escaped}' };
    const s = getComputedStyle(el);
    return { ${propExtractions.join(", ")} };
  })()`;
}

// Merges the flat getComputedStyle() readout back into the same property shape
// extractFigmaProperties produces (e.g. 4 padding numbers → 1 "padding" string),
// so compareProperties can compare like with like.
export function normalizeBrowserResponse(data: Record<string, any>, properties: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const prop of properties) {
    switch (prop) {
      case "padding": {
        const [t, r, b, l] = [data.paddingTop, data.paddingRight, data.paddingBottom, data.paddingLeft].map(parseFloat);
        result.padding = [t, r, b, l].every(v => !isNaN(v)) ? normalizePadding(t, r, b, l) : null;
        break;
      }
      case "margin": {
        const [t, r, b, l] = [data.marginTop, data.marginRight, data.marginBottom, data.marginLeft].map(parseFloat);
        result.margin = [t, r, b, l].every(v => !isNaN(v)) ? normalizePadding(t, r, b, l) : null;
        break;
      }
      case "borderWidth": {
        const [t, r, b, l] = [data.borderTopWidth, data.borderRightWidth, data.borderBottomWidth, data.borderLeftWidth].map(parseFloat);
        result.borderWidth = [t, r, b, l].every(v => !isNaN(v)) ? normalizePadding(t, r, b, l) : null;
        break;
      }
      case "borderRadius": {
        const [tl, tr, br, bl] = [data.borderTopLeftRadius, data.borderTopRightRadius,
          data.borderBottomRightRadius, data.borderBottomLeftRadius].map(parseFloat);
        result.borderRadius = [tl, tr, br, bl].every(v => !isNaN(v)) ? normalizeBorderRadius(tl, tr, br, bl) : null;
        break;
      }
      case "fontFamily":
        result.fontFamily = typeof data.fontFamily === "string" && data.fontFamily
          ? firstFontFamily(data.fontFamily) : null;
        break;
      case "fontWeight":
        result.fontWeight = normalizeFontWeight(data.fontWeight);
        break;
      case "letterSpacing":
        result.letterSpacing = data.letterSpacing === "normal" ? "0px"
          : data.letterSpacing != null ? String(data.letterSpacing) : null;
        break;
      case "borderStyle":
        result.borderStyle = data.borderStyle === "none none none none" ? "none" : (data.borderStyle || null);
        break;
      case "textDecoration":
        result.textDecoration = typeof data.textDecoration === "string" 
          ? (data.textDecoration.includes("none") ? "none" : data.textDecoration.split(" ")[0])
          : null;
        break;
      case "width":
      case "height": {
        if (!data._rect) { result[prop] = null; break; }
        try { result[prop] = `${round(JSON.parse(data._rect)[prop])}px`; } catch { result[prop] = null; }
        break;
      }
      default:
        result[prop] = data[prop] != null ? String(data[prop]) : null;
    }
  }
  return result;
}

// ── Comparison ───────────────────────────────────────────────────────────
// Properties whose absence in the design is itself a claim ("no shadow here"),
// so a stray browser value is a real finding rather than missing information.
// `margin` is deliberately NOT one of them: Figma has no margin concept at all
// (spacing is auto-layout gap/padding), so its null means "cannot know", not
// "should be zero" — counting it as a known default reported every ordinary CSS
// margin as an "extra browser style" mismatch.
export function hasKnownDefault(prop: string): boolean {
  return ["backgroundColor", "padding", "borderRadius", "borderWidth", "borderStyle", "boxShadow", "gap",
    "textDecoration", "opacity", "textTransform", "letterSpacing", "fontWeight"].includes(prop);
}

export function isBrowserDefault(prop: string, bv: string | null): boolean {
  if (!bv) return true;
  switch (prop) {
    case "backgroundColor": return bv === "rgba(0, 0, 0, 0)" || bv === "transparent";
    case "padding":
    case "margin":
    case "borderWidth":
    case "borderRadius": return bv === "0px 0px 0px 0px" || bv === "0px";
    case "boxShadow": return bv === "none";
    case "borderStyle": return bv === "none" || bv === "none none none none";
    case "gap": return bv === "normal" || bv === "0px" || bv === "0px 0px";
    case "textDecoration": return bv.includes("none");
    case "opacity": return bv === "1";
    case "textTransform": return bv === "none";
    case "letterSpacing": return bv === "normal" || bv === "0px";
    case "fontWeight": return bv === "400" || bv === "normal";
    default: return false;
  }
}

export function compareProperties(
  figma: Record<string, string | null>,
  browser: Record<string, string | null>,
  tolerancePx: number,
  toleranceColor: number,
): DesignDiffResult {
  const comparisons: PropertyComparison[] = [];
  let matches = 0, mismatches = 0, skipped = 0;
  const warnings: string[] = [];

  const push = (c: PropertyComparison) => {
    comparisons.push(c);
    if (c.match) matches++; else mismatches++;
  };

  for (const prop of Object.keys(figma)) {
    const fv = figma[prop];
    const bv = browser[prop];

    if (fv === null && bv === null) { skipped++; continue; }
    if (fv === null) {
      if (hasKnownDefault(prop)) {
        if (isBrowserDefault(prop, bv)) {
          push({ property: prop, figmaValue: "none", browserValue: bv, match: true });
        } else {
          push({ property: prop, figmaValue: "none", browserValue: bv, match: false, delta: "extra browser style" });
        }
      } else {
        comparisons.push({ property: prop, figmaValue: null, browserValue: bv, match: false, delta: "no Figma value" });
        skipped++;
      }
      continue;
    }
    if (bv === null) {
      comparisons.push({ property: prop, figmaValue: fv, browserValue: null, match: false, delta: "no browser value" });
      skipped++;
      continue;
    }

    if (fv === bv) { push({ property: prop, figmaValue: fv, browserValue: bv, match: true }); continue; }

    if (COLOR_PROPS.includes(prop)) {
      const fc = parseCSSColor(fv);
      const bc = parseCSSColor(bv);
      if (fc && bc) {
        const dr = Math.abs(fc.r - bc.r), dg = Math.abs(fc.g - bc.g), db = Math.abs(fc.b - bc.b);
        const ok = dr <= toleranceColor && dg <= toleranceColor && db <= toleranceColor;
        push({ property: prop, figmaValue: fv, browserValue: bv, match: ok, withinTolerance: ok || undefined, delta: `Δr:${dr}, Δg:${dg}, Δb:${db}` });
        continue;
      }
    }

    // Box properties compare per side/corner. A first-value-only numeric compare
    // would call "8px 8px 8px 8px" and "8px 8px 0px 0px" a match.
    const sides = BOX_PROPS[prop];
    if (sides) {
      const fb = parseBoxShorthand(fv);
      const bb = parseBoxShorthand(bv);
      if (fb && bb) {
        const deltas = fb.map((v, i) => round(v - bb[i]));
        const ok = deltas.every(d => Math.abs(d) <= tolerancePx);
        const detail = deltas
          .map((d, i) => (d === 0 ? null : `Δ${sides[i]}:${d > 0 ? "+" : ""}${d}px`))
          .filter(Boolean).join(", ");
        push({ property: prop, figmaValue: fv, browserValue: bv, match: ok, withinTolerance: ok || undefined, delta: detail || undefined });
        continue;
      }
    }

    // Unitless properties: the px tolerance is meaningless for them (a 2px
    // tolerance would call opacity 1 vs 0.5 a match, and weight 400 vs 401 too).
    if (prop === "opacity" || prop === "fontWeight") {
      const fNum = parseFloat(fv), bNum = parseFloat(bv);
      if (!isNaN(fNum) && !isNaN(bNum)) {
        const diff = round(fNum - bNum);
        const ok = Math.abs(diff) < 0.005;
        push({ property: prop, figmaValue: fv, browserValue: bv, match: ok, delta: ok ? undefined : `${diff > 0 ? "+" : ""}${diff}` });
        continue;
      }
    }

    if (prop === "fontFamily") {
      const ok = fv.toLowerCase() === bv.toLowerCase();
      push({ property: prop, figmaValue: fv, browserValue: bv, match: ok });
      continue;
    }

    const fNum = parseFloat(fv);
    const bNum = parseFloat(bv);
    if (!isNaN(fNum) && !isNaN(bNum)) {
      const diff = Math.abs(fNum - bNum);
      const ok = diff <= tolerancePx;
      push({
        property: prop, figmaValue: fv, browserValue: bv, match: ok, withinTolerance: ok || undefined,
        delta: ok ? `±${diff.toFixed(1)}px` : `${fNum > bNum ? "+" : ""}${(fNum - bNum).toFixed(1)}px`,
      });
      continue;
    }

    push({ property: prop, figmaValue: fv, browserValue: bv, match: false });
  }

  if (RESPONSIVE_PROPS.some(p => p in figma)) {
    warnings.push("width/height compare a fixed Figma size against a viewport-dependent browser layout — only meaningful when the viewport matches the design frame.");
  }

  return { matches, mismatches, skipped, comparisons, warnings };
}

// ── Formatting ───────────────────────────────────────────────────────────
export function formatDiffResult(result: DesignDiffResult): string {
  const label = result.label ? ` ${result.label}` : "";
  if (result.error) return `[PlayGuard design diff:${label} ERROR] ${result.error}`;

  const header = `[PlayGuard design diff:${label} ${result.mismatches} mismatch${result.mismatches === 1 ? "" : "es"}, ${result.matches} match${result.matches === 1 ? "" : "es"}]`;
  const viewport = result.viewport ? ` [viewport: ${result.viewport.width}×${result.viewport.height}]` : "";
  const lines = result.comparisons.map(c => {
    const isSkipped = c.figmaValue === null || c.browserValue === null;
    const status = c.match ? "✓  MATCH" : isSkipped ? "⚠️  SKIPPED" : "⚠️  MISMATCH";
    const delta = c.delta ? ` (${c.delta})` : "";
    const figmaStr = `Figma ${c.figmaValue ?? "N/A"}`;
    const browserStr = `Browser ${c.browserValue ?? "N/A"}`;
    return `  ${(c.property + ":").padEnd(17)}${figmaStr.padEnd(24)}→ ${browserStr.padEnd(24)}${status}${delta}`;
  });
  const warningsBlock = result.warnings.length ? "\n\n" + result.warnings.map(w => `⚠ ${w}`).join("\n") : "";
  return `${header}${viewport}\n\n${lines.join("\n")}${warningsBlock}`;
}

export function formatBatchResult(results: DesignDiffResult[], warnings: string[] = []): string {
  const matches = results.reduce((n, r) => n + r.matches, 0);
  const mismatches = results.reduce((n, r) => n + r.mismatches, 0);
  const failed = results.filter(r => r.error).length;
  const header = `[PlayGuard design diff: ${results.length} element${results.length === 1 ? "" : "s"}, ` +
    `${mismatches} mismatch${mismatches === 1 ? "" : "es"}, ${matches} match${matches === 1 ? "" : "es"}` +
    `${failed ? `, ${failed} failed` : ""}]`;
  const warn = warnings.length ? "\n\n" + warnings.map(w => `⚠ ${w}`).join("\n") : "";
  return `${header}${warn}\n\n${results.map(formatDiffResult).join("\n\n")}`;
}

// ══ Auto-detection (Phase 3) ═════════════════════════════════════════════

// Which properties are worth comparing for THIS node, rather than a fixed list:
// the node's type decides what it can carry, and anything the node doesn't
// actually define is dropped so it can't show up as a noisy SKIPPED row.
// width/height are never auto-selected — they are viewport-dependent (§6.2).
export function autoSelectProperties(nodeData: any, nodeId?: string): string[] {
  const { node } = resolveFigmaNode(nodeData, nodeId);
  // Same depth rule as extractColor: a nested label still makes this a node
  // whose typography is worth comparing.
  const hasText = !!findTextDescendant(node);
  // A button is a FRAME whose text lives in a TEXT child, but the DOM <button>
  // carries both sets of properties — so a container with text gets both.
  const candidates = node.type === "TEXT"
    ? TEXT_PROPS
    : [...CONTAINER_PROPS, ...(hasText ? TEXT_PROPS : [])];

  const ordered = ALL_PROPERTIES.filter(p => candidates.includes(p) && !RESPONSIVE_PROPS.includes(p));
  const extracted = extractFigmaProperties(nodeData, ordered, nodeId);

  // Even when Figma leaves these unset, an unwanted browser value (stray
  // border-radius, a leftover shadow) is a real visual bug — so any property
  // with a known CSS zero-default is always checked against it (isBrowserDefault),
  // instead of silently dropping out because the design "didn't say".
  return ordered.filter(p => extracted[p] !== null || hasKnownDefault(p));
}

// ── Batch auto-mapping ───────────────────────────────────────────────────
export interface MappableNode {
  figmaNodeId: string;
  name: string;
  type: string;
  text?: string;
  selectors: string[];
}

const kebab = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Selectors a developer plausibly used for a layer named "Login Button", most
// explicit first. A data-figma-id attribute is the only exact one; the rest are
// conventions, so a candidate is only accepted when it matches exactly one element.
export function selectorCandidates(name: string, nodeId: string): string[] {
  const out = [`[data-figma-id="${nodeId}"]`];
  const safeName = /["\\]/.test(name) ? null : name.trim();
  const k = kebab(name);
  if (safeName) out.push(`[data-testid="${safeName}"]`);
  if (k) {
    out.push(`[data-testid="${k}"]`);
    // A leading digit is not a valid identifier in a #id/.class selector.
    if (/^[a-z]/.test(k)) out.push(`#${k}`, `.${k}`);
  }
  return out;
}

// Walks the fetched subtree and collects the layers worth mapping. Invisible and
// unnamed layers are skipped; the root itself is included (it is usually the
// component the caller pointed at).
export function collectMappableNodes(nodeData: any, nodeId?: string, limit = MAX_AUTO_MAP): MappableNode[] {
  const { node: root } = resolveFigmaNode(nodeData, nodeId);
  const out: MappableNode[] = [];

  const walk = (n: AnyRec) => {
    if (!n || typeof n !== "object" || out.length >= limit) return;
    const id = typeof n.id === "string" ? n.id : null;
    const name = typeof n.name === "string" ? n.name.trim() : "";
    if (id && name && n.visible !== false && MAPPABLE_TYPES.includes(n.type)) {
      const text = typeof n.characters === "string" ? n.characters.trim()
        : typeof n.text === "string" ? n.text.trim() : undefined;
      out.push({
        figmaNodeId: id, name, type: n.type,
        ...(n.type === "TEXT" && text ? { text } : {}),
        selectors: selectorCandidates(name, id),
      });
    }
    for (const c of n.children ?? []) walk(c);
  };

  walk(root);
  return out;
}

// Resolves each candidate layer to a concrete element and hands back a CSS path
// that querySelector can re-find, so the diff pass reuses the normal pair flow.
// A candidate that matches zero or several elements is rejected — a guessed
// selector that hits the wrong element is worse than an honest "unmapped".
export function buildAutoMapScript(nodes: MappableNode[]): string {
  // U+2028/2029 are legal inside a JSON string but were line terminators in JS
  // source before ES2019: left raw, a layer name containing one could break the
  // expression we hand to browser_evaluate. Escaped to their \u form, which is
  // what the JSON string needs to survive being embedded as JS source.
  const payload = JSON.stringify(nodes.map(n => ({ id: n.figmaNodeId, selectors: n.selectors, text: n.text })))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `(() => {
    const items = ${payload};
    const path = (el) => {
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
        let part = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
        }
        parts.unshift(part);
        el = el.parentElement;
      }
      return parts.join(' > ');
    };
    const out = {};
    for (const item of items) {
      let el = null;
      for (const sel of item.selectors) {
        let found;
        try { found = document.querySelectorAll(sel); } catch { continue; }
        if (found.length === 1) { el = found[0]; break; }
      }
      if (!el && item.text) {
        const hits = Array.from(document.querySelectorAll('body *'))
          .filter(e => e.children.length === 0 && e.textContent.trim() === item.text);
        if (hits.length === 1) el = hits[0];
      }
      out[item.id] = el ? path(el) : null;
    }
    return out;
  })()`;
}
