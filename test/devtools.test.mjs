// Run: npm test  (builds first, then `node --test`)
// Pure DevTools optimizers from src/devtools.ts. Fixtures: opt-perf-trace.txt is a real
// chrome-devtools-mcp 1.12 trace of playguard.dev; opt-netreq.txt is synthetic in the
// exact get_network_request format (formatters/NetworkFormatter.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

const {
  DEVTOOLS_READ_ONLY, DEVTOOLS_RAW_TOOLS, withDevtoolsDefaults, compactDevtoolsTools,
  summarizeNetworkList, trimNetworkRequest, trimPerfTrace, devtoolsErrorHint,
} = await import("../dist/devtools.js");

const fixture = name => readFileSync(new URL(`./fixtures/devtools/${name}`, import.meta.url), "utf8");

// ── withDevtoolsDefaults() ────────────────────────────────────────────────
test("withDevtoolsDefaults appends all three opt-outs to an empty argv", () => {
  assert.deepEqual(withDevtoolsDefaults(["--headless"]),
    ["--headless", "--no-usage-statistics", "--no-performance-crux", "--no-page-id-routing"]);
});

test("withDevtoolsDefaults respects a user-set option in every yargs spelling", () => {
  for (const flag of ["--usage-statistics", "--usageStatistics", "--no-usage-statistics", "--no-usageStatistics",
    "--usage-statistics=false", "--usageStatistics=true"]) {
    const out = withDevtoolsDefaults([flag]);
    assert.equal(out.filter(a => /usage-?statistics/i.test(a)).length, 1, flag);
    assert.equal(out[0], flag);
  }
  assert.deepEqual(withDevtoolsDefaults(["--page-id-routing", "--performanceCrux=true"]),
    ["--page-id-routing", "--performanceCrux=true", "--no-usage-statistics"]);
});

test("withDevtoolsDefaults sees options after `--` (npm exec -- pkg --x) and does not mutate input", () => {
  const args = ["exec", "--", "chrome-devtools-mcp@latest", "--usage-statistics"];
  const out = withDevtoolsDefaults(args);
  assert.deepEqual(out.slice(args.length), ["--no-performance-crux", "--no-page-id-routing"]);
  assert.deepEqual(args, ["exec", "--", "chrome-devtools-mcp@latest", "--usage-statistics"]);
});

// ── compactDevtoolsTools() ────────────────────────────────────────────────
const sampleTools = () => [
  {
    name: "take_snapshot", description: "Take a text snapshot.",
    inputSchema: {
      type: "object", $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { verbose: { type: "boolean", description: "Whether to include everything. Default is false." } },
    },
  },
  {
    name: "close_page", description: "Closes the page by its index.",
    inputSchema: { type: "object", properties: { pageId: { type: "number", description: "The ID of the page to close. Call list_pages to list pages." } } },
  },
  {
    name: "list_pages", description: "Get a list of pages open in the browser.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fill_form", description: "Fill out multiple form elements at once.",
    inputSchema: {
      type: "object",
      properties: {
        elements: {
          type: "array", description: "Elements from snapshot to fill out. Extra detail.",
          items: { type: "object", properties: { value: { type: "string", description: "Value for the element. \"true\" or \"false\" for checkboxes." } } },
        },
        dialogAction: { type: "string", description: "Handle dialogs. \"accept\", \"dismiss\", or prompt text." },
        format: { type: "string", enum: ["png", "jpeg"], description: "Image format. Default is \"png\"." },
        headers: { type: "string", description: "Headers as JSON, e.g. {\"X-A\": \"b\"}. Pass empty to clear." },
      },
    },
  },
];

test("compactDevtoolsTools keeps every param description whole, nested ones too", () => {
  const tools = sampleTools();
  const [snap, close, , form] = compactDevtoolsTools(tools);
  assert.equal(snap.inputSchema.properties.verbose.description, "Whether to include everything. Default is false.");
  assert.equal(close.inputSchema.properties.pageId.description, "The ID of the page to close. Call list_pages to list pages.");
  assert.deepEqual(form.inputSchema, tools[3].inputSchema);
});

