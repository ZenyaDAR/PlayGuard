process.env.PLAYGUARD_NO_SERVE = "1";
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  figmaColorToCSS, parseCSSColor, parseHexColor, normalizePadding, normalizeBorderRadius,
  parseBoxShorthand, firstFontFamily, normalizeFontWeight, resolveFigmaNode,
  extractFigmaProperties, buildBrowserEvalScript, normalizeBrowserResponse,
  compareProperties, formatDiffResult, formatBatchResult,
  autoSelectProperties, selectorCandidates, collectMappableNodes, buildAutoMapScript,
  isFramelinkShape, findTextDescendant, hasKnownDefault,
  BIG_FIVE, ALL_PROPERTIES, MAX_AUTO_MAP,
} = await import("../dist/design-diff.js");

// ── figmaColorToCSS ──────────────────────────────────────────────────────
test("figmaColorToCSS: converts RGBA 0–1 to rgb() string", () => {
  assert.equal(figmaColorToCSS({ r: 0.1, g: 0.1, b: 0.1, a: 1 }), "rgb(26, 26, 26)");
  assert.equal(figmaColorToCSS({ r: 1, g: 1, b: 1, a: 1 }), "rgb(255, 255, 255)");
  assert.equal(figmaColorToCSS({ r: 0, g: 0, b: 0, a: 1 }), "rgb(0, 0, 0)");
});

test("figmaColorToCSS: includes alpha when < 1", () => {
  assert.equal(figmaColorToCSS({ r: 0, g: 0, b: 0, a: 0.5 }), "rgba(0, 0, 0, 0.5)");
});

test("figmaColorToCSS: handles missing alpha as 1", () => {
  assert.equal(figmaColorToCSS({ r: 0.5, g: 0.5, b: 0.5 }), "rgb(128, 128, 128)");
});

// ── parseCSSColor ────────────────────────────────────────────────────────
test("parseCSSColor: parses rgb() format", () => {
  assert.deepEqual(parseCSSColor("rgb(26, 26, 26)"), { r: 26, g: 26, b: 26, a: 1 });
});

test("parseCSSColor: parses rgba() format", () => {
  assert.deepEqual(parseCSSColor("rgba(0, 0, 0, 0.25)"), { r: 0, g: 0, b: 0, a: 0.25 });
});

test("parseCSSColor: returns null for non-color strings", () => {
  assert.equal(parseCSSColor("16px"), null);
});

// ── normalizePadding / normalizeBorderRadius ────────────────────────────
test("normalizePadding: always emits 4 explicit values", () => {
  assert.equal(normalizePadding(12, 24, 12, 24), "12px 24px 12px 24px");
});

test("normalizeBorderRadius: always emits 4 explicit values", () => {
  assert.equal(normalizeBorderRadius(8, 4, 8, 4), "8px 4px 8px 4px");
});

// ── extractFigmaProperties (Raw API) ─────────────────────────────────────
test("extractFigmaProperties: extracts fontSize from raw API format", () => {
  const node = { style: { fontSize: 16 } };
  const result = extractFigmaProperties(node, ["fontSize"]);
  assert.equal(result.fontSize, "16px");
});

test("extractFigmaProperties: extracts color from fills array", () => {
  const node = { fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }] };
  const result = extractFigmaProperties(node, ["backgroundColor"]);
  assert.equal(result.backgroundColor, "rgb(26, 26, 26)");
});

test("extractFigmaProperties: text color prefers a TEXT child's fill over the container's", () => {
  const node = {
    type: "FRAME",
    fills: [{ type: "SOLID", color: { r: 0.098, g: 0.463, b: 0.824, a: 1 } }],
    children: [{ type: "TEXT", fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] }],
  };
  const result = extractFigmaProperties(node, ["color", "backgroundColor"]);
  assert.equal(result.color, "rgb(255, 255, 255)");
  assert.equal(result.backgroundColor, "rgb(25, 118, 210)");
});

test("extractFigmaProperties: extracts padding from individual properties", () => {
  const node = { paddingTop: 24, paddingRight: 16, paddingBottom: 24, paddingLeft: 16 };
  const result = extractFigmaProperties(node, ["padding"]);
  assert.equal(result.padding, "24px 16px 24px 16px");
});

test("extractFigmaProperties: extracts uniform borderRadius", () => {
  const node = { cornerRadius: 8 };
  const result = extractFigmaProperties(node, ["borderRadius"]);
  assert.equal(result.borderRadius, "8px");
});

test("extractFigmaProperties: extracts per-corner borderRadius", () => {
  const node = { topLeftRadius: 8, topRightRadius: 4, bottomRightRadius: 8, bottomLeftRadius: 4 };
  const result = extractFigmaProperties(node, ["borderRadius"]);
  assert.equal(result.borderRadius, "8px 4px 8px 4px");
});

test("extractFigmaProperties: returns null for missing properties", () => {
  const result = extractFigmaProperties({}, ["fontSize"]);
  assert.equal(result.fontSize, null);
});

test("extractFigmaProperties: unwraps a top-level 'document' envelope (Raw REST API shape)", () => {
  const result = extractFigmaProperties({ document: { style: { fontSize: 16 } } }, ["fontSize"]);
  assert.equal(result.fontSize, "16px");
});

// ── buildBrowserEvalScript ────────────────────────────────────────────────
test("buildBrowserEvalScript: escapes single quotes in the selector", () => {
  const script = buildBrowserEvalScript("[data-testid='login-btn']", ["fontSize"]);
  assert.match(script, /\[data-testid=\\'login-btn\\'\]/);
});

