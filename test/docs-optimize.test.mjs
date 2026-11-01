// Run: npm test  (builds first, then `node --test`)
// Pure rewrites for the documentation upstreams (src/docs-optimize.ts) and the disk cache
// (src/docs-cache.ts). Fixtures are real upstream output: test/fixtures/shopify-dev
// (@shopify/dev-mcp 1.18.0) and test/fixtures/context7 (@upstash/context7-mcp 4.4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  compactShopifySearch, unescapeLearn, compactShopifyTools, fillShopifyArgs, shopifyKeyArgs,
  compactResolve, trimDocs, compactContext7Tools, context7KeyArgs, isPinnedLibraryId, CONTEXT7_INSTRUCTIONS,
} = await import("../dist/docs-optimize.js");
const { docsCacheKey, readDocsCache, writeDocsCache } = await import("../dist/docs-cache.js");

// Upstream text is LF; a CRLF checkout of the fixtures must not change what is measured.
const fixture = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const saved = (a, b) => 1 - b.length / a.length;
const fences = (t) => t.match(/```[\s\S]*?```/g) ?? [];

// ── Shopify search_docs_chunks ──────────────────────────────────────────────
for (const name of ["search-cart-ajax.txt", "search-metafields-liquid.txt"]) {
  test(`compactShopifySearch ${name}: −15..35%, every url, title and content kept`, () => {
    const raw = fixture(`shopify-dev/${name}`);
    const { text, skip } = compactShopifySearch(raw);
    assert.equal(skip, undefined);
    const s = saved(raw, text);
    assert.ok(s > 0.15 && s < 0.35, `saved ${(s * 100).toFixed(1)}%`);
    for (const c of JSON.parse(raw)) {
      assert.ok(text.includes(c.url), c.url);
      assert.ok(text.includes(c.content), `content of ${c.url} kept whole`);
      if (c.title) assert.ok(text.includes(`## ${c.title}`));
    }
    assert.ok(!/"score"|"domain"/.test(text));
  });
}

