#!/usr/bin/env node
// Research probe for the Shopify Dev MCP (needs network, not part of npm test). Talks to the
// upstream DIRECTLY (no PlayGuard in between) and records what an optimizer would care about:
// initialize result, tools/list size per tool, response size/latency/structure per call, and
// whether a repeat with the same args is byte-identical (cacheability).
// Run: node bench/probe-shopify-dev.mjs [outDir]
// Upstream: SHOPIFY_DEV_MCP_CMD if set, else `npx -y @shopify/dev-mcp@1.18.0`.
// Telemetry is switched off (OPT_OUT_INSTRUMENTATION=true, DO_NOT_TRACK=1): with it on, the
// published build posts tool inputs AND results to https://shopify.dev/mcp/usage.
// Raw responses land in outDir (default: a temp dir) as <label>.txt plus summary.json.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";

const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "pg-probe-shopify-"));
mkdirSync(outDir, { recursive: true });
const [cmd, ...cmdArgs] = (process.env.SHOPIFY_DEV_MCP_CMD ?? "npx -y @shopify/dev-mcp@1.18.0").split(" ");
const isWin = process.platform === "win32";
const baseEnv = { ...process.env, OPT_OUT_INSTRUMENTATION: "true", DO_NOT_TRACK: "1" };
// Do not leak the host agent's session id into the upstream (it reads CLAUDE_CODE_SESSION_ID etc.).
for (const k of ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CURSOR_SESSION_ID", "COPILOT_SESSION_ID"]) delete baseEnv[k];

const summary = { upstream: [cmd, ...cmdArgs].join(" "), starts: [], calls: [] };
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const text = (r) => (r.content ?? []).map(c => c.text ?? `[${c.type}]`).join("\n");

async function start(label, extraEnv = {}) {
  const client = new Client({ name: "probe-shopify-dev", version: "0" });
  const t0 = Date.now();
  // npx is a .cmd shim on Windows; spawn it through cmd.exe.
  const transport = isWin && cmd === "npx"
    ? new StdioClientTransport({ command: "cmd", args: ["/c", cmd, ...cmdArgs], env: { ...baseEnv, ...extraEnv }, stderr: "ignore" })
    : new StdioClientTransport({ command: cmd, args: cmdArgs, env: { ...baseEnv, ...extraEnv }, stderr: "ignore" });
  await client.connect(transport);
  const ms = Date.now() - t0;
  summary.starts.push({ label, ms });
  console.log(`start ${label}: ${ms} ms`);
  return client;
}

function shape(t) {
  return {
    headings: (t.match(/^#{1,6} /gm) ?? []).length,
    urls: (t.match(/https?:\/\/\S+/g) ?? []).length,
    codeFences: (t.match(/^```/gm) ?? []).length / 2,
    jsonLike: /^\s*[[{]/.test(t),
    indentBytes: (t.match(/^[ \t]+/gm) ?? []).reduce((n, s) => n + s.length, 0),
    emoji: (t.match(/\p{Extended_Pictographic}/gu) ?? []).length,
  };
}

async function call(client, label, name, args) {
  const t0 = Date.now();
  let r, err;
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  const t = err ? `PROTOCOL ERROR: ${err.message}` : text(r);
  writeFileSync(join(outDir, `${label}.txt`), t);
  const rec = { label, name, args: JSON.stringify(args).slice(0, 160), ms, chars: t.length, isError: !!(err || r?.isError), sha: sha(t), ...shape(t) };
  summary.calls.push(rec);
  console.log(`${label.padEnd(30)} ${String(t.length).padStart(7)} chars ${String(ms).padStart(6)} ms ${rec.isError ? "ERROR " : ""}sha=${rec.sha}`);
  return t;
}

// A tiny theme with one good and one broken file for validate_theme.
const themeDir = mkdtempSync(join(tmpdir(), "pg-probe-theme-"));
for (const d of ["layout", "sections", "snippets", "templates", "config", "locales", "assets", "blocks"]) mkdirSync(join(themeDir, d));
writeFileSync(join(themeDir, "snippets", "price-badge.liquid"),
  "{%- liquid\n  assign on_sale = false\n  if product.compare_at_price > product.price\n    assign on_sale = true\n  endif\n-%}\n{% if on_sale %}<span class=\"badge\">{{ 'products.sale' | t }}</span>{% endif %}\n{{ product.price | money }}\n");
writeFileSync(join(themeDir, "snippets", "broken-card.liquid"),
  "{% for p in collection.products limit: 4 %}\n  <a href=\"{{ p.url }}\">{{ p.titel | escpe }}</a>\n  {{ p.metafields.custom.swatch.text }}\n{% endfor\n");
writeFileSync(join(themeDir, "locales", "en.default.json"), JSON.stringify({ products: { sale: "Sale" } }));

const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

try {
  // ---- Session 1: default config (LIQUID_VALIDATION_MODE=full)
  const c1 = await start("first");
  const init = { server: c1.getServerVersion(), capabilities: c1.getServerCapabilities(), instructions: c1.getInstructions() ?? null };
  const { tools } = await c1.listTools();
  const toolsJson = JSON.stringify(tools);
  summary.initialize = init;
  summary.toolsList = {
    count: tools.length, bytes: toolsJson.length, approxTokens: Math.round(toolsJson.length / 4),
    perTool: tools.map(t => ({ name: t.name, descBytes: t.description.length, schemaBytes: JSON.stringify(t.inputSchema).length })),
  };
  writeFileSync(join(outDir, "tools-list.json"), JSON.stringify({ initialize: init, tools }, null, 2));
  console.log(`tools/list: ${tools.length} tools, ${toolsJson.length} bytes (~${summary.toolsList.approxTokens} tokens)`);
  for (const p of summary.toolsList.perTool) console.log(`  ${p.name.padEnd(22)} desc ${p.descBytes}  schema ${p.schemaBytes}`);
  for (const [k, fn] of [["prompts", () => c1.listPrompts()], ["resources", () => c1.listResources()]]) {
    try { const r = await fn(); summary[k] = r; console.log(`${k}/list: ${JSON.stringify(r).length} bytes`); }
    catch (e) { summary[k] = `error: ${e.message}`; console.log(`${k}/list: ${e.message}`); }
  }

  // Errors first: tools that need a conversationId, called without / with a made-up one.
  await call(c1, "err-search-no-convid", "search_docs_chunks", { prompt: "cart ajax api" });
  await call(c1, "err-search-fake-convid", "search_docs_chunks", { conversationId: "not-a-real-id", prompt: "cart ajax api" });
  await call(c1, "err-validate-liquid-in-full", "validate", { conversationId: "not-a-real-id", api: "liquid", code: [{ content: "{{ product.title }}" }] });

  const userPrompt = "Add a sale badge to the product card snippet using metafields";
  const learnLiquid = await call(c1, "learn-liquid", "learn_shopify_api", { api: "liquid", model: "none", user_prompt: userPrompt });
  const conv = uuidRe.exec(learnLiquid)?.[0];
  console.log(`conversationId: ${conv}`);
  await call(c1, "learn-liquid-same-conv", "learn_shopify_api", { api: "liquid", conversationId: conv, model: "none", user_prompt: userPrompt });
  await call(c1, "learn-liquid-new-conv", "learn_shopify_api", { api: "liquid", model: "none", user_prompt: userPrompt });
  await call(c1, "learn-admin", "learn_shopify_api", { api: "admin", conversationId: conv, model: "none", user_prompt: "query products with metafields" });
  await call(c1, "learn-custom-data", "learn_shopify_api", { api: "custom-data", conversationId: conv, model: "none", user_prompt: userPrompt });
  await call(c1, "learn-storefront", "learn_shopify_api", { api: "storefront-graphql", conversationId: conv, model: "none", user_prompt: "cart api" });
  await call(c1, "learn-admin-bad-version", "learn_shopify_api", { api: "admin", version: "2023-01", conversationId: conv, model: "none" });

  await call(c1, "search-cart-ajax", "search_docs_chunks", { conversationId: conv, prompt: "cart ajax api add to cart /cart/add.js" });
  await call(c1, "search-cart-ajax-repeat", "search_docs_chunks", { conversationId: conv, prompt: "cart ajax api add to cart /cart/add.js" });
  await call(c1, "search-metafields-liquid", "search_docs_chunks", { conversationId: conv, prompt: "access product metafields in liquid" });
  await call(c1, "search-section-schema", "search_docs_chunks", { conversationId: conv, prompt: "section schema settings blocks presets", api_name: "liquid" });
  await call(c1, "search-admin-product", "search_docs_chunks", { conversationId: conv, prompt: "productUpdate mutation metafields", api_name: "admin" });
  await call(c1, "search-admin-product-max3", "search_docs_chunks", { conversationId: conv, prompt: "productUpdate mutation metafields", api_name: "admin", max_num_results: 3 });

  const goodGql = "query ProductWithMetafields($id: ID!) {\n  product(id: $id) {\n    id\n    title\n    metafields(first: 10, namespace: \"custom\") {\n      nodes { key type value }\n    }\n  }\n}";
  const badGql = "query {\n  products(first: 5) {\n    edges { node { id title price swatchColor variants(first: 2) { nodes { sku inventoryCount } } } }\n  }\n}";
  await call(c1, "validate-admin-good", "validate", { conversationId: conv, api: "admin", code: [{ content: goodGql }] });
  await call(c1, "validate-admin-good-repeat", "validate", { conversationId: conv, api: "admin", code: [{ content: goodGql }] });
  await call(c1, "validate-admin-bad", "validate", { conversationId: conv, api: "admin", code: [{ content: badGql }] });
  await call(c1, "validate-storefront-cart", "validate", { conversationId: conv, api: "storefront-graphql", code: [{ content: "mutation { cartCreate(input: { lines: [{ merchandiseId: \"gid://shopify/ProductVariant/1\", quantity: 1 }] }) { cart { id checkoutUrl totalQuantity } userErrors { field message } } }" }] });
  await call(c1, "validate-theme", "validate_theme", { conversationId: conv, absoluteThemePath: themeDir, filesCreatedOrUpdated: [{ path: "snippets/price-badge.liquid" }, { path: "snippets/broken-card.liquid" }] });
  await call(c1, "validate-theme-repeat", "validate_theme", { conversationId: conv, absoluteThemePath: themeDir, filesCreatedOrUpdated: [{ path: "snippets/price-badge.liquid" }, { path: "snippets/broken-card.liquid" }] });
  await c1.close();

  // ---- Session 2: warm start (npx cache populated) + LIQUID_VALIDATION_MODE=partial
  const c2 = await start("warm-partial", { LIQUID_VALIDATION_MODE: "partial" });
  const { tools: t2 } = await c2.listTools();
  summary.toolsListPartial = { count: t2.length, bytes: JSON.stringify(t2).length, names: t2.map(t => t.name) };
  console.log(`tools/list (partial): ${t2.map(t => t.name).join(", ")} ${summary.toolsListPartial.bytes} bytes`);
  const l2 = await call(c2, "partial-learn-liquid", "learn_shopify_api", { api: "liquid", model: "none" });
  const conv2 = uuidRe.exec(l2)?.[0];
  await call(c2, "partial-validate-liquid", "validate", { conversationId: conv2, api: "liquid", code: [
    { content: "{% for p in collection.products %}{{ p.titel | escpe }}{% endfor", fileName: "broken-card.liquid", fileType: "snippets", context: "theme" },
    { content: "{{ product.title | escape }}", fileName: "title.liquid", fileType: "snippets", context: "theme" },
  ] });
  await c2.close();
} finally {
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nraw responses + summary.json in ${outDir}`);
}