test("buildBrowserEvalScript: drops properties outside the known whitelist", () => {
  const script = buildBrowserEvalScript("#x", ["fontSize", "}); alert(1); ({"]);
  assert.doesNotMatch(script, /alert\(1\)/);
  assert.match(script, /fontSize: s\.fontSize/);
});

test("buildBrowserEvalScript: expands padding/borderRadius into per-side reads", () => {
  const script = buildBrowserEvalScript("#x", ["padding", "borderRadius"]);
  assert.match(script, /paddingTop: s\.paddingTop/);
  assert.match(script, /borderTopLeftRadius: s\.borderTopLeftRadius/);
});

// ── normalizeBrowserResponse ──────────────────────────────────────────────
test("normalizeBrowserResponse: merges per-side padding into one string", () => {
  const result = normalizeBrowserResponse(
    { paddingTop: "12px", paddingRight: "24px", paddingBottom: "12px", paddingLeft: "24px" },
    ["padding"],
  );
  assert.equal(result.padding, "12px 24px 12px 24px");
});

test("normalizeBrowserResponse: passes simple properties through as strings", () => {
  const result = normalizeBrowserResponse({ fontSize: "16px" }, ["fontSize"]);
  assert.equal(result.fontSize, "16px");
});

test("normalizeBrowserResponse: reads width/height from the serialized rect", () => {
  const result = normalizeBrowserResponse({ _rect: JSON.stringify({ width: 198.5, height: 48 }) }, ["width", "height"]);
  assert.equal(result.width, "198.5px");
  assert.equal(result.height, "48px");
});

// ── compareProperties ──────────────────────────────────────────────────────
test("compareProperties: exact match", () => {
  const result = compareProperties({ fontSize: "16px" }, { fontSize: "16px" }, 2, 5);
  assert.equal(result.matches, 1);
  assert.equal(result.mismatches, 0);
});

test("compareProperties: pixel tolerance allows small differences", () => {
  const result = compareProperties({ fontSize: "16px" }, { fontSize: "15px" }, 2, 5);
  assert.equal(result.matches, 1);
  assert.equal(result.comparisons[0].withinTolerance, true);
});

test("compareProperties: pixel difference beyond tolerance is a mismatch", () => {
  const result = compareProperties({ fontSize: "16px" }, { fontSize: "12px" }, 2, 5);
  assert.equal(result.mismatches, 1);
});

test("compareProperties: color tolerance per-channel", () => {
  const result = compareProperties({ color: "rgb(26, 26, 26)" }, { color: "rgb(28, 28, 28)" }, 2, 5);
  assert.equal(result.matches, 1); // Δ=2 ≤ 5
});

test("compareProperties: color beyond tolerance is mismatch", () => {
  const result = compareProperties({ color: "rgb(26, 26, 26)" }, { color: "rgb(51, 51, 51)" }, 2, 5);
  assert.equal(result.mismatches, 1); // Δ=25 > 5
});

test("compareProperties: null figma value is skipped", () => {
  const result = compareProperties({ color: null }, { color: "rgb(0,0,0)" }, 2, 5);
  assert.equal(result.skipped, 1);
});

test("compareProperties: both null is skipped without a comparison entry", () => {
  const result = compareProperties({ borderRadius: null }, { borderRadius: null }, 2, 5);
  assert.equal(result.skipped, 1);
  assert.equal(result.comparisons.length, 0);
});

// ── formatDiffResult ───────────────────────────────────────────────────────
test("formatDiffResult: produces header with match/mismatch counts", () => {
  const result = {
    matches: 2, mismatches: 1, skipped: 0,
    comparisons: [
      { property: "fontSize", figmaValue: "16px", browserValue: "14px", match: false, delta: "+2px" },
      { property: "color", figmaValue: "rgb(0,0,0)", browserValue: "rgb(0,0,0)", match: true },
      { property: "padding", figmaValue: "24px", browserValue: "24px", match: true },
    ],
    warnings: [],
  };
  const output = formatDiffResult(result);
  assert.match(output, /1 mismatch/);
  assert.match(output, /2 matches/);
  assert.match(output, /MISMATCH/);
  assert.match(output, /MATCH/);
});

test("formatDiffResult: includes viewport when present", () => {
  const result = { matches: 0, mismatches: 0, skipped: 0, comparisons: [], warnings: [], viewport: { width: 1440, height: 900 } };
  assert.match(formatDiffResult(result), /1440×900/);
});

// ── BIG_FIVE / ALL_PROPERTIES ────────────────────────────────────────────
test("BIG_FIVE is the MVP property set, a subset of ALL_PROPERTIES", () => {
  assert.deepEqual(BIG_FIVE, ["fontSize", "color", "backgroundColor", "padding", "borderRadius"]);
  for (const p of BIG_FIVE) assert.ok(ALL_PROPERTIES.includes(p));
});

// ══ Phase 2 ══════════════════════════════════════════════════════════════

// ── parseBoxShorthand ────────────────────────────────────────────────────
test("parseBoxShorthand: expands 1/2/3/4-value CSS box shorthands", () => {
  assert.deepEqual(parseBoxShorthand("8px"), [8, 8, 8, 8]);
  assert.deepEqual(parseBoxShorthand("24px 16px"), [24, 16, 24, 16]);
  assert.deepEqual(parseBoxShorthand("1px 2px 3px"), [1, 2, 3, 2]);
  assert.deepEqual(parseBoxShorthand("1px 2px 3px 4px"), [1, 2, 3, 4]);
});

test("parseBoxShorthand: rejects junk and over-long lists", () => {
  assert.equal(parseBoxShorthand("none"), null);
  assert.equal(parseBoxShorthand("1px 2px 3px 4px 5px"), null);
});

