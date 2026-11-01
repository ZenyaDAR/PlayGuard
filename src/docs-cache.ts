// On-disk cache for read-only documentation tools (Shopify search_docs_chunks, Context7
// resolve-library-id / query-docs): one JSON file per call under .playguard/.cache/docs.
// Stores the upstream result as received; rewrites run on every read. The key is a hash of
// (server, tool, normalized args) only — API keys never reach it or the files.
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "fs";
import { resolve } from "path";

// Key order must not decide identity (same rule as index.ts sortDeep, which this module
// cannot import: index.ts starts the server on import).
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])]))
  : v;

export function docsCacheKey(server: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([server, tool, sorted(args)])).digest("hex");
}

// ttlMs <= 0 or a missing/corrupt/expired file = miss.
export function readDocsCache<T>(dir: string, key: string, ttlMs: number, now = Date.now()): T | null {
  if (ttlMs <= 0) return null;
  try {
    const { ts, result } = JSON.parse(readFileSync(resolve(dir, `${key}.json`), "utf8"));
    return typeof ts === "number" && now - ts < ttlMs ? result as T : null;
  } catch { return null; }
}

// ponytail: no eviction, expired files just accumulate (a few KB per distinct lookup). If that
// ever matters, sweep files older than the longest TTL on the first write of a process.
let writeFailed = false;
// Atomic: another PlayGuard process reading the same key sees the old file or the new one,
// never a half-written one. Best-effort: a failure only costs this cache entry.
export function writeDocsCache(dir: string, key: string, result: unknown, now = Date.now()): void {
  const file = resolve(dir, `${key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ts: now, result }));
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    if (!writeFailed) { writeFailed = true; process.stderr.write(`[PlayGuard] docs cache write failed (further failures not reported): ${e}\n`); }
  }
}
