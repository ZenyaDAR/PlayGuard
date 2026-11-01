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
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startFakeFigma, DESIGN_CODE } from "./fixtures/fake-figma-http.mjs";

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

// ── Chrome DevTools MCP upstream ─────────────────────────────────────────────
const FAKE_DT = resolve(here, "fixtures", "fake-devtools.mjs");

async function startDt(env = {}, dtArgs = "") {
  const dtCalls = join(mkdtempSync(join(tmpdir(), "pg-dt-")), "calls.ndjson");
  const pg = await start({
    DEVTOOLS_MCP_CMD: `"${process.execPath}" "${FAKE_DT}" "${dtCalls}" ${dtArgs}`,
    ...env,
  });
  const lines = () => existsSync(dtCalls) ? readFileSync(dtCalls, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  // initDevtoolsTools runs in the background on startup; listTools also registers routing.
  await pg.client.listTools();
  return { ...pg, dt: () => lines().filter(c => c.name), dtSpawns: () => lines().filter(c => c.argv) };
}
const dtLog = async (pg, tool) => (await pg.log()).filter(l => l.server === "devtools" && (!tool || l.tool === tool));

// Wiring — passes with the passthrough stubs in src/devtools*.ts.
test("devtools: tools are merged after Playwright's, and calls are routed to the DevTools upstream", async () => {
  const pg = await startDt();
  try {
    const { tools } = await pg.client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes("browser_click") && names.includes("take_snapshot") && names.includes("list_network_requests"));
    assert.ok(names.indexOf("take_snapshot") > names.indexOf("browser_navigate"));
    await pg.call("list_pages");
    assert.deepEqual(pg.dt().map(c => c.name), ["list_pages"]);
    assert.ok(!pg.upstream().some(c => c.name === "list_pages"));
    const row = (await dtLog(pg, "list_pages"))[0];
    assert.equal(row.err, false);
    assert.equal(typeof row.rawBytes, "number");
    assert.equal(typeof row.keptBytes, "number");
  } finally { await pg.close(); }
});

test("devtools: server instructions are announced only when DevTools is enabled", async () => {
  const pg = await startDt();
  try { assert.match(pg.client.getInstructions() ?? "", /separate Chrome/); } finally { await pg.close(); }
  const off = await start();
  try { assert.equal(off.client.getInstructions(), undefined); } finally { await off.close(); }
});

test("devtools: a colliding tool name stays with Playwright", async () => {
  const pg = await startDt({}, "--collide");
  try {
    const { tools } = await pg.client.listTools();
    assert.equal(tools.filter(t => t.name === "browser_click").length, 1);
    await pg.call("browser_click", { target: "e8" });
    assert.ok(pg.upstream().some(c => c.name === "browser_click"));
    assert.ok(!pg.dt().some(c => c.name === "browser_click"));
  } finally { await pg.close(); }
});

test("devtools: PLAYGUARD_DEVTOOLS_DEFAULTS=false passes the user's argv through unchanged", async () => {
  const pg = await startDt({ PLAYGUARD_DEVTOOLS_DEFAULTS: "false", DEVTOOLS_MCP_ARGS: "--headless" });
  try {
    assert.deepEqual(pg.dtSpawns()[0].argv, ["--headless"]);
  } finally { await pg.close(); }
});

test("devtools: FIGMA_* env vars are not leaked to the DevTools upstream", async () => {
  const pg = await startDt({ FIGMA_API_KEY: "secret-key" });
  try {
    assert.deepEqual(pg.dtSpawns()[0].figmaEnv, []);
  } finally { await pg.close(); }
});

test("devtools: the upstream gets an allowlisted env — no secrets, but PATH, proxy and the update-check opt-out", async () => {
  const pg = await startDt({ AWS_SECRET_ACCESS_KEY: "secret", GITHUB_TOKEN: "secret", HTTPS_PROXY: "http://proxy.test:3128" });
  try {
    const keys = pg.dtSpawns()[0].envKeys.map(k => k.toUpperCase());
    assert.ok(!keys.includes("AWS_SECRET_ACCESS_KEY") && !keys.includes("GITHUB_TOKEN"));
    assert.ok(keys.includes("PATH"));
    assert.ok(keys.includes("HTTPS_PROXY"));
    assert.ok(keys.includes("CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS"));
  } finally { await pg.close(); }
});

test("devtools: the upstream runs in .playguard/.qa with the project and artifact dir as workspaces", async () => {
  const pg = await startDt();
  try {
    const { argv, cwd } = pg.dtSpawns()[0];
    const roots = argv.flatMap((a, i) => a === "--workspace" ? [argv[i + 1]] : []);
    assert.match(cwd, /[\\/]out[\\/]\.qa$/);
    assert.deepEqual(roots, [resolve(process.cwd()), cwd], "the test's artifact dir is outside the project root");
  } finally { await pg.close(); }
  const own = await startDt({ DEVTOOLS_MCP_ARGS: "--filesystem-root=/somewhere" });
  try {
    assert.ok(!own.dtSpawns()[0].argv.includes("--workspace"), "a user path option wins");
  } finally { await own.close(); }
});

