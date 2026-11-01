// Chrome DevTools MCP (chrome-devtools-mcp) optimizers: upstream launch defaults, a
// cheaper tools/list, and response rewrites for network, trace and error output.
// All pure — index.ts does the I/O. Formats mirror chrome-devtools-mcp 1.12
// (formatters/NetworkFormatter.js, McpResponse.js).
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Tools that never change page state. Every other DevTools tool invalidates the snapshot
// UNCHANGED shortcut after it succeeds. Upstream's readOnlyHint is not the source here:
// select_page and wait_for claim read-only but change which page/state the next snapshot
// sees, while take_snapshot/take_screenshot/get_network_request claim mutating only
// because they can write a file.
export const DEVTOOLS_READ_ONLY = new Set<string>([
  "take_snapshot", "take_screenshot", "list_pages", "list_console_messages", "get_console_message",
  "list_network_requests", "get_network_request", "get_css_styles", "performance_analyze_insight",
]);

// Tools that accept the PlayGuard-only `raw:true` argument (skip our rewrite for this call).
// index.ts strips `raw` before forwarding upstream.
export const DEVTOOLS_RAW_TOOLS = new Set<string>([
  "take_snapshot", "get_network_request", "performance_start_trace", "performance_stop_trace",
]);

// Upstream defaults we flip: usage statistics go to Google, performanceCrux sends every
// traced URL to Google's CrUX API, and page-id routing adds a required pageId to 30 of
// 32 tools (~2.5K chars of tools/list) that a single-agent proxy never needs.
const DEVTOOLS_OFF_BY_DEFAULT = ["usage-statistics", "performance-crux", "page-id-routing"];
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

// Appends privacy and routing defaults to the upstream argv unless the user already set
// the same option in any spelling yargs accepts (--x, --no-x, --x=false, camelCase).
// The whole argv is scanned: `npm exec -- chrome-devtools-mcp --usage-statistics` puts the
// user's options after `--`, and ours are appended after them too.
// ponytail: CLI only — the same option set in a --config JSON file is not seen, and
// ours then wins (CLI beats config file upstream).
export function withDevtoolsDefaults(args: string[]): string[] {
  const given = new Set(args.map(a => {
    const m = /^--(?:no-)?([^=]+)/.exec(a);
    return m ? camel(m[1]) : "";
  }));
  const add = DEVTOOLS_OFF_BY_DEFAULT.filter(o => !given.has(camel(o))).map(o => `--no-${o}`);
  return [...args, ...add];
}

function compactSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema") continue; // 57 chars × 32 tools; clients assume the current draft
    out[k] = compactSchema(v);
  }
  return out;
}

const NAV_TOOLS = new Set(["new_page", "navigate_page", "list_pages"]);
const NAV_NOTE = "[PlayGuard] This is a separate Chrome instance from the browser_* (Playwright) tools: pages, cookies and uids are not shared.";
const RAW_PARAM = { type: "boolean", description: "PlayGuard: return the upstream response unmodified." };
const networkNote = (max: number) =>
  `[PlayGuard] Without pageSize/pageIdx/resourceTypes, a list longer than ${max} requests comes back as a summary ` +
  "(main document, failed and pending rows, per-host counts); pass pageSize/pageIdx or resourceTypes for the rows.";

// tools/list rewrite: drops $schema (lossless), adds the `raw` param on DEVTOOLS_RAW_TOOLS,
// a note on the navigation tools that this is a separate Chrome from browser_* tools, and —
// when networkMax (summarizeNetworkList's maxRows) is set — a note on list_network_requests
// that long lists are summarized. Descriptions are kept whole: they carry semantics agents
// rely on ("omit to reset", "Incompatible with uid"). Returns new objects; never mutates
// the upstream list.
export function compactDevtoolsTools(tools: Tool[], opts: { networkMax?: number } = {}): Tool[] {
  return tools.map(t => {
    const schema = compactSchema(t.inputSchema) as Tool["inputSchema"];
    if (DEVTOOLS_RAW_TOOLS.has(t.name)) schema.properties = { ...schema.properties, raw: RAW_PARAM };
    const note = NAV_TOOLS.has(t.name) ? NAV_NOTE
      : t.name === "list_network_requests" && opts.networkMax ? networkNote(opts.networkMax) : "";
    const description = note ? `${t.description ?? ""}\n${note}` : t.description;
    return { ...t, description, inputSchema: schema };
  });
}