// ── Box comparison is per side/corner, not first-value-only ──────────────
test("compareProperties: borderRadius differing only on later corners is a MISMATCH", () => {
  // Regression: a first-value-only parseFloat compare called these equal.
  const result = compareProperties(
    { borderRadius: "8px 8px 8px 8px" }, { borderRadius: "8px 8px 0px 0px" }, 2, 5,
  );
  assert.equal(result.mismatches, 1);
  assert.match(result.comparisons[0].delta, /Δbr:\+8px/);
  assert.match(result.comparisons[0].delta, /Δbl:\+8px/);
});

test("compareProperties: uniform Figma radius matches the browser's 4 explicit corners", () => {
  const result = compareProperties(
    { borderRadius: "8px" }, { borderRadius: "8px 8px 8px 8px" }, 2, 5,
  );
  assert.equal(result.matches, 1);
});

test("compareProperties: padding within tolerance on every side is a match", () => {
  const result = compareProperties(
    { padding: "12px 24px 12px 24px" }, { padding: "13px 24px 12px 24px" }, 2, 5,
  );
  assert.equal(result.matches, 1);
});

test("compareProperties: padding beyond tolerance on one side is a mismatch", () => {
  const result = compareProperties(
    { padding: "12px 24px 12px 24px" }, { padding: "12px 24px 12px 4px" }, 2, 5,
  );
  assert.equal(result.mismatches, 1);
  assert.match(result.comparisons[0].delta, /Δleft:\+20px/);
});

// ── Unitless properties do not inherit the px tolerance ──────────────────
test("compareProperties: opacity is not matched by the 2px tolerance", () => {
  const result = compareProperties({ opacity: "1" }, { opacity: "0.5" }, 2, 5);
  assert.equal(result.mismatches, 1);
  assert.equal(result.comparisons[0].delta, "+0.5");
});

test("compareProperties: fontWeight is compared exactly, not with the px tolerance", () => {
  assert.equal(compareProperties({ fontWeight: "400" }, { fontWeight: "401" }, 2, 5).mismatches, 1);
  assert.equal(compareProperties({ fontWeight: "600" }, { fontWeight: "600" }, 2, 5).matches, 1);
});

test("compareProperties: fontFamily compares case-insensitively", () => {
  const result = compareProperties({ fontFamily: "Inter" }, { fontFamily: "inter" }, 2, 5);
  assert.equal(result.matches, 1);
});

test("compareProperties: width/height carry a viewport warning", () => {
  const result = compareProperties({ width: "200px" }, { width: "200px" }, 2, 5);
  assert.equal(result.matches, 1);
  assert.match(result.warnings[0], /viewport/);
});

// ── fontFamily / fontWeight normalization ─────────────────────────────────
test("firstFontFamily: takes the first family and strips quotes", () => {
  assert.equal(firstFontFamily("Inter, sans-serif"), "Inter");
  assert.equal(firstFontFamily('"SF Pro Text", -apple-system'), "SF Pro Text");
});

test("normalizeFontWeight: maps Figma style names to CSS numbers", () => {
  assert.equal(normalizeFontWeight("SemiBold"), "600");
  assert.equal(normalizeFontWeight("Extra Bold"), "800");
  assert.equal(normalizeFontWeight("Regular"), "400");
});

test("normalizeFontWeight: passes numbers and numeric strings through", () => {
  assert.equal(normalizeFontWeight(600), "600");
  assert.equal(normalizeFontWeight("600"), "600");
});

test("normalizeFontWeight: returns null for an unmappable value", () => {
  assert.equal(normalizeFontWeight("Chonky"), null);
  assert.equal(normalizeFontWeight(undefined), null);
});

// ── Phase 2 extractors (Raw REST API) ─────────────────────────────────────
test("extractFigmaProperties: fontFamily takes the Figma family name", () => {
  const r = extractFigmaProperties({ style: { fontFamily: "Inter" } }, ["fontFamily"]);
  assert.equal(r.fontFamily, "Inter");
});

test("extractFigmaProperties: fontWeight from the numeric style field", () => {
  const r = extractFigmaProperties({ style: { fontWeight: 600 } }, ["fontWeight"]);
  assert.equal(r.fontWeight, "600");
});

test("extractFigmaProperties: lineHeight from lineHeightPx", () => {
  const r = extractFigmaProperties({ style: { fontSize: 16, lineHeightPx: 24 } }, ["lineHeight"]);
  assert.equal(r.lineHeight, "24px");
});

test("extractFigmaProperties: lineHeight resolves FONT_SIZE_% against fontSize", () => {
  const r = extractFigmaProperties(
    { style: { fontSize: 16, lineHeightPercent: 150, lineHeightUnit: "FONT_SIZE_%" } }, ["lineHeight"],
  );
  assert.equal(r.lineHeight, "24px");
});

test("extractFigmaProperties: lineHeight is null when only INTRINSIC_% is available", () => {
  const r = extractFigmaProperties(
    { style: { fontSize: 16, lineHeightPercent: 100, lineHeightUnit: "INTRINSIC_%" } }, ["lineHeight"],
  );
  assert.equal(r.lineHeight, null);
});

test("extractFigmaProperties: letterSpacing in px and as a PERCENT of fontSize", () => {
  assert.equal(extractFigmaProperties({ style: { letterSpacing: 0.5 } }, ["letterSpacing"]).letterSpacing, "0.5px");
  const pct = extractFigmaProperties(
    { style: { fontSize: 16, letterSpacing: { value: 5, unit: "PERCENT" } } }, ["letterSpacing"],
  );
  assert.equal(pct.letterSpacing, "0.8px");
});

test("extractFigmaProperties: boxShadow renders a DROP_SHADOW in CSS computed order", () => {
  const node = {
    effects: [{
      type: "DROP_SHADOW", visible: true,
      color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0,
    }],
  };
  const r = extractFigmaProperties(node, ["boxShadow"]);
  assert.equal(r.boxShadow, "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px");
});

