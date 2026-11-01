#!/usr/bin/env node
// Smoke check against the REAL Shopify Dev MCP and Context7 upstreams (needs network, not part
// of npm test). Drives PlayGuard over stdio like an agent would.
// Run: npm run build && node bench/smoke-docs.mjs [main|fail|privacy|list]
//   main    - list timing + list_changed, Shopify and Context7 calls, call log
//   fail    - CONTEXT7_MCP_CMD points to a nonexistent command (failure isolation)
//   privacy - dummy secrets in env must not reach any log/cache file
//   list    - print the non-browser tools and their input schemas
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mode = process.argv[2] ?? "main";
const dir = mkdtempSync(join(tmpdir(), `pg-smoke-docs-${mode}-`));
const baseEnv = {
  ...process.env,
  SHOPIFY_DEV_MCP_CMD: "npx -y @shopify/dev-mcp@latest",
  CONTEXT7_MCP_CMD: mode === "fail" ? "playguard-no-such-command-xyz" : "npx -y @upstash/context7-mcp@latest",
  PLAYWRIGHT_MCP_ARGS: "--headless --isolated",
  PLAYGUARD_UPDATE_CHECK: "false",
  PLAYGUARD_LOG_DIR: join(dir, "logs"),
  PLAYGUARD_OUTPUT_DIR: join(dir, "out"),
  PLAYGUARD_PROJECT_ROOT: dir,
  ...(mode === "privacy" ? { FIGMA_API_KEY: "sk-test-123", CONTEXT7_API_KEY: "ctx-test-456" } : {}),
};
const text = (r) => r.content.map(c => c.text ?? "").join("\n");
const results = [];
const check = (name, ok, evidence) => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${evidence ?? ""}`); };

async function open(extraEnv = {}) {
  const client = new Client({ name: "smoke-docs", version: "0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...baseEnv, ...extraEnv }, stderr: "ignore" }));
  return { client, changes: () => changed };
}
const names = (tools) => tools.map(t => t.name);
const call = async (client, name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const t = text(r);
  console.log(`  ${name.padEnd(24)} ${String(t.length).padStart(7)} chars ${Date.now() - t0}ms${r.isError ? " ERROR" : ""} ${JSON.stringify(args).slice(0, 80)}`);
  return { r, t };
};
const strip = (s) => s.replace(/artifact-[0-9a-f-]{36}/g, "artifact-ID");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (mode === "list") {
  const { client } = await open({ PLAYGUARD_LIST_WAIT_MS: "60000" });
  const { tools } = await client.listTools();
  for (const t of tools.filter(t => !t.name.startsWith("browser_"))) console.log(t.name, JSON.stringify(t.inputSchema).slice(0, 2500));
  await client.close();
  process.exit(0);
}

if (mode === "main") {
  // A. default list wait: immediate list, then the list_changed re-list.
  const a = await open();
  let t0 = Date.now();
  const first = (await a.client.listTools()).tools;
  console.log(`first tools/list: ${first.length} tools in ${Date.now() - t0}ms`);
  check("1a first list has browser_* tools", names(first).some(n => n.startsWith("browser_")), `${first.length} tools`);
  const instr = a.client.getInstructions();
  check("1b initialize instructions present", !!instr && instr.length > 0, `${instr?.length} chars`);
  const hadC7First = names(first).some(n => /resolve-library-id|query-docs/.test(n));
  console.log(`  context7 present in first list: ${hadC7First}`);
  let waited = 0;
  while (!hadC7First && a.changes() === 0 && waited < 90000) { await sleep(500); waited += 500; }
  const relist = (await a.client.listTools()).tools;
  const rn = names(relist);
  if (!hadC7First) check("1c list_changed notification arrived", a.changes() > 0, `after ~${waited}ms, count=${a.changes()}`);
  check("1d re-list has Context7 tools", rn.includes("resolve-library-id") && rn.includes("query-docs"), rn.filter(n => /library|docs/.test(n)).join(","));
  const shopify = relist.filter(t => !t.name.startsWith("browser_") && !["resolve-library-id", "query-docs"].includes(t.name));
  console.log("  non-browser, non-c7 tools:", names(shopify).join(", "));
  check("1e Shopify tools present", rn.includes("learn_shopify_api") && rn.includes("search_docs_chunks") && rn.includes("validate"), "");
  check("1f feedback tool hidden", !rn.some(n => /feedback/i.test(n)), "");
  const sdc = relist.find(t => t.name === "search_docs_chunks");
  check("1g conversationId not required", !(sdc?.inputSchema.required ?? []).includes("conversationId"), `required=${JSON.stringify(sdc?.inputSchema.required)}`);
  console.log(`  tools/list size: ${JSON.stringify(relist).length} chars`);

  // B. Shopify
  console.log("\nShopify");
  const l1 = await call(a.client, "learn_shopify_api", { api: "liquid" });
  const l2 = await call(a.client, "learn_shopify_api", { api: "liquid" });
  const l3 = await call(a.client, "learn_shopify_api", { api: "liquid", raw: true });
  check("2a learn first call returns text", !l1.r.isError && l1.t.length > 500, `${l1.t.length} chars`);
  // learn is the routing guide: a repeat returns the full body (a subagent sharing the process may never have seen it).
  check("2b learn repeat returns full body", !l2.r.isError && l2.t.length === l1.t.length, `${l2.t.length} vs ${l1.t.length} chars`);
  check("2c learn raw:true returns full", l3.t.length >= l1.t.length, `${l3.t.length} chars`);
  const q = { prompt: "product metafields liquid", max_num_results: 5 };
  const s1 = await call(a.client, "search_docs_chunks", q);
  const s2 = await call(a.client, "search_docs_chunks", q);
  const s3 = await call(a.client, "search_docs_chunks", { ...q, raw: true });
  check("2d search w/o conversationId works", !s1.r.isError && s1.t.length > 200 && /https?:\/\//.test(s1.t), `${s1.t.length} chars (raw ${s3.t.length}); head: ${JSON.stringify(s1.t.slice(0, 160))}`);
  check("2e search repeat -> cache/unchanged note", s2.t.length < s1.t.length / 2 && /unchanged|cache|same|already/i.test(s2.t), `${s2.t.length} chars: ${JSON.stringify(s2.t.slice(0, 200))}`);
  const bad = "query { products(first: 1) { nonexistentField } }";
  const vt = shopify.find(t => t.name === "validate");
  console.log("  validate schema:", JSON.stringify(vt?.inputSchema.properties).slice(0, 300));
  const vCall = { api: "admin", code: [{ content: bad }] };
  const v1 = await call(a.client, "validate", vCall);
  const v2 = await call(a.client, "validate", { ...vCall, raw: true });
  console.log("  validate output:", JSON.stringify(v1.t.slice(0, 400)));
  check("2f validate returns validation error untouched", /nonexistentField|invalid|error|FAIL/i.test(v1.t) && strip(v1.t) === strip(v2.t), `proxied ${v1.t.length} vs raw ${v2.t.length} chars, equal(modulo random artifact id)=${strip(v1.t) === strip(v2.t)}`);

  // C. Context7
  console.log("\nContext7");
  const r1 = await call(a.client, "resolve-library-id", { libraryName: "next.js", query: "app router middleware" });
  const r2 = await call(a.client, "resolve-library-id", { libraryName: "next.js", query: "app router middleware", raw: true });
  const ids = [...r1.t.matchAll(/\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?/g)].map(m => m[0]);
  const lines = r1.t.split("\n").filter(l => l.trim()).length;
  console.log("  compact head:", JSON.stringify(r1.t.slice(0, 400)));
  check("3a resolve compact one-line-per-library", ids.length > 0 && r1.t.length < r2.t.length, `${r1.t.length} vs raw ${r2.t.length} chars, ${lines} lines, first id ${ids[0]}`);
  const id = ids.find(i => /next/i.test(i)) ?? ids[0];
  const d1 = await call(a.client, "query-docs", { libraryId: id, query: "middleware matcher example" });
  const d2 = await call(a.client, "query-docs", { libraryId: id, query: "middleware matcher example", raw: true });
  const fences = (s) => (s.match(/```/g) ?? []).length;
  check("3b query-docs snippets intact", !d1.r.isError && d1.t.length > 500 && fences(d1.t) >= 2 && d1.t.length >= d2.t.length * 0.8, `id=${id} ${d1.t.length} vs raw ${d2.t.length} chars; fences ${fences(d1.t)}/${fences(d2.t)}`);
  await a.client.close();

  // Large wait: everything in the first list.
  const b = await open({ PLAYGUARD_LIST_WAIT_MS: "90000" });
  t0 = Date.now();
  const bl = names((await b.client.listTools()).tools);
  check("1h large wait: first list has all three upstreams", bl.some(n => n.startsWith("browser_")) && bl.includes("learn_shopify_api") && bl.includes("query-docs"), `${bl.length} tools in ${Date.now() - t0}ms`);
  await b.client.close();
  // Tiny list wait: Context7 must be missing from the first list and arrive via list_changed.
  const c = await open({ PLAYGUARD_LIST_WAIT_MS: "300" });
  t0 = Date.now();
  const cf = names((await c.client.listTools()).tools);
  console.log(`  tiny-wait first list: ${cf.length} tools in ${Date.now() - t0}ms, context7=${cf.includes("query-docs")}, shopify=${cf.includes("learn_shopify_api")}`);
  let cw = 0;
  while (c.changes() === 0 && cw < 90000) { await sleep(250); cw += 250; }
  let cr = names((await c.client.listTools()).tools);
  console.log(`  after 1st notification (count ${c.changes()}): ${cr.length} tools, shopify=${cr.includes("learn_shopify_api")}, context7=${cr.includes("query-docs")}`);
  for (let i = 0; i < 40 && !(cr.includes("query-docs") && cr.includes("learn_shopify_api")); i++) { await sleep(500); cr = names((await c.client.listTools()).tools); }
  check("1c list_changed arrives and re-list is complete", c.changes() > 0 && cr.includes("query-docs") && cr.includes("learn_shopify_api") && cr.some(n => n.startsWith("browser_")), `first=${cf.length} tools, notification after ~${cw}ms (count ${c.changes()}), re-list=${cr.length} tools`);
  await c.client.close();
}

