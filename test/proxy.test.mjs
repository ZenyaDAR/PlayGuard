// Run: npm test. Drives the real dist/index.js over stdio against a fake upstream
// (test/fixtures/fake-pw.mjs), so the CallTool handler — logging, caches, retries,
// redirects — is covered, not just the pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, "..", "dist", "index.js");
const FAKE = resolve(here, "fixtures", "fake-pw.mjs");

async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pg-proxy-"));
  const calls = join(dir, "calls.ndjson");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      PLAYWRIGHT_MCP_CMD: process.execPath,
      PLAYWRIGHT_MCP_ARGS: `"${FAKE}" "${calls}"`,
      PLAYGUARD_LOG_DIR: join(dir, "logs"),
      PLAYGUARD_OUTPUT_DIR: join(dir, "out"),
      PLAYGUARD_UPDATE_CHECK: "false",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "proxy-test", version: "0" });
  await client.connect(transport);
  const lines = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    // logCall uses async appendFile — give it a beat to land.
    log: async () => {
      await new Promise(r => setTimeout(r, 100));
      const d = join(dir, "logs");
      return existsSync(d) ? readdirSync(d).flatMap(f => lines(join(d, f))) : [];
    },
    upstream: () => lines(calls).filter(c => c.name),
    argv: () => lines(calls).filter(c => c.argv).map(c => c.argv),
    close: () => client.close(),
  };
}

const text = (r) => r.content.map(c => c.text ?? "").join("");

// ── Regression: behavior that existed before 0.8.0 ──────────────────────────
test("proxy: navigate is logged with the pre-call url", async () => {
  const pg = await start();
  try {
    await pg.call("browser_navigate", { url: "https://a.test/" });
    await pg.call("browser_navigate", { url: "https://b.test/" });
    const nav = (await pg.log()).filter(l => l.tool === "browser_navigate");
    assert.equal(nav.length, 2);
    assert.equal(nav[0].err, false);
    assert.equal(typeof nav[0].ms, "number");
    assert.equal(nav[0].url, undefined);
    assert.equal(nav[1].url, "https://a.test/");
  } finally { await pg.close(); }
});

test("proxy: identical evaluates within TTL hit the eval cache; a click clears it", async () => {
  const pg = await start({ PLAYGUARD_EVAL_CACHE_TTL: "60000" });
  try {
    await pg.call("browser_evaluate", { function: "() => 42" });
    await pg.call("browser_evaluate", { function: "() => 42" });
    assert.equal(pg.upstream().filter(c => c.name === "browser_evaluate").length, 1);
    assert.ok((await pg.log()).some(l => l.evalCacheHit === true));
    await pg.call("browser_click", { target: "e8" });
    await pg.call("browser_evaluate", { function: "() => 42" });
    assert.equal(pg.upstream().filter(c => c.name === "browser_evaluate").length, 2);
  } finally { await pg.close(); }
});

test("proxy: snapshot is compacted and logs raw/kept bytes", async () => {
  const pg = await start();
  try {
    const r = await pg.call("browser_snapshot");
    assert.ok(!text(r).includes("Lorem ipsum"), "non-interactive paragraph should be stripped");
    assert.ok(text(r).includes("[ref=e8]"));
    const snap = (await pg.log()).find(l => l.tool === "browser_snapshot");
    assert.ok(snap.rawBytes > snap.keptBytes);
  } finally { await pg.close(); }
});

test("proxy: a dead-browser error revives once and replays the last url", async () => {
  const pg = await start();
  try {
    await pg.call("browser_navigate", { url: "https://a.test/" });
    const r = await pg.call("browser_click", { target: "dead" });
    assert.ok(!r.isError);
    const up = pg.upstream();
    const reviveNav = up.findIndex((c, i) => i > 1 && c.name === "browser_navigate");
    assert.equal(up[reviveNav].args.url, "https://a.test/");
    assert.equal(up.filter(c => c.args?.target === "dead").length, 2);
    assert.ok((await pg.log()).some(l => l.tool === "browser_click" && l.retried === true));
  } finally { await pg.close(); }
});

test("proxy: redirect mode serves a snapshot for a non-visual screenshot", async () => {
  const pg = await start({ PLAYGUARD_SCREENSHOTS: "redirect" });
  try {
    const r = await pg.call("browser_take_screenshot");
    assert.ok(text(r).includes("snapshot served instead of screenshot"));
    const names = pg.upstream().map(c => c.name);
    assert.ok(names.includes("browser_snapshot"));
    assert.ok(!names.includes("browser_take_screenshot"));
  } finally { await pg.close(); }
});

test("proxy: listTools keeps the snapshot params and the redirect visual flag", async () => {
  const pg = await start({ PLAYGUARD_SCREENSHOTS: "redirect" });
  try {
    const { tools } = await pg.client.listTools();
    const snap = tools.find(t => t.name === "browser_snapshot");
    assert.ok(snap.inputSchema.properties.section && snap.inputSchema.properties.around && snap.inputSchema.properties.depth);
    assert.ok(tools.find(t => t.name === "browser_take_screenshot").inputSchema.properties.visual);
  } finally { await pg.close(); }
});

// ── 0.8.0: error text, argument shape, codegen, prefetch, hints ─────────────
test("proxy: an isError result logs its error text; successes carry none", async () => {
  const pg = await start();
  try {
    await pg.call("browser_click", { target: "timeout" });
    await pg.call("browser_click", { target: "e8" });
    const clicks = (await pg.log()).filter(l => l.tool === "browser_click");
    assert.equal(clicks[0].err, true);
    assert.match(clicks[0].errText, /Timeout 5000ms/);
    assert.ok(!clicks[0].errText.includes("\n"));
    assert.equal(clicks[1].errText, undefined);
  } finally { await pg.close(); }
});

