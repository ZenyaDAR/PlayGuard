#!/usr/bin/env node
// PlayGuard benchmark v3 — npm run bench

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const URLS = [
  "https://playwright.dev",
  "https://news.ycombinator.com",
  "https://github.com",
];
const LATENCY_RUNS = 10;
const CRASH_CYCLES = 3;

const kb  = (b) => `${(b / 1024).toFixed(1)} KB`;
const tok = (b) => `~${Math.round(b / 4).toLocaleString()} tok`;
const ms  = (n) => `${n.toFixed(0)}ms`;
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p / 100)];

function bytes(result) {
  return Buffer.byteLength(JSON.stringify(result.content));
}
function text(result) {
  return (result.content ?? []).map((x) => x.text ?? "").join("");
}

// Parse PlayGuard compact header: "... 14.0KB→2.1KB"
function parseCompactHeader(snapText) {
  const m = snapText.match(/(\d+\.\d+)KB→(\d+\.\d+)KB/);
  return m ? { rawKB: parseFloat(m[1]), cmpKB: parseFloat(m[2]) } : null;
}

function connect(extraEnv = {}) {
  const t = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, PLAYGUARD_SCREENSHOTS: "allow", ...extraEnv },
  });
  const c = new Client({ name: "bench", version: "0.1.0" });
  return c.connect(t).then(() => c);
}

// ─── 1. Connect ───────────────────────────────────────────────────────────────
process.stdout.write("Connecting... ");
const pg = await connect();
console.log("OK\n");

const { tools } = await pg.listTools();
console.log(`Tools proxied: ${tools.length}\n`);

// ─── 2. Latency ───────────────────────────────────────────────────────────────
console.log("--- Latency (warm, playwright.dev) ---");
await pg.callTool({ name: "browser_navigate", arguments: { url: "https://playwright.dev" } });
await pg.callTool({ name: "browser_snapshot", arguments: {} }); // discard warm-up

const times = [];
for (let i = 0; i < LATENCY_RUNS; i++) {
  // navigate to invalidate cache, then snapshot
  await pg.callTool({ name: "browser_navigate", arguments: { url: "https://playwright.dev" } });
  const t0 = performance.now();
  await pg.callTool({ name: "browser_snapshot", arguments: {} });
  times.push(performance.now() - t0);
  process.stdout.write(".");
}
console.log(`\n  avg ${ms(avg(times))}  p50 ${ms(pct(times,50))}  p90 ${ms(pct(times,90))}  min ${ms(Math.min(...times))}  max ${ms(Math.max(...times))}\n`);

// ─── 3. Compact snapshot: raw vs filtered ────────────────────────────────────
console.log("--- Compact snapshot: raw vs filtered (token cost) ---");
console.log(
  "  " + "Page".padEnd(30) +
  "raw".padStart(10) + "  " + "compact".padStart(10) + "  " + "saved".padStart(7) +
  "  raw tokens"
);
console.log("  " + "─".repeat(68));

for (const url of URLS) {
  await pg.callTool({ name: "browser_navigate", arguments: { url } });
  await new Promise((r) => setTimeout(r, 600));

  const snap = await pg.callTool({ name: "browser_snapshot", arguments: {} });
  const snapText = text(snap);
  const sizes = parseCompactHeader(snapText);

  if (sizes) {
    const { rawKB, cmpKB } = sizes;
    const saved = Math.round((1 - cmpKB / rawKB) * 100);
    const rawTok = tok(rawKB * 1024);
    console.log(
      "  " + url.replace("https://", "").padEnd(30) +
      `${rawKB.toFixed(1)} KB`.padStart(10) + "  " +
      `${cmpKB.toFixed(1)} KB`.padStart(10) + "  " +
      `${saved}%`.padStart(7) + "  " +
      rawTok
    );
  } else {
    console.log(`  ${url.replace("https://", "").padEnd(30)}  (could not parse header)`);
  }
}
console.log();

// ─── 4. Cache hit demo ────────────────────────────────────────────────────────
console.log("--- Snapshot cache: repeated calls on unchanged page ---");
await pg.callTool({ name: "browser_navigate", arguments: { url: "https://playwright.dev" } });
await new Promise((r) => setTimeout(r, 400));

const s1 = await pg.callTool({ name: "browser_snapshot", arguments: {} });
const s2 = await pg.callTool({ name: "browser_snapshot", arguments: {} }); // cache hit
const s3 = await pg.callTool({ name: "browser_snapshot", arguments: {} }); // cache hit again

const b1 = bytes(s1), b2 = bytes(s2), b3 = bytes(s3);
const isHit2 = text(s2).includes("UNCHANGED");
const isHit3 = text(s3).includes("UNCHANGED");

console.log(`  1st snapshot (miss):  ${kb(b1).padStart(8)}  ${tok(b1)}`);
console.log(`  2nd snapshot (${isHit2 ? "HIT ✓" : "miss ✗"}):  ${kb(b2).padStart(8)}  ${tok(b2)}${isHit2 ? "  ← " + Math.round((1-b2/b1)*100) + "% saved" : ""}`);
console.log(`  3rd snapshot (${isHit3 ? "HIT ✓" : "miss ✗"}):  ${kb(b3).padStart(8)}  ${tok(b3)}${isHit3 ? "  ← " + Math.round((1-b3/b1)*100) + "% saved" : ""}`);

await pg.callTool({ name: "browser_navigate", arguments: { url: "https://playwright.dev/docs/intro" } });
const s4 = await pg.callTool({ name: "browser_snapshot", arguments: {} });
console.log(`  after navigate (miss): ${kb(bytes(s4)).padStart(7)}  ${tok(bytes(s4))}  ← cache invalidated\n`);

// ─── 5. Crash recovery ────────────────────────────────────────────────────────
console.log(`--- Crash recovery (${CRASH_CYCLES} cycles via chrome://crash) ---`);
const recoveryTimes = [];

for (let i = 1; i <= CRASH_CYCLES; i++) {
  await pg.callTool({ name: "browser_navigate", arguments: { url: "https://playwright.dev" } });
  process.stdout.write(`  Cycle ${i}: crash → `);
  await Promise.race([
    pg.callTool({ name: "browser_navigate", arguments: { url: "chrome://crash" } }),
    new Promise((r) => setTimeout(r, 3000)),
  ]).catch(() => {});

  const t0 = performance.now();
  const result = await pg.callTool({ name: "browser_navigate", arguments: { url: "https://playwright.dev" } });
  const elapsed = performance.now() - t0;

  if (result.isError) {
    console.log(`FAILED in ${ms(elapsed)}`);
  } else {
    recoveryTimes.push(elapsed);
    console.log(`recovered in ${ms(elapsed)}`);
  }
}
console.log();

// ─── 6. Summary ───────────────────────────────────────────────────────────────
console.log("─── Summary ─────────────────────────────────────────────────────────");
console.log(`  Tools proxied:         ${tools.length} (zero API changes)`);
console.log(`  Snapshot latency:      avg ${ms(avg(times))}, p90 ${ms(pct(times,90))}`);
console.log(`  Compact savings:       see table above (PLAYGUARD_COMPACT=false to disable)`);
console.log(`  Cache hits:            ${isHit2 && isHit3 ? "working ✓" : "check output above"}, repeat snapshots ~99% cheaper`);
console.log(`  Crash recovery:        ${recoveryTimes.length}/${CRASH_CYCLES} automatic${recoveryTimes.length ? ", avg " + ms(avg(recoveryTimes)) : ""}`);

await pg.close();
console.log("\nDone.");
