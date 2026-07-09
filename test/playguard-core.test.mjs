// Run: npm test  (builds first, then `node --test`)
// Separate file from playguard.test.mjs so it doesn't inherit that file's
// PLAYGUARD_TOKEN_BUDGET=25 override (node:test runs each file in its own process).
process.env.PLAYGUARD_NO_SERVE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { dead, splitArgs, ttlCache, decideSnapshot, emptySnapState } = await import("../dist/index.js");

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
