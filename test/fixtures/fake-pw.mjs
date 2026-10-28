// Stand-in for @playwright/mcp in proxy tests. Records argv and every call to the
// file passed as argv[2] — env vars are not forwarded by the SDK's stdio transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync, existsSync } from "fs";

const LOG = process.argv[2];
const record = (o) => appendFileSync(LOG, JSON.stringify(o) + "\n");
record({ argv: process.argv.slice(3) });

const CODEGEN = !process.argv.includes("none"); // crude: `--codegen none` drops the code block
const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const withCode = (body, code) => body + (CODEGEN ? `\n### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`` : "");

const SNAPSHOT = [
  "- generic [ref=e1]:",
  "  - banner [ref=e2]:",
  "    - link \"Home\" [ref=e3]",
  "  - main [ref=e4]:",
  "    - heading \"Welcome\" [level=1] [ref=e5]",
  "    - paragraph [ref=e6]: Hello",
  "    - paragraph [ref=e7]:",
  "      - text: Lorem ipsum dolor sit amet",
  "    - button \"Buy\" [ref=e8]",
].join("\n");

const tool = (name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object", properties: {} } });
const NAMES = ["browser_navigate", "browser_evaluate", "browser_snapshot", "browser_click",
  "browser_wait_for", "browser_run_code_unsafe", "browser_take_screenshot"];

const server = new Server({ name: "fake-pw", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: NAMES.map(tool) }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  // Count earlier "dead" clicks before recording this one: the revive retry runs in a
  // fresh process, so the file is the only memory shared across the respawn.
  const priorDead = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(l => l.includes('"target":"dead"')).length : 0;
  record({ name, args });
  switch (name) {
    case "browser_navigate": return text(withCode(`### Page\n- Page URL: ${args.url}`, `await page.goto('${args.url}');`));
    case "browser_evaluate": return text(withCode("### Result\n42", "await page.evaluate('() => 42');"));
    case "browser_snapshot": return text(`### Page snapshot\n\`\`\`yaml\n${SNAPSHOT}\n\`\`\``);
    case "browser_click":
      if (args.target === "timeout") return text("### Result\nTimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator", true);
      if (args.target === "throw") throw new Error("fake upstream exploded");
      if (args.target === "dead" && priorDead === 0) return text("Error: Target page, context or browser has been closed", true);
      return text(withCode("### Result\nclicked", "await page.click();"));
    case "browser_take_screenshot": return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
    default: return text("### Result\nok");
  }
});
await server.connect(new StdioServerTransport());
