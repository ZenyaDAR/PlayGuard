// All configuration in one place: env-derived knobs, resolved paths, and the
// upstream MCP commands. Beyond parsing the dials it only creates the two
// directories it resolves (LOG_DIR, OUTPUT_DIR) — no other side effects.
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { resolve, dirname, sep } from "path";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { withDevtoolsDefaults } from "./devtools.js";

// Splits a command-line string on spaces, respecting "..."/'...' quoting so
// paths like `--storage-state "C:/path with spaces/state.json"` survive.
export function splitArgs(s: string): string[] {
  const parts = s.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  // Strip quotes only when they actually pair up — an unclosed quote (matched by \S+)
  // must survive literally instead of losing its first and last characters.
  return parts.map(a =>
    a.length >= 2 && ((a[0] === '"' && a.endsWith('"')) || (a[0] === "'" && a.endsWith("'")))
      ? a.slice(1, -1) : a);
}

// A malformed dial (PLAYGUARD_SMART_WAIT_MS=1s) must fall back to the default, not
// to NaN: `setTimeout(res, NaN)` fires immediately and `attempts < NaN` is always
// false, so the feature silently turns itself off instead of failing loudly.
function num(v: string | undefined, dflt: number, parse: (s: string) => number = parseInt): number {
  if (v === undefined) return dflt;
  const n = parse(v);
  return Number.isNaN(n) ? dflt : n;
}

export const SCREENSHOTS = process.env.PLAYGUARD_SCREENSHOTS ?? "warn"; // block | warn | allow | redirect
// ponytail: compact on by default — strips non-interactive lines, set =false to get raw snapshots
export const COMPACT = process.env.PLAYGUARD_COMPACT !== "false";
export const TOKEN_BUDGET = num(process.env.PLAYGUARD_TOKEN_BUDGET, 0); // 0 = off
export const EVAL_CACHE_TTL = num(process.env.PLAYGUARD_EVAL_CACHE_TTL, 500); // ms; 0 = off
// Default off since 0.8.0: the next call after a navigate is almost always an evaluate,
// which is MUTATING and discards the prefetch (3 hits in 3238 navigates), while the
// background snapshot competes with that evaluate on the one upstream connection.
export const PREFETCH_SNAPSHOT = process.env.PLAYGUARD_PREFETCH_SNAPSHOT === "true";
// Tool-description hints that nudge agents to batch evaluate/run_code calls.
export const HINTS = process.env.PLAYGUARD_HINTS !== "false";
// Asks the npm registry for the latest version on startup; =false for offline/CI.
export const UPDATE_CHECK = process.env.PLAYGUARD_UPDATE_CHECK !== "false";
export const SMART_WAIT = process.env.PLAYGUARD_SMART_WAIT === "1" || process.env.PLAYGUARD_SMART_WAIT === "true"; // default off
export const SMART_WAIT_MS = num(process.env.PLAYGUARD_SMART_WAIT_MS, 1000);
export const SMART_WAIT_MAX_RETRIES = num(process.env.PLAYGUARD_SMART_WAIT_MAX_RETRIES, 3);
export const SMART_WAIT_MIN_REFS = num(process.env.PLAYGUARD_SMART_WAIT_MIN_REFS, 5);
export const EVAL_COMPACT_THRESHOLD = num(process.env.PLAYGUARD_EVAL_COMPACT, 10000); // chars; 0 = off
export const FIGMA_MCP_CMD = process.env.FIGMA_MCP_CMD; // stdio upstream (Framelink)
// Official Figma MCP over HTTP — the desktop app's server, http://127.0.0.1:3845/mcp.
// No key: the Figma app's own login authorizes it. Wins over FIGMA_MCP_CMD when both are set.
export const FIGMA_MCP_URL = process.env.FIGMA_MCP_URL || undefined;
export const FIGMA_ENABLED = !!(FIGMA_MCP_URL || FIGMA_MCP_CMD);
const figmaUrl = (() => { try { return FIGMA_MCP_URL ? new URL(FIGMA_MCP_URL) : undefined; } catch { return undefined; } })();
// Set when FIGMA_MCP_URL is not a URL at all (e.g. "127.0.0.1:3845/mcp" without http://).
// Also http(s) only ("localhost:3845/mcp" parses with scheme "localhost:"), and no user:pass@ —
// fetch refuses URLs with credentials, so it could never connect.
export const FIGMA_URL_INVALID = !!FIGMA_MCP_URL && (!figmaUrl || !/^https?:$/.test(figmaUrl.protocol) || !!(figmaUrl.username || figmaUrl.password));
// For messages and logs: never echo credentials someone put in the URL.
export const FIGMA_URL_SAFE = figmaUrl ? `${figmaUrl.protocol}//${figmaUrl.host}${figmaUrl.pathname}` : (FIGMA_MCP_URL ?? "");
// Figma's remote server (mcp.figma.com) admits only clients from Figma's own catalog;
// PlayGuard isn't one, so this setup is refused up front with what to do instead.
export const FIGMA_REMOTE_REFUSED = !!figmaUrl && /(^|\.)figma\.com$/i.test(figmaUrl.hostname.replace(/\.$/, ""));
export const FIGMA_CACHE_TTL = num(process.env.FIGMA_CACHE_TTL, 0); // ms; 0 = off
export const FIGMA_SVG_REFS = process.env.FIGMA_SVG_REFS !== "false"; // default on: replace inline SVG with lightweight refs
// Some Figma MCPs (e.g. Framelink figma-developer-mcp) pre-simplify to YAML/markdown text
// instead of raw REST-API JSON, so optimizeFigmaResponse's modules never fire on them —
// this is the fallback that still saves tokens on that path. chars; 0 = off
export const FIGMA_TEXT_COMPACT = num(process.env.FIGMA_TEXT_COMPACT, 10000);
export const DESIGN_DIFF_TOLERANCE_PX = num(process.env.PLAYGUARD_DESIGN_DIFF_TOLERANCE_PX, 2);
export const DESIGN_DIFF_TOLERANCE_COLOR = num(process.env.PLAYGUARD_DESIGN_DIFF_TOLERANCE_COLOR, 5);