test("extractFigmaProperties: boxShadow marks INNER_SHADOW inset, joins multiples, skips hidden", () => {
  const node = {
    effects: [
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4 },
      { type: "INNER_SHADOW", color: { r: 1, g: 1, b: 1, a: 1 }, offset: { x: 0, y: 1 }, radius: 0 },
      { type: "DROP_SHADOW", visible: false, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 9, y: 9 }, radius: 9 },
      { type: "LAYER_BLUR", radius: 4 },
    ],
  };
  const r = extractFigmaProperties(node, ["boxShadow"]);
  assert.equal(r.boxShadow, "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px, rgb(255, 255, 255) 0px 1px 0px 0px inset");
});

test("extractFigmaProperties: boxShadow is null when the node has no shadow effects", () => {
  assert.equal(extractFigmaProperties({ effects: [] }, ["boxShadow"]).boxShadow, null);
});

test("extractFigmaProperties: opacity and width/height", () => {
  const node = { opacity: 0.87, absoluteBoundingBox: { x: 1, y: 2, width: 200, height: 48 } };
  const r = extractFigmaProperties(node, ["opacity", "width", "height"]);
  assert.equal(r.opacity, "0.87");
  assert.equal(r.width, "200px");
  assert.equal(r.height, "48px");
});

test("extractFigmaProperties: skips an invisible fill when picking the solid color", () => {
  const node = {
    fills: [
      { type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0, a: 1 } },
      { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } },
    ],
  };
  assert.equal(extractFigmaProperties(node, ["backgroundColor"]).backgroundColor, "rgb(0, 0, 255)");
});

// ── resolveFigmaNode: upstream envelopes ─────────────────────────────────
test("resolveFigmaNode: unwraps the raw REST nodes-by-id map and picks the requested node", () => {
  const data = {
    nodes: {
      "42:1337": { document: { id: "42:1337", name: "Button" } },
      "42:9999": { document: { id: "42:9999", name: "Other" } },
    },
  };
  assert.equal(resolveFigmaNode(data, "42:1337").node.name, "Button");
  // Figma accepts both "42-1337" and "42:1337" and agents emit both.
  assert.equal(resolveFigmaNode(data, "42-1337").node.name, "Button");
});

test("resolveFigmaNode: picks the requested node out of a Framelink nodes array", () => {
  const data = { nodes: [{ id: "1:1", name: "A" }, { id: "42:1337", name: "B" }], globalVars: { styles: {} } };
  assert.equal(resolveFigmaNode(data, "42:1337").node.name, "B");
});

test("resolveFigmaNode: exposes globalVars for ref resolution", () => {
  const data = { nodes: [{ id: "1:1" }], globalVars: { styles: { fill_A: ["#FFF"] } } };
  assert.deepEqual(resolveFigmaNode(data, "1:1").globalVars.styles.fill_A, ["#FFF"]);
});

// ── Framelink adapter ────────────────────────────────────────────────────
const FRAMELINK = {
  nodes: [{
    id: "42:1337",
    name: "Login Button",
    type: "FRAME",
    dimensions: { width: 200, height: 48 },
    fills: "fill_PRIMARY",          // ref into globalVars
    layout: "layout_CENTER",        // ref into globalVars
    borderRadius: "8px",
    opacity: 0.9,
    styles: {
      typography: {
        fontSize: 16, fontFamily: "Inter", fontWeight: 600,
        lineHeight: "1.5em", letterSpacing: "0.5px",
      },
    },
    children: [{ id: "42:1338", type: "TEXT", styles: { fills: ["#FFFFFF"] } }],
  }],
  globalVars: {
    styles: {
      fill_PRIMARY: ["#1976D2"],
      layout_CENTER: { mode: "row", padding: "12px 24px" },
    },
  },
};

test("Framelink: resolves a globalVars fill ref into a CSS color", () => {
  const r = extractFigmaProperties(FRAMELINK, ["backgroundColor"], "42:1337");
  assert.equal(r.backgroundColor, "rgb(25, 118, 210)");
});

test("Framelink: resolves a globalVars layout ref into padding", () => {
  const r = extractFigmaProperties(FRAMELINK, ["padding"], "42:1337");
  assert.equal(r.padding, "12px 24px 12px 24px");
});

test("Framelink: text color comes from the TEXT child's inline fills", () => {
  const r = extractFigmaProperties(FRAMELINK, ["color"], "42:1337");
  assert.equal(r.color, "rgb(255, 255, 255)");
});

test("Framelink: typography — fontSize, fontFamily, fontWeight", () => {
  const r = extractFigmaProperties(FRAMELINK, ["fontSize", "fontFamily", "fontWeight"], "42:1337");
  assert.equal(r.fontSize, "16px");
  assert.equal(r.fontFamily, "Inter");
  assert.equal(r.fontWeight, "600");
});

test("Framelink: em lineHeight resolves against fontSize", () => {
  const r = extractFigmaProperties(FRAMELINK, ["lineHeight"], "42:1337");
  assert.equal(r.lineHeight, "24px");
});

test("Framelink: px letterSpacing, borderRadius, opacity, dimensions", () => {
  const r = extractFigmaProperties(FRAMELINK, ["letterSpacing", "borderRadius", "opacity", "width", "height"], "42:1337");
  assert.equal(r.letterSpacing, "0.5px");
  assert.equal(r.borderRadius, "8px 8px 8px 8px");
  assert.equal(r.opacity, "0.9");
  assert.equal(r.width, "200px");
  assert.equal(r.height, "48px");
});

