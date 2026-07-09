// Run: npm test  (builds first, then `node --test`)
// PLAYGUARD_NO_SERVE keeps the imported module from opening the stdio transport.
process.env.PLAYGUARD_NO_SERVE = "1";
process.env.PLAYGUARD_TOKEN_BUDGET = "25"; // charLimit = 100, forces a mid-snapshot cut
process.env.FIGMA_SVG_REFS = "true";

import { test } from "node:test";
import assert from "node:assert/strict";

const { collapseRuns, compactSnap, optimizeFigmaResponse, budgetTrimFigma } = await import("../dist/index.js");

const refLine = (i) => `- button "label ${i}" [ref=${i}]`;

test("collapseRuns folds a run of >=5 look-alike lines into first 3 + marker", () => {
  const lines = [1, 2, 3, 4, 5, 6].map(refLine);
  const out = collapseRuns(lines);
  assert.equal(out.length, 4); // 3 kept + 1 marker
  assert.match(out[3], /×3 more similar elements/);
  assert.match(out[3], /refs 4–6/);
});

test("collapseRuns leaves a short run (<5) untouched", () => {
  const lines = [1, 2, 3, 4].map(refLine);
  assert.deepEqual(collapseRuns(lines), lines);
});

test("collapseRuns marker never prints 'undefined' for a run without refs", () => {
  // Blank lines become adjacent after compactSnap filters text between them.
  const out = collapseRuns(["", "", "", "", "", ""]);
  assert.equal(out.length, 4);
  assert.doesNotMatch(out[3], /undefined/);
  assert.match(out[3], /×3 more similar lines/);
});

test("compactSnap survives an empty snapshot without NaN in the header", () => {
  const { text, rawBytes, keptBytes } = compactSnap([{ text: "" }]);
  assert.doesNotMatch(text, /NaN/);
  assert.equal(rawBytes, 0);
  assert.ok(keptBytes >= 0);
});

test("token budget never cuts a [ref=] line mid-token", () => {
  const content = [{ text: [1, 2, 3, 4, 5, 6].map(refLine).join("\n") }];
  const { text } = compactSnap(content);
  assert.match(text, /truncated at 25 tokens/);
  for (const line of text.split("\n")) {
    if (line.includes("[ref=")) assert.match(line, /\[ref=\d+\]/, `broken ref in: ${line}`);
  }
});

test("optimizeFigmaResponse applies all subtractive modules", () => {
  const doc = {
    document: {
      type: "DOCUMENT",
      children: [{
        type: "FRAME", name: "Root", layoutMode: "VERTICAL", visible: true, createdAt: "2020",
        children: [
          { type: "INSTANCE", componentId: "C1", id: "i1", name: "Btn", x: 1, y: 2 },
          { type: "INSTANCE", componentId: "C1", id: "i2", name: "Btn", x: 3, y: 4 },
          { type: "TEXT", id: "hidden", visible: false, x: 0, y: 0 },
          { type: "VECTOR", id: "v1", fillGeometry: [1, 2, 3], strokeGeometry: [9] },
        ],
      }],
    },
  };
  const { data, stats } = optimizeFigmaResponse(doc);

  assert.ok(stats.metaKeysDeleted >= 1, "createdAt should be dropped");
  assert.equal(stats.invisiblePruned, 1, "hidden node pruned");
  assert.equal(stats.uniqueComponents, 1);
  assert.equal(stats.instancesCollapsed, 1, "second C1 instance collapsed to a ref");
  assert.equal(stats.svgRefsReplaced, 1);
  assert.ok(stats.layoutCoordsRemoved >= 1, "x/y dropped inside auto-layout");
  assert.ok(stats.outBytes < stats.inBytes, "output is smaller");

  const kids = data.document.children[0].children;
  assert.equal(kids.find((k) => k.id === "i2")._ref, "C1");
  assert.equal(kids.find((k) => k.id === "v1")._svgRef, "v1");
});

test("optimizeFigmaResponse: inBytes uses the raw upstream byte count when provided", () => {
  // Regression for 0.2.1: measuring inBytes from JSON.stringify(parsed) hid the
  // YAML→JSON reformatting saving, so pct always read 0 on YAML upstreams.
  const { stats } = optimizeFigmaResponse({ a: 1 }, 5000);
  assert.equal(stats.inBytes, 5000);
  const { stats: noRaw } = optimizeFigmaResponse({ a: 1 });
  assert.equal(noRaw.inBytes, Buffer.byteLength(JSON.stringify({ a: 1 })));
});

test("optimizeFigmaResponse Module 5 trims top-level metadata but keeps the rest", () => {
  const doc = { metadata: { thumbnailUrl: "https://signed", lastModified: "2026", name: "My File" }, nodes: {} };
  const { data, stats } = optimizeFigmaResponse(doc);
  assert.equal(data.metadata.thumbnailUrl, undefined);
  assert.equal(data.metadata.lastModified, undefined);
  assert.equal(data.metadata.name, "My File");
  assert.equal(stats.metaKeysDeleted, 2);
});

