#!/usr/bin/env node
import { readdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const LOG_DIR = process.env.PLAYGUARD_LOG_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "..", "logs");

let files;
try { files = readdirSync(LOG_DIR).filter(f => f.endsWith(".ndjson")); }
catch { console.error("No logs dir found. Run PlayGuard first."); process.exit(1); }

if (!files.length) { console.log("No log files found."); process.exit(0); }

const entries = files.flatMap(f =>
  readFileSync(resolve(LOG_DIR, f), "utf8")
    .trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
);

const instances = new Set(entries.map(e => e.inst).filter(Boolean));
console.log(`\nAnalyzed ${entries.length} calls from ${files.length} log file(s)${instances.size ? ` across ${instances.size} server instance(s)` : ""}\n`);
if (instances.size > 1) console.log(`  (caches are per-instance and in-memory — repeat calls in different instances always miss)\n`);

const toTok = b => Math.round(b / 4);

// ── Snapshot token savings ─────────────────────────────────────────────────
const snaps = entries.filter(e => e.tool === "browser_snapshot");
const cacheHits = snaps.filter(e => e.cacheHit);
const compactSnaps = snaps.filter(e => !e.cacheHit && e.rawBytes != null);

const bytesSavedByCache   = cacheHits.reduce((s, e) => s + (e.savedBytes ?? 0), 0);
const bytesSavedByCompact = compactSnaps.reduce((s, e) => s + (e.rawBytes - e.keptBytes), 0);
const bytesActuallySent   = compactSnaps.reduce((s, e) => s + (e.keptBytes ?? e.rawBytes ?? 0), 0);
const bytesWouldHaveSent  = bytesSavedByCache + bytesSavedByCompact + bytesActuallySent;

if (snaps.length) {
  console.log("── Snapshot token savings ────────────────────────────────");
  const prefetchHits = cacheHits.filter(e => e.prefetchHit).length;
  console.log(`  Cache hits:      ${cacheHits.length}/${snaps.length} snapshots (${prefetchHits} from prefetch)`);
  console.log(`  Bytes saved by cache:   ${(bytesSavedByCache/1024).toFixed(1)} KB  (~${toTok(bytesSavedByCache).toLocaleString()} tokens)`);
  console.log(`  Bytes saved by compact: ${(bytesSavedByCompact/1024).toFixed(1)} KB  (~${toTok(bytesSavedByCompact).toLocaleString()} tokens)`);
  console.log(`  Total saved:            ${((bytesSavedByCache+bytesSavedByCompact)/1024).toFixed(1)} KB  (~${toTok(bytesSavedByCache+bytesSavedByCompact).toLocaleString()} tokens)`);
  if (bytesWouldHaveSent > 0) {
    const pct = ((bytesSavedByCache + bytesSavedByCompact) / bytesWouldHaveSent * 100).toFixed(0);
    console.log(`  Reduction vs raw:       ${pct}%  (${(bytesActuallySent/1024).toFixed(1)} KB sent vs ${(bytesWouldHaveSent/1024).toFixed(1)} KB without PlayGuard)`);
  }
  console.log();
}

// ── PlayGuard interceptions ────────────────────────────────────────────────
const redirected = entries.filter(e => e.tool === "browser_take_screenshot" && e.redirected);
const evalHits   = entries.filter(e => e.evalCacheHit);
const evalAll    = entries.filter(e => e.tool === "browser_evaluate");
const retried    = entries.filter(e => e.retried);

if (redirected.length || evalHits.length || retried.length) {
  console.log("── PlayGuard interceptions ───────────────────────────────");
  if (redirected.length) {
    const fromCache = redirected.filter(e => e.cacheHit).length;
    const bytesSaved = redirected.reduce((s, e) => s + (e.rawBytes ?? 0), 0);
    console.log(`  Screenshot → snapshot: ${redirected.length} redirected (${fromCache} from cache, ${redirected.length - fromCache} fresh, ~${toTok(bytesSaved).toLocaleString()} tokens saved)`);
  }
  if (evalHits.length) {
    const realEvals = evalAll.filter(e => !e.evalCacheHit);
    const avgMs = realEvals.length ? Math.round(realEvals.reduce((s, e) => s + e.ms, 0) / realEvals.length) : 0;
    console.log(`  Eval cache hits:       ${evalHits.length}/${evalAll.length} evaluates (~${avgMs * evalHits.length}ms saved at ${avgMs}ms avg)`);
  }
  if (retried.length) {
    console.log(`  Browser crashes:       ${retried.length} calls required retry (browser revival)`);
  }
  console.log();
}