test("compactDevtoolsTools notes the network summary on list_network_requests only when networkMax is set", () => {
  const tools = [...sampleTools(), { name: "list_network_requests", description: "Lists requests.", inputSchema: { type: "object", properties: {} } }];
  const noted = compactDevtoolsTools(tools, { networkMax: 30 }).at(-1).description;
  assert.match(noted, /^Lists requests\.\n\[PlayGuard\] .*longer than 30 requests comes back as a summary.*pageSize\/pageIdx or resourceTypes/);
  assert.equal(compactDevtoolsTools(tools).at(-1).description, "Lists requests.");
  assert.equal(compactDevtoolsTools(tools, { networkMax: 0 }).at(-1).description, "Lists requests.", "0 = summary off");
  assert.doesNotMatch(compactDevtoolsTools(tools, { networkMax: 30 })[0].description, /PlayGuard/);
});

test("compactDevtoolsTools adds raw to raw tools, the nav note, drops $schema", () => {
  const [snap, close, pages] = compactDevtoolsTools(sampleTools());
  assert.equal(snap.inputSchema.properties.raw.type, "boolean");
  assert.equal(snap.inputSchema.$schema, undefined);
  assert.equal(close.inputSchema.properties.raw, undefined);
  assert.match(pages.description, /separate Chrome instance from the browser_\*/);
  assert.doesNotMatch(close.description, /PlayGuard/);
  assert.ok(DEVTOOLS_RAW_TOOLS.has("get_network_request"));
});

test("compactDevtoolsTools never mutates the upstream list", () => {
  const tools = sampleTools();
  const before = JSON.stringify(tools);
  compactDevtoolsTools(tools);
  assert.equal(JSON.stringify(tools), before);
});

test("DEVTOOLS_READ_ONLY excludes tools that change what the next snapshot sees", () => {
  assert.ok(DEVTOOLS_READ_ONLY.has("list_network_requests"));
  for (const t of ["select_page", "wait_for", "click", "navigate_page"]) assert.ok(!DEVTOOLS_READ_ONLY.has(t), t);
});

// ── summarizeNetworkList() ────────────────────────────────────────────────
const netList = rows => ["## Network requests", `Showing 1-${rows.length} of ${rows.length} (Page 1 of 1).`, ...rows].join("\n");
const okRows = n => Array.from({ length: n }, (_, i) =>
  `reqid=${i + 2} GET https://${i % 3 ? "cdn.example.test" : "example.test"}/asset-${i}.js [200]`);

test("summarizeNetworkList leaves short lists untouched", () => {
  const text = netList(okRows(5));
  assert.deepEqual(summarizeNetworkList(text, {}, 30), { text, summarized: false, rows: 5 });
});

test("summarizeNetworkList keeps the main document, every not-OK row, per-host counts", () => {
  const rows = [
    "reqid=1 GET https://example.test/ [200]",
    ...okRows(40),
    "reqid=50 GET https://example.test/api [500]",
    "reqid=51 GET https://ads.example.test/x.js [net::ERR_BLOCKED_BY_CLIENT]",
    "reqid=52 GET https://example.test/poll [pending]",
    "reqid=53 POST https://example.test/form [302] [selected in the DevTools Network panel]",
    "reqid=54 GET https://example.test/missing [404] [selected in the DevTools Network panel]",
    "reqid=55 GET data:image/png;base64,AAAA... <truncated> [200]",
  ];
  const r = summarizeNetworkList(`Before\n${netList(rows)}\n## Console messages\nmsgid=1 [log] hi`, {}, 30);
  assert.equal(r.summarized, true);
  assert.equal(r.rows, 47);
  assert.match(r.text, /^Before\n## Network requests\n\[PlayGuard: 47 requests, summarized/);
  assert.match(r.text, /pageSize:100 → 1 page \(pageIdx from 0\)/);
  assert.match(r.text, /Main document: reqid=1 GET https:\/\/example\.test\/ \[200\]/);
  assert.match(r.text, /\nFailed \(3\):\nreqid=50 [^\n]*\nreqid=51 [^\n]*\nreqid=54 [^\n]*\nPending \(1\):\nreqid=52 /);
  assert.doesNotMatch(r.text, /reqid=53 |reqid=2 |Showing 1-/);
  assert.match(r.text, /By host: cdn\.example\.test 26, example\.test 19, ads\.example\.test 1, data: 1/);
  assert.match(r.text, /\n## Console messages\nmsgid=1 \[log\] hi$/, "sections after the list survive");
});

test("summarizeNetworkList on an all-OK list says none failed; host overflow rolls up", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `reqid=${i + 1} GET https://h${i % 12}.example.test/ [200]`);
  const r = summarizeNetworkList(netList(rows), {}, 30);
  assert.match(r.text, /\nFailed: none\nPending: none\n/);
  assert.match(r.text, /4 other hosts 12$/);
});

