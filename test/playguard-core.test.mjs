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
