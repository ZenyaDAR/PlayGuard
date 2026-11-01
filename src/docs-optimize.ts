// Pure response/tools rewrites for the two documentation upstreams: Shopify Dev MCP
// (@shopify/dev-mcp) and Context7 (@upstash/context7-mcp). Every rewrite detects its
// format first and returns the input unchanged, with a `skip` reason, when it does not
// recognise it — an upstream format change must show up as a no-op, never as corruption.
// Measurements and the format notes behind each rule: .omc/research/{shopify-dev,context7}.md.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

type ToolArgs = Record<string, unknown>;
export type Rewrite = { text: string; skip?: string };

const RAW_PARAM = { type: "boolean", description: "PlayGuard: return the upstream text unchanged (no compaction, no repeat note)." };

// Drops $schema (lossless) and the given properties; never mutates the input schema.
function pruneSchema(schema: Tool["inputSchema"], drop: Set<string>, extra: Record<string, object> = {}): Tool["inputSchema"] {
  const { $schema: _, ...rest } = schema as Tool["inputSchema"] & { $schema?: string };
  const properties = Object.fromEntries(Object.entries(rest.properties ?? {}).filter(([k]) => !drop.has(k)));
  const required = rest.required?.filter(k => !drop.has(k));
  return { ...rest, properties: { ...properties, ...extra }, ...(required ? { required } : {}) };
}

// ── Shopify Dev MCP ──────────────────────────────────────────────────────────

// Sends usage data only (a "scorecard" of how the tools performed); PlayGuard runs the
// upstream with telemetry off, so the tool would only cost ~3.5K chars of tools/list.
const SHOPIFY_HIDDEN_TOOLS = new Set(["feedback"]);
// Telemetry-only params of learn_shopify_api: they change nothing in the output.
const SHOPIFY_TELEMETRY_PARAMS = new Set(["model", "user_prompt"]);
export const SHOPIFY_RAW_TOOLS = new Set(["search_docs_chunks", "learn_shopify_api"]);

// tools/list: hides `feedback`, drops the telemetry params (and the workflow steps that ask
// for them), makes conversationId optional (the proxy fills one in, see fillShopifyArgs),
// adds `raw`. The per-API routing list in learn_shopify_api's description stays whole: it
// is how the agent picks `api`.
export function compactShopifyTools(tools: Tool[]): Tool[] {
  return tools.filter(t => !SHOPIFY_HIDDEN_TOOLS.has(t.name)).map(t => {
    const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    const extra: Record<string, object> = {};
    if (props.conversationId) extra.conversationId = { type: "string", description: "Optional: PlayGuard fills in a session id when omitted." };
    if (SHOPIFY_RAW_TOOLS.has(t.name)) extra.raw = RAW_PARAM;
    const schema = pruneSchema(t.inputSchema, new Set([...SHOPIFY_TELEMETRY_PARAMS, "conversationId"]), extra);
    let description = t.description;
    if (description && t.name === "learn_shopify_api") {
      description = description
        .split("\n")
        .filter(l => !/^\s*\d+\.\s.*(`model` parameter|`user_prompt` parameter|call the feedback tool)/.test(l))
        .join("\n")
        .replace(/, and the user_prompt that triggered the new call/, "");
    }
    return { ...t, description, inputSchema: schema };
  });
}

// conversationId only feeds upstream telemetry and is not validated ("not-a-real-id" gives
// normal results), but the schema requires it — one stable id per PlayGuard process.
export function fillShopifyArgs(args: ToolArgs, sessionId: string): ToolArgs {
  return args.conversationId ? args : { ...args, conversationId: sessionId };
}

// Cache / repeat identity: everything except the per-session and telemetry-only args.
export function shopifyKeyArgs(args: ToolArgs): ToolArgs {
  const { conversationId: _c, model: _m, user_prompt: _u, raw: _r, ...rest } = args;
  return rest;
}