// ── Per-tool latency table ─────────────────────────────────────────────────
const byTool = {};
for (const e of entries) (byTool[e.tool] ??= []).push(e);

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)] ?? 0;
}

const rows = Object.entries(byTool).map(([tool, calls]) => {
  const ms = calls.map(c => c.ms);
  const errors = calls.filter(c => c.err).length;
  const intercepted = calls.filter(c => c.cacheHit || c.evalCacheHit || c.redirected).length;
  return [
    tool, calls.length, errors,
    ((errors / calls.length) * 100).toFixed(0) + "%",
    intercepted || "-",
    Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
    pct(ms, 50), pct(ms, 95), pct(ms, 99), Math.max(...ms),
  ].map(String);
}).sort((a, b) => +b[1] - +a[1]);

const headers = ["tool", "count", "errors", "err%", "intercepted", "avg ms", "p50", "p95", "p99", "max"];
const widths = headers.map(h => h.length);
for (const row of rows) row.forEach((v, i) => { widths[i] = Math.max(widths[i], v.length); });

const line = "+" + widths.map(w => "-".repeat(w + 2)).join("+") + "+";
const fmt = row => "| " + row.map((v, i) => v.padStart(widths[i])).join(" | ") + " |";

console.log("── Latency by tool ───────────────────────────────────────");
console.log(line);
console.log(fmt(headers));
console.log(line);
for (const row of rows) console.log(fmt(row));
console.log(line);

const totalMs = entries.reduce((s, e) => s + e.ms, 0);
const totalErr = entries.filter(e => e.err).length;
console.log(`\nTotal time in browser calls: ${(totalMs / 1000).toFixed(2)}s`);
console.log(`Overall error rate: ${totalErr}/${entries.length} (${((totalErr/entries.length)*100).toFixed(1)}%)`);

