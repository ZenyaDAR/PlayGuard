#!/usr/bin/env node
// Smoke check against the real bundled Playwright MCP (needs a browser, not part of
// npm test): with the default --codegen none, responses carry no `### Ran Playwright
// code` block and evaluate results still parse. Run: npm run build && node bench/smoke-codegen.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import assert from "node:assert/strict";

process.env.PLAYGUARD_NO_SERVE = "1";
const { parseEvalText } = await import("../dist/index.js");

const dir = mkdtempSync(join(tmpdir(), "pg-smoke-"));
const env = { ...process.env, PLAYGUARD_LOG_DIR: join(dir, "logs"), PLAYGUARD_OUTPUT_DIR: join(dir, "out") };
delete env.PLAYGUARD_NO_SERVE;
delete env.PLAYWRIGHT_MCP_CMD;
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));

const text = (r) => r.content.map(c => c.text ?? "").join("");
try {
  const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } });
  const ev = await client.callTool({ name: "browser_evaluate", arguments: { function: "() => ({ title: document.title })" } });
  for (const [name, r] of [["navigate", nav], ["evaluate", ev]]) {
    assert.ok(!r.isError, `${name} failed: ${text(r)}`);
    assert.ok(!text(r).includes("### Ran Playwright code"), `${name} still has a codegen block`);
    console.log(`${name}: ${text(r).length} chars, no codegen block`);
  }
  assert.ok(text(ev).includes("### Result"));
  const data = parseEvalText(text(ev));
  assert.equal(data.title, "Example Domain");
  console.log("evaluate parsed:", data);
  console.log("OK");
} finally {
  await client.close();
}