// `reqid=12 GET https://… [200]`, optionally followed by the DevTools-panel marker.
// Status is the HTTP code, a net::ERR_* failure text, or "pending".
const NET_ROW = /^reqid=\S+ \S+ (.*) \[([^\]]*)\]$/;
const SELECTED = " [selected in the DevTools Network panel]";
const NET_OK = /^[123]\d\d$/;
const HOSTS_SHOWN = 8;
const PAGE_SIZE_HINT = 100;

// list_network_requests: when the agent did not page/filter and the list is long, return
// failed and pending rows + per-host counts + how to get the full list. Explicit pageSize/pageIdx/
// resourceTypes/includePreservedRequests → untouched. maxRows 0 = off.
export function summarizeNetworkList(
  text: string, args: Record<string, unknown>, maxRows: number,
): { text: string; summarized: boolean; rows: number } {
  const lines = text.split("\n");
  const start = lines.indexOf("## Network requests");
  if (start < 0) return { text, summarized: false, rows: 0 };
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const rows = lines.slice(start + 1, end).filter(l => l.startsWith("reqid="));
  const explicit = ["pageSize", "pageIdx", "resourceTypes", "includePreservedRequests"].some(k => args[k] !== undefined);
  if (!maxRows || explicit || rows.length <= maxRows) return { text, summarized: false, rows: rows.length };

  const failed: string[] = [];
  const pending: string[] = [];
  const hosts = new Map<string, number>();
  const parse = (row: string) => NET_ROW.exec(row.endsWith(SELECTED) ? row.slice(0, -SELECTED.length) : row);
  // The first row may be a redirect hop (http→https, / → /en/): the document is the first
  // row that isn't a 3xx. Its own status is on the Main line, so it's not repeated below.
  const main = rows.find(r => !/^3\d\d$/.test(parse(r)?.[2] ?? "")) ?? rows[0];
  for (const row of rows) {
    const m = parse(row);
    if (!m) continue;
    if (row === main) { /* shown on the Main line */ }
    else if (m[2] === "pending") pending.push(row);
    else if (!NET_OK.test(m[2])) failed.push(row);
    let host: string;
    try { host = new URL(m[1]).host || new URL(m[1]).protocol; } catch { host = "(unparsed)"; }
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const byCount = [...hosts].sort((a, b) => b[1] - a[1]);
  const rest = byCount.slice(HOSTS_SHOWN);
  const hostLine = byCount.slice(0, HOSTS_SHOWN).map(([h, n]) => `${h} ${n}`)
    .concat(rest.length ? [`${rest.length} other hosts ${rest.reduce((s, [, n]) => s + n, 0)}`] : []).join(", ");
  // ponytail: failed + pending rows share the maxRows cap (failed first) — a page where
  // everything failed would otherwise come back as the full list, which is what this replaces.
  const bucket = (name: string, list: string[], cap: number) => {
    const shown = list.slice(0, cap);
    return [list.length ? `${name} (${list.length}):` : `${name}: none`, ...shown,
      ...(list.length > shown.length ? [`… ${list.length - shown.length} more — page with pageSize/pageIdx`] : [])];
  };
  const pages = Math.ceil(rows.length / PAGE_SIZE_HINT);
  const summary = [
    `[PlayGuard: ${rows.length} requests, summarized to the main document, failed (4xx/5xx/net::ERR_*) and pending rows ` +
      `and per-host counts. Full list: pageSize:${PAGE_SIZE_HINT} → ${pages} page${pages > 1 ? "s" : ""} (pageIdx from 0); ` +
      `filter with resourceTypes (e.g. ["fetch","xhr"]).]`,
    `Main document: ${main}`,
    // The Main line takes one of the maxRows slots.
    ...bucket("Failed", failed, maxRows - 1),
    ...bucket("Pending", pending, Math.max(0, maxRows - 1 - failed.length)),
    `By host: ${hostLine}`,
  ];
  return {
    text: [...lines.slice(0, start + 1), ...summary, ...lines.slice(end)].join("\n"),
    summarized: true, rows: rows.length,
  };
}

// Headers an agent debugging a request almost never reads. Kept on purpose: cookie,
// set-cookie, location, content-type, cache-control, authorization and every x-*.
const NOISY_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "user-agent", "upgrade-insecure-requests", "priority",
  "report-to", "reporting-endpoints", "nel", "permissions-policy", "origin-trial", "alt-svc",
  "server-timing", "accept-ch",
]);
const NOISY_FAMILIES: [RegExp, string][] = [[/^sec-ch-ua/, "sec-ch-ua*"], [/^sec-fetch-/, "sec-fetch-*"], [/^:/, ":pseudo"]];
const CSP_HEADER = /^content-security-policy(-report-only)?$/;
const CSP_KEEP = 200; // shorter policies stay inline — cheaper than the note
// Line indices of the headings that end a body. NetworkFormatter.js emits, in order:
// Request Headers, [Request Body], [Response Headers], [Response Body], [Request failed with
// + one line], [Redirect chain + reqid rows]. A body is page content and may itself hold any
// of those lines, so the real ones are found by structure: the tail from the end, the rest
// as the first heading after a header block (header lines never start with "### ").
// ponytail: after a request body the real Response Headers is taken as the last one before
// the tail — a response body that itself holds "### Response Headers" would be misread then.
function bodyEnds(lines: string[]): Set<number> {
  const ends = new Set<number>();
  let tail = lines.length;
  const chain = lines.lastIndexOf("### Redirect chain");
  if (chain >= 0 && chain < tail - 1 && lines.slice(chain + 1).every(l => /^\s*reqid=/.test(l))) ends.add(tail = chain);
  if (lines[tail - 2] === "### Request failed with") ends.add(tail -= 2);
  const nextHeading = (from: number) => lines.findIndex((l, i) => i > from && l.startsWith("### "));
  const after = nextHeading(lines.indexOf("### Request Headers"));
  let resHeaders = lines[after] === "### Response Headers" ? after : -1;
  if (lines[after] === "### Request Body") {
    resHeaders = lines.lastIndexOf("### Response Headers", tail - 1);
    if (resHeaders <= after) resHeaders = -1;
  }
  const resBody = resHeaders >= 0 ? nextHeading(resHeaders)
    : lines[after] === "### Response Body" ? after : lines.lastIndexOf("### Response Body", tail - 1);
  for (const i of [resHeaders, resBody]) if (i > after && i < tail) ends.add(i);
  return ends;
}