test("devtools: a hanging upstream does not block tools/list", async () => {
  const t0 = Date.now();
  const pg = await startDt({ PLAYGUARD_LIST_WAIT_MS: "300" }, "--hang");
  try {
    const { tools } = await pg.client.listTools();
    assert.ok(Date.now() - t0 < 10_000);
    assert.ok(tools.some(t => t.name === "browser_navigate"));
    assert.ok(!tools.some(t => t.name === "take_snapshot"));
    assert.ok(!(await pg.call("browser_navigate", { url: "https://a.test/" })).isError);
  } finally { await pg.close(); }
});

test("devtools: a slow upstream is listed later, announced with tools/list_changed", async () => {
  const pg = await startDt({ PLAYGUARD_LIST_WAIT_MS: "300" }, "--slow-init=1500");
  try {
    assert.ok(pg.client.getServerCapabilities().tools.listChanged);
    const changed = new Promise(res => pg.client.setNotificationHandler(ToolListChangedNotificationSchema, res));
    assert.ok(!(await pg.client.listTools()).tools.some(t => t.name === "take_snapshot"));
    await changed;
    assert.ok((await pg.client.listTools()).tools.some(t => t.name === "take_snapshot"));
    assert.ok(!(await pg.call("list_pages")).isError);
  } finally { await pg.close(); }
});

test("devtools: slow tools get a long timeout and ask for progress; quick ones do not", async () => {
  const pg = await startDt();
  try {
    await pg.call("performance_stop_trace");
    await pg.call("list_pages");
    assert.ok(pg.dt().find(c => c.name === "performance_stop_trace").meta?.progressToken !== undefined);
    assert.equal(pg.dt().find(c => c.name === "list_pages").meta, undefined);
  } finally { await pg.close(); }
});

test("devtools: a navigation logs the url it went to", async () => {
  const pg = await startDt();
  try {
    await pg.call("navigate_page", { type: "url", url: "https://shop.test/a" });
    await pg.call("list_pages");
    const rows = await dtLog(pg);
    assert.equal(rows.find(r => r.tool === "navigate_page").url, "https://shop.test/a");
    assert.equal(rows.find(r => r.tool === "list_pages").url, "https://shop.test/a");
  } finally { await pg.close(); }
});

test("devtools: `raw` is stripped before forwarding", async () => {
  const pg = await startDt();
  try {
    await pg.call("take_snapshot", { pageId: 1, raw: true });
    assert.deepEqual(pg.dt().find(c => c.name === "take_snapshot").args, { pageId: 1 });
    assert.equal((await dtLog(pg, "take_snapshot"))[0].raw, true);
  } finally { await pg.close(); }
});