type SearchChunk = { content: string; url: string; title?: string };
const SEARCH_FIELDS = new Set(["score", "content", "url", "title", "domain"]);
// A /YYYY-MM/ (or /unstable/) path segment: the same page published per API version.
const API_VERSION_SEG = /\/(?:\d{4}-\d{2}|unstable)(?=[/?#]|$)/g;

// search_docs_chunks: a pretty-printed JSON array of {score, content, url, title, domain}
// becomes `## title\nurl\ncontent` blocks. Drops score/domain, exact duplicate chunks, and
// a chunk whose content is byte-identical to an earlier one and whose URL differs only in the
// API version segment (its URL goes on the earlier chunk's `also:` line). Content that differs
// at all, even only in a version inside code, keeps both chunks. Content is never cut.
export function compactShopifySearch(text: string): Rewrite {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { text, skip: "search_not_json" }; }
  if (!Array.isArray(parsed) || !parsed.length) return { text, skip: "search_not_array" };
  // Any field we would silently drop beyond score/domain means the format moved on.
  if (!parsed.every(c => c && typeof c.content === "string" && typeof c.url === "string" &&
    (c.title == null || typeof c.title === "string") && Object.keys(c).every(k => SEARCH_FIELDS.has(k)))) {
    return { text, skip: "search_unknown_fields" };
  }
  const kept: Array<SearchChunk & { also: string[] }> = [];
  const exact = new Set<string>();
  const byVersionless = new Map<string, SearchChunk & { also: string[] }>();
  for (const c of parsed as SearchChunk[]) {
    const k = `${c.url}\0${c.content}`;
    if (exact.has(k)) continue;
    exact.add(k);
    const vk = `${c.url.replace(API_VERSION_SEG, "/V")}\0${c.content}`;
    const twin = byVersionless.get(vk);
    if (twin) { if (twin.url !== c.url && !twin.also.includes(c.url)) twin.also.push(c.url); continue; }
    const entry = { ...c, also: [] };
    byVersionless.set(vk, entry);
    kept.push(entry);
  }
  const out = kept.map(c =>
    `## ${c.title || "(untitled)"}\n${c.url}${c.also.length ? `\nalso: ${c.also.join(", ")}` : ""}\n${c.content}`);
  return { text: out.join("\n\n") };
}

// learn_shopify_api: some bundled instruction bodies escape every backtick (\`\`\` fences
// reach the agent with literal backslashes), followed by an unescaped common tail. Only the
// part up to the last escaped backtick is unescaped, and only when that part has no bare
// backtick at all: a text mixing both styles there (real escapes in code) is left alone.
export function unescapeLearn(text: string): Rewrite {
  const last = text.lastIndexOf("\\`");
  if (last < 0) return { text };
  const head = text.slice(0, last + 2);
  if (/(?<!\\)`/.test(head)) return { text, skip: "learn_mixed_backticks" };
  return { text: head.replace(/\\`/g, "`") + text.slice(last + 2) };
}

// ── Context7 ─────────────────────────────────────────────────────────────────

export const CONTEXT7_RAW_TOOLS = new Set(["resolve-library-id", "query-docs"]);

// Replaces Context7's ~700-char server instructions (PlayGuard does not forward upstream
// instructions; this is what the agent sees instead).
export const CONTEXT7_INSTRUCTIONS =
  "Context7 (resolve-library-id, query-docs): fetch current docs for any library, framework, SDK, API, CLI or cloud service, " +
  "even well-known ones, instead of relying on memory or web search. Not for code that does not depend on a library.";

const C7_DESCRIPTIONS: Record<string, { marker: RegExp; text: string; params: Record<string, string> }> = {
  "resolve-library-id": {
    marker: /Context7-compatible library ID/,
    text: "Resolves a library/package name to Context7-compatible library IDs (/org/project). One line per match: " +
      "id | title | code snippets | source reputation | benchmark score (max 100) | versions | description. " +
      "Call it before query-docs unless the user gave an id as /org/project or /org/project/version. " +
      "Pick by name match, reputation, snippet count and score; pin a listed version as /org/project/version. " +
      "Do not call it more than 3 times per question.",
    params: {
      query: "What the user is trying to do; used to rank the libraries. Sent to the Context7 API: never include secrets, credentials, personal data or proprietary code.",
      libraryName: "Official library name with punctuation, e.g. 'Next.js' not 'nextjs', 'Three.js' not 'threejs'.",
    },
  },
  "query-docs": {
    marker: /Context7/,
    text: "Fetches up-to-date documentation and code examples for a library from Context7. " +
      "Needs a Context7-compatible library ID from resolve-library-id, unless the user gave one as /org/project or /org/project/version. " +
      "Pass `language` when known. Do not call it more than 3 times per question.",
    params: {
      libraryId: "Exact Context7-compatible library ID, e.g. '/vercel/next.js' or '/vercel/next.js/v16.2.9'.",
      query: "One specific concept, e.g. 'React useEffect cleanup function examples' (not 'hooks'); one call per distinct concept. Sent to the Context7 API: never include secrets, credentials, personal data or proprietary code.",
      language: "Language of the user's code, e.g. 'TypeScript', 'Python'; ranks examples in it first. Omit when unknown.",
    },
  },
};