test("Framelink: a gradient fill (object, not hex) yields no backgroundColor", () => {
  const data = { nodes: [{ id: "1:1", styles: { fills: [{ type: "GRADIENT_LINEAR" }] } }], globalVars: { styles: {} } };
  assert.equal(extractFigmaProperties(data, ["backgroundColor"], "1:1").backgroundColor, null);
});

test("parseHexColor: handles 3-, 6- and 8-digit hex", () => {
  assert.deepEqual(parseHexColor("#FFF"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseHexColor("#1976D2"), { r: 25, g: 118, b: 210, a: 1 });
  assert.equal(parseHexColor("#00000080").a, 128 / 255);
});

// ── Browser normalization of the Phase 2 properties ──────────────────────
test("normalizeBrowserResponse: fontFamily → first family, fontWeight → number", () => {
  const r = normalizeBrowserResponse({ fontFamily: "Inter, sans-serif", fontWeight: "600" }, ["fontFamily", "fontWeight"]);
  assert.equal(r.fontFamily, "Inter");
  assert.equal(r.fontWeight, "600");
});

test("normalizeBrowserResponse: letterSpacing 'normal' is 0px, matching Figma's 0", () => {
  const r = normalizeBrowserResponse({ letterSpacing: "normal" }, ["letterSpacing"]);
  assert.equal(r.letterSpacing, "0px");
  const figma = extractFigmaProperties({ style: { letterSpacing: 0 } }, ["letterSpacing"]);
  assert.equal(compareProperties(figma, r, 2, 5).matches, 1);
});

// ── End-to-end: the plan's Login Button scenario (§4.1) ──────────────────
test("end-to-end: the Login Button design and its implementation fully match", () => {
  const figmaNode = {
    document: {
      id: "42:1337", name: "Login Button", type: "FRAME",
      fills: [{ type: "SOLID", color: { r: 0.098, g: 0.463, b: 0.824, a: 1 } }],
      cornerRadius: 8,
      paddingTop: 12, paddingRight: 24, paddingBottom: 12, paddingLeft: 24,
      style: { fontSize: 16, fontFamily: "Inter", fontWeight: 600 },
      children: [{ id: "42:1338", type: "TEXT", fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] }],
    },
  };
  const browserRaw = {
    fontSize: "16px", color: "rgb(255, 255, 255)", backgroundColor: "rgb(25, 118, 210)",
    paddingTop: "12px", paddingRight: "24px", paddingBottom: "12px", paddingLeft: "24px",
    borderTopLeftRadius: "8px", borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px", borderBottomLeftRadius: "8px",
  };
  const diff = compareProperties(
    extractFigmaProperties(figmaNode, BIG_FIVE),
    normalizeBrowserResponse(browserRaw, BIG_FIVE),
    2, 5,
  );
  assert.equal(diff.matches, 5);
  assert.equal(diff.mismatches, 0);
});

// ── Batch formatting ─────────────────────────────────────────────────────
test("formatBatchResult: totals across pairs and labels each block", () => {
  const results = [
    {
      label: "42:1337 → #a", matches: 2, mismatches: 1, skipped: 0, warnings: [],
      comparisons: [{ property: "fontSize", figmaValue: "16px", browserValue: "14px", match: false, delta: "+2px" }],
    },
    {
      label: "42:1400 → #b", matches: 3, mismatches: 0, skipped: 0, warnings: [],
      comparisons: [{ property: "color", figmaValue: "rgb(0, 0, 0)", browserValue: "rgb(0, 0, 0)", match: true }],
    },
  ];
  const out = formatBatchResult(results);
  assert.match(out, /2 elements, 1 mismatch, 5 matches/);
  assert.match(out, /42:1337 → #a/);
  assert.match(out, /42:1400 → #b/);
});

test("formatBatchResult: a failed pair is counted and rendered without sinking the others", () => {
  const results = [
    { label: "42:1337 → #missing", matches: 0, mismatches: 0, skipped: 0, comparisons: [], warnings: [], error: "Element not found: #missing" },
    { label: "42:1400 → #b", matches: 1, mismatches: 0, skipped: 0, warnings: [], comparisons: [{ property: "opacity", figmaValue: "1", browserValue: "1", match: true }] },
  ];
  const out = formatBatchResult(results);
  assert.match(out, /1 failed/);
  assert.match(out, /ERROR.*Element not found/);
  assert.match(out, /1 match/);
});

// ══ Phase 3 ══════════════════════════════════════════════════════════════

// ── autoSelectProperties: type-aware, drops what the node doesn't define ──
test("autoSelectProperties: a TEXT node gets typography, never background/padding/radius", () => {
  const node = {
    type: "TEXT",
    style: { fontSize: 16, fontFamily: "Inter", fontWeight: 400 },
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
  };
  const props = autoSelectProperties(node);
  assert.deepEqual(props,
    ["fontSize", "color", "fontFamily", "fontWeight", "opacity", "letterSpacing", "textDecoration", "textTransform"]);
  assert.ok(!props.includes("backgroundColor"));
  assert.ok(!props.includes("padding"));
});

test("a TEXT node's fill is its color, never a backgroundColor", () => {
  // The DOM <span> has a transparent background — comparing the glyph color
  // against it would be a guaranteed false mismatch.
  const node = { type: "TEXT", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] };
  const extracted = extractFigmaProperties(node, ["color", "backgroundColor"]);
  assert.equal(extracted.color, "rgb(0, 0, 0)");
  assert.equal(extracted.backgroundColor, null);
});

test("autoSelectProperties: a button FRAME gets both container and text properties", () => {
  const node = {
    type: "FRAME",
    fills: [{ type: "SOLID", color: { r: 0.1, g: 0.4, b: 0.8, a: 1 } }],
    cornerRadius: 8,
    paddingTop: 12, paddingRight: 24, paddingBottom: 12, paddingLeft: 24,
    style: { fontSize: 16 },
    children: [{ type: "TEXT", fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] }],
  };
  // Every property with a known CSS zero-default rides along unset: no shadow/
  // border/weight/etc in the design still needs checking against a stray
  // browser value (see hasKnownDefault). `margin` is absent by design — Figma
  // cannot express it, so it is unknowable rather than known-zero.
  assert.deepEqual(autoSelectProperties(node), [
    "fontSize", "color", "backgroundColor", "padding", "borderRadius", "fontWeight",
    "boxShadow", "opacity", "letterSpacing", "borderWidth", "borderStyle",
    "gap", "textDecoration", "textTransform",
  ]);
});