test("summarizeNetworkList caps failed + pending rows at maxRows together", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `reqid=${i + 1} GET https://example.test/${i} [${i < 35 ? "net::ERR_FAILED" : "pending"}]`);
  const r = summarizeNetworkList(netList(rows), {}, 30);
  assert.match(r.text, /Failed \(34\):/);
  assert.match(r.text, /… 5 more — page with pageSize\/pageIdx\nPending \(5\):\n… 5 more/);
  assert.equal(r.text.split("\n").filter(l => /^(Main document: )?reqid=/.test(l)).length, 30, "29 failed + the main document line");
});

test("summarizeNetworkList shows a failed main document once, on the Main line, and counts pages", () => {
  for (const status of ["500", "net::ERR_NAME_NOT_RESOLVED"]) {
    const rows = [`reqid=1 GET https://example.test/ [${status}]`, ...okRows(249)];
    const r = summarizeNetworkList(netList(rows), {}, 30);
    assert.ok(r.text.includes(`Main document: reqid=1 GET https://example.test/ [${status}]\nFailed: none\n`), status);
    assert.match(r.text, /pageSize:100 → 3 pages/);
  }
});

test("summarizeNetworkList takes the main document after leading redirect hops", () => {
  const rows = ["reqid=1 GET http://example.test/ [301]", "reqid=2 GET https://example.test/ [200]", ...okRows(40)];
  const r = summarizeNetworkList(netList(rows), {}, 30);
  assert.match(r.text, /Main document: reqid=2 GET https:\/\/example\.test\/ \[200\]/);
});

test("summarizeNetworkList passes through explicit paging/filter args, maxRows 0 and empty lists", () => {
  const text = netList(okRows(40));
  for (const args of [{ pageSize: 50 }, { pageIdx: 0 }, { resourceTypes: ["xhr"] }, { includePreservedRequests: false }])
    assert.equal(summarizeNetworkList(text, args, 30).summarized, false, JSON.stringify(args));
  assert.equal(summarizeNetworkList(text, {}, 0).summarized, false);
  const empty = "## Network requests\nNo requests found.";
  assert.deepEqual(summarizeNetworkList(empty, {}, 30), { text: empty, summarized: false, rows: 0 });
  assert.equal(summarizeNetworkList("Page navigated.", {}, 30).summarized, false);
});

