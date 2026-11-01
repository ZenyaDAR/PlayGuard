// Run: npm test. The in-page axe script (run against a stub axe) and the report formatter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAxeScript, formatAxe, loadAxeSource, DEFAULT_TAGS, MAX_NODES } from "../dist/a11y.js";

const node = (i) => ({ target: [`li:nth-child(${i})`], html: `<li>\n  item ${i}</li>`, failureSummary: "Fix any of the following:\n  Element has insufficient color contrast of 2.1\n  Second reason" });

// Evaluates the generated browser function in Node with stub page globals.
async function runScript(src, axe, selector, tags) {
  const seen = {};
  globalThis.window = { axe: { version: "9.9.9", getRules: (t) => t.includes("nope") ? [] : [{}], run: async (ctx, opts) => { seen.ctx = ctx; seen.opts = opts; return axe(); } } };
  globalThis.location = { href: "https://a.test/" };
  globalThis.document = { fake: true };
  try { return { out: await (0, eval)(`(${buildAxeScript(src, { selector, tags })})`)(), seen }; }
  finally { delete globalThis.window; delete globalThis.location; delete globalThis.document; }
}

test("a11y script: groups violations, caps nodes, cleans the failure summary", async () => {
  const res = { violations: [{ id: "color-contrast", impact: "serious", help: "h", helpUrl: "u", nodes: [1, 2, 3, 4, 5, 6, 7].map(node) }], passes: [{}, {}], incomplete: [{ id: "x" }] };
  const { out, seen } = await runScript("/* axe already present */", () => res);
  assert.equal(seen.ctx.fake, true, "whole document by default");
  assert.deepEqual(seen.opts.runOnly.values, DEFAULT_TAGS);
  assert.deepEqual(seen.opts.resultTypes, ["violations"]);
  const v = out.v[0];
  assert.equal(v.n, 7);
  assert.equal(v.nodes.length, MAX_NODES);
  assert.deepEqual(v.nodes[0], { t: "li:nth-child(1)", h: "<li> item 1</li>", f: "Element has insufficient color contrast of 2.1 (+1 more)" });
  assert.equal(out.passes, 2);
  assert.deepEqual(out.incomplete, ["x"]);
  assert.equal(out.version, "9.9.9");
});

test("a11y script: selector is the axe context; an axe throw becomes _error", async () => {
  const { seen } = await runScript("", () => ({ violations: [], passes: [], incomplete: [] }), "main");
  assert.equal(seen.ctx, "main");
  const { out } = await runScript("", () => { throw new Error("No elements found"); }, "#x");
  assert.equal(out._error, "No elements found");
  assert.equal(out.url, "https://a.test/");
});

test("a11y script: real axe-core source is wrapped so page UMD globals can't swallow it", () => {
  const src = loadAxeSource();
  assert.ok(src.length > 100_000);
  const script = buildAxeScript(src);
  assert.ok(script.includes('if (typeof (window.axe && window.axe.run) !== "function") { (function (module, exports, define) {'));
});

test("a11y script: tags that match no axe rule are an error, not a clean report", async () => {
  const { out, seen } = await runScript("", () => ({ violations: [], passes: [], incomplete: [] }), undefined, ["nope"]);
  assert.equal(out._error, "no axe rules match tag nope");
  assert.equal(seen.ctx, undefined, "axe.run is not called");
  const mixed = await runScript("", () => ({ violations: [], passes: [], incomplete: [] }), undefined, ["wcag2a", "nope"]);
  assert.equal(mixed.out._error, "no axe rules match tag nope", "one typo among good tags is still caught");
});

test("a11y script: a page element with id=axe (window.axe = a DOM node) still gets axe injected", async () => {
  globalThis.window = { axe: { tagName: "DIV" } };
  globalThis.location = { href: "https://a.test/" };
  globalThis.document = {};
  const src = "window.axe = { version: 'injected', getRules: () => [{}], run: async () => ({ violations: [], passes: [], incomplete: [] }) };";
  try {
    const out = await (0, eval)(`(${buildAxeScript(src)})`)();
    assert.equal(out.version, "injected");
  } finally { delete globalThis.window; delete globalThis.location; delete globalThis.document; }
});

test("a11y format: most severe first, overflow counted, empty result says so", () => {
  const r = {
    v: [
      { id: "region", impact: "moderate", help: "landmarks", helpUrl: "u1", n: 1, nodes: [{ t: "div", h: "<div>", f: "" }] },
      { id: "image-alt", impact: "critical", help: "alt", helpUrl: "u2", n: 9, nodes: [{ t: "img", h: "<img>", f: "no alt" }] },
    ],
    passes: 10, incomplete: [], version: "4.14.0", url: "https://a.test/",
  };
  const t = formatAxe(r);
  assert.ok(t.indexOf("image-alt") < t.indexOf("region"));
  assert.match(t, /^\[PlayGuard a11y: 2 violations \(10 elements\)/);
  assert.match(t, / {2}- img {2}<img>\n {4}no alt\n {2}… \+8 more\n {2}u2/);
  assert.match(formatAxe({ ...r, v: [] }), /0 violations[\s\S]*No violations for these tags/);
});
