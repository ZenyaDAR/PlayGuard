// Lazy, self-healing upstream MCP client: spawned on first use, respawned by revive().
// Used by Chrome DevTools and the docs upstreams; Playwright and Figma still have their own copies
// of this pattern in index.ts (see HUB_PLAN.md §2.3).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export function lazyUpstream(spawn: () => Promise<Client>, onRevive?: (c: Client) => Promise<void>) {
  let conn: Client | null = null;
  let pending: Promise<Client> | null = null;
  let reviving: Promise<Client> | null = null;
  // A live client closed on its own (the process exited between calls). Its replacement
  // must go through revive(), or onRevive's state reset and page replay never run.
  let lost = false;

  // A process that exits on its own leaves a Client that only ever answers "Not connected".
  // Forgetting it on close makes the next get() respawn; the identity check keeps
  // revive()'s close() of the old client from clearing the new one.
  const attach = (c: Client): Client => {
    const prev = c.onclose;
    c.onclose = () => { if (conn === c) { conn = null; lost = true; } prev?.(); };
    conn = c;
    return c;
  };

  const up = {
    get(): Promise<Client> {
      if (conn) return Promise.resolve(conn);
      if (reviving) return reviving;
      if (lost) return up.revive();
      pending ??= spawn().then(attach).finally(() => { pending = null; });
      return pending;
    },
    // Single-flight: concurrent callers that all saw the same failure share one respawn.
    revive(): Promise<Client> {
      reviving ??= (async () => {
        const old = conn;
        conn = null;
        try { await old?.close(); } catch {}
        // A spawn already in flight is as fresh as a new one: reuse it instead of starting
        // a second process (and a second Chrome) that nobody would ever close.
        const inflight = pending && await pending.catch(() => null);
        const c = inflight ?? attach(await spawn());
        lost = false; // only once a respawn worked: a failed one leaves the next get() reviving
        await onRevive?.(c);
        return c;
      })().finally(() => { reviving = null; });
      return reviving;
    },
  };
  return up;
}