test("compactShopifySearch drops an exact duplicate chunk", () => {
  const raw = fixture("shopify-dev/search-cart-ajax.txt");
  const chunks = JSON.parse(raw);
  const { text } = compactShopifySearch(raw);
  const blocks = text.split(/\n\n(?=## )/);
  assert.equal(blocks.length, new Set(chunks.map(c => c.url + "\0" + c.content)).size);
});

test("compactShopifySearch keeps chunks whose content differs only in the API version", () => {
  // Folding these used to leave the agent with only the first (older) version's code.
  const mk = (v) => ({ score: 0.4, content: `Code fetch('/admin/api/${v}/graphql.json', { method: 'POST' })`,
    url: `https://shopify.dev/docs/api/admin-rest/${v}/resources/product`, title: "Product", domain: null });
  const { text } = compactShopifySearch(JSON.stringify([mk("2024-01"), mk("2026-10")], null, 2));
  assert.ok(text.includes("/admin/api/2024-01/graphql.json") && text.includes("/admin/api/2026-10/graphql.json"));
  assert.equal(text.match(/## Product/g).length, 2);
  assert.ok(!text.includes("also:"));
});

test("compactShopifySearch folds a byte-identical chunk for another API version into `also:`", () => {
  const mk = (v) => ({ score: 0.4, content: "Target purchase.checkout.block.render renders a block. Code <s-text>Hi</s-text>",
    url: `https://shopify.dev/docs/api/checkout-ui-extensions/${v}/targets/block`, title: "Block target", domain: null });
  const raw = JSON.stringify([mk("2026-10"), mk("2026-07"), mk("2026-04"), { ...mk("2026-10"), content: "Other text", url: "https://shopify.dev/x" }], null, 2);
  const { text } = compactShopifySearch(raw);
  assert.equal(text.match(/renders a block/g).length, 1);
  assert.match(text, /\nalso: https:\/\/shopify\.dev\/docs\/api\/checkout-ui-extensions\/2026-07\/targets\/block, https:\/\/shopify\.dev\/docs\/api\/checkout-ui-extensions\/2026-04\/targets\/block\n/);
  assert.ok(text.includes("Other text"));
});

test("compactShopifySearch leaves an unknown format unchanged", () => {
  for (const raw of ["Search failed: network error", "[]", JSON.stringify([{ content: "x", url: "u", extra: 1 }]), "{}"]) {
    const r = compactShopifySearch(raw);
    assert.equal(r.text, raw);
    assert.ok(r.skip, raw);
  }
});

// ── Shopify learn_shopify_api ───────────────────────────────────────────────
test("unescapeLearn fixes the escaped fences in learn-liquid and keeps the unescaped tail", () => {
  const raw = fixture("shopify-dev/learn-liquid.txt");
  const { text, skip } = unescapeLearn(raw);
  assert.equal(skip, undefined);
  assert.ok(!text.includes("\\`"));
  assert.ok(text.includes("\n```\n"));
  assert.equal(text.match(/`/g).length, raw.match(/`/g).length, "no backtick lost");
  assert.equal(raw.length - text.length, raw.match(/\\`/g).length);
});

test("unescapeLearn leaves clean text and mixed escapes alone", () => {
  const admin = fixture("shopify-dev/learn-admin.txt");
  assert.deepEqual(unescapeLearn(admin), { text: admin });
  const mixed = "Use `x` here, then \\`y\\`";
  assert.equal(unescapeLearn(mixed).text, mixed);
  assert.equal(unescapeLearn(mixed).skip, "learn_mixed_backticks");
});

// ── Shopify tools/list and args ─────────────────────────────────────────────
test("compactShopifyTools: no feedback, no telemetry params, conversationId optional, raw added, −15%+", () => {
  const { tools } = JSON.parse(fixture("shopify-dev/tools-list.json"));
  const out = compactShopifyTools(tools);
  assert.deepEqual(out.map(t => t.name), tools.map(t => t.name).filter(n => n !== "feedback"));
  for (const t of out) {
    assert.ok(!t.inputSchema.$schema);
    assert.ok(!(t.inputSchema.required ?? []).includes("conversationId"), t.name);
    assert.ok(!t.inputSchema.properties.model && !t.inputSchema.properties.user_prompt);
    assert.ok(t.inputSchema.properties.conversationId, `${t.name} still accepts conversationId`);
  }
  const learn = out.find(t => t.name === "learn_shopify_api");
  assert.ok(!/`model`|user_prompt|feedback tool/.test(learn.description));
  assert.ok(learn.description.includes("Polaris Customer Account Extensions"), "per-API routing list kept");
  assert.ok(out.find(t => t.name === "search_docs_chunks").inputSchema.properties.raw);
  assert.ok(!out.find(t => t.name === "validate").inputSchema.properties.raw);
  assert.deepEqual(out.find(t => t.name === "validate").inputSchema.required, ["api", "code"]);
  assert.ok(saved(JSON.stringify(tools), JSON.stringify(out)) > 0.15);
  assert.ok(tools[0].inputSchema.$schema, "input not mutated");
});

test("fillShopifyArgs fills a missing conversationId only; keys ignore per-session args", () => {
  assert.deepEqual(fillShopifyArgs({ prompt: "x" }, "S"), { prompt: "x", conversationId: "S" });
  assert.deepEqual(fillShopifyArgs({ prompt: "x", conversationId: "mine" }, "S"), { prompt: "x", conversationId: "mine" });
  assert.deepEqual(shopifyKeyArgs({ prompt: "x", conversationId: "a", model: "m", user_prompt: "u", raw: true }), { prompt: "x" });
});

// ── Context7 resolve-library-id ─────────────────────────────────────────────
for (const name of ["resolve-nextjs.txt", "resolve-hydrogen.txt", "resolve-notfound.txt"]) {
  test(`compactResolve ${name}: one line per library, ids and order kept, −40%+`, () => {
    const raw = fixture(`context7/${name}`);
    const { text, skip } = compactResolve(raw);
    assert.equal(skip, undefined);
    const ids = [...raw.matchAll(/Context7-compatible library ID: (\S+)/g)].map(m => m[1]);
    const lines = text.split("\n").slice(1);
    assert.deepEqual(lines.map(l => l.split(" | ")[0]), ids);
    assert.ok(saved(raw, text) > 0.4, `saved ${(saved(raw, text) * 100).toFixed(1)}%`);
    for (const l of lines) assert.ok(l.split(" | ").at(-1).length <= 91, "description cut to ~90 chars");
  });
}

test("compactResolve drops __branch__ versions and keeps the real ones", () => {
  const { text } = compactResolve(fixture("context7/resolve-nextjs.txt"));
  assert.ok(!text.includes("__branch__"));
  assert.match(text, /versions: v14\.3\.0-canary\.87, .*v16\.2\.9 \|/);
});

test("compactResolve leaves an unknown format unchanged", () => {
  for (const raw of ["No libraries found.", "Available Libraries:\n\n- Title: X\n- Something odd\n", "**Note:** filtered\nAvailable Libraries:"]) {
    assert.equal(compactResolve(raw).text, raw);
    assert.ok(compactResolve(raw).skip);
  }
});

// ── Context7 query-docs ─────────────────────────────────────────────────────
for (const name of ["docs-nextjs-server-actions.txt", "docs-nextjs-middleware-ts.txt", "docs-vague.txt"]) {
  test(`trimDocs ${name}: code blocks byte-identical, titles and sources kept`, () => {
    const raw = fixture(`context7/${name}`);
    const { text, skip } = trimDocs(raw);
    assert.equal(skip, undefined);
    assert.deepEqual(fences(text), fences(raw));
    assert.deepEqual(text.match(/^### .*$/gm), raw.match(/^### .*$/gm));
    for (const [, org, repo, ref, path] of raw.matchAll(/^Source: https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(\S+)$/gm)) {
      assert.ok(text.includes(`Source: ${org}/${repo}@${ref}:${path}`));
    }
    const s = saved(raw, text);
    assert.ok(s > 0.01 && s < 0.1, `saved ${(s * 100).toFixed(1)}%`);
  });
}

test("trimDocs keeps a nested-fence APIDOC snippet intact", () => {
  const raw = fixture("context7/docs-vague.txt");
  const apidoc = raw.slice(raw.indexOf("```APIDOC"), raw.indexOf("--------------------------------", raw.indexOf("```APIDOC")));
  assert.ok(apidoc.split("```").length > 4, "fixture really nests fences");
  assert.ok(trimDocs(raw).text.includes(apidoc.replace(/^Source: .*$/m, "")));
});

test("trimDocs drops an exact duplicate snippet and passes unknown formats through", () => {
  const snip = "### T\n\nSource: https://example.com/a\n\nText.\n\n```js\nx()\n```";
  const sep = "\n--------------------------------\n";
  assert.equal(trimDocs([snip, snip].join(sep)).text, snip);
  for (const raw of [fixture("context7/docs-badid.txt"), "**Note:** something\n\n" + snip]) {
    assert.equal(trimDocs(raw).text, raw);
    assert.equal(trimDocs(raw).skip, "docs_unknown_format");
  }
});

// ── Context7 tools/list and args ────────────────────────────────────────────
test("compactContext7Tools + instructions: −50%+, params, required and annotations kept", () => {
  const { init, tools } = JSON.parse(fixture("context7/tools-list.json"));
  const out = compactContext7Tools(tools);
  const before = JSON.stringify(tools).length + init.instructions.length;
  const after = JSON.stringify(out).length + CONTEXT7_INSTRUCTIONS.length;
  assert.ok(1 - after / before > 0.5, `saved ${((1 - after / before) * 100).toFixed(1)}%`);
  for (const [i, t] of out.entries()) {
    assert.equal(t.name, tools[i].name);
    assert.deepEqual(t.annotations, tools[i].annotations);
    assert.deepEqual(t.inputSchema.required, tools[i].inputSchema.required);
    assert.deepEqual(Object.keys(t.inputSchema.properties), [...Object.keys(tools[i].inputSchema.properties), "raw"]);
    for (const [k, p] of Object.entries(tools[i].inputSchema.properties)) assert.equal(t.inputSchema.properties[k].type, p.type);
  }
  assert.match(out[0].description, /more than 3 times/);
});

test("compactContext7Tools keeps a description it does not recognise", () => {
  const t = [{ name: "resolve-library-id", description: "Something new", inputSchema: { type: "object", properties: { q: { type: "string", description: "d" } } } }];
  assert.equal(compactContext7Tools(t)[0].description, "Something new");
  assert.equal(compactContext7Tools(t)[0].inputSchema.properties.q.description, "d");
});

test("context7KeyArgs normalizes case/whitespace where it does not matter; pinned ids detected", () => {
  assert.deepEqual(context7KeyArgs({ libraryName: " Next.js ", query: " Routing ", raw: true }), { libraryName: "next.js", query: "Routing" });
  assert.deepEqual(context7KeyArgs({ libraryId: "/vercel/next.js", query: "q", language: "TypeScript" }), { libraryId: "/vercel/next.js", query: "q", language: "typescript" });
  assert.ok(isPinnedLibraryId("/vercel/next.js/v16.2.9"));
  assert.ok(!isPinnedLibraryId("/vercel/next.js"));
});

// ── Disk cache ──────────────────────────────────────────────────────────────
test("docs cache: key ignores arg order, separates servers/tools; ttl expiry and 0 = off", () => {
  assert.equal(docsCacheKey("c7", "query-docs", { a: 1, b: 2 }), docsCacheKey("c7", "query-docs", { b: 2, a: 1 }));
  assert.notEqual(docsCacheKey("c7", "query-docs", { a: 1 }), docsCacheKey("shopify-dev", "query-docs", { a: 1 }));
  assert.notEqual(docsCacheKey("c7", "query-docs", { a: 1 }), docsCacheKey("c7", "resolve-library-id", { a: 1 }));
  const dir = join(mkdtempSync(join(tmpdir(), "pg-docs-cache-")), "docs");
  const key = docsCacheKey("c7", "query-docs", { q: "x" });
  const result = { content: [{ type: "text", text: "hello" }] };
  assert.equal(readDocsCache(dir, key, 1000), null);
  writeDocsCache(dir, key, result, 1_000_000);
  assert.deepEqual(readDocsCache(dir, key, 1000, 1_000_500), result);
  assert.equal(readDocsCache(dir, key, 1000, 1_001_000), null, "expired");
  assert.equal(readDocsCache(dir, key, 0, 1_000_500), null, "ttl 0 = off");
  assert.deepEqual(readdirSync(dir), [`${key}.json`], "no temp file left behind");
});