// Bodies over bodyMax are cut, at a line break when one is in the last 20%. JSON is left
// whole: upstream already caps every body at 10K chars, and JSON cut mid-structure is
// misread. Upstream placeholders (<binary data>, <empty response>, <… not available …>) too.
function capBody(body: string[], bodyMax: number, fileParam: string): string[] {
  const text = body.join("\n");
  if (!bodyMax || text.length <= bodyMax || /^<[^\n]*>$/.test(text) || /^\s*[[{]/.test(text)) return body;
  let cut = bodyMax;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--; // never split a surrogate pair
  const nl = text.lastIndexOf("\n", cut);
  if (nl >= cut * 0.8) cut = nl;
  return [text.slice(0, cut),
    `[PlayGuard: body cut at ${cut} of ${text.length} chars — pass raw:true for the whole body inline, or ${fileParam} ` +
      "to save it to a file (a relative path is saved under .playguard/.qa)]"];
}

// get_network_request: collapse noisy headers, cap an inline body at bodyMax chars with a
// pointer to responseFilePath. bodyMax 0 = no cap.
export function trimNetworkRequest(text: string, bodyMax: number): { text: string; trimmed: boolean } {
  const out: string[] = [];
  let mode: "other" | "headers" | "requestBody" | "responseBody" = "other";
  let omitted: string[] = [];
  let skipping = false; // inside a dropped header's continuation lines (multi-value set-cookie etc.)
  let body: string[] = [];
  const flush = () => {
    if (omitted.length) {
      const names = [...new Set(omitted)];
      out.push(`- (${omitted.length} headers omitted: ${names.join(", ")} — pass raw:true)`);
    }
    if (mode === "requestBody") out.push(...capBody(body, bodyMax, "requestFilePath"));
    if (mode === "responseBody") out.push(...capBody(body, bodyMax, "responseFilePath"));
    omitted = []; body = []; skipping = false;
  };
  const lines = text.split("\n");
  const ends = bodyEnds(lines);
  for (const [i, line] of lines.entries()) {
    const inBody = mode === "requestBody" || mode === "responseBody";
    const isSection = inBody ? ends.has(i) : line.startsWith("### ") || line.startsWith("## ");
    if (isSection) {
      flush();
      out.push(line);
      mode = line === "### Request Headers" || line === "### Response Headers" ? "headers"
        : line === "### Request Body" ? "requestBody"
        : line === "### Response Body" ? "responseBody" : "other";
      continue;
    }
    if (inBody) { body.push(line); continue; }
    if (mode !== "headers") { out.push(line); continue; }
    const m = /^- (:?[^:]*):(.*)$/.exec(line);
    if (!m) { if (!skipping) out.push(line); continue; } // continuation of the previous header
    const name = m[1].toLowerCase();
    const family = NOISY_FAMILIES.find(([re]) => re.test(name));
    skipping = NOISY_HEADERS.has(name) || !!family;
    if (skipping) { omitted.push(family ? family[1] : name); continue; }
    out.push(CSP_HEADER.test(name) && m[2].length > CSP_KEEP
      ? `- ${m[1]}:<${m[2].length} chars omitted — pass raw:true>` : line);
  }
  flush();
  const result = out.join("\n");
  return { text: result, trimmed: result !== text };
}

// performance_start_trace / performance_stop_trace: drop "example question" lines and
// markdown link targets from the insight list. Insight set ids and insight names stay —
// performance_analyze_insight needs both.
export function trimPerfTrace(text: string): string {
  return text
    .split("\n").filter(l => !/^\s*example question:/.test(l)).join("\n")
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/g, "$1");
}

// Upstream errors that do not say what to do next (input.js, McpPage.js, McpContext.js,
// PageCollector). Ones that already name the fix ("No snapshot found … Use take_snapshot")
// are left alone.
const ERROR_HINTS: [RegExp, string][] = [
  [/did not become interactive within the configured timeout/,
    "The element is likely off-screen, covered by an overlay, or hidden. Scroll it into view with evaluate_script " +
    "({function: \"(el) => el.scrollIntoView({block: 'center'})\", args: [uid]}) or take a fresh take_snapshot and retry."],
  [/Element uid "[^"]*" not found on page/,
    "The uid comes from an older snapshot. Call take_snapshot and use a uid from the latest one."],
  [/\bNo page selected\b/,
    "Call list_pages, then select_page — or new_page to open one."],
  [/is not within any of the configured workspace roots/,
    "Use a relative path (saved under .playguard/.qa) or an absolute path inside the project or the OS temp dir."],
  [/Request not found for selected page/,
    "That reqid is not on the selected page's current list. Call list_network_requests again " +
    "(includePreservedRequests: true for earlier navigations) or select_page the page that made it."],
];

// One-line actionable hint for a known-opaque upstream error, or null.
export function devtoolsErrorHint(errorText: string): string | null {
  const hit = ERROR_HINTS.find(([re]) => re.test(errorText));
  return hit ? `[PlayGuard] ${hit[1]}` : null;
}