// tools/list: shorter descriptions addressed to the agent (the upstream ones carry a
// "Selection Process"/"Response Format" essay and repeat the privacy sentence twice).
// Names, param names, types, required lists and annotations are kept as they are; a tool
// whose description no longer looks like Context7's keeps its upstream text.
export function compactContext7Tools(tools: Tool[]): Tool[] {
  return tools.map(t => {
    const known = C7_DESCRIPTIONS[t.name];
    const extra: Record<string, object> = CONTEXT7_RAW_TOOLS.has(t.name) ? { raw: RAW_PARAM } : {};
    const schema = pruneSchema(t.inputSchema, new Set(), extra);
    if (!known || !known.marker.test(t.description ?? "")) return { ...t, inputSchema: schema };
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const [k, d] of Object.entries(known.params)) if (props[k]) props[k] = { ...props[k], description: d };
    return { ...t, description: known.text, inputSchema: schema };
  });
}

// Cache / repeat identity: trimmed strings, case-insensitive library name and language.
export function context7KeyArgs(args: ToolArgs): ToolArgs {
  const { raw: _r, ...rest } = args;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => {
    if (typeof v !== "string") return [k, v];
    const s = v.trim();
    return [k, k === "libraryName" || k === "language" ? s.toLowerCase() : s];
  }));
}

// A version-pinned id (/org/project/version) never changes upstream: cached longer.
export const isPinnedLibraryId = (id: unknown): boolean => typeof id === "string" && id.split("/").filter(Boolean).length >= 3;

const C7_DESC_MAX = 90;
const shorten = (s: string, max: number) => {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max - 1);
  return `${s.slice(0, cut > max * 0.6 ? cut : max - 1).replace(/[\s,.;:]+$/, "")}…`;
};

// resolve-library-id: five ~350-char `- Field: value` blocks become one line each, keeping
// every id and the upstream order. Drops `__branch__*` pseudo-versions and cuts the
// description to ~90 chars. Unknown fields are kept verbatim at the end of the line.
export function compactResolve(text: string): Rewrite {
  const t = text.replace(/\r\n/g, "\n");
  if (!t.startsWith("Available Libraries:")) return { text, skip: "resolve_no_header" };
  const blocks = t.slice("Available Libraries:".length).split(/\n-{10}\n/);
  const lines: string[] = [];
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const l of block.split("\n")) {
      if (!l.trim()) continue;
      const m = /^- ([^:]+): (.*)$/.exec(l);
      if (!m) return { text, skip: "resolve_unknown_line" };
      fields.set(m[1], m[2]);
    }
    const id = fields.get("Context7-compatible library ID");
    if (!id?.startsWith("/") || !fields.has("Title")) return { text, skip: "resolve_unknown_entry" };
    const versions = (fields.get("Versions") ?? "").split(",").map(v => v.trim()).filter(v => v && !v.startsWith("__branch__"));
    const cols = [
      id,
      fields.get("Title")!,
      fields.has("Code Snippets") ? `${fields.get("Code Snippets")} snippets` : "",
      fields.get("Source Reputation") ?? "",
      fields.get("Benchmark Score") ?? "",
      versions.length ? `versions: ${versions.join(", ")}` : "",
      shorten(fields.get("Description") ?? "", C7_DESC_MAX),
    ];
    const known = new Set(["Context7-compatible library ID", "Title", "Code Snippets", "Source Reputation", "Benchmark Score", "Versions", "Description"]);
    for (const [k, v] of fields) if (!known.has(k)) cols.push(`${k}: ${v}`);
    lines.push(cols.filter(Boolean).join(" | "));
  }
  return { text: `Libraries (id | title | snippets | reputation | benchmark | versions | description):\n${lines.join("\n")}` };
}

const DOCS_SEPARATOR = /\r?\n-{32}\r?\n/;
const GITHUB_SOURCE = /^Source: https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([^/\s]+)\/(\S+)$/m;

// query-docs: light trim only — snippets are the payload. Splits on the 32-dash separator
// line (never on ``` fences: APIDOC blocks nest them), drops an exact duplicate snippet,
// and shortens GitHub `Source:` URLs to `org/repo@ref:path` (lossless). Code is untouched.
export function trimDocs(text: string): Rewrite {
  const chunks = text.split(DOCS_SEPARATOR);
  if (!chunks.every(c => /^\s*### /.test(c) && /^Source: /m.test(c))) return { text, skip: "docs_unknown_format" };
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const seen = new Set<string>();
  const kept = chunks.filter(c => { const k = c.trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(c => c.replace(GITHUB_SOURCE, (_, org, repo, ref, path) => `Source: ${org}/${repo}@${ref}:${path}`));
  return { text: kept.join(`${nl}${"-".repeat(32)}${nl}`) };
}
