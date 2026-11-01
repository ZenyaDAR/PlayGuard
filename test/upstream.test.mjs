// Run: npm test. lazyUpstream's lifecycle against mock clients: no real process needed,
// only `onclose` and `close()` matter to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lazyUpstream } from "../dist/upstream.js";

function harness() {
  const all = [];
  let revives = 0;
  const h = { failNext: 0 };
  const spawn = async () => {
    await new Promise(r => setTimeout(r, 20));
    if (h.failNext > 0) { h.failNext--; all.push(null); throw new Error("spawn failed"); }
    const c = { id: all.length + 1, closed: false, onclose: undefined, async close() { this.closed = true; this.onclose?.(); } };
    all.push(c);
    return c;
  };
  const up = lazyUpstream(spawn, async () => { revives++; });
  return Object.assign(h, { up, all: () => all.filter(Boolean), spawns: () => all.length, revives: () => revives });
}

test("upstream: get() spawns once and reuses the client", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.up.get(), h.up.get()]);
  assert.equal(a, b);
  assert.equal(await h.up.get(), a);
  assert.equal(h.spawns(), 1);
  assert.equal(h.revives(), 0);
});

test("upstream: a process that exits between calls is respawned through the revive path", async () => {
  const h = harness();
  const c1 = await h.up.get();
  c1.onclose(); // the transport closed on its own
  const c2 = await h.up.get();
  assert.notEqual(c2, c1);
  assert.equal(h.revives(), 1, "onRevive resets state and replays the last url");
  assert.equal(await h.up.get(), c2);
  assert.equal(h.revives(), 1, "only once");
});

test("upstream: revive() during a pending spawn reuses it — no second, orphaned process", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.up.get(), h.up.revive()]);
  assert.equal(a, b);
  assert.equal(h.spawns(), 1);
  assert.equal(h.revives(), 1);
  const cur = await h.up.get();
  assert.deepEqual(h.all().filter(c => !c.closed && c !== cur), []);
});

test("upstream: concurrent revives share one respawn and close the old client", async () => {
  const h = harness();
  const c1 = await h.up.get();
  const [a, b] = await Promise.all([h.up.revive(), h.up.revive()]);
  assert.equal(a, b);
  assert.ok(c1.closed);
  assert.equal(h.spawns(), 2);
  assert.equal(h.revives(), 1);
  assert.equal(await h.up.get(), a, "the old client's close did not clear the new one");
});

test("upstream: a failed respawn leaves the next get() on the revive path", async () => {
  const h = harness();
  const c1 = await h.up.get();
  c1.onclose();
  h.failNext = 1;
  await assert.rejects(h.up.get(), /spawn failed/);
  const c = await h.up.get();
  assert.notEqual(c, c1);
  assert.equal(h.revives(), 1, "the retry still resets state and replays the url");
});

test("upstream: an initial spawn failure is retried by the next get()", async () => {
  const h = harness();
  h.failNext = 1;
  await assert.rejects(h.up.get(), /spawn failed/);
  const c = await h.up.get();
  assert.ok(c);
  assert.equal(h.revives(), 0, "never connected, so nothing to revive");
});
