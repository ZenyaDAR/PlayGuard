// Snapshot compaction and the pure UNCHANGED/delta/full decision logic.
// Everything here is side-effect-free (state in, state out) so it's unit-testable
// without a live Playwright connection.
import { createHash } from "crypto";
import { COMPACT, TOKEN_BUDGET, SMART_WAIT_MIN_REFS } from "./config.js";

// Structural landmarks: keep for navigation context even without [ref=]
export const STRUCTURAL_RE = /^\s*- (document|main|nav|navigation|header|footer|form|article|section|dialog|banner|region|complementary|contentinfo|heading)\b/i;

export function hashContent(content: Array<{ text?: string }>): string {
  return createHash("sha256")
    .update(content.map((c) => c.text ?? "").join(""))
    .digest("hex")
    .slice(0, 16);
}

// Keep only lines that Claude can act on:
// [ref=] lines are interactive elements; structural landmarks give context.
// Paragraphs, decorative images, static text have no refs and aren't needed.

function filterSubtree(lines: string[], filters: { section?: string, around?: number, depth?: number }): { filtered: string[], warning?: string } {
  let startIdx = -1;
  let startIndent = -1;
  let warning: string | undefined;

  if (filters.around !== undefined) {
    const refStr = `[ref=${filters.around}]`;
    const refIdx = lines.findIndex(l => l.includes(refStr));
    if (refIdx >= 0) {
      let currentIndent = lines[refIdx].length - lines[refIdx].trimStart().length;
      startIdx = refIdx;
      startIndent = currentIndent;
      for (let i = refIdx; i >= 0; i--) {
        const line = lines[i];
        if (line.trim() === "") continue;
        const indent = line.length - line.trimStart().length;
        if (indent < currentIndent && STRUCTURAL_RE.test(line)) {
          startIdx = i;
          startIndent = indent;
          break;
        } else if (indent < currentIndent) {
          currentIndent = indent;
        }
      }
    } else {
      warning = `ref=${filters.around}`;
    }
  } else if (filters.section) {
    const sectionLower = filters.section.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("- ")) {
        const label = trimmed.slice(2).toLowerCase();
        if (label.startsWith(sectionLower) || label.includes(`"${sectionLower}"`)) {
          startIdx = i;
          startIndent = line.length - trimmed.length;
          break;
        }
      }
    }
    if (startIdx === -1) warning = `section "${filters.section}"`;
  }

  if (startIdx >= 0) {
    const subtree = [lines[startIdx]];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") { subtree.push(line); continue; }
      const indent = line.length - line.trimStart().length;
      if (indent <= startIndent) break;

      if (filters.depth !== undefined && indent > startIndent + filters.depth * 2) continue;
      subtree.push(line);
    }
    return { filtered: subtree };
  }

  if (startIdx === -1 && filters.depth !== undefined && !filters.section && filters.around === undefined) {
    return {
      filtered: lines.filter(line => {
        if (line.trim() === "") return true;
        const indent = line.length - line.trimStart().length;
        return indent <= filters.depth! * 2;
      })
    };
  }

  return { filtered: lines, warning };
}

