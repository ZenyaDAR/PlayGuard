// Run: npm test  (builds first, then `node --test`)
// Chrome DevTools MCP snapshot compaction + UNCHANGED/delta decision (src/devtools-snapshot.ts).
// Fixtures are real take_snapshot captures of playguard.dev and en.wikipedia.org.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

const { processSnapshotResponse, invalidateDtSnap, emptyDtSnapState } = await import("../dist/devtools-snapshot.js");

// CRLF-normalize: a checkout with autocrlf must not change what the parser sees.
const fixture = (name) => readFileSync(new URL(`./fixtures/devtools/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const OPTS = { compact: true, deltaEnabled: true, deltaThreshold: 0.3, verbose: false };
const run = (text, state = emptyDtSnapState, opts = {}) => processSnapshotResponse(text, state, { ...OPTS, ...opts });
const ROOT = 'uid=1_0 RootWebArea "Shop" url="https://shop.test/"';
// Same-origin links whose rewrite saves more than the marker costs, so a small test page
// still comes back compacted (a page where compaction saves less is sent as received).
const FILL = Array.from({ length: 20 }, (_, i) => "  uid=0_" + i + ' link "f' + i + '" url="https://shop.test/f/' + i + '"');
const snap = (root, ...lines) => "## Latest page snapshot\n" + [root, ...FILL, ...lines].join("\n") + "\n";

// ── compaction transforms ────────────────────────────────────────────────────
test("same-origin urls become paths; query strings and other origins are kept", () => {
  const { text } = run(snap(ROOT,
    '  uid=1_1 link "Red" url="https://shop.test/products/a?variant=42"',
    '  uid=1_2 link "Home" url="https://shop.test"',
    '  uid=1_3 link "Out" url="https://other.test/x"'));
  assert.match(text, /uid=1_0 RootWebArea "Shop" url="https:\/\/shop.test\/"/, "root url stays absolute");
  assert.match(text, /uid=1_1 link "Red" url="\/products\/a\?variant=42"/);
  assert.match(text, /uid=1_2 link "Home" url="\/"/);
  assert.match(text, /uid=1_3 link "Out" url="https:\/\/other.test\/x"/);
});

test("image nodes lose their url attribute", () => {
  const { text } = run(snap(ROOT, '  uid=1_1 image "Logo" url="https://cdn.test/logo.png"'));
  assert.match(text, /uid=1_1 image "Logo"\n/);
});

test("LineBreak nodes (two physical lines) are dropped", () => {
  const { text } = run(snap(ROOT, '  uid=1_1 "a"', '  uid=1_2 LineBreak "', '"', '  uid=1_3 "b"'));
  assert.ok(!text.includes("LineBreak"));
  assert.match(text, /uid=1_1 "a"\n {2}uid=1_3 "b"\n$/);
});

test("a doubled name is halved only when a child carries the half", () => {
  const { text } = run(snap(ROOT,
    '  uid=1_1 link "Tree Runner Tree Runner" url="https://shop.test/p"',
    '    uid=1_2 image "Tree Runner" url="https://cdn.test/t.png"',
    '  uid=1_3 button "PL PL PL"',
    '  uid=1_4 button "Bye Bye"',
    '  uid=1_5 heading "New York New York"'));
  assert.match(text, /uid=1_1 link "Tree Runner" url="\/p"\n/);
  assert.ok(!text.includes("uid=1_2"), "the image repeating the link name goes");
  assert.match(text, /uid=1_3 button "PL PL PL"/, "odd repetition is not a doubled name");
  assert.match(text, /uid=1_4 button "Bye Bye"/, "a legit doubled name without such a child stays");
  assert.match(text, /uid=1_5 heading "New York New York"/);
});

test("a name change into a doubled name is still reported", () => {
  const first = run(snap(ROOT, '  uid=1_1 button "Go"'));
  const r = run(snap(ROOT, '  uid=1_1 button "Go Go"'), invalidateDtSnap(first.state));
  assert.equal(r.meta.delta, true);
  assert.match(r.text, /ADDED:\n {2}uid=1_1 button "Go Go"\nREMOVED:\n {2}uid=1_1 button "Go"\n/);
});

test("image/text leaf repeating its parent's or previous sibling's name is dropped", () => {
  const { text } = run(snap(ROOT,
    '  uid=1_1 link "Shoe Shoe" url="https://shop.test/p"',
    '    uid=1_2 image "Shoe" url="https://cdn.test/1.png"',
    '  uid=1_3 radio "Small"',
    '  uid=1_4 "Small"',
    '  uid=1_5 "Large"'));
  assert.ok(!text.includes("uid=1_2"));
  assert.ok(!text.includes("uid=1_4"));
  assert.match(text, /uid=1_5 "Large"/);
});

test("repeated siblings are all kept: focusable generics, images, repeated text", () => {
  const { text } = run(snap(ROOT,
    "  uid=1_1 group",
    "    uid=1_2 generic focusable",
    "    uid=1_3 generic focusable",
    '  uid=1_4 image "thumb" url="https://cdn.test/1.jpg"',
    '  uid=1_5 image "thumb" url="https://cdn.test/2.jpg"',
    '  uid=1_6 "★"',
    '  uid=1_7 "★"',
    "  uid=1_8 button",
    "  uid=1_9 button"));
  for (let i = 2; i <= 9; i++) assert.match(text, new RegExp("uid=1_" + i + "[ \\n]"), "lost uid=1_" + i);
});

test("a leaf with any attribute is never dropped", () => {
  const { text } = run(snap(ROOT, '  uid=1_1 link "Sale" url="https://shop.test/s"', '    uid=1_2 "Sale" focusable'));
  assert.match(text, /uid=1_2 "Sale" focusable/);
});

test("a node with children is never dropped", () => {
  const { text } = run(snap(ROOT, '  uid=1_1 "x"', '  uid=1_2 "x"', '    uid=1_3 "y"'));
  assert.ok(text.includes("uid=1_2") && text.includes("uid=1_3"));
});

test("names containing quotes and newlines survive verbatim", () => {
  const { text } = run(snap(ROOT, '  uid=1_1 link "Say "hi"\nnow" url="https://shop.test/q"', '  uid=1_2 "end"'));
  assert.match(text, /uid=1_1 link "Say "hi"\nnow" url="\/q"\n/);
});

test("marker line reports lines and size, and dropped image urls", () => {
  const { text, meta } = run(fixture("wiki-snapshot.txt"));
  assert.match(text, /^## Latest page snapshot\n\[PlayGuard compact: \d+\/119 lines, 8\.9KB→\d+\.\dKB; img urls dropped, raw:true for full\]\n/);
  assert.ok(meta.keptBytes < meta.rawBytes);
  assert.match(run(snap(ROOT)).text, /\[PlayGuard compact: [^\]]*KB\]\n/, "no image → no note");
});

test("verbose keeps image urls", () => {
  const { text } = run(snap(ROOT, '  uid=1_1 image "Logo" url="https://cdn.test/logo.png"'), emptyDtSnapState, { verbose: true });
  assert.match(text, /uid=1_1 image "Logo" url="https:\/\/cdn.test\/logo.png"/);
  assert.ok(!text.includes("img urls dropped"));
});

test("a tiny snapshot where compaction saves less than the marker is sent as received", () => {
  for (const raw of ['## Latest page snapshot\nuid=1_0 RootWebArea "" url="about:blank"\n',
    "## Latest page snapshot\n" + ROOT + '\n  uid=1_1 link "Home" url="https://shop.test/"\n']) {
    assert.equal(run(raw).text, raw);
  }
});

test("urls inside a cross-origin iframe stay absolute", () => {
  const { text } = run(snap(ROOT,
    '  uid=1_1 Iframe "frame"',
    '    uid=1_2 RootWebArea "inner" url="https://b.test/f"',
    '      uid=1_3 link "back" url="https://shop.test/x"',
    '  uid=1_4 link "after" url="https://shop.test/y"'));
  assert.match(text, /uid=1_2 RootWebArea "inner" url="https:\/\/b.test\/f"/);
  assert.match(text, /uid=1_3 link "back" url="https:\/\/shop.test\/x"/);
  assert.match(text, /uid=1_4 link "after" url="\/y"/, "rewriting resumes after the iframe");
});

test("a uid-less line under the root does not lose the page url", () => {
  const raw = snap(ROOT + '\n  "The Internet"');
  const first = run(raw);
  assert.match(first.text, /uid=0_0 link "f0" url="\/f\/0"/);
  const other = run(raw.replace("https://shop.test/", "https://other.test/"), first.state);
  assert.equal(other.meta.delta, false, "a different root url is a different page");
});

test("a huge node is emitted verbatim, fast", () => {
  const huge = '  uid=1_1 button "q' + ' w="a"'.repeat(16000) + ' "';
  const t0 = performance.now();
  const { text } = run(snap(ROOT, huge));
  assert.ok(performance.now() - t0 < 200, "no quadratic regex");
  assert.ok(text.includes(huge + "\n"));
});

// ── uid preservation on real captures ────────────────────────────────────────
const INTERACTIVE = /^ *uid=(\S+) (link|button|radio|checkbox|textbox|searchbox|combobox|option|tab|menuitem|RootWebArea)\b/;
for (const name of ["playguard-snapshot.txt", "wiki-snapshot.txt", "wiki-snapshot-verbose.txt"]) {
  test(`every interactive uid survives compaction (${name})`, () => {
    const raw = fixture(name);
    const { text } = run(raw);
    const uids = raw.split("\n").map((l) => l.match(INTERACTIVE)?.[1]).filter(Boolean);
    assert.ok(uids.length > 10);
    for (const u of uids) assert.match(text, new RegExp(`uid=${u}[ \\n]`), `lost uid=${u}`);
    // every surviving uid line still carries the uid it came with — nothing renumbered
    const before = new Set(raw.match(/uid=\S+/g));
    for (const u of text.match(/uid=\S+/g)) assert.ok(before.has(u), `invented ${u}`);
  });
}

// ── section isolation ────────────────────────────────────────────────────────
test("only the snapshot section is rewritten; surrounding text is byte-identical", () => {
  const head = "Successfully hovered over the element\n";
  const tail = "\n## Console messages\n<no console messages found>";
  const { text } = run(head + snap(ROOT, '  uid=1_1 image "Logo" url="https://cdn.test/l.png"') + tail);
  assert.ok(text.startsWith(head + "## Latest page snapshot\n[PlayGuard compact"));
  assert.ok(text.endsWith('uid=1_1 image "Logo"\n' + tail));
});

test("no snapshot section (e.g. saved to file) → null", () => {
  assert.equal(run("Saved snapshot to /tmp/s.txt."), null);
  assert.equal(run("Successfully hovered over the element"), null);
});

test("compact:false leaves the section as received", () => {
  const raw = fixture("playguard-snapshot.txt");
  const r = run(raw, emptyDtSnapState, { compact: false });
  assert.equal(r.text, raw);
  assert.equal(r.meta.rawBytes, r.meta.keptBytes);
});

// ── UNCHANGED / delta / full decision ────────────────────────────────────────
test("identical snapshot → one short UNCHANGED line", () => {
  const raw = fixture("wiki-snapshot.txt");
  const first = run(raw);
  const second = run(raw, first.state);
  assert.equal(second.meta.cacheHit, true);
  assert.match(second.text, /^## Latest page snapshot\n\[PlayGuard: UNCHANGED since \d+ms ago\]\n$/);
});

test("a change compaction hides (image url) is neither UNCHANGED nor +0/0: full snapshot", () => {
  const raw = fixture("wiki-snapshot.txt");
  const first = run(raw);
  const changed = raw.replace("wikipedia-wordmark-en-25.svg", "wikipedia-wordmark-en-26.svg");
  for (const state of [first.state, invalidateDtSnap(first.state)]) {
    const r = run(changed, state);
    assert.equal(r.meta.cacheHit, false);
    assert.equal(r.meta.delta, false);
    assert.match(r.text, /\[PlayGuard compact: /);
  }
});

test("small change → ADDED/REMOVED delta only", () => {
  const raw = fixture("wiki-snapshot.txt");
  const first = run(raw);
  const changed = raw.replace('uid=6_13 button "Search"', 'uid=6_13 button "Search" disableable disabled');
  const r = run(changed, first.state);
  assert.equal(r.meta.delta, true);
  assert.deepEqual([r.meta.deltaAdded, r.meta.deltaRemoved], [1, 1]);
  assert.equal(r.text, '## Latest page snapshot\n[PlayGuard delta: +1 added, 1 removed]\n'
    + 'ADDED:\n        uid=6_13 button "Search" disableable disabled\nREMOVED:\n        uid=6_13 button "Search"\n');
});

test("delta keeps indentation, so nesting inside a new dialog is visible", () => {
  const first = run(snap(ROOT));
  const r = run(snap(ROOT, '  uid=1_1 dialog "Cart"', '    uid=1_2 button "Checkout"'), first.state);
  assert.equal(r.meta.delta, true);
  assert.match(r.text, /ADDED:\n {2}uid=1_1 dialog "Cart"\n {4}uid=1_2 button "Checkout"\n$/);
});

test("different page (root url) or verbose flag → full snapshot, no delta", () => {
  const raw = fixture("wiki-snapshot.txt");
  const first = run(raw);
  const other = raw.replace('url="https://en.wikipedia.org/wiki/Chrome_DevTools"', 'url="https://en.wikipedia.org/wiki/Other"');
  const r1 = run(other, first.state);
  assert.equal(r1.meta.delta, false);
  assert.match(r1.text, /\[PlayGuard compact: /);
  const r2 = run(raw, first.state, { verbose: true });
  assert.equal(r2.meta.cacheHit, false);
  assert.equal(r2.meta.delta, false);
});

test("large change → full snapshot", () => {
  const first = run(fixture("wiki-snapshot.txt"));
  const r = run(fixture("wiki-snapshot.txt").replace(/uid=6_/g, "uid=9_"), first.state);
  assert.equal(r.meta.delta, false);
  assert.equal(r.meta.cacheHit, false);
});

test("invalidate drops UNCHANGED but keeps the delta baseline", () => {
  const raw = fixture("wiki-snapshot.txt");
  const first = run(raw);
  const r = run(raw, invalidateDtSnap(first.state));
  assert.equal(r.meta.cacheHit, false);
  assert.equal(r.meta.delta, true);
  assert.deepEqual([r.meta.deltaAdded, r.meta.deltaRemoved], [0, 0]);
});

test("deltaEnabled:false → full snapshot even for a small change", () => {
  const raw = fixture("wiki-snapshot.txt");
  const first = run(raw);
  const r = run(raw.replace('"Search"', '"Find"'), first.state, { deltaEnabled: false });
  assert.equal(r.meta.delta, false);
  assert.match(r.text, /\[PlayGuard compact: /);
});
