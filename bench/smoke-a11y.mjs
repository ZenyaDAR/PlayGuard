#!/usr/bin/env node
// Smoke check for playguard_a11y_audit against the real bundled Playwright MCP and real
// axe-core (needs a browser, not part of npm test): serves a page with known violations
// on localhost and checks they come back. Run: npm run build && node bench/smoke-a11y.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import assert from "node:assert/strict";

const PAGE = `<!doctype html><html><head><title>a11y smoke</title>
<script>window.define = function () {}; window.define.amd = true;</script></head><body>
<main><h1>Shop</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" class="hero">
<p style="color:#bbb;background:#fff">Low contrast text</p>
<button></button><input type="text"></main>
<div id="ok"><p>Fine</p></div><div id="axe"></div></body></html>`;
const http = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE); });
await new Promise(r => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/`;

const dir = mkdtempSync(join(tmpdir(), "pg-a11y-"));
const env = { ...process.env, PLAYGUARD_LOG_DIR: join(dir, "logs"), PLAYGUARD_OUTPUT_DIR: join(dir, "out"), PLAYGUARD_UPDATE_CHECK: "false" };
delete env.PLAYWRIGHT_MCP_CMD;
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));
const text = (r) => r.content.map(c => c.text ?? "").join("");
try {
  await client.callTool({ name: "browser_navigate", arguments: { url } });
  const t0 = Date.now();
  const r = await client.callTool({ name: "playguard_a11y_audit", arguments: {} });
  console.log(text(r), `\n(${Date.now() - t0} ms, ${text(r).length} chars)`);
  assert.ok(!r.isError, text(r));
  for (const id of ["image-alt", "color-contrast", "button-name", "label"]) assert.match(text(r), new RegExp(`\\b${id}\\b`), `${id} missing`);
  const again = await client.callTool({ name: "playguard_a11y_audit", arguments: { selector: "#ok" } });
  assert.match(text(again), /0 violations/, text(again));
  const missing = await client.callTool({ name: "playguard_a11y_audit", arguments: { selector: "#nope" } });
  assert.ok(missing.isError, text(missing));
  const typo = await client.callTool({ name: "playguard_a11y_audit", arguments: { tags: ["wcag21AA"] } });
  assert.ok(typo.isError && /no axe rules match/.test(text(typo)), text(typo));
  console.log("typo tag:", text(typo));
  console.log("\nscoped:", text(again).split("\n")[0], "\nmissing:", text(missing));
  console.log("OK");
} finally {
  await client.close();
  http.close();
}
