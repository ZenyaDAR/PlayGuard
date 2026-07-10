// Run: npm test  (builds first, then `node --test`)
// Separate file from playguard.test.mjs so it doesn't inherit that file's
// PLAYGUARD_TOKEN_BUDGET=25 override (node:test runs each file in its own process).
process.env.PLAYGUARD_NO_SERVE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { dead, splitArgs, ttlCache, decideSnapshot, emptySnapState, optimizeFigmaResponse } = await import("../dist/index.js");

// ── dead() — crash/disconnect detection that drives session revival ─────────
test("dead() recognizes known crash/disconnect error text", () => {
  assert.ok(dead(new Error("Target page, context or browser has been closed")));
  assert.ok(dead("connect ECONNREFUSED 127.0.0.1:9222"));
  assert.ok(dead("Browser has crashed"));
});

test("dead() does not flag ordinary tool errors", () => {
  assert.ok(!dead(new Error("Element not found: #submit")));
  assert.ok(!dead("Timeout waiting for selector"));
});

test("dead() recognizes the navigation-failed and protocol-error patterns", () => {
  assert.ok(dead("Navigation failed because page was closed!"));
  assert.ok(dead("Protocol error (Runtime.evaluate): Target closed"));
});

// ── splitArgs() — env-var arg parsing for PLAYWRIGHT_MCP_ARGS/FIGMA_MCP_ARGS ─
test("splitArgs splits on spaces and keeps quoted args with spaces intact", () => {
  assert.deepEqual(splitArgs("--headless --browser firefox"), ["--headless", "--browser", "firefox"]);
  assert.deepEqual(
    splitArgs('--storage-state "C:/path with spaces/state.json"'),
    ["--storage-state", "C:/path with spaces/state.json"],
  );
  assert.deepEqual(splitArgs("--foo 'single quoted'"), ["--foo", "single quoted"]);
});

test("splitArgs returns an empty array for an empty string", () => {
  assert.deepEqual(splitArgs(""), []);
});

test("splitArgs keeps an unclosed quote literal instead of mangling the token", () => {
  // Regression: `"unclosed` used to lose its first AND last character (→ `unclose`).
  assert.deepEqual(splitArgs('--foo "unclosed'), ["--foo", '"unclosed']);
  assert.deepEqual(splitArgs('""'), [""]); // empty quoted arg still unwraps
});

// ── ttlCache() — shared by evalCache and figmaCache ──────────────────────────
test("ttlCache returns a value within TTL and not after it expires", async () => {
  const cache = ttlCache(10);
  cache.set("k", "v");
  assert.equal(cache.get("k", 1000), "v");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get("k", 10), undefined);
});

test("ttlCache clears the whole map once maxEntries is reached", () => {
  const cache = ttlCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // map was full (size 2) -> clears, then inserts c
  assert.equal(cache.get("a", 10_000), undefined);
  assert.equal(cache.get("b", 10_000), undefined);
  assert.equal(cache.get("c", 10_000), 3);
});

test("ttlCache.get returns undefined for a key that was never set", () => {
  const cache = ttlCache(10);
  assert.equal(cache.get("missing", 10_000), undefined);
});

// ── decideSnapshot() — cache/delta decision extracted out of the MCP handler ─
const refLine = (i) => `- button "item ${i}" [ref=${i}]`;
const makeContent = (refs) => [{ text: refs.map(refLine).join("\n") }];
const opts = { deltaEnabled: true, deltaThreshold: 0.4, hintThreshold: 4, compact: true };
const URL = "https://example.com";

test("decideSnapshot: first call is a full snapshot, not a cache hit", () => {
  const d = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  assert.equal(d.meta.cacheHit, false);
  assert.equal(d.meta.delta, false);
  assert.ok(d.state.hash);
});