export function compactSnap(content: Array<{ text?: string }>, opts: { compact?: boolean, section?: string, around?: number, depth?: number } = {}): { text: string; rawBytes: number; keptBytes: number } {
  const rawText = content.map((c) => c.text ?? "").join("");
  const lines = rawText.split("\n");
  let kept = lines.filter((l) => l.includes("[ref=") || STRUCTURAL_RE.test(l) || l.trim() === "");

  const { filtered, warning } = filterSubtree(kept, opts);
  kept = filtered;

  const shouldCompact = opts.compact ?? COMPACT;
  const collapsed = shouldCompact ? collapseRuns(kept) : kept;
  const keptText = collapsed.join("\n");
  const rawBytes = Buffer.byteLength(rawText);
  const keptBytes = Buffer.byteLength(keptText);
  const pct = lines.length > 0 ? Math.round((1 - kept.length / lines.length) * 100) : 0;

  const headerOpts = [];
  if (opts.section) headerOpts.push(`section: ${opts.section}`);
  if (opts.around) headerOpts.push(`around: ${opts.around}`);
  if (opts.depth !== undefined) headerOpts.push(`depth: ${opts.depth}`);
  const headerCtx = headerOpts.length > 0 ? ` (${headerOpts.join(", ")})` : "";
  const warnStr = warning ? `[PlayGuard: ${warning} not found. Returning full snapshot.]\n` : "";

  const result = {
    text: warnStr + `[PlayGuard compact${headerCtx}: ${kept.length}/${lines.length} lines, ~${pct}% removed, ${(rawBytes / 1024).toFixed(1)}KB→${(keptBytes / 1024).toFixed(1)}KB]\n` + keptText,
    rawBytes,
    keptBytes,
  };
  if (TOKEN_BUDGET > 0) {
    const charLimit = TOKEN_BUDGET * 4;
    if (result.text.length > charLimit) {
      // Cut on a line boundary so we never split mid-`[ref=` and hand the agent a broken ref.
      const nl = result.text.lastIndexOf("\n", charLimit);
      const cut = nl > 0 ? nl : charLimit;
      const truncated = result.text.slice(0, cut);
      const remaining = result.text.slice(cut).split("\n").filter(l => l.includes("[ref=")).length;
      return {
        text: truncated + `\n[PlayGuard: truncated at ${TOKEN_BUDGET} tokens, ~${remaining} interactive elements omitted]`,
        rawBytes,
        keptBytes: Buffer.byteLength(truncated),
      };
    }
  }
  return result;
}

const COLLAPSE_MIN = 5;

function fingerprint(line: string) {
  return line.replace(/\[ref=\d+\]/, "[ref=?]").replace(/"[^"]*"/g, '"?"');
}

