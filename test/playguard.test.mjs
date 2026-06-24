// Run: npm test  (builds first, then `node --test`)
// PLAYGUARD_NO_SERVE keeps the imported module from opening the stdio transport.
process.env.PLAYGUARD_NO_SERVE = "1";
process.env.PLAYGUARD_TOKEN_BUDGET = "25"; // charLimit = 100, forces a mid-snapshot cut
process.env.FIGMA_SVG_REFS = "true";

import { test } from "node:test";
import assert from "node:assert/strict";

const { collapseRuns, compactSnap, optimizeFigmaResponse } = await import("../dist/index.js");

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