test("decideSnapshot: identical content on the same URL is UNCHANGED (cache hit)", () => {
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([1, 2, 3]), d1.state, URL, opts);
  assert.equal(d2.meta.cacheHit, true);
  assert.match(d2.responseText, /UNCHANGED/);
});

test("decideSnapshot: a small change on the same URL returns a delta", () => {
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([1, 2, 3, 4]), d1.state, URL, opts);
  assert.equal(d2.meta.delta, true);
  assert.equal(d2.meta.deltaAdded, 1);
  assert.equal(d2.meta.deltaRemoved, 0);
});

test("decideSnapshot: a large change falls back to a full snapshot instead of a delta", () => {
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([101, 102, 103]), d1.state, URL, opts);
  assert.equal(d2.meta.delta, false);
  assert.equal(d2.meta.cacheHit, false);
});

test("decideSnapshot: navigating to a different URL forces a full snapshot, never a delta", () => {
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([1, 2, 3, 4]), d1.state, "https://other.example.com", opts);
  assert.equal(d2.meta.delta, false);
});

test("decideSnapshot: a small change still deltas after a MUTATING-tool reset (hash/compact cleared, lines/url kept)", () => {
  // Mirrors what invoke() does after e.g. browser_click succeeds — the regression this
  // guards is the server wiping the whole SnapState (including `lines`) on every mutation,
  // which made delta unreachable in the click-then-snapshot flow the feature exists for.
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const afterMutation = { ...d1.state, hash: null, compact: null };
  const d2 = decideSnapshot(makeContent([1, 2, 3, 4]), afterMutation, URL, opts);
  assert.equal(d2.meta.delta, true);
  assert.equal(d2.meta.deltaAdded, 1);
});

test("decideSnapshot: identical content on a different URL is never reported UNCHANGED", () => {
  // Guards against a coincidental hash collision across genuinely different pages.
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([1, 2, 3]), d1.state, "https://other.example.com", opts);
  assert.equal(d2.meta.cacheHit, false);
  assert.doesNotMatch(d2.responseText, /UNCHANGED/);
});

test("decideSnapshot: cache hit reports savedBytes equal to the cached raw snapshot size", () => {
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([1, 2, 3]), d1.state, URL, opts);
  // bench/analyze.mjs sums this field as "Bytes saved by cache" — must track the real raw size.
  assert.equal(d2.meta.savedBytes, d1.state.rawBytes);
});

// Distinct roles so collapseRuns (≥5 look-alike lines) never folds these away
// before the delta diff sees them.
const roleContent = (roles) => [{ text: roles.map((r, i) => `- ${r} "x" [ref=${i + 1}]`).join("\n") }];