test("optimizeFigmaResponse guards: opacity 0 pruned, ABSOLUTE keeps x/y, tiny geometry kept", () => {
  const doc = {
    document: {
      type: "DOCUMENT",
      children: [{
        type: "FRAME", name: "Root", layoutMode: "HORIZONTAL",
        children: [
          { type: "TEXT", id: "ghost", opacity: 0 },
          { type: "FRAME", id: "abs", layoutPositioning: "ABSOLUTE", x: 10, y: 20 },
          { type: "VECTOR", id: "small", fillGeometry: [1, 2] },
        ],
      }],
    },
  };
  const { data, stats } = optimizeFigmaResponse(doc);
  const kids = data.document.children[0].children;

  assert.equal(stats.invisiblePruned, 1);
  assert.equal(kids.find((k) => k.id === "ghost"), undefined, "opacity 0 node pruned");

  const abs = kids.find((k) => k.id === "abs");
  assert.equal(abs.x, 10, "ABSOLUTE-positioned node keeps x inside auto-layout");
  assert.equal(abs.y, 20);

  const small = kids.find((k) => k.id === "small");
  assert.deepEqual(small.fillGeometry, [1, 2], "geometry of <=2 paths stays inline");
  assert.equal(stats.svgRefsReplaced, 0);
});

test("deduplicateComponents: an overridden instance never becomes the base definition", () => {
  const doc = {
    document: {
      type: "DOCUMENT",
      children: [
        { type: "INSTANCE", componentId: "C1", id: "i1", name: "Btn", overrides: [{ id: "o1" }] },
        { type: "INSTANCE", componentId: "C1", id: "i2", name: "Btn" },
        { type: "INSTANCE", componentId: "C1", id: "i3", name: "Btn" },
      ],
    },
  };
  const { data, stats } = optimizeFigmaResponse(doc);
  const kids = data.document.children;

  // i1 has overrides → kept in full, not registered as base
  assert.equal(kids.find((k) => k.id === "i1")._ref, undefined, "overridden instance stays full");
  // i2 is the first clean instance → becomes the base, kept in full
  assert.equal(kids.find((k) => k.id === "i2")._ref, undefined, "clean base stays full");
  // i3 collapses against i2
  assert.equal(kids.find((k) => k.id === "i3")._ref, "C1");
  assert.equal(stats.uniqueComponents, 1);
  assert.equal(stats.instancesCollapsed, 1);
});

test("budgetTrimFigma: under-budget tree passes through untouched", () => {
  const doc = { document: { id: "0", type: "DOCUMENT", children: [{ id: "1", name: "Root", type: "FRAME" }] } };
  const { data, stubbed } = budgetTrimFigma(doc, 10_000);
  assert.deepEqual(data, doc);
  assert.equal(stubbed, 0);
});

test("budgetTrimFigma: over-budget document tree stubs branches but keeps every top-level id", () => {
  const filler = "x".repeat(400);
  const doc = {
    document: {
      id: "0", type: "DOCUMENT",
      children: Array.from({ length: 5 }, (_, i) => ({
        id: `frame${i}`, name: `Frame ${i}`, type: "FRAME",
        children: Array.from({ length: 10 }, (_, j) => ({ id: `n${i}-${j}`, type: "TEXT", blob: filler })),
      })),
    },
  };
  const fullSize = JSON.stringify(doc).length;
  const { data, stubbed } = budgetTrimFigma(doc, 800);
  const out = JSON.stringify(data);

  assert.ok(stubbed > 0, "some branch had to be stubbed");
  assert.ok(out.length < fullSize, "trimmed output is smaller than the untrimmed tree");
  assert.doesNotThrow(() => JSON.parse(out), "trimmed output stays valid JSON");
  for (const frame of doc.document.children) {
    assert.ok(out.includes(frame.id), `top-level section ${frame.id} must not vanish silently`);
  }
});

test("budgetTrimFigma: Framelink 'nodes' array shape is trimmed the same way, metadata untouched", () => {
  const filler = "y".repeat(400);
  const doc = {
    metadata: { name: "My File" },
    nodes: Array.from({ length: 4 }, (_, i) => ({
      id: `node${i}`, name: `Node ${i}`, type: "FRAME",
      children: Array.from({ length: 8 }, (_, j) => ({ id: `c${i}-${j}`, type: "TEXT", blob: filler })),
    })),
  };
  const { data, stubbed } = budgetTrimFigma(doc, 600);
  const out = JSON.stringify(data);

  assert.equal(data.metadata.name, "My File", "small fixed fields pass through untouched");
  assert.ok(stubbed > 0);
  for (const node of doc.nodes) {
    assert.ok(out.includes(node.id), `top-level node ${node.id} must not vanish silently`);
  }
});