// ── trimNetworkRequest() ──────────────────────────────────────────────────
test("trimNetworkRequest collapses noisy headers per section and keeps the useful ones", () => {
  const r = trimNetworkRequest(fixture("opt-netreq.txt"), 0);
  assert.equal(r.trimmed, true);
  const [req, res] = r.text.split("### Response Headers");
  assert.match(req, /- \(16 headers omitted: upgrade-insecure-requests, user-agent, sec-ch-ua\*, :pseudo, accept, accept-encoding, accept-language, priority, sec-fetch-\* — pass raw:true\)/);
  assert.match(req, /- cookie:session=abc123/);
  assert.match(req, /- authorization:Bearer test-token/);
  assert.match(res, /- \(6 headers omitted: accept-ch, alt-svc, nel, permissions-policy, report-to, server-timing — pass raw:true\)/);
  for (const keep of ["cache-control", "content-type", "location", "x-request-id"]) assert.match(res, new RegExp(`\\n- ${keep}:`), keep);
  assert.match(res, /- set-cookie:a=1; Path=\/; HttpOnly\n b=2; Path=\/; Secure/, "multi-line set-cookie stays whole");
  assert.doesNotMatch(r.text, /ma=86400|reports\.example\.test/, "continuation of dropped headers goes too");
});

test("trimNetworkRequest replaces a long CSP value with its length, keeps a short one", () => {
  const { text } = trimNetworkRequest(fixture("opt-netreq.txt"), 0);
  assert.match(text, /- content-security-policy:<\d+ chars omitted — pass raw:true>/);
  assert.match(text, /- content-security-policy-report-only:default-src 'none'/);
});