test("decideSnapshot: a removed-only change is reported as a delta with REMOVED lines", () => {
  const d1 = decideSnapshot(roleContent(["button", "link", "textbox", "checkbox", "combobox", "radio"]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(roleContent(["button", "link", "textbox", "checkbox", "combobox"]), d1.state, URL, opts);
  assert.equal(d2.meta.delta, true);
  assert.equal(d2.meta.deltaAdded, 0);
  assert.equal(d2.meta.deltaRemoved, 1);
  assert.match(d2.responseText, /REMOVED:/);
  assert.match(d2.responseText, /radio/);
});

test("decideSnapshot: change ratio exactly at the threshold falls back to a full snapshot", () => {
  // threshold is strict (<): (1 added + 1 removed) / 5 lines = 0.4 → full, not delta
  const d1 = decideSnapshot(roleContent(["button", "link", "textbox", "checkbox", "combobox"]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(roleContent(["button", "link", "textbox", "checkbox", "radio"]), d1.state, URL, opts);
  assert.equal(d2.meta.delta, false);
  assert.equal(d2.meta.cacheHit, false);
});

test("decideSnapshot: compact=false returns the raw snapshot text without a PlayGuard header", () => {
  const content = makeContent([1, 2, 3]);
  const d = decideSnapshot(content, emptySnapState, URL, { ...opts, deltaEnabled: false, compact: false });
  assert.equal(d.responseText, content[0].text);
});

test("decideSnapshot: hintThreshold=0 disables hints entirely", () => {
  const state = { ...emptySnapState, withoutAction: 99 };
  const d = decideSnapshot(makeContent([1, 2, 3]), state, URL, { ...opts, hintThreshold: 0 });
  assert.equal(d.meta.hinted, false);
  assert.doesNotMatch(d.responseText, /PlayGuard hint/);
});

test("decideSnapshot: UNCHANGED cache hits still advance the without-action counter", () => {
  // Idle polling via cache hits must eventually trigger the hint, not mask it.
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, opts);
  const d2 = decideSnapshot(makeContent([1, 2, 3]), d1.state, URL, opts);
  assert.equal(d1.meta.snapCount, 1);
  assert.equal(d2.meta.snapCount, 2);
  assert.equal(d2.state.withoutAction, 2);
});

// ── Module 8 — Framelink-shape ({metadata, nodes[], globalVars.styles}) ──────
const framelinkFixture = () => ({
  metadata: { name: "f", lastModified: "2026-07-09", thumbnailUrl: "https://signed" },
  nodes: [{
    id: "1:1", name: "root", type: "FRAME", layout: "layout_ROW",
    children: [
      { id: "1:2", name: "card", type: "FRAME", fills: "fill_A", children: [{ id: "1:20", name: "icon", type: "IMAGE-SVG", fills: "fill_A" }] },
      { id: "1:3", name: "card", type: "FRAME", fills: "fill_A", children: [{ id: "1:30", name: "icon", type: "IMAGE-SVG", fills: "fill_A" }] },
      { id: "1:4", name: "caption", type: "TEXT", text: "pi is 3.14159", textStyle: "style_T", layout: "layout_NONE" },
    ],
  }],
  globalVars: { styles: {
    layout_ROW: { mode: "row", gap: "8px" },
    layout_NONE: { mode: "none", sizing: {} },
    style_T: { fontSize: 16, lineHeight: "1.3999999364217122em" },
    fill_A: ["#FFFFFF"],
  } },
});

test("M8a collapses duplicate siblings (identical except ids) to a _sameAs stub", () => {
  const { data, stats } = optimizeFigmaResponse(framelinkFixture());
  const kids = data.nodes[0].children;
  assert.equal(stats.siblingsCollapsed, 1);
  assert.deepEqual(kids[1], { id: "1:3", name: "card", _sameAs: "1:2" });
  assert.equal(kids[0].children[0].id, "1:20"); // first copy keeps its full subtree
});

test("M8a+ collapses structural copies (same tree, different text) keeping a text diff", () => {
  const card = (id, tid, text) => ({
    id, name: "card", type: "FRAME", fills: "fill_A",
    children: [
      { id: `${id}0`, name: "icon", type: "IMAGE-SVG", fills: "fill_A" },
      { id: tid, name: "title", type: "TEXT", text, textStyle: "style_T" },
    ],
  });
  const fixture = framelinkFixture();
  fixture.nodes[0].children = [card("2:1", "2:11", "Товар 1"), card("2:2", "2:21", "Товар 2"), card("2:3", "2:31", "Товар 1")];
  const { data, stats } = optimizeFigmaResponse(fixture);
  const kids = data.nodes[0].children;
  assert.equal(stats.structSiblingsCollapsed, 1); // only the text-differing copy
  assert.equal(stats.siblingsCollapsed, 1);       // same-text copy is caught by exact 8a
  assert.deepEqual(kids[1], { id: "2:2", name: "card", _sameAs: "2:1", _textDiff: { 0: "Товар 2" } });
  assert.deepEqual(kids[2], { id: "2:3", name: "card", _sameAs: "2:1" });
  assert.equal(kids[0].children[1].text, "Товар 1"); // reference copy stays full
});

test("M8a+ collapses copies that differ only in layer names (grid copies named 1..N)", () => {
  const fixture = framelinkFixture();
  const card = (id, name) => ({
    id, name, type: "FRAME", fills: "fill_A",
    children: [{ id: `${id}1`, name: "icon", type: "IMAGE-SVG", fills: "fill_A" }],
  });
  fixture.nodes[0].children = [card("5:1", "1"), card("5:2", "2")];
  const { data, stats } = optimizeFigmaResponse(fixture);
  assert.equal(stats.structSiblingsCollapsed, 1);
  assert.deepEqual(data.nodes[0].children[1], { id: "5:2", name: "2", _sameAs: "5:1" });
});

test("M8a+ does NOT collapse copies that differ in styling, not just text", () => {
  const fixture = framelinkFixture();
  fixture.nodes[0].children = [
    { id: "3:1", name: "card", type: "FRAME", fills: "fill_A", children: [{ id: "3:11", name: "t", type: "TEXT", text: "a" }] },
    { id: "3:2", name: "card", type: "FRAME", fills: "fill_B", children: [{ id: "3:21", name: "t", type: "TEXT", text: "b" }] },
  ];
  fixture.globalVars.styles.fill_B = ["#000000"];
  const { data, stats } = optimizeFigmaResponse(fixture);
  assert.equal(stats.structSiblingsCollapsed, 0);
  assert.equal(data.nodes[0].children[1].fills, "fill_B");
});

test("M8a+ skips the stub when it would not be smaller than the original", () => {
  const fixture = framelinkFixture();
  fixture.nodes[0].children = [
    { id: "4:1", name: "t", type: "TEXT", text: "x" },
    { id: "4:2", name: "t", type: "TEXT", text: "a very long replacement text that makes the diff stub bigger than the tiny node itself" },
  ];
  const { data, stats } = optimizeFigmaResponse(fixture);
  assert.equal(stats.structSiblingsCollapsed, 0);
  assert.equal(data.nodes[0].children[1].id, "4:2");
});

test("M8b drops no-op layout styles and the refs pointing at them", () => {
  const { data, stats } = optimizeFigmaResponse(framelinkFixture());
  assert.equal(stats.emptyStylesDropped, 1);
  assert.ok(!("layout_NONE" in data.globalVars.styles));
  assert.ok(!("layout" in data.nodes[0].children[2]));
  assert.equal(data.nodes[0].layout, "layout_ROW"); // real layout ref untouched
});

test("M8c rounds float noise in styles but never touches node text", () => {
  const { data, stats } = optimizeFigmaResponse(framelinkFixture());
  assert.equal(data.globalVars.styles.style_T.lineHeight, "1.4em");
  assert.ok(stats.floatsRounded >= 1);
  assert.equal(data.nodes[0].children[2].text, "pi is 3.14159");
});

test("M8 leaves the raw REST document shape alone", () => {
  const rest = { document: { id: "0:0", type: "DOCUMENT", children: [] }, nodes: [{ id: "9:9" }] };
  const { stats } = optimizeFigmaResponse(rest);
  assert.equal(stats.siblingsCollapsed, 0);
});

test("decideSnapshot: hints at interactive elements after hintThreshold snapshots without action", () => {
  const noDelta = { ...opts, deltaEnabled: false, hintThreshold: 2 };
  const d1 = decideSnapshot(makeContent([1, 2, 3]), emptySnapState, URL, noDelta);
  const d2 = decideSnapshot(makeContent([4, 5, 6]), d1.state, URL, noDelta);
  const d3 = decideSnapshot(makeContent([7, 8, 9]), d2.state, URL, noDelta);
  assert.equal(d1.meta.hinted, false);
  assert.equal(d2.meta.hinted, false);
  assert.equal(d3.meta.hinted, true);
  assert.match(d3.responseText, /PlayGuard hint/);
});