test("autoSelectProperties: a plain container with no text gets no typography", () => {
  assert.deepEqual(autoSelectProperties({ type: "FRAME", cornerRadius: 4, children: [] }), [
    "backgroundColor", "padding", "borderRadius", "boxShadow", "opacity", "borderWidth", "borderStyle", "gap",
  ]);
});

test("autoSelectProperties: never auto-selects the viewport-dependent width/height", () => {
  const node = { type: "FRAME", cornerRadius: 4, absoluteBoundingBox: { width: 200, height: 48 } };
  const props = autoSelectProperties(node);
  assert.ok(!props.includes("width"));
  assert.ok(!props.includes("height"));
});

test("autoSelectProperties: a node defining nothing comparable still checks the must-check visual props", () => {
  assert.deepEqual(autoSelectProperties({ type: "FRAME" }), [
    "backgroundColor", "padding", "borderRadius", "boxShadow", "opacity", "borderWidth", "borderStyle", "gap",
  ]);
});

// ── resolveFigmaNode: deep lookup (one fetch, many descendants) ───────────
test("resolveFigmaNode: finds a descendant by id inside the parent's subtree", () => {
  const tree = {
    document: {
      id: "42:1", type: "FRAME", name: "Card",
      children: [{ id: "42:2", type: "FRAME", children: [{ id: "42:3", type: "TEXT", name: "Title" }] }],
    },
  };
  assert.equal(resolveFigmaNode(tree, "42:3").node.name, "Title");
  assert.equal(resolveFigmaNode(tree, "42-3").node.name, "Title");
});

// ── selectorCandidates ───────────────────────────────────────────────────
test("selectorCandidates: data-figma-id first, then testid/id/class from the name", () => {
  assert.deepEqual(selectorCandidates("Login Button", "42:1337"), [
    '[data-figma-id="42:1337"]',
    '[data-testid="Login Button"]',
    '[data-testid="login-button"]',
    "#login-button",
    ".login-button",
  ]);
});

test("selectorCandidates: skips #id/.class when the kebab name starts with a digit", () => {
  const out = selectorCandidates("2x Grid", "1:1");
  assert.ok(!out.some(s => s.startsWith("#") || s.startsWith(".")));
  assert.ok(out.includes('[data-testid="2x-grid"]'));
});

test("selectorCandidates: a name containing a quote never yields a broken attribute selector", () => {
  const out = selectorCandidates('He said "hi"', "1:1");
  assert.ok(out.every(s => !s.includes('"hi"')));
  assert.ok(out.includes('[data-testid="he-said-hi"]'));
});

// ── collectMappableNodes ─────────────────────────────────────────────────
const CARD = {
  document: {
    id: "1:0", name: "Card", type: "FRAME",
    children: [
      { id: "1:1", name: "Title", type: "TEXT", characters: "Hello" },
      { id: "1:2", name: "Icon", type: "VECTOR" },                      // not mappable
      { id: "1:3", name: "Hidden", type: "FRAME", visible: false },     // skipped
      { id: "1:4", type: "FRAME" },                                     // unnamed, skipped
      {
        id: "1:5", name: "Save Button", type: "INSTANCE",
        children: [{ id: "1:6", name: "Label", type: "TEXT", characters: "Save" }],
      },
    ],
  },
};

test("collectMappableNodes: walks the subtree, keeping named visible mappable layers", () => {
  assert.deepEqual(collectMappableNodes(CARD, "1:0").map(n => n.figmaNodeId), ["1:0", "1:1", "1:5", "1:6"]);
});

test("collectMappableNodes: TEXT layers carry their text for the fallback match", () => {
  const nodes = collectMappableNodes(CARD, "1:0");
  assert.equal(nodes.find(n => n.figmaNodeId === "1:1").text, "Hello");
  assert.equal(nodes.find(n => n.figmaNodeId === "1:0").text, undefined); // containers have no text to match on
});

test("collectMappableNodes: honours the cap", () => {
  const many = {
    document: {
      id: "9:0", name: "Root", type: "FRAME",
      children: Array.from({ length: 50 }, (_, i) => ({ id: `9:${i + 1}`, name: `Row ${i}`, type: "FRAME" })),
    },
  };
  assert.equal(collectMappableNodes(many, "9:0").length, MAX_AUTO_MAP);
  assert.equal(collectMappableNodes(many, "9:0", 3).length, 3);
});