test("devtools: PLAYGUARD_DEVTOOLS_OPTIMIZE=false is a byte-exact passthrough", async () => {
  const pg = await startDt({ PLAYGUARD_DEVTOOLS_OPTIMIZE: "false" });
  try {
    for (const [tool, args] of [["take_snapshot", {}], ["list_network_requests", {}], ["get_network_request", { reqid: 1 }], ["performance_stop_trace", {}]]) {
      const first = await pg.call(tool, args);
      const second = await pg.call(tool, args);
      assert.equal(text(first), text(second));
      assert.ok(!text(first).includes("PlayGuard"), `${tool} was rewritten`);
    }
    assert.match(text(await pg.call("take_snapshot")), /^## Latest page snapshot\nuid=1_0 RootWebArea/);
    const r = await pg.call("click", { uid: "1_99" });
    assert.equal(r.content.length, 1, "no error hint when optimization is off");
  } finally { await pg.close(); }
});

test("devtools: screenshot policy — block refuses without calling upstream", async () => {
  const pg = await startDt({ PLAYGUARD_SCREENSHOTS: "block" });
  try {
    const r = await pg.call("take_screenshot", { pageId: 1 });
    assert.ok(r.isError);
    assert.match(text(r), /screenshots blocked/);
    assert.ok(!pg.dt().some(c => c.name === "take_screenshot"));
    assert.equal((await dtLog(pg, "take_screenshot"))[0].blocked, true);
  } finally { await pg.close(); }
});

test("devtools: screenshot policy — redirect serves a snapshot, visual:true gets pixels", async () => {
  const pg = await startDt({ PLAYGUARD_SCREENSHOTS: "redirect" });
  try {
    const { tools } = await pg.client.listTools();
    assert.ok(tools.find(t => t.name === "take_screenshot").inputSchema.properties.visual);
    const r = await pg.call("take_screenshot", { pageId: 1 });
    assert.match(text(r), /^\[PlayGuard: snapshot served instead of screenshot/);
    assert.match(text(r), /uid=1_7 button "Buy"/);
    assert.deepEqual(pg.dt().map(c => [c.name, c.args]), [["take_snapshot", { pageId: 1 }]]);
    const shot = await pg.call("take_screenshot", { pageId: 1, visual: true });
    assert.ok(shot.content.some(c => c.type === "image"));
    assert.deepEqual(pg.dt().at(-1), { name: "take_screenshot", args: { pageId: 1 } }, "visual is not forwarded");
    const rows = await dtLog(pg, "take_screenshot");
    assert.equal(rows[0].redirected, true);
    assert.equal(rows[1].visual, true);
    assert.ok(rows[1].screenshotBytes > 0);
  } finally { await pg.close(); }
});

test("devtools: image items keep their place in the response", async () => {
  const pg = await startDt({ PLAYGUARD_SCREENSHOTS: "allow" });
  try {
    const r = await pg.call("take_screenshot", { pageId: 1 });
    assert.deepEqual(r.content.map(c => c.type), ["text", "image"]);
  } finally { await pg.close(); }
});

test("devtools: the upstream process dying mid-call revives it, replays the last url and retries once", async () => {
  const pg = await startDt();
  try {
    await pg.call("navigate_page", { pageId: 1, type: "url", url: "https://shop.test/" });
    const r = await pg.call("click", { pageId: 1, uid: "die" });
    assert.ok(!r.isError);
    assert.match(text(r), /Successfully clicked/);
    assert.equal(pg.dtSpawns().length, 2);
    const calls = pg.dt();
    const replay = calls.findLastIndex(c => c.name === "navigate_page");
    assert.ok(replay > 0, "last url replayed after revive");
    assert.deepEqual(calls[replay].args, { type: "url", url: "https://shop.test/", pageId: 1 });
    assert.equal(calls.at(-1).args.uid, "die");
    assert.equal((await dtLog(pg, "click"))[0].retried, true);
  } finally { await pg.close(); }
});

test("devtools: a Chrome restart reported by the upstream is not revived, but points at the last url", async () => {
  const pg = await startDt();
  try {
    await pg.call("navigate_page", { pageId: 1, type: "url", url: "https://shop.test/" });
    const r = await pg.call("click", { pageId: 1, uid: "restart" });
    assert.ok(r.isError);
    assert.match(text(r), /https:\/\/shop\.test\//);
    const ok = await pg.call("click", { pageId: 1, uid: "restart-ok" });
    assert.ok(!ok.isError);
    assert.match(text(ok), /last page you opened here was https:\/\/shop\.test\//);
    assert.equal(pg.dtSpawns().length, 1);
    assert.ok((await dtLog(pg, "click")).every(l => l.chromeRestarted === true));
  } finally { await pg.close(); }
});

test("devtools: a DevTools spawn failure leaves Playwright tools/list and calls working", async () => {
  const pg = await start({ DEVTOOLS_MCP_CMD: "definitely-not-a-real-binary-xyz" });
  try {
    const { tools } = await pg.client.listTools();
    assert.ok(tools.some(t => t.name === "browser_navigate"));
    assert.ok(!tools.some(t => t.name === "take_snapshot"));
    const r = await pg.call("browser_navigate", { url: "https://a.test/" });
    assert.ok(!r.isError);
  } finally { await pg.close(); }
});

// Optimizer contract — depends on the real bodies in src/devtools.ts / devtools-snapshot.ts.
test("devtools: tools/list is compacted and advertises `raw` on the raw tools", async () => {
  const pg = await startDt();
  try {
    const { tools } = await pg.client.listTools();
    assert.ok(tools.find(t => t.name === "take_snapshot").inputSchema.properties.raw);
    assert.ok(!tools.find(t => t.name === "list_pages").inputSchema.properties.raw);
  } finally { await pg.close(); }
});

test("devtools: launch defaults are appended, and a user flag in any spelling wins", async () => {
  const pg = await startDt({ DEVTOOLS_MCP_ARGS: "--usage-statistics=true" });
  try {
    const argv = pg.dtSpawns()[0].argv;
    assert.ok(argv.length > 1, "defaults appended");
    assert.ok(!argv.includes("--no-usage-statistics"), "user's own --usage-statistics wins");
  } finally { await pg.close(); }
});

test("devtools: a repeat snapshot is UNCHANGED; a mutating call invalidates it, a read-only one does not", async () => {
  const pg = await startDt();
  try {
    const first = await pg.call("take_snapshot", { pageId: 1 });
    assert.ok(!text(first).includes("uid=1_6"), "static text repeating its parent heading is compacted away");
    assert.ok(text(first).includes('uid=1_7 button "Buy"'));
    await pg.call("take_snapshot", { pageId: 1 });
    await pg.call("list_network_requests", { pageId: 1 });
    await pg.call("take_snapshot", { pageId: 1 });
    await pg.call("click", { pageId: 1, uid: "1_7" });
    await pg.call("take_snapshot", { pageId: 1 });
    const snaps = await dtLog(pg, "take_snapshot");
    assert.deepEqual(snaps.map(s => s.cacheHit), [false, true, true, false]);
  } finally { await pg.close(); }
});

test("devtools: a changing page goes full → UNCHANGED → delta → full (new page)", async () => {
  const pg = await startDt();
  try {
    await pg.call("take_snapshot");
    assert.match(text(await pg.call("take_snapshot")), /UNCHANGED/);
    await pg.call("click", { uid: "grow" });
    const delta = text(await pg.call("take_snapshot"));
    assert.match(delta, /\[PlayGuard delta: \+1 added, 0 removed\]/);
    assert.match(delta, /uid=1_20 button "Item 0"/);
    await pg.call("navigate_page", { type: "url", url: "https://shop.test/other" });
    const full = text(await pg.call("take_snapshot"));
    assert.match(full, /url="https:\/\/shop\.test\/other"/);
    const snaps = await dtLog(pg, "take_snapshot");
    assert.deepEqual(snaps.map(s => [s.cacheHit, s.delta]), [[false, false], [true, false], [false, true], [false, false]]);
  } finally { await pg.close(); }
});

test("devtools: a mutating action with includeSnapshot sets the new baseline", async () => {
  const pg = await startDt();
  try {
    await pg.call("take_snapshot");
    const clicked = text(await pg.call("click", { uid: "grow", includeSnapshot: true }));
    assert.match(clicked, /Successfully clicked/);
    assert.match(clicked, /uid=1_20 button "Item 0"/);
    assert.match(text(await pg.call("take_snapshot")), /UNCHANGED/, "the post-action tree is current");
  } finally { await pg.close(); }
});

test("devtools: select_page and new_page invalidate the UNCHANGED shortcut", async () => {
  const pg = await startDt();
  try {
    await pg.call("take_snapshot");
    await pg.call("take_snapshot");
    await pg.call("select_page", { pageId: 1 });
    await pg.call("take_snapshot");
    await pg.call("take_snapshot");
    await pg.call("new_page", { url: "https://shop.test/" });
    await pg.call("take_snapshot");
    const snaps = await dtLog(pg, "take_snapshot");
    assert.deepEqual(snaps.map(s => s.cacheHit), [false, true, false, true, false]);
  } finally { await pg.close(); }
});

test("devtools: an upstream that died between calls is revived: state reset, url replayed, agent told", async () => {
  const pg = await startDt();
  try {
    await pg.call("navigate_page", { type: "url", url: "https://shop.test/a" });
    await pg.call("take_snapshot");
    await pg.call("click", { uid: "exit-after" });
    await new Promise(r => setTimeout(r, 300)); // the process is gone before the next call
    const r = await pg.call("take_snapshot");
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /^\[PlayGuard\] The DevTools browser was restarted.*https:\/\/shop\.test\/a was reopened/);
    assert.doesNotMatch(text(r), /UNCHANGED/, "the snapshot cache did not survive the restart");
    assert.equal(pg.dtSpawns().length, 2);
    const calls = pg.dt();
    assert.deepEqual(calls.at(-2), { name: "navigate_page", args: { type: "url", url: "https://shop.test/a" } });
    assert.equal(calls.at(-1).name, "take_snapshot");
    const row = (await dtLog(pg, "take_snapshot")).at(-1);
    assert.equal(row.revived, true);
    assert.equal(row.cacheHit, false);
  } finally { await pg.close(); }
});

test("devtools: redirect mode keeps a real screenshot for filePath / uid / fullPage", async () => {
  const pg = await startDt({ PLAYGUARD_SCREENSHOTS: "redirect" });
  try {
    for (const args of [{ filePath: "shot.png" }, { uid: "1_7" }, { fullPage: true }]) {
      const r = await pg.call("take_screenshot", args);
      assert.ok(r.content.some(c => c.type === "image"), JSON.stringify(args));
      assert.deepEqual(pg.dt().at(-1), { name: "take_screenshot", args });
    }
    assert.ok((await dtLog(pg, "take_screenshot")).every(l => l.visual === true && !l.redirected));
  } finally { await pg.close(); }
});

test("playwright: redirect mode keeps a real screenshot for filename / element / fullPage", async () => {
  const pg = await start({ PLAYGUARD_SCREENSHOTS: "redirect" });
  try {
    for (const args of [{ filename: "shot.png" }, { element: "Buy button", target: "e8" }, { fullPage: true }]) {
      const r = await pg.call("browser_take_screenshot", args);
      assert.ok(r.content.some(c => c.type === "image"), JSON.stringify(args));
    }
    assert.ok(!pg.upstream().some(c => c.name === "browser_snapshot"));
  } finally { await pg.close(); }
});

test("devtools: a long network list is summarized; an explicit page is untouched", async () => {
  const pg = await startDt();
  try {
    const summary = await pg.call("list_network_requests", { pageId: 1 });
    const paged = await pg.call("list_network_requests", { pageId: 1, pageSize: 200 });
    assert.ok(text(summary).length < text(paged).length);
    assert.ok(text(paged).includes("reqid=120 "));
    const rows = await dtLog(pg, "list_network_requests");
    assert.equal(rows[0].summarized, true);
    assert.equal(rows[1].summarized, undefined);
  } finally { await pg.close(); }
});

test("devtools: a big request body is trimmed unless raw:true", async () => {
  const pg = await startDt();
  try {
    const trimmed = await pg.call("get_network_request", { pageId: 1, reqid: 1 });
    const raw = await pg.call("get_network_request", { pageId: 1, reqid: 1, raw: true });
    assert.ok(text(trimmed).length < text(raw).length);
    assert.equal((await dtLog(pg, "get_network_request"))[0].trimmed, true);
  } finally { await pg.close(); }
});

test("devtools: an opaque upstream error gets a hint appended", async () => {
  const pg = await startDt();
  try {
    const r = await pg.call("click", { pageId: 1, uid: "1_99" });
    assert.ok(r.isError);
    assert.equal(r.content.length, 2);
    assert.equal((await dtLog(pg, "click"))[0].hinted, true);
  } finally { await pg.close(); }
});

// ── Documentation upstreams (Shopify Dev MCP, Context7) ─────────────────────
const FAKE_DOCS = resolve(here, "fixtures", "fake-docs.mjs");

async function startDocs(env = {}, { shopify = "", context7 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pg-docs-"));
  const shopCalls = join(dir, "shopify.ndjson");
  const c7Calls = join(dir, "context7.ndjson");
  const pg = await start({
    SHOPIFY_DEV_MCP_CMD: `"${process.execPath}" "${FAKE_DOCS}" "${shopCalls}" ${shopify}`,
    ...(context7 !== undefined ? { CONTEXT7_MCP_CMD: `"${process.execPath}" "${FAKE_DOCS}" "${c7Calls}" --context7 ${context7}` } : {}),
    ...env,
  });
  const lines = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  await pg.client.listTools();
  return {
    ...pg,
    shop: () => lines(shopCalls).filter(c => c.name), shopSpawns: () => lines(shopCalls).filter(c => c.argv),
    c7: () => lines(c7Calls).filter(c => c.name), c7Spawns: () => lines(c7Calls).filter(c => c.argv),
  };
}
const docsLog = async (pg, server, tool) => (await pg.log()).filter(l => l.server === server && (!tool || l.tool === tool));

test("docs: Shopify tools are merged and routed; feedback hidden; conversationId filled in", async () => {
  const pg = await startDocs();
  try {
    const { tools } = await pg.client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes("browser_click") && names.includes("search_docs_chunks") && names.includes("validate"));
    assert.ok(!names.includes("feedback"));
    assert.ok(!tools.find(t => t.name === "search_docs_chunks").inputSchema.required.includes("conversationId"));
    const r = await pg.call("search_docs_chunks", { prompt: "cart add" });
    assert.ok(!r.isError);
    assert.match(text(r), /^## Cart API reference\nhttps:\/\/shopify\.dev\/docs\/api\/ajax\/reference\/cart\n/);
    const fwd = pg.shop()[0].args;
    assert.match(fwd.conversationId, /^[0-9a-f-]{36}$/);
    await pg.call("search_docs_chunks", { prompt: "other" });
    assert.equal(pg.shop()[1].args.conversationId, fwd.conversationId, "one id per process");
    assert.ok(!pg.upstream().some(c => c.name === "search_docs_chunks"));
    const row = (await docsLog(pg, "shopify-dev", "search_docs_chunks"))[0];
    assert.ok(row.rawBytes > row.keptBytes);
  } finally { await pg.close(); }
});

test("docs: identical repeat → UNCHANGED note; raw:true bypasses it and is served from the disk cache", async () => {
  const out = mkdtempSync(join(tmpdir(), "pg-docs-out-"));
  const pg = await startDocs({ PLAYGUARD_OUTPUT_DIR: out });
  try {
    await pg.call("search_docs_chunks", { prompt: "cart add", conversationId: "a" });
    const again = await pg.call("search_docs_chunks", { prompt: "cart add", conversationId: "b" });
    assert.match(text(again), /^\[PlayGuard\] UNCHANGED: identical search_docs_chunks call.*no longer have it in context, call again with raw: true/);
    const raw = await pg.call("search_docs_chunks", { prompt: "cart add", raw: true });
    assert.match(text(raw), /^\[\n {2}\{\n {4}"score"/);
    assert.equal(pg.shop().length, 1, "repeat and raw never reached the upstream");
    assert.ok(!("raw" in pg.shop()[0].args));
    const rows = await docsLog(pg, "shopify-dev", "search_docs_chunks");
    assert.deepEqual(rows.map(r => [!!r.repeat, !!r.cached, !!r.raw]), [[false, false, false], [true, false, false], [false, true, true]]);
  } finally { await pg.close(); }
  // A new process with the same artifact root reads the same cache.
  const next = await startDocs({ PLAYGUARD_OUTPUT_DIR: out });
  try {
    const r = await next.call("search_docs_chunks", { prompt: "cart add" });
    assert.match(text(r), /^## Cart API reference/);
    assert.equal(next.shop().length, 0);
    assert.equal((await docsLog(next, "shopify-dev", "search_docs_chunks"))[0].cached, true);
  } finally { await next.close(); }
});

test("docs: learn always returns the full body (no repeat note); validate is never cached", async () => {
  const pg = await startDocs();
  try {
    const first = await pg.call("learn_shopify_api", { api: "liquid", model: "x" });
    assert.ok(!text(first).includes("\\`"), "escaped fences fixed");
    const second = await pg.call("learn_shopify_api", { api: "liquid", model: "y", user_prompt: "z" });
    assert.equal(text(second), text(first), "the routing guide is never replaced by a note");
    await pg.call("validate", { api: "admin", code: [{ content: "{ shop { name } }" }] });
    const v2 = await pg.call("validate", { api: "admin", code: [{ content: "{ shop { name } }" }] });
    assert.deepEqual(pg.shop().map(c => c.name), ["learn_shopify_api", "learn_shopify_api", "validate", "validate"]);
    assert.ok(!(await docsLog(pg, "shopify-dev", "learn_shopify_api")).some(l => l.repeat));
    assert.ok(!text(v2).includes("UNCHANGED"));
  } finally { await pg.close(); }
});

test("docs: PLAYGUARD_DOCS_OPTIMIZE=false is a passthrough (cache still applies)", async () => {
  const pg = await startDocs({ PLAYGUARD_DOCS_OPTIMIZE: "false" });
  try {
    const { tools } = await pg.client.listTools();
    assert.ok(tools.some(t => t.name === "feedback"));
    assert.ok(tools.find(t => t.name === "search_docs_chunks").inputSchema.required.includes("conversationId"));
    const r = await pg.call("search_docs_chunks", { prompt: "cart", conversationId: "c" });
    assert.match(text(r), /^\[\n {2}\{/);
    assert.equal(pg.shop()[0].args.conversationId, "c");
  } finally { await pg.close(); }
});

test("docs: the Shopify upstream gets an allowlisted env with telemetry off", async () => {
  const pg = await startDocs({
    CLAUDE_CODE_SESSION_ID: "s", FIGMA_API_KEY: "k", CONTEXT7_API_KEY: "c7", GITHUB_TOKEN: "g", HTTPS_PROXY: "http://p.test:1",
    USE_LEGACY_SEARCH: "true", SHOPIFY_AI_TOOLKIT_OPT_OUT_FILE: "/tmp/opt-out",
  });
  try {
    const spawn = pg.shopSpawns()[0];
    const keys = spawn.envKeys.map(k => k.toUpperCase());
    assert.ok(keys.includes("USE_LEGACY_SEARCH") && keys.includes("SHOPIFY_AI_TOOLKIT_OPT_OUT_FILE"));
    for (const k of ["CLAUDE_CODE_SESSION_ID", "FIGMA_API_KEY", "CONTEXT7_API_KEY", "GITHUB_TOKEN"]) assert.ok(!keys.includes(k), k);
    assert.ok(keys.includes("PATH") && keys.includes("HTTPS_PROXY"));
    assert.equal(spawn.optOut, "true");
  } finally { await pg.close(); }
  const own = await startDocs({ OPT_OUT_INSTRUMENTATION: "false" });
  try { assert.equal(own.shopSpawns()[0].optOut, "false", "a user setting wins"); } finally { await own.close(); }
});

test("docs: Context7 is routed, compacted and announced; its key is forwarded to it only", async () => {
  const pg = await startDocs({ CONTEXT7_API_KEY: "c7-secret", GITHUB_TOKEN: "g" }, { context7: "" });
  try {
    assert.match(pg.client.getInstructions() ?? "", /Context7/);
    const { tools } = await pg.client.listTools();
    assert.ok(tools.find(t => t.name === "query-docs").inputSchema.properties.raw);
    const r = await pg.call("resolve-library-id", { query: "routing", libraryName: "Next.js" });
    assert.match(text(r), /^Libraries \(id \|.*\n\/vercel\/next\.js \| Next\.js \| 6393 snippets/);
    const d = await pg.call("query-docs", { libraryId: "/vercel/next.js", query: "server actions" });
    assert.match(text(d), /Source: vercel\/next\.js@canary:docs\//);
    assert.deepEqual(pg.c7().map(c => c.name), ["resolve-library-id", "query-docs"]);
    assert.equal(pg.shop().length, 0);
    assert.equal(pg.c7Spawns()[0].c7Key, "c7-secret");
    assert.equal(pg.shopSpawns()[0].c7Key, null);
    assert.ok(!pg.c7Spawns()[0].envKeys.map(k => k.toUpperCase()).includes("GITHUB_TOKEN"));
    assert.ok(!JSON.stringify(await pg.log()).includes("c7-secret"), "the key never reaches the call log");
  } finally { await pg.close(); }
});

test("docs: an upstream error is never cached", async () => {
  const pg = await startDocs({}, { context7: "" });
  try {
    const a = await pg.call("query-docs", { libraryId: "/x", query: "q" });
    const b = await pg.call("query-docs", { libraryId: "/x", query: "q" });
    assert.ok(a.isError && b.isError);
    assert.match(text(b), /not found/);
    assert.equal(pg.c7().length, 2);
  } finally { await pg.close(); }
});

test("docs: a failing docs upstream leaves tools/list and the others working", async () => {
  const pg = await start({
    SHOPIFY_DEV_MCP_CMD: "definitely-not-a-real-binary-xyz",
    CONTEXT7_MCP_CMD: `"${process.execPath}" "${FAKE_DOCS}" "${join(mkdtempSync(join(tmpdir(), "pg-docs-")), "c.ndjson")}" --context7`,
  });
  try {
    const { tools } = await pg.client.listTools();
    assert.ok(tools.some(t => t.name === "browser_navigate"));
    assert.ok(tools.some(t => t.name === "query-docs"));
    assert.ok(!tools.some(t => t.name === "search_docs_chunks"));
    assert.ok(!(await pg.call("browser_navigate", { url: "https://a.test/" })).isError);
    assert.ok(!(await pg.call("resolve-library-id", { query: "q", libraryName: "react" })).isError);
    const down = await pg.call("search_docs_chunks", { prompt: "cart" });
    assert.ok(down.isError);
    assert.match(text(down), /^\[PlayGuard\] Shopify Dev MCP is not running: .*Check SHOPIFY_DEV_MCP_CMD/);
    assert.equal((await docsLog(pg, "shopify-dev", "search_docs_chunks"))[0].down, true);
  } finally { await pg.close(); }
});

// ── Official Figma MCP over HTTP (FIGMA_MCP_URL) ─────────────────────────────
test("figma official: tools listed and routed over HTTP; long code passes whole; no design diff", async () => {
  const fig = await startFakeFigma();
  const pg = await start({ FIGMA_MCP_URL: fig.url });
  try {
    const names = (await pg.client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes("get_design_context") && names.includes("browser_click"));
    assert.ok(!names.includes("playguard_compare_design"));
    const r = await pg.call("get_design_context", { nodeId: "1-2" });
    assert.ok(!r.isError);
    assert.equal(text(r), DESIGN_CODE);
    const shot = await pg.call("get_screenshot", { nodeId: "1:2" });
    assert.equal(shot.content[0].type, "image");
    assert.deepEqual(fig.calls.map(c => c.name), ["get_design_context", "get_screenshot"]);
    assert.ok(!pg.upstream().some(c => c.name === "get_design_context"));
    const row = (await pg.log()).find(l => l.tool === "get_design_context");
    assert.equal(row.official, true);
    assert.equal(row.parseSkip, undefined);
    assert.equal(row.textTruncated, undefined);
  } finally { await pg.close(); await fig.close(); }
});

test("figma official: desktop app not running → the call says how to turn the server on", async () => {
  const fig = await startFakeFigma();
  const url = fig.url;
  await fig.close(); // nothing listens on that port any more
  const pg = await start({ FIGMA_MCP_URL: url, PLAYGUARD_LIST_WAIT_MS: "2000" });
  try {
    assert.ok((await pg.client.listTools()).tools.some(t => t.name === "browser_click"));
    const r = await pg.call("get_design_context", { nodeId: "1:2" }).catch(e => ({ isError: true, content: [{ text: String(e) }] }));
    assert.ok(r.isError);
    assert.match(text(r), /not reachable[\s\S]*Enable desktop MCP server/);
    assert.ok(!pg.upstream().some(c => c.name === "get_design_context"));
  } finally { await pg.close(); }
});

test("figma official: the remote server URL is refused up front with what to do instead", async () => {
  const pg = await start({ FIGMA_MCP_URL: "https://mcp.figma.com/mcp", PLAYGUARD_LIST_WAIT_MS: "2000" });
  try {
    assert.match(pg.client.getInstructions() ?? "", /only accepts clients from Figma's MCP catalog.*127\.0\.0\.1:3845.*claude mcp add --transport http figma/);
    const names = (await pg.client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes("browser_click") && !names.includes("get_design_context"));
  } finally { await pg.close(); }
});

test("figma official: one call's server error does not abort another call in flight", async () => {
  const fig = await startFakeFigma();
  const pg = await start({ FIGMA_MCP_URL: fig.url });
  try {
    await pg.client.listTools();
    const slow = pg.call("slow_ok");
    await new Promise(r => setTimeout(r, 100));
    const bad = await pg.call("fail_fast").catch(e => ({ isError: true, content: [{ text: String(e) }] }));
    assert.ok(bad.isError);
    assert.match(text(bad), /boom/);
    const ok = await slow;
    assert.ok(!ok.isError, text(ok));
    assert.equal(text(ok), "slow done");
    assert.equal(fig.calls.filter(c => c.name === "fail_fast").length, 1, "a server error is not retried");
  } finally { await pg.close(); await fig.close(); }
});

test("figma official: the desktop app starting after PlayGuard registers its tools and announces them", async () => {
  const probe = await startFakeFigma();
  const port = new URL(probe.url).port;
  await probe.close();
  const pg = await start({ FIGMA_MCP_URL: `http://127.0.0.1:${port}/mcp`, PLAYGUARD_LIST_WAIT_MS: "1500" });
  let fig;
  try {
    assert.ok(!(await pg.client.listTools()).tools.some(t => t.name === "get_design_context"));
    await new Promise(r => setTimeout(r, 3500)); // startup retries (0 s, 3 s) give up
    fig = await startFakeFigma(Number(port));
    const changed = new Promise(res => pg.client.setNotificationHandler(ToolListChangedNotificationSchema, res));
    const r = await pg.call("get_design_context", { nodeId: "1:2" });
    assert.ok(!r.isError, text(r));
    await changed;
    assert.ok((await pg.client.listTools()).tools.some(t => t.name === "get_code_connect_suggestions"));
    const extra = await pg.call("get_code_connect_suggestions", { nodeId: "1:2" });
    assert.ok(!extra.isError);
    assert.ok(fig.calls.some(c => c.name === "get_code_connect_suggestions"));
    assert.ok(!pg.upstream().some(c => c.name === "get_code_connect_suggestions"));
  } finally { await pg.close(); await fig?.close(); }
});

test("figma official: FIGMA_CACHE_TTL does not apply — selection-based answers are never stale", async () => {
  const fig = await startFakeFigma();
  const pg = await start({ FIGMA_MCP_URL: fig.url, FIGMA_CACHE_TTL: "60000" });
  try {
    await pg.client.listTools();
    assert.equal(text(await pg.call("get_design_context", {})), "selection #1");
    assert.equal(text(await pg.call("get_design_context", {})), "selection #2");
  } finally { await pg.close(); await fig.close(); }
});

test("figma official: calling playguard_compare_design from memory says it needs Framelink", async () => {
  const fig = await startFakeFigma();
  const pg = await start({ FIGMA_MCP_URL: fig.url });
  try {
    const r = await pg.call("playguard_compare_design", { figmaFileKey: "k", figmaNodeId: "1:2", browserSelector: "a" });
    assert.ok(r.isError);
    assert.match(text(r), /needs the Framelink Figma MCP/);
    assert.equal(fig.calls.length, 0);
  } finally { await pg.close(); await fig.close(); }
});

test("figma official: a trailing-dot remote host is refused; a non-URL value says it is invalid", async () => {
  const dot = await start({ FIGMA_MCP_URL: "https://MCP.figma.com./mcp", PLAYGUARD_LIST_WAIT_MS: "1500" });
  try { assert.match(dot.client.getInstructions() ?? "", /only accepts clients from Figma's MCP catalog/); } finally { await dot.close(); }
  const bad = await start({ FIGMA_MCP_URL: "127.0.0.1:3845/mcp", PLAYGUARD_LIST_WAIT_MS: "1500" });
  try {
    const r = await bad.call("get_design_context", {});
    assert.ok(r.isError);
    assert.match(text(r), /FIGMA_MCP_URL is not a usable URL/);
  } finally { await bad.close(); }
  const scheme = await start({ FIGMA_MCP_URL: "localhost:3845/mcp", PLAYGUARD_LIST_WAIT_MS: "1500" });
  try { assert.match(text(await scheme.call("get_design_context", {})), /not a usable URL/); } finally { await scheme.close(); }
});

test("figma official: credentials in the URL never reach the agent or the log", async () => {
  const fig = await startFakeFigma();
  const port = new URL(fig.url).port;
  await fig.close();
  const pg = await start({ FIGMA_MCP_URL: `http://user:s3cret@127.0.0.1:${port}/mcp`, PLAYGUARD_LIST_WAIT_MS: "1500" });
  try {
    const r = await pg.call("get_design_context", {});
    assert.ok(r.isError);
    assert.match(text(r), /not a usable URL.*no user:password/);
    assert.ok(!text(r).includes("s3cret"));
    assert.ok(!JSON.stringify(await pg.log()).includes("s3cret"));
  } finally { await pg.close(); }
});

// ── playguard_a11y_audit ─────────────────────────────────────────────────────
test("a11y: tags must be strings; a single string is accepted", async () => {
  const pg = await start();
  try {
    const bad = await pg.call("playguard_a11y_audit", { tags: [{}] });
    assert.ok(bad.isError);
    assert.match(text(bad), /tags must be an array of axe tag strings/);
    assert.equal(pg.upstream().filter(c => c.name === "browser_evaluate").length, 0);
    const one = await pg.call("playguard_a11y_audit", { tags: "best-practice" });
    assert.ok(!one.isError, text(one));
    assert.match(pg.upstream().find(c => c.name === "browser_evaluate").args.function, /const tags = \["best-practice"\];/);
  } finally { await pg.close(); }
});

test("a11y: listed always; the audit runs through browser_evaluate and comes back as a short report", async () => {
  const pg = await start();
  try {
    const tool = (await pg.client.listTools()).tools.find(t => t.name === "playguard_a11y_audit");
    assert.ok(tool?.annotations?.readOnlyHint);
    await pg.call("browser_navigate", { url: "https://a.test/" });
    const r = await pg.call("playguard_a11y_audit", { selector: "main" });
    assert.ok(!r.isError);
    assert.match(text(r), /^\[PlayGuard a11y: 1 violation \(1 element\) · 30 rules passed · axe 4\.14\.0/);
    assert.match(text(r), /critical image-alt — Images must have alternative text \(1\)\n {2}- img\.hero/);
    assert.match(text(r), /Needs manual review.*color-contrast/);
    const ev = pg.upstream().filter(c => c.name === "browser_evaluate");
    assert.equal(ev.length, 1);
    assert.match(ev[0].args.function, /const ctx = "main";/);
    const row = (await pg.log()).find(l => l.tool === "playguard_a11y_audit");
    assert.equal(row.violations, 1);
    assert.equal(row.err, false);
  } finally { await pg.close(); }
});

test("a11y: a selector that matches nothing is an error naming the selector", async () => {
  const pg = await start();
  try {
    const r = await pg.call("playguard_a11y_audit", { selector: "#missing" });
    assert.ok(r.isError);
    assert.match(text(r), /axe failed: No elements found.*selector: #missing/);
  } finally { await pg.close(); }
});

test("docs: a colliding tool name stays with Playwright", async () => {
  const pg = await startDocs({}, { shopify: "--collide" });
  try {
    const { tools } = await pg.client.listTools();
    assert.equal(tools.filter(t => t.name === "browser_click").length, 1);
    await pg.call("browser_click", { target: "e8" });
    assert.ok(!pg.shop().some(c => c.name === "browser_click"));
  } finally { await pg.close(); }
});
