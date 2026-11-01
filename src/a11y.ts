// playguard_a11y_audit: runs axe-core inside the Playwright page and turns its
// result into a short, impact-sorted report. The heavy lifting (grouping, cutting
// node lists, trimming html) happens in the page, so only a few KB cross stdio back.
import { createRequire } from "module";
import { readFileSync } from "fs";

// WCAG 2.0–2.2 A/AA. best-practice is opt-in: it adds landmark/region noise on most sites.
export const DEFAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
export const MAX_NODES = 5; // elements listed per rule; the rest are counted

let axeSource: string | undefined;
// ponytail: read once, lazily — 650 KB nobody pays for until the first audit.
export function loadAxeSource(): string {
  return axeSource ??= readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
}

export type AxeNode = { t: string; h: string; f: string };
export type AxeViolation = { id: string; impact: string | null; help: string; helpUrl: string; n: number; nodes: AxeNode[] };
export type AxeSummary = {
  v: AxeViolation[]; passes: number; incomplete: string[]; version: string; url: string; _error?: string;
};

// Browser-side function for browser_evaluate. axe is injected once per page; the UMD
// globals are shadowed so a page with RequireJS/CommonJS shims can't swallow it.
// ponytail: the source is resent on every call (axe is skipped if already there) — a
// local stdio hop of ~650 KB; a presence check would cost an extra page-settle wait.
export function buildAxeScript(source: string, opts: { selector?: string; tags?: string[] } = {}): string {
  const tags = opts.tags?.length ? opts.tags : DEFAULT_TAGS;
  return `async () => {
  // Not just !window.axe: an element with id="axe" makes window.axe a DOM node.
  if (typeof (window.axe && window.axe.run) !== "function") { (function (module, exports, define) { ${source}
  }).call(window); }
  const ctx = ${opts.selector ? JSON.stringify(opts.selector) : "document"};
  const tags = ${JSON.stringify(tags)};
  // axe runs zero rules for an unknown tag and reports a clean page — say so instead.
  // Per tag: getRules(tags) matches rules with ANY of them, so one typo among good tags would slip by.
  const unknown = tags.filter(t => !window.axe.getRules([t]).length);
  if (unknown.length) return { _error: "no axe rules match tag" + (unknown.length > 1 ? "s " : " ") + unknown.join(", "), url: location.href };
  let r;
  try {
    r = await window.axe.run(ctx, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
  } catch (e) { return { _error: String(e && e.message || e), url: location.href }; }
  // First reason only: under "Fix any of the following" every line is an alternative fix.
  const fix = (s) => {
    const l = (s || "").split("\\n").map(x => x.trim()).filter(x => x && !/^Fix (any|all) of the following:$/.test(x));
    return l.length ? l[0].slice(0, 240) + (l.length > 1 ? " (+" + (l.length - 1) + " more)" : "") : "";
  };
  return {
    v: r.violations.map(v => ({
      id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl.replace(/\\?application=axeAPI$/, ""), n: v.nodes.length,
      nodes: v.nodes.slice(0, ${MAX_NODES}).map(n => ({ t: n.target.map(String).join(" "), h: n.html.replace(/\\s+/g, " ").slice(0, 140), f: fix(n.failureSummary) })),
    })),
    passes: r.passes.length, incomplete: r.incomplete.map(i => i.id), version: window.axe.version, url: location.href,
  };
}`;
}

const RANK: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

export function formatAxe(r: AxeSummary, tags: string[] = DEFAULT_TAGS): string {
  const v = [...r.v].sort((a, b) => (RANK[a.impact ?? ""] ?? 4) - (RANK[b.impact ?? ""] ?? 4) || b.n - a.n);
  const elements = v.reduce((s, x) => s + x.n, 0);
  const head = `[PlayGuard a11y: ${v.length} violation${v.length === 1 ? "" : "s"} (${elements} element${elements === 1 ? "" : "s"}) · ` +
    `${r.passes} rule${r.passes === 1 ? "" : "s"} passed · axe ${r.version} · ${tags.join(",")} · ${r.url}]`;
  const out = [head];
  for (const x of v) {
    out.push("", `${(x.impact ?? "unknown").padEnd(8)} ${x.id} — ${x.help} (${x.n})`);
    for (const n of x.nodes) out.push(`  - ${n.t}  ${n.h}${n.f ? `\n    ${n.f}` : ""}`);
    if (x.n > x.nodes.length) out.push(`  … +${x.n - x.nodes.length} more`);
    out.push(`  ${x.helpUrl}`);
  }
  if (r.incomplete.length) out.push("", `Needs manual review (axe could not decide): ${r.incomplete.join(", ")}`);
  if (!v.length) out.push("No violations for these tags. Automated checks don't cover keyboard flow or screen-reader wording — those still need a manual pass.");
  else out.push("", "Selectors are CSS (use them in browser_evaluate); element [ref=] ids come from browser_snapshot.");
  return out.join("\n");
}