// ── buildAutoMapScript, run against a minimal fake DOM ────────────────────
// This script is what actually decides which DOM element a Figma layer maps to,
// so it gets executed rather than string-matched.
function fakeDom(root) {
  const all = [];
  const link = (node, parent) => {
    node.nodeType = 1;
    node.parentElement = parent ?? null;
    node.children = node.children ?? [];
    node.attrs = node.attrs ?? {};
    node.id = node.attrs.id ?? "";   // real elements expose id as a property
    all.push(node);
    for (const c of node.children) link(c, node);
    return node;
  };
  const html = link(root, null);
  const textOf = n => (n.children.length ? n.children.map(textOf).join("") : (n.text ?? ""));
  for (const n of all) Object.defineProperty(n, "textContent", { get: () => textOf(n) });

  const matches = (el, sel) => {
    let m;
    if ((m = sel.match(/^\[([\w-]+)="(.*)"\]$/))) return el.attrs[m[1]] === m[2];
    if ((m = sel.match(/^#(.+)$/))) return el.attrs.id === m[1];
    if ((m = sel.match(/^\.(.+)$/))) return (el.attrs.class ?? "").split(/\s+/).includes(m[1]);
    if (sel === "body *") return el !== html;
    throw new Error("unsupported selector: " + sel);
  };
  return {
    document: { documentElement: html, querySelectorAll: sel => all.filter(el => matches(el, sel)) },
    CSS: { escape: s => s },
  };
}

function runAutoMap(nodes, root) {
  const { document, CSS } = fakeDom(root);
  return new Function("document", "CSS", "return " + buildAutoMapScript(nodes))(document, CSS);
}

const mappable = (id, name, type = "FRAME", text) => ({
  figmaNodeId: id, name, type, ...(text ? { text } : {}), selectors: selectorCandidates(name, id),
});

test("buildAutoMapScript: resolves a layer by data-testid to a re-queryable CSS path", () => {
  const root = { tagName: "HTML", children: [{ tagName: "BUTTON", attrs: { "data-testid": "login-button" }, text: "Login" }] };
  assert.equal(runAutoMap([mappable("42:1", "Login Button")], root)["42:1"], "button");
});

test("buildAutoMapScript: data-figma-id wins over the name-based guesses", () => {
  const root = {
    tagName: "HTML",
    children: [
      { tagName: "DIV", attrs: { "data-testid": "login-button" } },
      { tagName: "BUTTON", attrs: { "data-figma-id": "42:1" } },
    ],
  };
  assert.equal(runAutoMap([mappable("42:1", "Login Button")], root)["42:1"], "button");
});

test("buildAutoMapScript: an ambiguous selector is rejected rather than guessed", () => {
  const root = {
    tagName: "HTML",
    children: [{ tagName: "DIV", attrs: { class: "row" } }, { tagName: "DIV", attrs: { class: "row" } }],
  };
  assert.equal(runAutoMap([mappable("7:1", "Row")], root)["7:1"], null);
});

test("buildAutoMapScript: a TEXT layer falls back to an exact unique text match", () => {
  const root = {
    tagName: "HTML",
    children: [{ tagName: "DIV", children: [{ tagName: "H1", text: "Hello" }, { tagName: "P", text: "Other" }] }],
  };
  assert.equal(runAutoMap([mappable("1:1", "Title", "TEXT", "Hello")], root)["1:1"], "div > h1");
});

test("buildAutoMapScript: the CSS path disambiguates like-tagged siblings by position", () => {
  const root = {
    tagName: "HTML",
    children: [{ tagName: "UL", children: [{ tagName: "LI", text: "A" }, { tagName: "LI", text: "B" }] }],
  };
  assert.equal(runAutoMap([mappable("1:2", "Second", "TEXT", "B")], root)["1:2"], "ul > li:nth-of-type(2)");
});

test("buildAutoMapScript: an id short-circuits the path", () => {
  const root = { tagName: "HTML", children: [{ tagName: "DIV", attrs: { id: "save-btn", "data-figma-id": "3:1" } }] };
  assert.equal(runAutoMap([mappable("3:1", "Save Btn")], root)["3:1"], "#save-btn");
});

test("buildAutoMapScript: an unmatched layer resolves to null, not to a wrong element", () => {
  const root = { tagName: "HTML", children: [{ tagName: "DIV", attrs: { "data-testid": "something-else" } }] };
  assert.equal(runAutoMap([mappable("3:1", "Missing")], root)["3:1"], null);
});

// ── Upstream-shape detection (Framelink vs raw REST) ─────────────────────
// A REST node carrying a shared-style map used to be read as Framelink, which
// sent every extractor down the wrong path and returned null for everything.

const restTextNode = (extra = {}) => ({
  nodes: { "1:1": { document: {
    id: "1:1", type: "TEXT",
    style: { fontSize: 24, fontFamily: "Inter", fontWeight: 700 },
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 } }],
    ...extra,
  } } },
});

test("isFramelinkShape: a REST style-id map is not a Framelink signal", () => {
  assert.equal(isFramelinkShape({ type: "TEXT", styles: { text: "9:9" }, style: { fontSize: 24 } }), false);
  assert.equal(isFramelinkShape({ type: "FRAME", absoluteBoundingBox: { width: 1, height: 1 }, styles: { fill: "1:2" } }), false);
});

test("isFramelinkShape: real Framelink markers are still detected", () => {
  assert.equal(isFramelinkShape({ type: "TEXT" }, { globalVars: { styles: {} } }), true, "envelope");
  assert.equal(isFramelinkShape({ type: "TEXT", fills: "fill_PRIMARY" }), true, "globalVars ref");
  assert.equal(isFramelinkShape({ type: "FRAME", dimensions: { width: 1, height: 1 } }), true);
  assert.equal(isFramelinkShape({ type: "TEXT", styles: { typography: { fontSize: 12 } } }), true, "Framelink sections");
});

test("extractFigmaProperties: a REST node with a shared-style map still yields its values", () => {
  const props = ["fontSize", "fontFamily", "fontWeight", "color"];
  const withStyles = extractFigmaProperties(restTextNode({ styles: { text: "9:9" } }), props, "1:1");
  const control = extractFigmaProperties(restTextNode(), props, "1:1");
  assert.deepEqual(withStyles, control, "a shared style must not blank out every property");
  assert.equal(withStyles.fontSize, "24px");
  assert.equal(withStyles.color, "rgb(255, 0, 0)");
});

