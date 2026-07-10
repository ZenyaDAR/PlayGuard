#!/usr/bin/env node
// PlayGuard benchmark v4 — npm run bench
//
// If logs/*.ndjson exist, offers to bench against the real URLs and Figma
// targets found there (asks first; Figma key is read from stdin, kept only in
// this process's memory, never written anywhere). Falls back to default URLs.
//
// Two server instances are used on purpose:
//   cold — prefetch/delta OFF: honest snapshot latency + compact table
//   warm — defaults ON (prefetch, delta, redirect): behavior demos match production

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";

const DEFAULT_URLS = [
  "https://playwright.dev",
  "https://news.ycombinator.com",
  "https://github.com",
];
const LATENCY_RUNS = 10;
const CRASH_CYCLES = 3;
const MAX_LOG_URLS = 3;
const MAX_FIGMA_TARGETS = 3;

const kb  = (b) => `${(b / 1024).toFixed(1)} KB`;
const tok = (b) => `~${Math.round(b / 4).toLocaleString()} tok`;
const ms  = (n) => `${n.toFixed(0)}ms`;
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p / 100)];
const sleep = (n) => new Promise((r) => setTimeout(r, n));

const bytes = (result) => Buffer.byteLength(JSON.stringify(result.content));
const text  = (result) => (result.content ?? []).map((x) => x.text ?? "").join("");

// PlayGuard compact header: "[PlayGuard compact: ... 14.0KB→2.1KB]"
function parseCompactHeader(snapText) {
  const m = snapText.match(/(\d+\.\d+)KB→(\d+\.\d+)KB/);
  return m ? { rawKB: parseFloat(m[1]), cmpKB: parseFloat(m[2]) } : null;
}
// Figma header: "[PlayGuard figma: -62% (140.2KB→52.9KB)]"
function parseFigmaHeader(t) {
  const m = t.match(/\[PlayGuard figma: -(\d+)% \((\d+\.\d+)KB→(\d+\.\d+)KB\)\]/);
  return m ? { pct: +m[1], inKB: parseFloat(m[2]), outKB: parseFloat(m[3]) } : null;
}

// Bench log lines go to a temp dir, not logs/ — analytics from real sessions stay clean.
// Shown via analyze.mjs at the end, then deleted.
const BENCH_LOG_DIR = mkdtempSync(join(tmpdir(), "playguard-bench-"));

function connect(extraEnv = {}) {
  const t = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, PLAYGUARD_LOG_DIR: BENCH_LOG_DIR, ...extraEnv },
  });
  const c = new Client({ name: "bench", version: "0.1.0" });
  return c.connect(t).then(() => c);
}