export const DELTA_THRESHOLD = num(process.env.PLAYGUARD_DELTA_THRESHOLD, 0.4, parseFloat);
export const DELTA_ENABLED = process.env.PLAYGUARD_DELTA !== "false";
export const HINT_THRESHOLD = num(process.env.PLAYGUARD_HINT_THRESHOLD, 4);

export const __dir = dirname(fileURLToPath(import.meta.url));

export const VERSION: string = JSON.parse(readFileSync(resolve(__dir, "..", "package.json"), "utf8")).version;

export const LOG_DIR = process.env.PLAYGUARD_LOG_DIR || resolve(__dir, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });

// process.cwd() is NOT reliably the project root: an MCP client spawns the server
// with whatever cwd it likes (its own install dir, `/`, the user's home), so anchoring
// artifacts on cwd scattered them almost at random. Walk up from cwd to the nearest
// directory that looks like a project root instead, and let the caller pin it outright.
export function findProjectRoot(start: string): string {
  for (let dir = start; ;) {
    if (existsSync(resolve(dir, ".git")) || existsSync(resolve(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return start; // hit the filesystem root without a marker
    dir = up;
  }
}
export const PROJECT_ROOT = process.env.PLAYGUARD_PROJECT_ROOT || findProjectRoot(process.cwd());

// Landing on our own install directory means cwd was never a user project (a global
// install, an npx cache, the client's own folder) — the walk-up then just finds
// PlayGuard's package.json. Nothing to fall back to, so say so instead of silently
// writing artifacts into node_modules.
if (resolve(PROJECT_ROOT) === resolve(__dir, ".."))
  process.stderr.write(
    "[PlayGuard] artifact root resolved to PlayGuard's own install dir — the MCP client " +
    "spawned this server outside a project. Set PLAYGUARD_PROJECT_ROOT to your project root.\n");

// One home for every on-disk artifact, split by origin so the two never mix:
//   .playguard/.figma  — everything coming from Figma (exported images)
//   .playguard/.qa     — everything coming from the site under test (screenshots,
//                        traces, PDFs, downloads, session state)
// instead of the upstream default `.playwright-mcp` plus stray files in the root.
export const OUTPUT_DIR = process.env.PLAYGUARD_OUTPUT_DIR || resolve(PROJECT_ROOT, ".playguard");
export const FIGMA_DIR = resolve(OUTPUT_DIR, ".figma");
export const QA_DIR = resolve(OUTPUT_DIR, ".qa");
// An unwritable root must not take the whole server down at import time: snapshots,
// the main feature, need no disk at all. Report it and let the writes fail later.
try {
  mkdirSync(FIGMA_DIR, { recursive: true });
  mkdirSync(QA_DIR, { recursive: true });
} catch (e) {
  process.stderr.write(`[PlayGuard] could not create ${OUTPUT_DIR}: ${e}\n`);
}

// Find the upstream through Node's own module resolution and run its entry with
// the node binary we're already running. Locating it by shim instead — a
// `.bin/playwright-mcp.cmd` path, or the bare name in the hope that npm put it
// on PATH — only works when this package is the project root. Under `npx`, a
// global install, or any hoisted layout, the shim lives in a directory that
// never reaches the child's PATH and the upstream fails to spawn at all.
// Resolving `package.json` (not `cli.js`) on purpose: the package's `exports`
// map doesn't expose the CLI, but `package.json` is always reachable and names
// the entry in its `bin` field.
export function resolveUpstream(): [string, string[]] | null {
  try {
    const pkgPath = createRequire(import.meta.url).resolve("@playwright/mcp/package.json");
    const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin;
    const entry = typeof bin === "string" ? bin : bin?.["playwright-mcp"];
    return entry ? [process.execPath, [resolve(dirname(pkgPath), entry)]] : null;
  } catch {
    return null;
  }
}

const binName = process.platform === "win32" ? "playwright-mcp.cmd" : "playwright-mcp";
const localBin = resolve(__dir, "..", "node_modules", ".bin", binName);
// Shim lookup stays as the last resort: it covers an upstream that was installed
// as a bare binary rather than as a resolvable dependency.
const [rawCmd, baseArgs]: [string, string[]] = process.env.PLAYWRIGHT_MCP_CMD
  ? [process.env.PLAYWRIGHT_MCP_CMD, []]
  : resolveUpstream() ?? [existsSync(localBin) ? localBin : binName, []];
const extraArgs = process.env.PLAYWRIGHT_MCP_ARGS ? splitArgs(process.env.PLAYWRIGHT_MCP_ARGS) : [];

// Point Playwright MCP's output at QA_DIR — but respect an explicit --output-dir
// the user already passed in PLAYWRIGHT_MCP_ARGS, in either `--output-dir X` or
// `--output-dir=X` form. Missing the `=` form would append a second flag and let
// ours silently win on last-flag-wins parsing, contradicting the documented precedence.
export function withOutputDir(args: string[], dir: string): string[] {
  const present = args.some(a => a === "--output-dir" || a.startsWith("--output-dir="));
  return present ? args : [...args, "--output-dir", dir];
}
// Drop the `### Ran Playwright code` block Playwright MCP appends to every response —
// agents never use it, and it costs 80–150 chars per call. Same precedence rule as
// withOutputDir: a user-passed --codegen wins in either form.
export function withCodegenOff(args: string[]): string[] {
  const present = args.some(a => a === "--codegen" || a.startsWith("--codegen="));
  return present ? args : [...args, "--codegen", "none"];
}
// Only for our own pinned @playwright/mcp: a custom PLAYWRIGHT_MCP_CMD may not know the
// flag and would fail to start.
const codegenOff = !process.env.PLAYWRIGHT_MCP_CMD && process.env.PLAYGUARD_CODEGEN !== "keep";
// Run the command directly and let cross-spawn (used inside the MCP SDK) handle .cmd/.bat
// invocation. A manual `cmd /c` wrapper mangles args with spaces — cmd's quote-stripping
// splits an --output-dir path like "…\Рабочий стол\…" mid-path.
const pwArgs = withOutputDir([...baseArgs, ...extraArgs], QA_DIR);
export const [PW_CMD, PW_ARGS]: [string, string[]] = [rawCmd, codegenOff ? withCodegenOff(pwArgs) : pwArgs];

const figmaExtraArgs = process.env.FIGMA_MCP_ARGS ? splitArgs(process.env.FIGMA_MCP_ARGS) : [];
export const [FIGMA_CMD, FIGMA_ARGS]: [string, string[]] = FIGMA_MCP_CMD
  ? (() => { const p = splitArgs(FIGMA_MCP_CMD); return [p[0], [...p.slice(1), ...figmaExtraArgs]] as [string, string[]]; })()
  : ["", []];

// Chrome DevTools MCP (chrome-devtools-mcp): opt-in upstream, e.g.
// DEVTOOLS_MCP_CMD="npx -y chrome-devtools-mcp@latest". undefined = disabled.
export const DEVTOOLS_MCP_CMD = process.env.DEVTOOLS_MCP_CMD;
// false = pure passthrough: no response rewriting, no tools/list compaction.
export const DEVTOOLS_OPTIMIZE = process.env.PLAYGUARD_DEVTOOLS_OPTIMIZE !== "false";
export const DEVTOOLS_NETWORK_MAX = num(process.env.PLAYGUARD_DEVTOOLS_NETWORK_MAX, 30); // rows; 0 = off
export const DEVTOOLS_BODY_MAX = num(process.env.PLAYGUARD_DEVTOOLS_BODY_MAX, 3000); // chars; 0 = off
// tools/list waits this long for an optional upstream (Figma, DevTools) before listing
// without it — a first `npx` download alone can take a minute. ms
export const LIST_WAIT_MS = num(process.env.PLAYGUARD_LIST_WAIT_MS, 6000);

// chrome-devtools-mcp resolves a relative filePath against its cwd (spawned in QA_DIR) and,
// with a client that declares no MCP roots, lets file tools touch only the OS temp dir.
// Allow the project and the artifact dir too — unless the user already configured paths,
// in any spelling yargs accepts (--workspace, --filesystem-root=…, --allowUnrestrictedPaths).
const DT_PATH_OPTS = new Set(["workspace", "filesystemRoot", "allowUnrestrictedPaths"]);
export function withDevtoolsWorkspace(args: string[], roots: string[]): string[] {
  const given = args.some(a => {
    const m = /^--(?:no-)?([^=]+)/.exec(a);
    return !!m && DT_PATH_OPTS.has(m[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
  });
  return given ? args : [...args, ...roots.flatMap(r => ["--workspace", r])];
}
// Documentation upstreams, both opt-in and both read-only: Shopify Dev MCP
// (SHOPIFY_DEV_MCP_CMD="npx -y @shopify/dev-mcp@latest") and Context7
// (CONTEXT7_MCP_CMD="npx -y @upstash/context7-mcp@latest"). undefined = disabled.
export const SHOPIFY_DEV_MCP_CMD = process.env.SHOPIFY_DEV_MCP_CMD;
export const CONTEXT7_MCP_CMD = process.env.CONTEXT7_MCP_CMD;
// false = pure passthrough for both: no response rewriting, no tools/list compaction.
export const DOCS_OPTIMIZE = process.env.PLAYGUARD_DOCS_OPTIMIZE !== "false";
// On-disk cache of read-only doc lookups. seconds; 0 = off. Version-pinned Context7 ids keep 7x.
export const DOCS_CACHE_TTL = num(process.env.PLAYGUARD_DOCS_CACHE_TTL, 86400);
export const DOCS_CACHE_DIR = resolve(OUTPUT_DIR, ".cache", "docs");
const cmdWithArgs = (cmd: string | undefined, extra: string | undefined): [string, string[]] => {
  if (!cmd) return ["", []];
  const p = splitArgs(cmd);
  return [p[0], [...p.slice(1), ...(extra ? splitArgs(extra) : [])]];
};
export const [SHOPIFY_DEV_CMD, SHOPIFY_DEV_ARGS] = cmdWithArgs(SHOPIFY_DEV_MCP_CMD, process.env.SHOPIFY_DEV_MCP_ARGS);
export const [CONTEXT7_CMD, CONTEXT7_ARGS] = cmdWithArgs(CONTEXT7_MCP_CMD, process.env.CONTEXT7_MCP_ARGS);

const devtoolsExtraArgs = process.env.DEVTOOLS_MCP_ARGS ? splitArgs(process.env.DEVTOOLS_MCP_ARGS) : [];
const projectAbs = resolve(PROJECT_ROOT);
const dtRoots = QA_DIR.startsWith(projectAbs + sep) ? [projectAbs] : [projectAbs, QA_DIR];
export const [DEVTOOLS_CMD, DEVTOOLS_ARGS]: [string, string[]] = DEVTOOLS_MCP_CMD
  ? (() => {
    const p = splitArgs(DEVTOOLS_MCP_CMD);
    const args = [...p.slice(1), ...devtoolsExtraArgs];
    return [p[0], process.env.PLAYGUARD_DEVTOOLS_DEFAULTS === "false" ? args : withDevtoolsWorkspace(withDevtoolsDefaults(args), dtRoots)] as [string, string[]];
  })()
  : ["", []];