// ── Top pages by call volume ───────────────────────────────────────────────
const byUrl = {};
for (const e of entries) {
  if (!e.url) continue;
  (byUrl[e.url] ??= []).push(e);
}
const urlRows = Object.entries(byUrl)
  .map(([u, calls]) => ({
    url: u.length > 60 ? u.slice(0, 57) + "..." : u,
    count: calls.length,
    avgMs: Math.round(calls.reduce((s, c) => s + c.ms, 0) / calls.length),
    errors: calls.filter(c => c.err).length,
  }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 8);

if (urlRows.length) {
  console.log("\n── Top pages by call volume ──────────────────────────────");
  const uh = ["url", "calls", "avg ms", "errors"];
  const uw = uh.map(h => h.length);
  const ud = urlRows.map(r => [r.url, r.count, r.avgMs, r.errors].map(String));
  ud.forEach(row => row.forEach((v, i) => { uw[i] = Math.max(uw[i], v.length); }));
  const ul = "+" + uw.map(w => "-".repeat(w + 2)).join("+") + "+";
  const uf = row => "| " + row.map((v, i) => (i === 0 ? v.padEnd(uw[i]) : v.padStart(uw[i]))).join(" | ") + " |";
  console.log(ul);
  console.log(uf(uh));
  console.log(ul);
  for (const row of ud) console.log(uf(row));
  console.log(ul);
}

// ── Evaluate script frequency (detect polling loops) ──────────────────────
const evalWithHash = evalAll.filter(e => e.scriptHash);
if (evalWithHash.length) {
  const byScript = {};
  for (const e of evalWithHash) (byScript[e.scriptHash] ??= []).push(e);
  const scriptRows = Object.entries(byScript)
    .map(([hash, calls]) => ({
      hash,
      count: calls.length,
      cacheHits: calls.filter(c => c.evalCacheHit).length,
      avgMs: Math.round(calls.filter(c => !c.evalCacheHit).reduce((s, c) => s + c.ms, 0) / (calls.filter(c => !c.evalCacheHit).length || 1)),
      truncated: calls.filter(c => c.truncated).length,
      avgOutputKB: calls.filter(c => c.outputBytes).length
        ? (calls.filter(c => c.outputBytes).reduce((s, c) => s + c.outputBytes, 0) / calls.filter(c => c.outputBytes).length / 1024).toFixed(1)
        : "-",
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  console.log("\n── Evaluate scripts (top by frequency) ──────────────────");
  const eh = ["scriptHash", "calls", "cacheHits", "avg ms", "avg KB", "truncated"];
  const ew = eh.map(h => h.length);
  const ed = scriptRows.map(r => [r.hash, r.count, r.cacheHits, r.avgMs, r.avgOutputKB, r.truncated].map(String));
  ed.forEach(row => row.forEach((v, i) => { ew[i] = Math.max(ew[i], v.length); }));
  const el = "+" + ew.map(w => "-".repeat(w + 2)).join("+") + "+";
  const ef = row => "| " + row.map((v, i) => v.padStart(ew[i])).join(" | ") + " |";
  console.log(el);
  console.log(ef(eh));
  console.log(el);
  for (const row of ed) console.log(ef(row));
  console.log(el);

  const truncatedTotal = evalAll.filter(e => e.truncated).length;
  // ponytail: no guessed fallback number here — analyze.mjs is a separate process reading
  // logs after the fact, it can't know the running server's compiled-in default, only what
  // this shell's env says. Avoids a second hardcoded copy of src/index.ts's default drifting.
  if (truncatedTotal) console.log(`  ${truncatedTotal} evaluate(s) had output truncated (PLAYGUARD_EVAL_COMPACT=${process.env.PLAYGUARD_EVAL_COMPACT ?? "default"})`);
}

// ── Figma optimizer analytics ──────────────────────────────────────────────
const figmaEntries = entries.filter(e => e.figma);
if (figmaEntries.length) {
  const figmaCacheHits = figmaEntries.filter(e => e.cacheHit);
  const figmaOptimized = figmaEntries.filter(e => !e.cacheHit && e.inBytes != null);

  const totalIn  = figmaOptimized.reduce((s, e) => s + (e.inBytes  ?? 0), 0);
  const totalOut = figmaOptimized.reduce((s, e) => s + (e.outBytes ?? 0), 0);
  const totalSaved = totalIn - totalOut;

  console.log("\n── Figma optimizer ───────────────────────────────────────");
  console.log(`  Calls:       ${figmaEntries.length} total  (${figmaCacheHits.length} cache hits, ${figmaOptimized.length} optimized)`);

  if (totalIn > 0) {
    const pct = ((totalSaved / totalIn) * 100).toFixed(0);
    console.log(`  Tokens in:   ~${toTok(totalIn).toLocaleString()}  →  out: ~${toTok(totalOut).toLocaleString()}  (saved ~${toTok(totalSaved).toLocaleString()}, -${pct}%)`);
    console.log(`  Bytes:       ${(totalIn/1024).toFixed(1)} KB  →  ${(totalOut/1024).toFixed(1)} KB`);
  }

  // Per-module breakdown
  const sum = key => figmaOptimized.reduce((s, e) => s + (e[key] ?? 0), 0);
  const modules = [
    ["M1 metadata",  sum("metaKeysDeleted"),    "keys deleted"],
    ["M2 invisible", sum("invisiblePruned"),     "nodes pruned"],
    ["M3 dedup",     sum("instancesCollapsed"),  `instances collapsed (${sum("uniqueComponents")} unique components)`],
    ["M4 svg refs",  sum("svgRefsReplaced"),     "SVG vectors replaced with refs"],
    ["M6 layout",    sum("layoutCoordsRemoved"), "x/y pairs removed"],
    ["M8a dup sibs", sum("siblingsCollapsed"),   "duplicate siblings collapsed"],
    ["M8a+ struct",  sum("structSiblingsCollapsed"), "structural copies collapsed (text diff kept)"],
    ["M8b styles",   sum("emptyStylesDropped"),  "no-op layout styles dropped"],
    ["M8c floats",   sum("floatsRounded"),       "float values rounded"],
  ].filter(([, n]) => n > 0);

  if (modules.length) {
    console.log("\n  Module breakdown:");
    for (const [label, n, unit] of modules)
      console.log(`    ${label.padEnd(12)}  ${String(n).padStart(6)}  ${unit}`);
  }

  // Repeat-call cache proof: same argsHash = byte-identical request, so every repeat
  // is either a cache hit, a cross-instance miss (separate process, separate cache),
  // or a TTL-expired / cache-disabled miss within one instance.
  const withArgsHash = figmaEntries.filter(e => e.argsHash && !e.err);
  if (withArgsHash.length) {
    const byArgs = {};
    for (const e of withArgsHash) (byArgs[e.argsHash] ??= []).push(e);
    const groups = Object.values(byArgs).filter(g => g.length > 1);
    if (groups.length) {
      let hits = 0, crossInstance = 0, sameInstanceMiss = 0;
      const missGaps = [];
      for (const g of groups) {
        g.sort((a, b) => a.ts - b.ts);
        for (let i = 1; i < g.length; i++) {
          if (g[i].cacheHit) hits++;
          else if (g[i].inst && g[i].inst !== g[i - 1].inst) crossInstance++;
          else { sameInstanceMiss++; missGaps.push(Math.round((g[i].ts - g[i - 1].ts) / 1000)); }
        }
      }
      console.log(`\n  Repeat calls (identical args): ${groups.reduce((s, g) => s + g.length - 1, 0)} repeats in ${groups.length} group(s)`);
      console.log(`    cache hits: ${hits}   cross-instance misses: ${crossInstance}   same-instance misses: ${sameInstanceMiss}${missGaps.length ? ` (gaps: ${missGaps.join("s, ")}s — check FIGMA_CACHE_TTL)` : ""}`);
    }
  }

  // Per-file table
  const byFile = {};
  for (const e of figmaEntries) {
    if (!e.fileKey) continue;
    (byFile[e.fileKey] ??= []).push(e);
  }
  const fileRows = Object.entries(byFile)
    .map(([key, calls]) => {
      const opt = calls.filter(c => c.inBytes != null);
      const inB  = opt.reduce((s, c) => s + (c.inBytes  ?? 0), 0);
      const outB = opt.reduce((s, c) => s + (c.outBytes ?? 0), 0);
      return {
        fileKey:  key.length > 22 ? key.slice(0, 19) + "..." : key,
        calls:    calls.length,
        cached:   calls.filter(c => c.cacheHit).length,
        savedKB:  ((inB - outB) / 1024).toFixed(1),
        pct:      inB > 0 ? Math.round((1 - outB / inB) * 100) + "%" : "-",
        avgMs:    Math.round(calls.reduce((s, c) => s + c.ms, 0) / calls.length),
      };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);

  if (fileRows.length) {
    console.log("\n  Top Figma files:");
    const fh = ["fileKey", "calls", "cached", "saved KB", "reduction", "avg ms"];
    const fw = fh.map(h => h.length);
    const fd = fileRows.map(r => [r.fileKey, r.calls, r.cached, r.savedKB, r.pct, r.avgMs].map(String));
    fd.forEach(row => row.forEach((v, i) => { fw[i] = Math.max(fw[i], v.length); }));
    const fl = "+" + fw.map(w => "-".repeat(w + 2)).join("+") + "+";
    const ff = row => "| " + row.map((v, i) => (i === 0 ? v.padEnd(fw[i]) : v.padStart(fw[i]))).join(" | ") + " |";
    console.log(fl);
    console.log(ff(fh));
    console.log(fl);
    for (const row of fd) console.log(ff(row));
    console.log(fl);
  }
}

// ── Screenshot bytes comparison ────────────────────────────────────────────
const realShots = entries.filter(e => e.tool === "browser_take_screenshot" && !e.redirected && e.screenshotBytes > 0);
if (realShots.length) {
  const totalShotKB = realShots.reduce((s, e) => s + e.screenshotBytes, 0) / 1024;
  const avgShotKB = (totalShotKB / realShots.length).toFixed(1);
  const avgSnapKB = compactSnaps.length
    ? (compactSnaps.reduce((s, e) => s + e.keptBytes, 0) / compactSnaps.length / 1024).toFixed(1)
    : "?";
  console.log(`\n── Screenshot size ───────────────────────────────────────`);
  const visualShots = realShots.filter(e => e.visual).length;
  console.log(`  ${realShots.length} real screenshot(s): avg ${avgShotKB} KB/shot (total ${totalShotKB.toFixed(1)} KB)${visualShots ? `, ${visualShots} explicitly requested pixels ({visual:true})` : ""}`);
  if (avgSnapKB !== "?") console.log(`  Avg snapshot size:  ${avgSnapKB} KB  (${((1 - +avgSnapKB / +avgShotKB) * 100).toFixed(0)}% smaller than screenshot)`);
  if (redirected.length) {
    const savedKB = redirected.reduce((s, e) => s + (e.rawBytes ?? 0), 0) / 1024;
    console.log(`  Redirect saved:     ~${savedKB.toFixed(1)} KB across ${redirected.length} redirected call(s)`);
  }
}