// ─── 0. Real data from logs + prompts ─────────────────────────────────────────
const LOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "logs");
let logEntries = [];
try {
  logEntries = readdirSync(LOG_DIR).filter(f => f.endsWith(".ndjson")).flatMap(f =>
    readFileSync(resolve(LOG_DIR, f), "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
} catch {}

const urlCounts = new Map();
for (const e of logEntries) if (e.url && e.url.startsWith("http")) urlCounts.set(e.url, (urlCounts.get(e.url) ?? 0) + 1);
const logUrls = [...urlCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LOG_URLS).map(([u]) => u);

const figmaCounts = new Map();
for (const e of logEntries) {
  if (e.figma && e.tool === "get_figma_data" && e.fileKey && e.nodeId) {
    const key = e.fileKey + "\0" + String(e.nodeId).replace("-", ":");
    figmaCounts.set(key, (figmaCounts.get(key) ?? 0) + 1);
  }
}
const figmaTargets = [...figmaCounts.entries()].sort((a, b) => b[1] - a[1])
  .slice(0, MAX_FIGMA_TARGETS)
  .map(([k]) => { const [fileKey, nodeId] = k.split("\0"); return { fileKey, nodeId }; });

let URLS = DEFAULT_URLS;
let figmaKey = "";
const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;

if ((logUrls.length || figmaTargets.length) && rl) {
  console.log("Found real usage data in logs/:");
  logUrls.forEach(u => console.log(`  URL    ${u}`));
  figmaTargets.forEach(t => console.log(`  Figma  ${t.fileKey} node ${t.nodeId}`));
  const ok = (await rl.question("\nRun the bench on this real data? [y/N] ")).trim().toLowerCase();
  if (ok === "y" || ok === "yes") {
    if (logUrls.length) URLS = logUrls;
    if (figmaTargets.length) {
      console.log("\nTo bench the Figma optimizer on these designs a Figma API key is needed.");
      console.log("The key is NOT stored anywhere — it lives only in this process for this run.");
      figmaKey = (await rl.question("Figma API key (empty = skip Figma bench): ")).trim();
    }
  }
  console.log();
} else if (logUrls.length && !rl) {
  console.log("(logs found, but stdin is not a TTY — using default URLs, skipping Figma)\n");
}
rl?.close();

const figmaEnabled = !!figmaKey;
const figmaEnv = figmaEnabled ? {
  FIGMA_MCP_CMD: process.env.FIGMA_MCP_CMD ?? "npx -y figma-developer-mcp --stdio",
  FIGMA_API_KEY: figmaKey,
  FIGMA_CACHE_TTL: "60000",
} : {};

// ─── 1. Cold instance: honest latency + compact table ────────────────────────
// Prefetch/delta off, otherwise navigate→snapshot measures a cache hit, not a snapshot.
process.stdout.write("Connecting (cold instance: prefetch/delta off)... ");
const cold = await connect({
  PLAYGUARD_SCREENSHOTS: "allow",
  PLAYGUARD_PREFETCH_SNAPSHOT: "false",
  PLAYGUARD_DELTA: "false",
});
console.log("OK\n");

console.log("--- Latency (real snapshot, no prefetch, " + URLS[0].replace("https://", "") + ") ---");
await cold.callTool({ name: "browser_navigate", arguments: { url: URLS[0] } });
await cold.callTool({ name: "browser_snapshot", arguments: {} }); // warm-up

const times = [];
for (let i = 0; i < LATENCY_RUNS; i++) {
  await cold.callTool({ name: "browser_navigate", arguments: { url: URLS[0] } }); // invalidate cache
  const t0 = performance.now();
  await cold.callTool({ name: "browser_snapshot", arguments: {} });
  times.push(performance.now() - t0);
  process.stdout.write(".");
}
console.log(`\n  avg ${ms(avg(times))}  p50 ${ms(pct(times,50))}  p90 ${ms(pct(times,90))}  min ${ms(Math.min(...times))}  max ${ms(Math.max(...times))}\n`);

console.log("--- Compact snapshot: raw vs filtered (token cost) ---");
console.log(
  "  " + "Page".padEnd(44) +
  "raw".padStart(10) + "  " + "compact".padStart(10) + "  " + "saved".padStart(7) +
  "  raw tokens"
);
console.log("  " + "─".repeat(84));

for (const url of URLS) {
  const short = url.replace("https://", "").slice(0, 42);
  const nav = await cold.callTool({ name: "browser_navigate", arguments: { url } }).catch(() => ({ isError: true }));
  if (nav.isError) { console.log(`  ${short.padEnd(44)}  (navigate failed, skipped)`); continue; }
  await sleep(600);

  const snap = await cold.callTool({ name: "browser_snapshot", arguments: {} });
  const sizes = parseCompactHeader(text(snap));
  if (sizes) {
    const { rawKB, cmpKB } = sizes;
    const saved = Math.round((1 - cmpKB / rawKB) * 100);
    console.log(
      "  " + short.padEnd(44) +
      `${rawKB.toFixed(1)} KB`.padStart(10) + "  " +
      `${cmpKB.toFixed(1)} KB`.padStart(10) + "  " +
      `${saved}%`.padStart(7) + "  " +
      tok(rawKB * 1024)
    );
  } else {
    console.log(`  ${short.padEnd(44)}  (could not parse header)`);
  }
}
console.log();
await cold.close();

// ─── 2. Warm instance: production defaults ────────────────────────────────────
process.stdout.write("Connecting (warm instance: production defaults + redirect)... ");
const pg = await connect({ PLAYGUARD_SCREENSHOTS: "redirect", ...figmaEnv });
console.log("OK\n");

const { tools } = await pg.listTools();
const figmaToolCount = tools.filter(t => t.name.includes("figma")).length;
console.log(`Tools proxied: ${tools.length}${figmaToolCount ? ` (incl. ${figmaToolCount} figma)` : ""}\n`);

// ── Prefetch + cache + delta (mirrors real agent flow: navigate, settle, snapshot ×3)
console.log("--- Snapshot cache & prefetch (production behavior) ---");
await pg.callTool({ name: "browser_navigate", arguments: { url: URLS[0] } });
await sleep(1200); // let background prefetch land

const s1 = await pg.callTool({ name: "browser_snapshot", arguments: {} });
const s2 = await pg.callTool({ name: "browser_snapshot", arguments: {} });
const t1 = text(s1);
const kind1 = t1.startsWith("[PlayGuard: UNCHANGED") ? "prefetch HIT ✓"
  : t1.includes("[PlayGuard delta:") ? "delta vs prefetch ✓" : "full (prefetch lost race)";
const isHit2 = text(s2).startsWith("[PlayGuard: UNCHANGED");

console.log(`  1st snapshot after navigate: ${kind1}  ${kb(bytes(s1)).padStart(8)}  ${tok(bytes(s1))}`);
console.log(`  2nd snapshot (${isHit2 ? "cache HIT ✓" : "miss ✗"}): ${kb(bytes(s2)).padStart(8)}  ${tok(bytes(s2))}${isHit2 ? "  ← " + Math.round((1 - bytes(s2) / bytes(s1)) * 100) + "% vs 1st" : ""}`);

const nav2 = await pg.callTool({ name: "browser_navigate", arguments: { url: URLS[1] ?? URLS[0] + "/#other" } });
if (!nav2.isError) {
  const s3 = await pg.callTool({ name: "browser_snapshot", arguments: {} });
  console.log(`  after navigate: ${text(s3).startsWith("[PlayGuard: UNCHANGED") ? "prefetch HIT ✓ (new page)" : "recomputed ✓"}  ← cache invalidated + re-prefetched`);
}
console.log();

// ── Eval cache + output truncation
console.log("--- Evaluate: dedup cache + output truncation ---");
const e1t0 = performance.now();
await pg.callTool({ name: "browser_evaluate", arguments: { function: "() => document.title" } });
const e1ms = performance.now() - e1t0;
const e2t0 = performance.now();
await pg.callTool({ name: "browser_evaluate", arguments: { function: "() => document.title" } });
const e2ms = performance.now() - e2t0;
console.log(`  identical eval ×2: ${ms(e1ms)} → ${ms(e2ms)}  ${e2ms < e1ms / 2 ? "(cache HIT ✓)" : "(no hit — TTL 500ms may have passed)"}`);

const big = await pg.callTool({ name: "browser_evaluate", arguments: { function: "() => 'x'.repeat(50000)" } });
const bigTruncated = text(big).includes("[PlayGuard: eval output truncated");
console.log(`  50KB eval output: ${bigTruncated ? "truncated ✓ → " + kb(bytes(big)) : "NOT truncated ✗"}\n`);

// ── Screenshot → snapshot redirect
console.log("--- Screenshot redirect (PLAYGUARD_SCREENSHOTS=redirect) ---");
const shot = await pg.callTool({ name: "browser_take_screenshot", arguments: {} });
const redirected = text(shot).includes("snapshot served instead of screenshot");
console.log(`  browser_take_screenshot: ${redirected ? "redirected to snapshot ✓" : "real pixels ✗"}  ${kb(bytes(shot))}  ${tok(bytes(shot))}\n`);

// ── Figma optimizer (real designs from logs)
let figmaRows = [];
if (figmaEnabled && figmaTargets.length) {
  console.log("--- Figma optimizer (real designs from logs) ---");
  for (const { fileKey, nodeId } of figmaTargets) {
    const label = `${fileKey.slice(0, 12)}… ${nodeId}`;
    try {
      const t0 = performance.now();
      const r = await pg.callTool({ name: "get_figma_data", arguments: { fileKey, nodeId } });
      const elapsed = performance.now() - t0;
      if (r.isError) { console.log(`  ${label.padEnd(28)} ERROR: ${text(r).slice(0, 80)}`); continue; }
      const h = parseFigmaHeader(text(r));
      const truncated = text(r).includes("figma output truncated");

      const c0 = performance.now();
      const r2 = await pg.callTool({ name: "get_figma_data", arguments: { fileKey, nodeId } });
      const cachedMs = performance.now() - c0;
      const cacheHit = !r2.isError && cachedMs < elapsed / 4;

      if (h) {
        figmaRows.push(h);
        console.log(`  ${label.padEnd(28)} ${h.inKB.toFixed(1)}KB → ${h.outKB.toFixed(1)}KB  (-${h.pct}%${truncated ? ", budget-trimmed" : ""})  ${ms(elapsed)}, repeat ${ms(cachedMs)} ${cacheHit ? "cache ✓" : ""}`);
      } else {
        console.log(`  ${label.padEnd(28)} ${kb(bytes(r))} (no optimizer header — upstream not JSON/YAML?)  ${ms(elapsed)}`);
      }
    } catch (e) {
      console.log(`  ${label.padEnd(28)} FAILED: ${String(e).slice(0, 80)}`);
    }
  }
  console.log();
}

// ── Crash recovery (last: it disrupts the browser)
console.log(`--- Crash recovery (${CRASH_CYCLES} cycles via chrome://crash) ---`);
const recoveryTimes = [];
for (let i = 1; i <= CRASH_CYCLES; i++) {
  await pg.callTool({ name: "browser_navigate", arguments: { url: URLS[0] } });
  process.stdout.write(`  Cycle ${i}: crash → `);
  await Promise.race([
    pg.callTool({ name: "browser_navigate", arguments: { url: "chrome://crash" } }),
    sleep(3000),
  ]).catch(() => {});

  const t0 = performance.now();
  const result = await pg.callTool({ name: "browser_navigate", arguments: { url: URLS[0] } });
  const elapsed = performance.now() - t0;
  if (result.isError) console.log(`FAILED in ${ms(elapsed)}`);
  else { recoveryTimes.push(elapsed); console.log(`recovered in ${ms(elapsed)}`); }
}
console.log();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log("─── Summary ─────────────────────────────────────────────────────────");
console.log(`  Data source:           ${URLS === DEFAULT_URLS ? "default URLs" : "real URLs from logs/"}${figmaRows.length ? " + real Figma designs" : ""}`);
console.log(`  Tools proxied:         ${tools.length} (zero API changes)`);
console.log(`  Snapshot latency:      avg ${ms(avg(times))}, p90 ${ms(pct(times,90))} (real snapshots, prefetch off)`);
console.log(`  Compact savings:       see table above (PLAYGUARD_COMPACT=false to disable)`);
console.log(`  Cache/prefetch:        1st=${kind1}, repeat=${isHit2 ? "HIT ✓" : "miss ✗"}`);
console.log(`  Eval cache:            ${e2ms < e1ms / 2 ? "working ✓" : "no hit this run"}; big output truncation ${bigTruncated ? "✓" : "✗"}`);
console.log(`  Screenshot redirect:   ${redirected ? "working ✓" : "✗"}`);
if (figmaRows.length) {
  const totIn = figmaRows.reduce((s, r) => s + r.inKB, 0), totOut = figmaRows.reduce((s, r) => s + r.outKB, 0);
  console.log(`  Figma optimizer:       ${totIn.toFixed(1)}KB → ${totOut.toFixed(1)}KB across ${figmaRows.length} design(s) (-${Math.round((1 - totOut / totIn) * 100)}%)`);
}
console.log(`  Crash recovery:        ${recoveryTimes.length}/${CRASH_CYCLES} automatic${recoveryTimes.length ? ", avg " + ms(avg(recoveryTimes)) : ""}`);

await pg.close();

// ─── Session analytics (from this run's temp logs, then deleted) ─────────────
console.log("\n═══ Session analytics (bench run only, logs discarded after) ═══════");
spawnSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), "analyze.mjs")], {
  stdio: "inherit",
  env: { ...process.env, PLAYGUARD_LOG_DIR: BENCH_LOG_DIR },
});
rmSync(BENCH_LOG_DIR, { recursive: true, force: true });

console.log("\nDone.");
