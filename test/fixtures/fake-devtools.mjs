// Stand-in for chrome-devtools-mcp in proxy tests. Records argv, the FIGMA_* env keys it
// was given, and every call to the file passed as argv[2]. Responses mimic the real
// 1.12 text shapes (## Latest page snapshot, ## Network requests, ## Request …).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync, existsSync } from "fs";

const LOG = process.argv[2];
const record = (o) => appendFileSync(LOG, JSON.stringify(o) + "\n");
record({ argv: process.argv.slice(3), figmaEnv: Object.keys(process.env).filter(k => k.startsWith("FIGMA_")), envKeys: Object.keys(process.env), cwd: process.cwd() });

const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

// The page tree changes with the session: navigate_page sets the root url, click "grow"
// adds a button — so UNCHANGED / delta / full can all be driven end to end.
let pageUrl = "https://shop.test/";
let grown = 0;
const snapshot = () => [
  "## Latest page snapshot",
  `uid=1_0 RootWebArea "Shop" url="${pageUrl}"`,
  "  uid=1_1 banner",
  "    uid=1_2 link \"Home\" url=\"https://shop.test/\"",
  "    uid=1_3 link \"Cart\" url=\"https://shop.test/cart\"",
  "  uid=1_4 main",
  "    uid=1_5 heading \"Welcome\" level=\"1\"",
  "      uid=1_6 \"Welcome\"",
  "    uid=1_7 button \"Buy\"",
  ...Array.from({ length: grown }, (_, i) => `    uid=1_${20 + i} button "Item ${i}"`),
].join("\n");

const NETWORK = ["## Network requests", "Showing 1-120 of 120 (Page 1 of 1)."]
  .concat(Array.from({ length: 120 }, (_, i) =>
    `reqid=${i + 1} GET https://${i % 3 ? "cdn" : "shop"}.test/asset-${i}.js [${i === 7 ? 404 : 200}]`))
  .join("\n");

const REQUEST = [
  "## Request https://shop.test/api/cart",
  "Status: 200",
  "### Request Headers",
  ...Array.from({ length: 20 }, (_, i) => `- x-header-${i}:value-${i}`),
  "### Response Headers",
  "- content-type:text/html",
  "### Response Body",
  // Not JSON: a JSON body is left whole (cutting it mid-structure misleads), HTML is cut.
  ...Array.from({ length: 400 }, (_, i) => `<li data-id="${i}">item ${i}</li>`),
].join("\n");

const TRACE = [
  "The performance trace has been stopped.",
  "## Insights",
  "- LCPBreakdown: [docs](https://developer.chrome.com/docs/performance/insights/lcp)",
  "  Example question: What is my LCP?",
].join("\n");

const tool = (name, properties = {}) => ({ name, description: `fake ${name}`, inputSchema: { type: "object", properties } });
const pageId = { pageId: { type: "number" } };
const TOOLS = [
  tool("list_pages"),
  tool("new_page", { url: { type: "string" } }),
  tool("navigate_page", { ...pageId, type: { type: "string" }, url: { type: "string" } }),
  tool("take_snapshot", { ...pageId, verbose: { type: "boolean" } }),
  tool("take_screenshot", pageId),
  tool("click", { ...pageId, uid: { type: "string" }, includeSnapshot: { type: "boolean" } }),
  tool("list_network_requests", { ...pageId, pageSize: { type: "number" } }),
  tool("get_network_request", { ...pageId, reqid: { type: "number" } }),
  tool("performance_stop_trace", pageId),
  tool("select_page", pageId),
];
// `--collide` makes one DevTools tool shadow a Playwright one, to test that ours wins.
if (process.argv.includes("--collide")) TOOLS.push(tool("browser_click"));

const server = new Server({ name: "fake-devtools", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {}, _meta } }) => {
  // The revive retry runs in a fresh process, so the file is the only shared memory.
  const priorDie = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(l => l.includes('"uid":"die"')).length : 0;
  record({ name, args, ...(_meta ? { meta: _meta } : {}) });
  switch (name) {
    case "list_pages": return text("## Pages\n1: about:blank [selected]");
    case "new_page": return text(`## Pages\n1: about:blank\n2: ${args.url} [selected]`);
    case "navigate_page": pageUrl = args.url; grown = 0; return text(`Successfully navigated to ${args.url}.\n## Pages\n1: ${args.url} [selected]`);
    case "take_snapshot": return text(snapshot());
    case "take_screenshot": return { content: [{ type: "text", text: "Took a screenshot of the current page's viewport." }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
    case "click":
      if (args.uid === "1_99") return text("Error: Failed to interact with the element with uid 1_99. The element did not become interactive within the configured timeout.", true);
      if (args.uid === "restart") return text("Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.\nError: No page found", true);
      // Without page-id routing (our default) the same restart comes back as a success.
      if (args.uid === "restart-ok") return text("Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.\n## Latest page snapshot\nuid=2_0 RootWebArea url=\"about:blank\"");
      if (args.uid === "die" && priorDie === 0) process.exit(1); // the upstream process dies mid-call
      if (args.uid === "exit-after") setTimeout(() => process.exit(0), 50); // dies between calls
      if (args.uid === "grow") grown++;
      return text(`Successfully clicked on the element${args.includeSnapshot ? "\n" + snapshot() : ""}`);
    case "list_network_requests": return text(NETWORK);
    case "get_network_request": return text(REQUEST);
    case "performance_stop_trace": return text(TRACE);
    default: return text(`ok ${name}`);
  }
});
// `--hang` never answers initialize (a stuck first `npx` download); `--slow-init=MS` answers late.
const slow = process.argv.find(a => a.startsWith("--slow-init="));
if (process.argv.includes("--hang")) process.stdin.resume();
else {
  if (slow) await new Promise(r => setTimeout(r, +slow.split("=")[1]));
  await server.connect(new StdioServerTransport());
}