test("trimNetworkRequest leaves the body alone under bodyMax, including markdown-like lines", () => {
  const { text } = trimNetworkRequest(fixture("opt-netreq.txt"), 0);
  assert.match(text, /### Response Body\n<!DOCTYPE html>[\s\S]*### Not a section, just markdown-looking page text\n<p>You do not/);
});

test("trimNetworkRequest caps request and response bodies with a pointer to the file param", () => {
  const big = "x".repeat(500);
  const text = ["## Request https://example.test/api", "Status: 500", "### Request Headers", "- content-type:application/json",
    "### Request Body", big, "### Response Headers", "- content-type:text/plain", "### Response Body", big,
    "### Request failed with", "net::ERR_FAILED"].join("\n");
  const r = trimNetworkRequest(text, 100);
  assert.match(r.text, /### Request Body\nx{100}\n\[PlayGuard: body cut at 100 of 500 chars — pass raw:true for the whole body inline, or requestFilePath to save it/);
  assert.match(r.text, /### Response Body\nx{100}\n\[PlayGuard: body cut at 100 of 500 chars — pass raw:true .* or responseFilePath .*under \.playguard\/\.qa\)\]/);
  assert.match(r.text, /### Request failed with\nnet::ERR_FAILED$/);
  assert.equal(trimNetworkRequest(text, 0).trimmed, false, "bodyMax 0 = no cap");
});

const netReq = (...sections) => ["## Request https://example.test/api", "Status: 200", "### Request Headers", "- a:b", ...sections].join("\n");

test("trimNetworkRequest never filters body lines that look like section headings", () => {
  const fakeHeaders = ["# notes", "### Response Headers", "- accept:text/html", "- user-agent:x", "more body", "### Response Body", "still body"];
  const text = netReq("### Request Body", ...fakeHeaders, "### Response Headers", "- user-agent:y", "- content-type:text/html",
    "### Response Body", "ok", "### Request failed with", "body text", "### Redirect chain", "- accept:z");
  const r = trimNetworkRequest(text, 3000);
  assert.ok(r.text.includes(["### Request Body", ...fakeHeaders].join("\n") + "\n### Response Headers\n- content-type:text/html\n- (1 headers omitted: user-agent"), r.text);
  assert.match(r.text, /### Response Body\nok\n### Request failed with\nbody text\n### Redirect chain\n- accept:z$/, "response body runs to the real tail");
  const tail = trimNetworkRequest(netReq("### Response Headers", "- user-agent:y", "### Response Body", "x", "### Request failed with",
    "- accept:q", "### Request failed with", "net::ERR_FAILED", "### Redirect chain", "reqid=1 GET https://example.test/ [302]"), 3000).text;
  assert.match(tail, /### Response Body\nx\n### Request failed with\n- accept:q\n### Request failed with\nnet::ERR_FAILED\n### Redirect chain\nreqid=1 /);
});

test("trimNetworkRequest cuts at a line break near bodyMax, never splits a surrogate pair, leaves JSON whole", () => {
  const emoji = trimNetworkRequest(netReq("### Response Body", "a".repeat(2999) + "\u{1F600}" + "b".repeat(5000)), 3000).text.split("\n")[5];
  assert.equal(emoji, "a".repeat(2999));
  const html = Array.from({ length: 100 }, (_, i) => `<p>line ${String(i).padStart(3, "0")}</p>`).join("\n"); // 15 chars + newline each
  const cut = trimNetworkRequest(netReq("### Response Body", html), 1000).text;
  assert.match(cut, /<p>line 061<\/p>\n\[PlayGuard: body cut at 991 of 1599 chars/);
  const json = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i })) });
  for (const body of [json, `[${json}]`, `  ${json}`]) assert.equal(trimNetworkRequest(netReq("### Response Body", body), 1000).trimmed, false);
});

test("trimNetworkRequest leaves no-body, binary-body and already-clean responses untouched", () => {
  const noBody = "## Request https://example.test/\nStatus: pending\n### Request Headers\n- cookie:a=1";
  assert.deepEqual(trimNetworkRequest(noBody, 100), { text: noBody, trimmed: false });
  const binary = "## Request https://example.test/a.png\nStatus: 200\n### Request Headers\n### Response Headers\n- content-type:image/png\n### Response Body\n<binary data>";
  assert.deepEqual(trimNetworkRequest(binary, 5), { text: binary, trimmed: false });
  const saved = "## Request https://example.test/\nStatus: 200\n### Request Headers\n### Response Body\nSaved to /tmp/x.network-response.";
  assert.equal(trimNetworkRequest(saved, 100).trimmed, false);
});

// ── trimPerfTrace() ───────────────────────────────────────────────────────
test("trimPerfTrace drops example questions and link targets, keeps ids and insight names", () => {
  const raw = fixture("opt-perf-trace.txt");
  const out = trimPerfTrace(raw);
  assert.doesNotMatch(out, /example question:|\]\(https?:/);
  assert.match(out, /insight set id: NAVIGATION_0/);
  for (const name of ["LCPBreakdown", "NetworkDependencyTree", "DOMSize", "ThirdParties", "Cache", "LegacyJavaScript"])
    assert.match(out, new RegExp(`insight name: ${name}\\n`), name);
  assert.match(out, /Avoid chaining critical requests by reducing/);
  assert.ok(out.length < raw.length * 0.85, `${raw.length} → ${out.length}`);
  assert.equal(trimPerfTrace("The performance trace has been started."), "The performance trace has been started.");
});

// ── devtoolsErrorHint() ───────────────────────────────────────────────────
test("devtoolsErrorHint explains the not-interactive timeout", () => {
  const hint = devtoolsErrorHint("Error: Failed to interact with the element with uid 1_1. The element did not become interactive within the configured timeout.");
  assert.match(hint, /^\[PlayGuard\] .*off-screen.*scrollIntoView.*take_snapshot/);
});

test("devtoolsErrorHint covers stale uid, no page, path sandbox, unknown reqid", () => {
  assert.match(devtoolsErrorHint('Element uid "3_14" not found on page 1.'), /take_snapshot/);
  assert.match(devtoolsErrorHint("No page selected"), /list_pages.*select_page/);
  assert.match(devtoolsErrorHint("Access denied: path /etc/x.png (canonical: /etc/x.png) is not within any of the configured workspace roots."),
    /relative path \(saved under \.playguard\/\.qa\).*OS temp dir/);
  assert.match(devtoolsErrorHint("Request not found for selected page"), /includePreservedRequests/);
});

test("devtoolsErrorHint returns null for errors that already say what to do", () => {
  assert.equal(devtoolsErrorHint("No snapshot found for page 1. Use take_snapshot to capture one."), null);
  assert.equal(devtoolsErrorHint(""), null);
  assert.equal(devtoolsErrorHint("A dialog is open (alert: Saved!). Call handle_dialog to handle it."), null, "upstream already names the fix");
});
