#!/usr/bin/env node
// Research probe for the Context7 MCP (needs network, not part of npm test).
// Spawns the upstream over stdio, records initialize/tools/list sizes, cold vs warm start,
// then calls each tool with realistic args and reports size, latency, structure and whether
// a repeat call with identical args returns byte-identical text (cacheability).
// Run: node bench/probe-context7.mjs [--save <dir>]
// Upstream: CONTEXT7_MCP_CMD if set, else `npx -y @upstash/context7-mcp@4.4.4`.
// CONTEXT7_API_KEY is passed through when present; without it the anonymous tier is used.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const saveIdx = process.argv.indexOf("--save");
const saveDir = saveIdx > 0 ? process.argv[saveIdx + 1] : null;
if (saveDir) mkdirSync(saveDir, { recursive: true });

const [cmd, ...cmdArgs] = (process.env.CONTEXT7_MCP_CMD ?? "npx -y @upstash/context7-mcp@4.4.4").split(" ");
const isWin = process.platform === "win32";

async function start() {
  const t0 = performance.now();
  const client = new Client({ name: "probe-context7", version: "0" });
  const transport = new StdioClientTransport({
    command: isWin && cmd === "npx" ? "npx.cmd" : cmd,
    args: cmdArgs,
    env: { ...process.env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", d => { stderr += d; });
  await client.connect(transport);
  return { client, ms: Math.round(performance.now() - t0), stderr: () => stderr };
}

const text = r => (r.content ?? []).map(c => c.text ?? "").join("\n");
const tok = n => Math.round(n / 4);

// Rough structural stats of a text response.
function shape(t) {
  return {
    chars: t.length,
    approxTokens: tok(t),
    separators: (t.match(/^-{10,}$/gm) ?? []).length,
    resolveEntries: (t.match(/^- Context7-compatible library ID:/gm) ?? []).length,
    codeFences: (t.match(/^```/gm) ?? []).length / 2,
    sourceLines: (t.match(/^(Source|SOURCE): /gm) ?? []).length,
    titleLines: (t.match(/^(### |TITLE: )/gm) ?? []).length,
    urls: (t.match(/https?:\/\/\S+/g) ?? []).length,
  };
}

const results = [];
async function call(client, name, args, label) {
  const t0 = performance.now();
  let r, err;
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  } catch (e) { err = String(e); }
  const ms = Math.round(performance.now() - t0);
  const t = r ? text(r) : err;
  const rec = { label, name, args, ms, isError: !!(r?.isError || err), ...shape(t) };
  results.push(rec);
  console.log(`${label.padEnd(28)} ${String(t.length).padStart(7)} chars ${String(ms).padStart(6)} ms${rec.isError ? "  ERROR" : ""}`);
  if (saveDir) writeFileSync(join(saveDir, `${label}.txt`), t);
  return t;
}

// Cold start (npx may need to download), then warm start (cache hit).
const cold = await start();
const init = {
  serverVersion: cold.client.getServerVersion(),
  instructions: cold.client.getInstructions() ?? "",
  capabilities: cold.client.getServerCapabilities(),
};
const { tools } = await cold.client.listTools();
await cold.client.close();
const warm = await start();
const client = warm.client;

console.log(`cold start ${cold.ms} ms, warm start ${warm.ms} ms`);
console.log(`server: ${JSON.stringify(init.serverVersion)}`);
console.log(`instructions: ${init.instructions.length} chars`);
const listJson = JSON.stringify(tools);
console.log(`tools/list: ${tools.length} tools, ${listJson.length} bytes JSON (~${tok(listJson.length)} tokens)`);
for (const t of tools) {
  console.log(`  ${t.name.padEnd(22)} description ${t.description?.length ?? 0} chars, schema ${JSON.stringify(t.inputSchema).length} chars, total ${JSON.stringify(t).length}`);
}
if (saveDir) writeFileSync(join(saveDir, "tools-list.json"), JSON.stringify({ init, tools }, null, 2));
console.log("");

const resolveTool = tools.find(t => /resolve/.test(t.name))?.name ?? "resolve-library-id";
const docsTool = tools.find(t => /docs/.test(t.name))?.name ?? "query-docs";

const resolves = [
  ["resolve-nextjs", { libraryName: "Next.js", query: "How to use the app router with server actions" }],
  ["resolve-hydrogen", { libraryName: "Shopify Hydrogen", query: "How to fetch a product with the Storefront API in Hydrogen" }],
  ["resolve-tailwindcss", { libraryName: "Tailwind CSS", query: "Configure dark mode with a class strategy" }],
  ["resolve-react", { libraryName: "React", query: "useEffect cleanup function examples" }],
  ["resolve-notfound", { libraryName: "zzqx-nonexistent-lib-9817", query: "anything" }],
];
const resolveTexts = {};
for (const [label, args] of resolves) resolveTexts[label] = await call(client, resolveTool, args, label);

// Pick the first id from the Next.js resolve, fall back to a known id.
const firstId = (/Context7-compatible library ID: (\S+)/.exec(resolveTexts["resolve-nextjs"]) ?? [])[1] ?? "/vercel/next.js";
console.log(`\nusing library id ${firstId}\n`);

const docs = [
  ["docs-nextjs-server-actions", { libraryId: firstId, query: "How to use server actions with forms in the app router" }],
  ["docs-nextjs-middleware-ts", { libraryId: firstId, query: "Middleware that redirects unauthenticated users", language: "TypeScript" }],
  ["docs-react-useeffect", { libraryId: "/websites/react_dev", query: "useEffect cleanup function examples" }],
  ["docs-tailwind-darkmode", { libraryId: "/tailwindlabs/tailwindcss.com", query: "Configure dark mode with a class strategy" }],
  ["docs-badid", { libraryId: "/nope/does-not-exist-9817", query: "anything" }],
  ["docs-vague", { libraryId: firstId, query: "hooks" }],
];
const docTexts = {};
for (const [label, args] of docs) docTexts[label] = await call(client, docsTool, args, label);

// Repeat identical calls to check determinism.
console.log("");
const repeat = async (label, name, args, prev) => {
  const t = await call(client, name, args, `${label}-repeat`);
  console.log(`  identical to first call: ${t === prev}`);
  return t === prev;
};
const det = {
  resolve: await repeat("resolve-nextjs", resolveTool, resolves[0][1], resolveTexts["resolve-nextjs"]),
  docs: await repeat("docs-nextjs-server-actions", docsTool, docs[0][1], docTexts["docs-nextjs-server-actions"]),
};

await client.close();
const summary = { cold: cold.ms, warm: warm.ms, init: { ...init, instructionsChars: init.instructions.length }, toolsListBytes: listJson.length, det, results };
if (saveDir) writeFileSync(join(saveDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log("\n" + JSON.stringify({ det, results: results.map(({ label, chars, ms, separators, resolveEntries, codeFences, sourceLines, titleLines, urls }) => ({ label, chars, ms, separators, resolveEntries, codeFences, sourceLines, titleLines, urls })) }, null, 1));
const errOut = warm.stderr().trim();
if (errOut) console.log("\nstderr (warm):\n" + errOut.slice(0, 2000));