test("proxy: an upstream exception is still logged, and still reaches the client", async () => {
  const pg = await start();
  try {
    await assert.rejects(pg.call("browser_click", { target: "throw" }));
    const row = (await pg.log()).find(l => l.tool === "browser_click");
    assert.equal(row?.thrown, true);
    assert.equal(row.err, true);
    assert.match(row.errText, /fake upstream exploded/);
  } finally { await pg.close(); }
});

test("proxy: wait_for, run_code and screenshot log their argument shape", async () => {
  const pg = await start();
  try {
    await pg.call("browser_wait_for", { time: 5 });
    await pg.call("browser_wait_for", { text: "Hi" });
    const code = "async (page) => { await page.waitForTimeout(500); await page.waitForTimeout(500); }";
    await pg.call("browser_run_code_unsafe", { code });
    await pg.call("browser_take_screenshot", { fullPage: true, type: "jpeg" });
    await pg.call("browser_evaluate", { function: "() => 1" });
    const log = await pg.log();
    const waits = log.filter(l => l.tool === "browser_wait_for");
    assert.equal(waits[0].waitKind, "time");
    assert.equal(waits[0].waitTime, 5);
    assert.equal(waits[1].waitKind, "text");
    assert.equal(waits[1].waitTime, undefined);
    const run = log.find(l => l.tool === "browser_run_code_unsafe");
    assert.equal(run.codeChars, code.length);
    assert.equal(run.codeSleeps, 2);
    assert.match(run.codeHash, /^[0-9a-f]{8}$/);
    const shot = log.find(l => l.tool === "browser_take_screenshot");
    assert.equal(shot.fullPage, true);
    assert.equal(shot.type, "jpeg");
    const ev = log.find(l => l.tool === "browser_evaluate");
    assert.match(ev.scriptHash, /^[0-9a-f]{8}$/);
    assert.equal(typeof ev.outputBytes, "number");
  } finally { await pg.close(); }
});

test("proxy: a custom upstream (PLAYWRIGHT_MCP_CMD) gets no --codegen flag", async () => {
  const pg = await start();
  try {
    await pg.call("browser_navigate", { url: "https://a.test/" });
    const argv = pg.argv()[0];
    assert.ok(!argv.includes("--codegen"));
    assert.ok(argv.includes("--output-dir"));
  } finally { await pg.close(); }
});

test("proxy: prefetch is off by default — navigate sends exactly one upstream call", async () => {
  const pg = await start();
  try {
    await pg.call("browser_navigate", { url: "https://a.test/" });
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(pg.upstream().map(c => c.name), ["browser_navigate"]);
  } finally { await pg.close(); }
});

test("proxy: PLAYGUARD_PREFETCH_SNAPSHOT=true still prefetches and serves the hit", async () => {
  const pg = await start({ PLAYGUARD_PREFETCH_SNAPSHOT: "true" });
  try {
    await pg.call("browser_navigate", { url: "https://a.test/" });
    await new Promise(r => setTimeout(r, 300));
    assert.ok(pg.upstream().some(c => c.name === "browser_snapshot"));
    await pg.call("browser_snapshot");
    assert.ok((await pg.log()).some(l => l.tool === "browser_snapshot" && l.prefetchHit === true));
  } finally { await pg.close(); }
});

test("proxy: with prefetch on, an evaluate between navigate and snapshot forces a fresh snapshot", async () => {
  const pg = await start({ PLAYGUARD_PREFETCH_SNAPSHOT: "true" });
  try {
    await pg.call("browser_navigate", { url: "https://a.test/" });
    await new Promise(r => setTimeout(r, 300));
    await pg.call("browser_evaluate", { function: "() => 1" });
    const r = await pg.call("browser_snapshot");
    assert.ok(!text(r).includes("UNCHANGED"));
    assert.equal(pg.upstream().filter(c => c.name === "browser_snapshot").length, 2);
  } finally { await pg.close(); }
});

test("proxy: listTools adds batching hints; PLAYGUARD_HINTS=false leaves descriptions alone", async () => {
  const on = await start();
  try {
    const { tools } = await on.client.listTools();
    assert.match(tools.find(t => t.name === "browser_evaluate").description, /\[PlayGuard\]/);
  } finally { await on.close(); }
  const off = await start({ PLAYGUARD_HINTS: "false" });
  try {
    const { tools } = await off.client.listTools();
    assert.equal(tools.find(t => t.name === "browser_evaluate").description, "fake browser_evaluate");
  } finally { await off.close(); }
});

// ── Update check ─────────────────────────────────────────────────────────────
test("proxy: a newer version on the registry is announced once, on the first tool result", async () => {
  const { createServer } = await import("http");
  const registry = createServer((req, res) => {
    res.end(JSON.stringify(req.url === "/playguard/latest" ? { version: "999.0.0" } : {}));
  });
  await new Promise(r => registry.listen(0, "127.0.0.1", r));
  const pg = await start({ PLAYGUARD_UPDATE_CHECK: "true", npm_config_registry: `http://127.0.0.1:${registry.address().port}` });
  try {
    await new Promise(r => setTimeout(r, 300)); // background check lands
    const first = await pg.call("browser_navigate", { url: "https://a.test/" });
    assert.match(first.content[0].text, /Update available: .* → 999\.0\.0/);
    assert.match(first.content[0].text, /git pull/); // dist/ here is a checkout, not npx
    const second = await pg.call("browser_navigate", { url: "https://b.test/" });
    assert.ok(!text(second).includes("Update available"));
  } finally { await pg.close(); registry.close(); }
});
