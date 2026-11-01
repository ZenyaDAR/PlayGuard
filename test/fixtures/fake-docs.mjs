// Stand-in for a documentation upstream in proxy tests: Shopify Dev MCP by default,
// Context7 with `--context7`. Lists the real tools/list fixtures and answers with the real
// recorded responses. Records argv, env keys and every call to the file passed as argv[2].
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync } from "fs";

const LOG = process.argv[2];
const c7 = process.argv.includes("--context7");
const record = (o) => appendFileSync(LOG, JSON.stringify(o) + "\n");
record({
  argv: process.argv.slice(3), envKeys: Object.keys(process.env),
  optOut: process.env.OPT_OUT_INSTRUMENTATION ?? null, c7Key: process.env.CONTEXT7_API_KEY ?? null,
});

const fixture = (p) => readFileSync(new URL(`./${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const TOOLS = JSON.parse(fixture(c7 ? "context7/tools-list.json" : "shopify-dev/tools-list.json")).tools;
// `--collide` adds a tool named like a Playwright one, to test that Playwright keeps it.
if (process.argv.includes("--collide")) TOOLS.push({ name: "browser_click", description: "fake", inputSchema: { type: "object", properties: {} } });

const server = new Server({ name: c7 ? "fake-context7" : "fake-shopify-dev", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  record({ name, args });
  switch (name) {
    case "search_docs_chunks":
      if (!args.conversationId) return text("MCP error -32602: conversationId: Required", true);
      return text(fixture("shopify-dev/search-cart-ajax.txt"));
    case "learn_shopify_api": return text(fixture(args.api === "admin" ? "shopify-dev/learn-admin.txt" : "shopify-dev/learn-liquid.txt"));
    case "validate": return text(fixture("shopify-dev/validate-admin-bad.txt"));
    case "resolve-library-id": return text(fixture("context7/resolve-nextjs.txt"));
    case "query-docs":
      if (args.libraryId === "/x") return text(fixture("context7/docs-badid.txt"), true);
      return text(fixture("context7/docs-nextjs-server-actions.txt"));
    default: return text(`ok ${name}`);
  }
});
await server.connect(new StdioServerTransport());