if (mode === "fail") {  const a = await open();
  const tools = (await a.client.listTools()).tools;
  const n = names(tools);
  check("4a list has Playwright + Shopify with dead Context7", n.some(x => x.startsWith("browser_")) && n.includes("learn_shopify_api") && !n.includes("query-docs"), `${n.length} tools`);
  await sleep(3000);
  let err;
  try {
    const r = await a.client.callTool({ name: "query-docs", arguments: { libraryId: "/vercel/next.js", query: "x" } });
    err = r.isError ? text(r) : `unexpected success: ${text(r).slice(0, 100)}`;
  } catch (e) { err = String(e.message ?? e); }
  console.log("  context7 call error:", JSON.stringify(err.slice(0, 300)));
  check("4b Context7 call fails with clear error", /context7|unavailable|not (available|found|connected)|unknown tool|ENOENT|spawn/i.test(err), err.slice(0, 120));
  const ok = await call(a.client, "learn_shopify_api", { api: "liquid" });
  check("4c process stays up, Shopify still works", !ok.r.isError && ok.t.length > 500, `${ok.t.length} chars`);
  await a.client.close();
}

if (mode === "privacy") {
  const a = await open({ PLAYGUARD_LIST_WAIT_MS: "90000" });
  await a.client.listTools();
  await call(a.client, "learn_shopify_api", { api: "liquid" });
  await call(a.client, "search_docs_chunks", { prompt: "metafields", max_num_results: 3 });
  const r = await call(a.client, "resolve-library-id", { libraryName: "react", query: "hooks" });
  const id = /\/[\w.-]+\/[\w.-]+/.exec(r.t)?.[0];
  if (id) await call(a.client, "query-docs", { libraryId: id, query: "useEffect" });
  await a.client.close();
  const hits = [], files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else { files.push(p); if (/sk-test-123|ctx-test-456/.test(readFileSync(p, "utf8"))) hits.push(p); }
    }
  };
  walk(dir);
  check("6 secrets absent from all log/cache files", hits.length === 0, `${files.length} files scanned under ${dir}; hits: ${hits.join(",") || "none"}`);
}

console.log(`\ndir: ${dir}`);
if (mode === "main") {
  const rows = readdirSync(join(dir, "logs")).flatMap(f => readFileSync(join(dir, "logs", f), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)));
  const sh = rows.filter(e => e.server === "shopify-dev");
  console.log(`call log: ${rows.length} rows, shopify-dev ${sh.length}, context7 ${rows.filter(e => e.server === "context7").length}, cached=${rows.filter(e => e.cached).length}`);
  console.log("sample:", JSON.stringify(sh.find(e => e.cached) ?? sh[0]));
  check("2g call log has server:shopify-dev and cached", sh.length > 0 && rows.some(e => e.cached), "");
}
const failed = results.filter(r => !r[1]);
console.log(failed.length ? `\n${failed.length} FAILED` : "\nOK");