#!/usr/bin/env node
// Smoke check against the real Chrome DevTools MCP (needs Chrome and network, not part of
// npm test). Drives PlayGuard over stdio like an agent would: acts only on uids read from
// the COMPACTED snapshot, fills and submits a real form, checks UNCHANGED/delta, then prints
// upstream vs sent bytes per tool from the call log.
// Run: npm run build && node bench/smoke-devtools.mjs
// Upstream: DEVTOOLS_MCP_CMD if set, else `npx -y chrome-devtools-mcp@1.12.0`.
// PLAYGUARD_DEVTOOLS_OPTIMIZE=false gives the passthrough baseline (the asserts that
// depend on compaction are skipped).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import assert from "node:assert/strict";

const optimize = process.env.PLAYGUARD_DEVTOOLS_OPTIMIZE !== "false";
const dir = mkdtempSync(join(tmpdir(), "pg-smoke-dt-"));
const env = {
  ...process.env,
  DEVTOOLS_MCP_CMD: process.env.DEVTOOLS_MCP_CMD ?? "npx -y chrome-devtools-mcp@1.12.0",
  DEVTOOLS_MCP_ARGS: process.env.DEVTOOLS_MCP_ARGS ?? "--headless --isolated",
  PLAYWRIGHT_MCP_ARGS: process.env.PLAYWRIGHT_MCP_ARGS ?? "--headless --isolated",
  PLAYGUARD_UPDATE_CHECK: "false",
  PLAYGUARD_LOG_DIR: join(dir, "logs"),
  PLAYGUARD_OUTPUT_DIR: join(dir, "out"),
};
const client = new Client({ name: "smoke-devtools", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));

const text = (r) => r.content.map(c => c.text ?? "").join("\n");
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const t = text(r);
  console.log(`${name.padEnd(26)} ${String(t.length).padStart(7)} chars${r.isError ? "  ERROR" : ""}  ${JSON.stringify(args).slice(0, 70)}`);
  return { r, t };
};
// uid of the first node with this role whose name starts with `name`, read from the text the agent got.
const uidOf = (t, role, name) => {
  const m = new RegExp(`uid=(\\S+) ${role} "${name}`).exec(t);
  assert.ok(m, `no ${role} "${name}" in the compacted snapshot`);
  return m[1];
};

try {
  const { tools } = await client.listTools();
  const dt = tools.filter(t => !t.name.startsWith("browser_"));
  console.log(`tools/list: ${tools.length} tools (${dt.length} DevTools), ${JSON.stringify(tools).length} chars (DevTools ${JSON.stringify(dt).length})\n`);

  // 1. Actionability: fill and submit a real form using only uids from the compacted snapshot.
  await call("navigate_page", { type: "url", url: "https://httpbin.org/forms/post" });
  const { t: form } = await call("take_snapshot");
  await call("fill_form", { elements: [
    { uid: uidOf(form, "textbox", "Customer name"), value: "PlayGuard Smoke" },
    { uid: uidOf(form, "textbox", "E-mail"), value: "smoke@example.com" },
  ] });
  await call("click", { uid: uidOf(form, "radio", "Large") });
  await call("click", { uid: uidOf(form, "checkbox", "Onion") });
  if (optimize) {
    const { t: delta } = await call("take_snapshot");
    assert.match(delta, /\[PlayGuard (delta|compact)/, "no compaction marker after a small change");
    const { t: same } = await call("take_snapshot");
    assert.match(same, /UNCHANGED/, "repeat snapshot without a change is not UNCHANGED");
  }
  const { t: posted } = await call("click", { uid: uidOf(form, "button", "Submit order") });
  assert.match(posted, /navigated to https:\/\/httpbin\.org\/post/);
  const { t: echo } = await call("evaluate_script", { function: "() => document.body.innerText" });
  for (const v of ["PlayGuard Smoke", "smoke@example.com", "large", "onion"]) assert.ok(echo.includes(v), `form echo misses ${v}`);
  console.log("form submitted with all values\n");

  // 2. Heavy pages: snapshot, network list and details, raw:true for the upstream size.
  for (const url of ["https://playguard.dev/", "https://en.wikipedia.org/wiki/Main_Page", "https://www.allbirds.com/"]) {
    await call("navigate_page", { type: "url", url });
    await call("take_snapshot");
    await call("take_snapshot", { raw: true });
    await call("take_snapshot", { verbose: true });
    const { t: net } = await call("list_network_requests");
    const doc = /reqid=(\d+) GET \S+ \[200\]/.exec(net);
    if (doc) {
      await call("get_network_request", { reqid: +doc[1] });
      await call("get_network_request", { reqid: +doc[1], raw: true });
    }
  }

  // 3. Trace: the insight names and set id survive the trim and still resolve.
  await call("navigate_page", { type: "url", url: "https://playguard.dev/" });
  const { t: trace } = await call("performance_start_trace", { reload: true, autoStop: true });
  const set = /insight set id: (\S+)/.exec(trace)?.[1];
  const insight = /insight name: (\S+)/.exec(trace)?.[1];
  assert.ok(set && insight, "trace lost its insight set id / insight names");
  const { r: ins } = await call("performance_analyze_insight", { insightSetId: set, insightName: insight });
  assert.ok(!ins.isError, `analyze_insight failed: ${text(ins)}`);

  // 4. Stale uid after navigation gets the actionable hint.
  const { r: stale, t: staleText } = await call("click", { uid: uidOf(form, "button", "Submit order") });
  assert.ok(stale.isError);
  if (optimize) assert.match(staleText, /\[PlayGuard\] The uid comes from an older snapshot/);
} finally {
  await client.close();
}

// Upstream vs sent bytes per tool, straight from PlayGuard's call log.
const rows = readdirSync(env.PLAYGUARD_LOG_DIR).flatMap(f =>
  readFileSync(join(env.PLAYGUARD_LOG_DIR, f), "utf8").trim().split("\n").map(l => JSON.parse(l)));
const by = {};
for (const e of rows.filter(e => e.server === "devtools" && e.rawBytes != null)) {
  const k = e.tool + (e.raw ? " (raw)" : "");
  const s = by[k] ??= { n: 0, raw: 0, kept: 0 };
  s.n++; s.raw += e.rawBytes; s.kept += e.keptBytes;
}
console.log(`\n${"tool".padEnd(34)} calls  upstream KB   sent KB  saved`);
for (const [k, s] of Object.entries(by).sort((a, b) => b[1].raw - a[1].raw))
  console.log(`${k.padEnd(34)} ${String(s.n).padStart(5)} ${(s.raw / 1024).toFixed(1).padStart(12)} ${(s.kept / 1024).toFixed(1).padStart(9)}  ${s.raw ? Math.round((1 - s.kept / s.raw) * 100) : 0}%`);
console.log(`\nOK (logs: ${env.PLAYGUARD_LOG_DIR})`);