// ── Border colour ────────────────────────────────────────────────────────
test("extractFigmaProperties: a Framelink hex border colour is converted to rgb()", () => {
  const out = extractFigmaProperties({
    globalVars: { styles: {} },
    nodes: [{ id: "1:1", type: "FRAME", dimensions: { width: 10, height: 10 },
      borders: [{ width: 2, style: "SOLID", color: "#FF0000" }] }],
  }, ["borderWidth", "borderStyle", "borderColor"], "1:1");
  assert.deepEqual(out, { borderWidth: "2px", borderStyle: "solid", borderColor: "rgb(255, 0, 0)" });
});

test("compareProperties: borderColor gets the same colour tolerance as color", () => {
  const { comparisons } = compareProperties(
    { borderColor: "rgb(255, 0, 0)" }, { borderColor: "rgb(254, 0, 0)" }, 2, 5);
  assert.equal(comparisons[0].match, true, "a 1-unit channel difference is within a 5 tolerance");
});

test("compareProperties: borderColor beyond tolerance is still a mismatch", () => {
  const { comparisons } = compareProperties(
    { borderColor: "rgb(255, 0, 0)" }, { borderColor: "rgb(0, 0, 255)" }, 2, 5);
  assert.equal(comparisons[0].match, false);
});

// ── margin: unknowable, not known-zero ───────────────────────────────────
test("hasKnownDefault: margin is not a known default (Figma cannot express it)", () => {
  assert.equal(hasKnownDefault("margin"), false);
  assert.equal(hasKnownDefault("padding"), true);
});

test("compareProperties: a browser margin is reported as unknown, not as an extra style", () => {
  const { comparisons, mismatches, skipped } = compareProperties(
    { margin: null }, { margin: "8px 8px 8px 8px" }, 2, 5);
  assert.equal(mismatches, 0, "an ordinary CSS margin is not a design defect");
  assert.equal(skipped, 1);
  assert.equal(comparisons[0].delta, "no Figma value");
});

// ── Text colour depth ────────────────────────────────────────────────────
test("findTextDescendant: reaches a TEXT nested below the first level", () => {
  const tree = { type: "FRAME", children: [{ type: "GROUP", children: [{ type: "TEXT", id: "deep" }] }] };
  assert.equal(findTextDescendant(tree).id, "deep");
  assert.equal(findTextDescendant({ type: "FRAME", children: [] }), null);
});

test("extractFigmaProperties: a nested label supplies the text colour, not the container's fill", () => {
  const out = extractFigmaProperties({ nodes: { "1:1": { document: {
    id: "1:1", type: "FRAME",
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 1 } }],
    children: [{ id: "1:2", type: "GROUP", children: [{ id: "1:3", type: "TEXT",
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }] }] }],
  } } } }, ["color", "backgroundColor"], "1:1");
  assert.equal(out.color, "rgb(255, 255, 255)", "the nested label's own fill");
  assert.equal(out.backgroundColor, "rgb(0, 0, 255)", "the frame's fill stays the background");
});

test("extractFigmaProperties: a container with no text anywhere has no text colour", () => {
  const out = extractFigmaProperties({ nodes: { "1:1": { document: {
    id: "1:1", type: "FRAME",
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 1 } }],
    children: [{ id: "1:2", type: "RECTANGLE" }],
  } } } }, ["color"], "1:1");
  assert.equal(out.color, null, "a background must never be reported as the text colour");
});

test("autoSelectProperties: a nested label still earns the typography properties", () => {
  const node = {
    type: "FRAME", cornerRadius: 4,
    children: [{ type: "GROUP", children: [{
      type: "TEXT", style: { fontSize: 16 },
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
    }] }],
  };
  const props = autoSelectProperties(node);
  assert.ok(props.includes("fontSize"), "typography is comparable when the label is nested");
  assert.ok(props.includes("color"), "so is the label's own colour");
  // And the values really do come from the nested layer, not from the container.
  const out = extractFigmaProperties(node, ["fontSize", "color"]);
  assert.equal(out.fontSize, "16px");
  assert.equal(out.color, "rgb(255, 255, 255)");
});

// ── Generated auto-map script ────────────────────────────────────────────
test("buildAutoMapScript: U+2028/2029 in a layer name are escaped, not left raw", () => {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const script = buildAutoMapScript([{
    figmaNodeId: "1:1", name: "a" + LS + "b", type: "TEXT", text: "a" + LS + "b" + PS + "c",
    selectors: ["#x"],
  }]);
  assert.ok(!script.includes(LS), "a raw U+2028 is a line terminator in pre-ES2019 JS source");
  assert.ok(!script.includes(PS));
  // Built from char codes: a literal backslash in this assertion is too easy to
  // lose to one round of escaping and would silently weaken the check.
  const BACKSLASH = String.fromCharCode(92);
  assert.ok(script.includes(BACKSLASH + "u2028"), "it survives as its escape sequence instead");
  // The script must still be parseable and carry the original text through.
  const items = new Function("return " + script.match(/const items = (\[[\s\S]*?\]);/)[1])();
  assert.equal(items[0].text, "a" + LS + "b" + PS + "c", "escaping is lossless");
});

test("buildAutoMapScript: a quote in a layer name cannot break out of the payload", () => {
  const script = buildAutoMapScript([{
    figmaNodeId: "1:1", name: 'x"; alert(1); //', type: "TEXT", text: 'x"; alert(1); //', selectors: ["#x"],
  }]);
  const items = new Function("return " + script.match(/const items = (\[[\s\S]*?\]);/)[1])();
  assert.equal(items[0].text, 'x"; alert(1); //', "the payload stays a single JSON string");
});