export function collapseRuns(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fp = fingerprint(lines[i]);
    let j = i + 1;
    while (j < lines.length && fingerprint(lines[j]) === fp) j++;
    const run = j - i;
    if (run >= COLLAPSE_MIN) {
      out.push(...lines.slice(i, i + 3));
      const refs = lines.slice(i + 3, j).map(l => l.match(/\[ref=(\d+)\]/)?.[1]).filter(Boolean);
      // A run without refs (e.g. blank lines left adjacent after filtering) has no range to show.
      out.push(refs.length
        ? `  [×${run - 3} more similar elements, refs ${refs[0]}–${refs.at(-1)}]`
        : `  [×${run - 3} more similar lines]`);
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out;
}

// Snapshot cache — cleared whenever a MUTATING tool succeeds
export interface SnapState {
  hash: string | null;
  ts: number;
  compact: string | null;
  rawBytes: number;
  prefetched: boolean; // was cache last populated by prefetch?
  lines: Set<string> | null;
  url: string;
  withoutAction: number;
  filterKey: string | null;
}
export const emptySnapState: SnapState = {
  hash: null, ts: 0, compact: null, rawBytes: 0,
  prefetched: false, lines: null, url: "", withoutAction: 0, filterKey: null,
};

export interface SnapshotMeta {
  cacheHit: boolean;
  prefetchHit?: boolean;
  delta: boolean;
  deltaAdded?: number;
  deltaRemoved?: number;
  savedBytes?: number;
  rawBytes?: number;
  keptBytes?: number;
  hinted: boolean;
  snapCount: number;
  section?: string;
  around?: number;
  depth?: number;
}

export interface SnapshotDecision {
  responseText: string;
  state: SnapState;
  meta: SnapshotMeta;
}

export interface SnapshotOptions {
  deltaEnabled: boolean;
  deltaThreshold: number;
  hintThreshold: number;
  compact: boolean;
  section?: string;
  around?: number;
  depth?: number;
}

// Pure decision logic for browser_snapshot: UNCHANGED (cache hit) vs delta vs full compact.
// Kept side-effect-free (state in, state out) so cache/delta behavior is unit-testable
// without a live Playwright connection.
export function decideSnapshot(
  content: Array<{ text?: string }>,
  state: SnapState,
  currentUrl: string,
  opts: SnapshotOptions,
): SnapshotDecision {
  const hash = hashContent(content);
  const filterKey = JSON.stringify({ s: opts.section, a: opts.around, d: opts.depth });

  if (state.hash && hash === state.hash && state.url === currentUrl && state.filterKey === filterKey) {
    const withoutAction = state.withoutAction + 1;
    const header = state.compact!.split("\n")[0];
    return {
      responseText: `[PlayGuard: UNCHANGED since ${Date.now() - state.ts}ms ago] ${header}`,
      state: { ...state, withoutAction },
      meta: { cacheHit: true, prefetchHit: state.prefetched || undefined, delta: false, savedBytes: state.rawBytes, hinted: false, snapCount: withoutAction, section: opts.section, around: opts.around, depth: opts.depth },
    };
  }

  const summary = compactSnap(content, opts);
  const newLines = summary.text.split("\n").filter(l => l.includes("[ref=") || STRUCTURAL_RE.test(l));
  const newSet = new Set(newLines);

  if (opts.deltaEnabled && state.lines && state.url === currentUrl && state.filterKey === filterKey) {
    const added = newLines.filter(l => !state.lines!.has(l));
    const removed = [...state.lines].filter(l => !newSet.has(l));
    const ratio = (added.length + removed.length) / (newLines.length || 1);

    if (ratio < opts.deltaThreshold) {
      const withoutAction = state.withoutAction + 1;
      const deltaText = [
        `[PlayGuard delta: +${added.length} added, ${removed.length} removed, ~${Math.round((1 - ratio) * 100)}% saved]`,
        added.length ? "ADDED:\n" + added.map(l => "  " + l.trim()).join("\n") : "",
        removed.length ? "REMOVED:\n" + removed.map(l => "  " + l.trim()).join("\n") : "",
      ].filter(Boolean).join("\n");
      return {
        responseText: deltaText,
        state: { hash, lines: newSet, url: currentUrl, ts: Date.now(), compact: summary.text, rawBytes: summary.rawBytes, prefetched: false, withoutAction, filterKey },
        meta: { cacheHit: false, delta: true, deltaAdded: added.length, deltaRemoved: removed.length, hinted: false, snapCount: withoutAction, section: opts.section, around: opts.around, depth: opts.depth },
      };
    }
  }

  const hinted = opts.hintThreshold > 0 && state.withoutAction >= opts.hintThreshold;
  let finalText = opts.compact ? summary.text : content.map((c) => c.text ?? "").join("");
  if (hinted) {
    const interactiveRefs = newLines.slice(0, 5).map(l => l.trim()).join("\n  ");
    finalText = `[PlayGuard hint: ${state.withoutAction} snapshots without action. Interactive elements available:\n  ${interactiveRefs}]\n` + finalText;
  }
  const withoutAction = state.withoutAction + 1;

  return {
    responseText: finalText,
    state: { hash, lines: newSet, url: currentUrl, ts: Date.now(), compact: summary.text, rawBytes: summary.rawBytes, prefetched: false, withoutAction, filterKey },
    meta: { cacheHit: false, delta: false, rawBytes: summary.rawBytes, keptBytes: summary.keptBytes, hinted, snapCount: withoutAction, section: opts.section, around: opts.around, depth: opts.depth },
  };
}

export function looksLikeLoading(content: Array<{ text?: string }>): boolean {
  const rawText = content.map((c) => c.text ?? "").join("");
  const refsCount = (rawText.match(/\[ref=\d+\]/g) || []).length;
  if (refsCount >= SMART_WAIT_MIN_REFS) return false;
  return /\b(loading|spinner|skeleton|progress|please wait)\b|загрузк/i.test(rawText);
}
