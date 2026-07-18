// All configuration in one place: env-derived knobs, resolved paths, and the
// upstream MCP commands. Beyond parsing the dials it only creates the two
// directories it resolves (LOG_DIR, OUTPUT_DIR) — no other side effects.
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { readFileSync, existsSync, mkdirSync } from "fs";

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

export const SCREENSHOTS = process.env.PLAYGUARD_SCREENSHOTS ?? "warn"; // block | warn | allow | redirect
// ponytail: compact on by default — strips non-interactive lines, set =false to get raw snapshots
export const COMPACT = process.env.PLAYGUARD_COMPACT !== "false";
export const TOKEN_BUDGET = parseInt(process.env.PLAYGUARD_TOKEN_BUDGET ?? "0"); // 0 = off
export const EVAL_CACHE_TTL = parseInt(process.env.PLAYGUARD_EVAL_CACHE_TTL ?? "500"); // ms; 0 = off
export const PREFETCH_SNAPSHOT = process.env.PLAYGUARD_PREFETCH_SNAPSHOT !== "false"; // default on
export const SMART_WAIT = process.env.PLAYGUARD_SMART_WAIT === "1" || process.env.PLAYGUARD_SMART_WAIT === "true"; // default off
export const SMART_WAIT_MS = parseInt(process.env.PLAYGUARD_SMART_WAIT_MS ?? "1000");
export const SMART_WAIT_MAX_RETRIES = parseInt(process.env.PLAYGUARD_SMART_WAIT_MAX_RETRIES ?? "3");
export const SMART_WAIT_MIN_REFS = parseInt(process.env.PLAYGUARD_SMART_WAIT_MIN_REFS ?? "5");
export const EVAL_COMPACT_THRESHOLD = parseInt(process.env.PLAYGUARD_EVAL_COMPACT ?? "10000"); // chars; 0 = off
export const FIGMA_MCP_CMD = process.env.FIGMA_MCP_CMD; // undefined = Figma disabled
export const FIGMA_CACHE_TTL = parseInt(process.env.FIGMA_CACHE_TTL ?? "0"); // ms; 0 = off
export const FIGMA_SVG_REFS = process.env.FIGMA_SVG_REFS !== "false"; // default on: replace inline SVG with lightweight refs
// Some Figma MCPs (e.g. Framelink figma-developer-mcp) pre-simplify to YAML/markdown text
// instead of raw REST-API JSON, so optimizeFigmaResponse's modules never fire on them —
// this is the fallback that still saves tokens on that path. chars; 0 = off
export const FIGMA_TEXT_COMPACT = parseInt(process.env.FIGMA_TEXT_COMPACT ?? "10000");
export const DESIGN_DIFF_TOLERANCE_PX = parseInt(process.env.PLAYGUARD_DESIGN_DIFF_TOLERANCE_PX ?? "2");
export const DESIGN_DIFF_TOLERANCE_COLOR = parseInt(process.env.PLAYGUARD_DESIGN_DIFF_TOLERANCE_COLOR ?? "5");

export const DELTA_THRESHOLD = parseFloat(process.env.PLAYGUARD_DELTA_THRESHOLD ?? "0.4");
export const DELTA_ENABLED = process.env.PLAYGUARD_DELTA !== "false";
export const HINT_THRESHOLD = parseInt(process.env.PLAYGUARD_HINT_THRESHOLD ?? "4");

export const __dir = dirname(fileURLToPath(import.meta.url));

export const VERSION: string = JSON.parse(readFileSync(resolve(__dir, "..", "package.json"), "utf8")).version;

export const LOG_DIR = process.env.PLAYGUARD_LOG_DIR || resolve(__dir, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });

// One home for every on-disk artifact (screenshots, traces, PDFs, downloads,
// session, Figma images) — instead of the upstream default `.playwright-mcp`
// plus stray screenshots in the project root. process.cwd() is the project root
// (it's where those files land today); override with PLAYGUARD_OUTPUT_DIR.
export const OUTPUT_DIR = process.env.PLAYGUARD_OUTPUT_DIR || resolve(process.cwd(), ".playguard");
mkdirSync(OUTPUT_DIR, { recursive: true });

const binName = process.platform === "win32" ? "playwright-mcp.cmd" : "playwright-mcp";
const localBin = resolve(__dir, "..", "node_modules", ".bin", binName);
// When installed via npm/npx, dependencies are hoisted — localBin points inside
// the package's own node_modules which doesn't exist. Fall back to the bare
// command name which npm places on PATH.
const rawCmd = process.env.PLAYWRIGHT_MCP_CMD ?? (existsSync(localBin) ? localBin : binName);
const extraArgs = process.env.PLAYWRIGHT_MCP_ARGS ? splitArgs(process.env.PLAYWRIGHT_MCP_ARGS) : [];

// Point Playwright MCP's output at OUTPUT_DIR — but respect an explicit --output-dir
// the user already passed in PLAYWRIGHT_MCP_ARGS, in either `--output-dir X` or
// `--output-dir=X` form. Missing the `=` form would append a second flag and let
// ours silently win on last-flag-wins parsing, contradicting the documented precedence.
export function withOutputDir(args: string[], dir: string): string[] {
  const present = args.some(a => a === "--output-dir" || a.startsWith("--output-dir="));
  return present ? args : [...args, "--output-dir", dir];
}
// Run the command directly and let cross-spawn (used inside the MCP SDK) handle .cmd/.bat
// invocation. A manual `cmd /c` wrapper mangles args with spaces — cmd's quote-stripping
// splits an --output-dir path like "…\Рабочий стол\…" mid-path.
export const [PW_CMD, PW_ARGS]: [string, string[]] = [rawCmd, withOutputDir(extraArgs, OUTPUT_DIR)];

const figmaExtraArgs = process.env.FIGMA_MCP_ARGS ? splitArgs(process.env.FIGMA_MCP_ARGS) : [];
export const [FIGMA_CMD, FIGMA_ARGS]: [string, string[]] = FIGMA_MCP_CMD
  ? (() => { const p = splitArgs(FIGMA_MCP_CMD); return [p[0], [...p.slice(1), ...figmaExtraArgs]] as [string, string[]]; })()
  : ["", []];
