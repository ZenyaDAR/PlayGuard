// Stand-in for the official Figma desktop MCP server (Streamable HTTP, stateless) in proxy
// tests. Started in-process: `const f = await startFakeFigma(); f.url; f.calls; await f.close()`.
import { createServer } from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Longer than FIGMA_TEXT_COMPACT (10000): must come back whole, never sliced mid-code.
export const DESIGN_CODE = "export default function Card() {\n" +
  Array.from({ length: 400 }, (_, i) => `  <div className="p-4 text-[#111]" data-node-id="1:${i}">Row ${i}</div>`).join("\n") + "\n}";

const tool = (name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object", properties: { nodeId: { type: "string" } } } });

// `port` lets a test bring the "desktop app" up later on a port PlayGuard already knows.
export async function startFakeFigma(port = 0) {
  const calls = [];
  let selection = 0; // bumps per selection-based call, like a user clicking around in Figma
  const http = createServer(async (req, res) => {
    const server = new Server({ name: "fake-figma-desktop", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["get_design_context", "get_metadata", "get_screenshot", "get_code_connect_suggestions", "fail_fast", "slow_ok"].map(tool) }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
      calls.push({ name, args });
      if (name === "fail_fast") throw new Error("boom");
      if (name === "slow_ok") { await new Promise(r => setTimeout(r, 400)); return { content: [{ type: "text", text: "slow done" }] }; }
      if (name === "get_design_context" && !args.nodeId) return { content: [{ type: "text", text: `selection #${++selection}` }] };
      if (name === "get_design_context") return { content: [{ type: "text", text: DESIGN_CODE }] };
      if (name === "get_screenshot") return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
      return { content: [{ type: "text", text: `<frame id="${args.nodeId}" name="Card" />` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((r) => http.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    calls,
    close: () => new Promise((r) => { http.closeAllConnections?.(); http.close(r); }),
  };
}
