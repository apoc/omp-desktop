#!/usr/bin/env node
// Regression script for src/app/conversation-tree.js (and the shape module it
// lays out with, conversation-tree-graph.js) — the model behind the
// conversation-tree navigator: which prompts still hit omp's prompt cache, the
// anchors that keep a long conversation partially cached, tips, and graph
// lanes. Trees are synthetic (the `conversation_tree` command's shape) with a
// fixed clock, so every state is deterministic.
// Run: node tests/test-conversation-tree.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const file of ["app/conversation-tree-graph.js", "app/conversation-tree.js"]) {
  vm.runInContext(readFileSync(join(root, "src", file), "utf8"), ctx, { filename: file });
}
const { buildModel } = ctx.OMP_CONV_TREE;

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

// ── builders ───────────────────────────────────────────────────────────────
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-03T10:00:00Z");
const CUR = "s/2026-10-03T10-00-00-000Z_cur.jsonl";
const FB = "s/2026-10-03T11-00-00-000Z_b.jsonl";
const FD = "s/2026-10-03T12-00-00-000Z_d.jsonl";
const FX = "s/2026-10-03T13-00-00-000Z_x.jsonl";

const entry = (o) => ({
  ts: null, at: null, text: null, agent: false, usage: null,
  firstKeptId: null, firstKeptExact: false, label: null, inCurrent: true, ...o,
});
const usage = (o = {}) => ({
  input: 0, output: 10, cacheRead: 0, cacheWrite: 0, ttl: 3600, costRead: null, costWrite: null, ...o,
});
// A request whose context is `prefix` tokens: the first prompt writes it all,
// later ones read all but 100 new tokens. Reads cost $1/M, writes $4/M.
function rq(prefix, o = {}) {
  const cacheRead = prefix > 1100 ? prefix - 100 : 0;
  const cacheWrite = prefix - cacheRead;
  return usage({ cacheRead, cacheWrite, costRead: cacheRead * 1e-6, costWrite: cacheWrite * 4e-6, ...o });
}
const HEAD = 1100; // smallest cacheRead > 0 in `convo`
const user = (id, parentId, ts, text = id, o = {}) => entry({ id, parentId, kind: "user", ts, text, ...o });
const asst = (id, parentId, ts, u = rq(1100), o = {}) =>
  entry({ id, parentId, kind: "assistant", ts, usage: u, text: `reply ${id}`, ...o });
const file = (path, leafId, current = false, title = null) => ({
  path, cwd: null, title, leafId, current,
});
const iso = (ms) => new Date(ms).toISOString();
const lin = (entries, leaf) => ({ files: [file(CUR, leaf, true)], entries });

/** n prompts p1…pn on one path, each answered by a1…an one second later. */
function convo(n, { at = (i) => (i - 1) * 20 * MIN, ...o } = {}) {
  const out = [];
  let parent = null;
  for (let i = 1; i <= n; i++) {
    const t = T0 + at(i);
    out.push(user(`p${i}`, parent, t), asst(`a${i}`, `p${i}`, t + SEC, rq(1000 + 100 * i, o)));
    parent = `a${i}`;
  }
  return out;
}

/** p1 → two sibling re-asks p2 (current file) and p2b (file B); optionally
 *  p2c (a third branch inside the current file) and p3b (file D continues B). */
function branchy({ c = false, d = false } = {}) {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + 20 * MIN), asst("a2", "p2", T0 + 20 * MIN + SEC, rq(1300)),
    user("p2b", "a1", T0 + 50 * MIN, "p2b", { inCurrent: false }),
    asst("a2b", "p2b", T0 + 50 * MIN + SEC, rq(1300), { inCurrent: false }),
  ];
  const files = [file(CUR, "a2", true, "Main"), file(FB, "a2b", false, "Side")];
  if (c) e.push(user("p2c", "a1", T0 + 30 * MIN), asst("a2c", "p2c", T0 + 30 * MIN + SEC, rq(1300)));
  if (d) {
    e.push(
      user("p3b", "a2b", T0 + 60 * MIN, "p3b", { inCurrent: false }),
      asst("a3b", "p3b", T0 + 60 * MIN + SEC, rq(1500), { inCurrent: false }),
    );
    files.push(file(FD, "a3b"));
  }
  return { files, entries: e };
}

// The model is built inside the vm context: round-trip it so deepEqual compares plain objects.
const model = (tree, now, since) => JSON.parse(JSON.stringify(buildModel(tree, { now, since })));
const row = (m, id) => m.rows.find((r) => r.id === id);
const states = (m) => m.rows.filter((r) => r.kind === "prompt").map((r) => r.state);
const segs = (r, part) => r.graph.segments.filter((s) => s.part === part);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

// ── expiry along a linear path ────────────────────────────────────────────
const lin3 = lin(convo(3), "a3");
const U = (i) => T0 + (i - 1) * 20 * MIN + SEC + HOUR; // when prompt i's prefix expires

check("a linear path's points expire one by one", () => {
  assert.deepEqual(states(model(lin3, T0 + 45 * MIN)), ["warm", "warm", "warm"]);
  assert.deepEqual(states(model(lin3, U(1) - 5 * MIN)), ["expiring", "warm", "warm"]);
  assert.deepEqual(states(model(lin3, U(2) - 5 * MIN)), ["cold", "expiring", "warm"]);
  assert.deepEqual(states(model(lin3, U(2))), ["cold", "cold", "warm"]);
  const m = model(lin3, U(3));
  assert.deepEqual(states(m), ["cold", "cold", "cold"]);
  assert.deepEqual(m.counts, { warm: 0, expiring: 0, partial: 0, cold: 3, unknown: 0, total: 3 });
});

check("exactly ten minutes left is expiring, one millisecond more is warm", () => {
  assert.equal(row(model(lin3, U(1) - 10 * MIN), "p1").state, "expiring");
  assert.equal(row(model(lin3, U(1) - 10 * MIN - 1), "p1").state, "warm");
});

check("exactly at `until` the prefix is no longer cached", () => {
  assert.equal(row(model(lin3, U(1) - 1), "p1").state, "expiring");
  const p1 = row(model(lin3, U(1)), "p1");
  assert.equal(p1.state, "cold");
  assert.equal(p1.until, U(1)); // for a cold row: when it expired
});

check("counts tally the states of the prompt rows", () => {
  const m = model(lin3, U(2) - 5 * MIN);
  assert.deepEqual(m.counts, { warm: 1, expiring: 1, partial: 0, cold: 1, unknown: 0, total: 3 });
  assert.equal(m.rows.length, 3);
  assert.equal(m.ttlMs, HOUR);
});

check("a cold row still reads the head while the tab's cache is alive, and writes the rest", () => {
  const p2 = row(model(lin3, U(2)), "p2"); // a3 (newest request) is still within its TTL
  assert.equal(p2.prefixTokens, 1110);
  assert.equal(p2.readTokens, HEAD);
  assert.equal(p2.writeTokens, 1110 - HEAD);
});

check("headLive off: once nothing ran within the TTL a cold row reads nothing", () => {
  const p2 = row(model(lin3, U(3)), "p2");
  assert.equal(p2.state, "cold");
  assert.equal(p2.readTokens, 0);
  assert.equal(p2.writeTokens, 1110);
  // coldPrice is always "after expiry, tools/system still cached"
  near(p2.price, 1110 * 4e-6);
  near(p2.coldPrice, HEAD * 1e-6 + 10 * 4e-6);
});

check("warm rows read their whole prefix", () => {
  const p3 = row(model(lin3, U(1)), "p3");
  assert.equal(p3.readTokens, p3.prefixTokens);
  assert.equal(p3.writeTokens, 0);
});

// ── prices ────────────────────────────────────────────────────────────────
check("prices use the $/token rates of the newest request that has them", () => {
  const m = model(lin3, U(2) - 5 * MIN); // p1 cold, p2 expiring, p3 warm
  near(m.rates.read, 1e-6);
  near(m.rates.write, 4e-6);
  near(row(m, "p2").price, 1110 * 1e-6);
  near(row(m, "p1").price, HEAD * 1e-6); // cold, head alive: reads the head, writes 0
  near(row(m, "p3").coldPrice, HEAD * 1e-6 + 110 * 4e-6);
  // What a cold re-ask writes: the prefix past the head, not the price over the write rate.
  assert.equal(row(m, "p3").coldWriteTokens, 110);
  assert.equal(row(m, "p1").coldWriteTokens, 0);
});

check("isLive / isCached group the states", () => {
  const { isLive, isCached } = ctx.OMP_CONV_TREE;
  assert.deepEqual(["warm", "expiring", "partial", "cold", "unknown"].map(isLive), [true, true, false, false, false]);
  assert.deepEqual(["warm", "expiring", "partial", "cold", "unknown"].map(isCached), [true, true, true, false, false]);
});

check("without rates there are no prices, but the states stay", () => {
  const t = lin(convo(3, { costRead: null, costWrite: null }), "a3");
  const m = model(t, U(2) - 5 * MIN);
  assert.equal(m.rates, null);
  assert.deepEqual(states(m), ["cold", "expiring", "warm"]);
  for (const r of m.rows) {
    assert.equal(r.price, null);
    assert.equal(r.coldPrice, null);
  }
  assert.equal(m.tips[0].price, null);
});

check("only one of the two rates known means no rates", () => {
  const e = convo(3);
  for (const x of e) if (x.usage) x.usage.costWrite = null;
  assert.equal(model(lin(e, "a3"), U(1)).rates, null);
});

// ── unknown ttl ───────────────────────────────────────────────────────────
check("without a cache lifetime every row is unknown and priceless", () => {
  const m = model(lin(convo(3, { ttl: null }), "a3"), U(1));
  assert.equal(m.ttlMs, null);
  assert.deepEqual(states(m), ["unknown", "unknown", "unknown"]);
  assert.deepEqual(m.counts, { warm: 0, expiring: 0, partial: 0, cold: 0, unknown: 3, total: 3 });
  for (const r of m.rows) {
    assert.equal(r.until, null);
    assert.equal(r.price, null);
    assert.equal(r.coldPrice, null);
    assert.equal(r.readTokens, null);
  }
  assert.equal(m.tips[0].state, "unknown");
  assert.equal(m.tips[0].until, null);
  assert.equal(m.rows[1].graph.segments[0].state, "unknown");
});

check("the ttl comes from the newest request that has one, on the current path first", () => {
  const a = convo(2);
  a[1].usage.ttl = 300; // a1: 5 minutes
  assert.equal(model(lin(a, "a2"), U(1)).ttlMs, HOUR); // a2 is newer
  const b = convo(2);
  b[1].usage.ttl = 300;
  b[3].usage.ttl = null; // a2 reports none → a1's
  assert.equal(model(lin(b, "a2"), U(1)).ttlMs, 5 * MIN);
  const t = branchy();
  for (const e of t.entries) if (e.usage) e.usage.ttl = e.id === "a2b" ? 300 : null;
  assert.equal(model(t, T0).ttlMs, 5 * MIN); // nothing on the current path: whole tree
});

// ── siblings and forks ────────────────────────────────────────────────────
check("a sibling re-ask refreshes the prefix of its siblings", () => {
  const now = T0 + 90 * MIN;
  const m = model(branchy(), now);
  const p2 = row(m, "p2");
  assert.equal(p2.state, "warm"); // p2b read the same prefix at 50 min
  assert.equal(p2.until, T0 + 50 * MIN + SEC + HOUR);
  assert.equal(row(m, "p2b").until, p2.until);
  const alone = branchy();
  alone.entries = alone.entries.filter((e) => !e.id.includes("2b"));
  alone.files.pop();
  const lone = row(model(alone, now), "p2");
  assert.equal(lone.state, "cold");
  assert.equal(lone.until, T0 + 20 * MIN + SEC + HOUR);
});

check("a turn's reply and fork point follow the current path, else the newest tip", () => {
  // p's turn: a1x → a1y → p2 on the current file; a fork file left at a1x and went on with q.
  const e = [
    user("p", null, T0), asst("a1x", "p", T0 + SEC, rq(1100), { text: "looking" }),
    asst("a1y", "a1x", T0 + 5 * SEC, rq(1100), { text: "final" }),
    user("p2", "a1y", T0 + 10 * MIN), asst("a2", "p2", T0 + 10 * MIN + SEC, rq(1300)),
    user("q", "a1x", T0 + 30 * MIN, "q", { inCurrent: false }),
    asst("aq", "q", T0 + 30 * MIN + SEC, rq(1300), { inCurrent: false }),
  ];
  const files = [file(CUR, "a2", true), file(FB, "aq")];
  const now = T0 + 40 * MIN;
  const m = model({ files, entries: e }, now);
  assert.equal(row(m, "p").reply, "final");
  assert.equal(row(m, "p").forkEntryId, "a1y");
  assert.equal(row(m, "q").openFile, FB);
  assert.equal(row(m, "q").inCurrent, false);
  assert.equal(row(m, "q").onCurrentPath, false);
  // q's parent is a1x, not a1y: p2 does not refresh it
  assert.equal(row(m, "q").until, T0 + 30 * MIN + SEC + HOUR);
  assert.equal(row(m, "p2").until, T0 + 10 * MIN + SEC + HOUR);
  // no current file: the turn is followed toward the newest tip, which is q
  const none = model({ files: [file(FB, "aq")], entries: e }, now);
  assert.equal(row(none, "p").forkEntryId, "a1x");
  assert.equal(row(none, "p").reply, "looking");
});

check("regenerated replies: the reply on the current path wins, else the newest", () => {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100), { text: "old reply" }),
    asst("a1r", "p1", T0 + 10 * MIN, rq(1100), { text: "new reply", inCurrent: false }),
  ];
  const withCur = model({ files: [file(CUR, "a1", true), file(FB, "a1r")], entries: e }, T0 + 20 * MIN);
  assert.equal(row(withCur, "p1").reply, "old reply");
  assert.equal(row(withCur, "p1").forkEntryId, "a1");
  assert.equal(row(withCur, "p1").until, T0 + SEC + HOUR); // the earliest request, across branches
  const none = model({ files: [file(FB, "a1r")], entries: e }, T0 + 20 * MIN);
  assert.equal(row(none, "p1").reply, "new reply");
  assert.equal(row(none, "p1").forkEntryId, "a1r");
});

// ── anchors ───────────────────────────────────────────────────────────────
// 17 prompts: p1…p16 a minute apart, p17 an hour in. p15 is the anchor; every
// later request on the path refreshed it, so it outlives p16's own prefix.
const anchored = lin(convo(17, { at: (i) => (i <= 16 ? i * MIN : 60 * MIN) }), "a17");
const ANCHOR_UNTIL = T0 + 60 * MIN + SEC + HOUR;

check("a cold row reads up to a live earlier anchor (partial)", () => {
  const m = model(anchored, T0 + 90 * MIN);
  const p16 = row(m, "p16");
  assert.equal(p16.state, "partial");
  assert.equal(p16.anchorOrdinal, 15);
  assert.equal(p16.prefixTokens, 2510); // a15's context: 2500 + its 10 output tokens
  assert.equal(p16.readTokens, 2500); // p15's through-anchor size
  assert.equal(p16.writeTokens, 10);
  assert.equal(p16.until, ANCHOR_UNTIL);
  near(p16.price, 2500 * 1e-6 + 10 * 4e-6);
  assert.equal(row(m, "p17").state, "warm");
  assert.equal(m.counts.partial, 1);
  assert.equal(row(m, "p15").isAnchor, true);
  assert.equal(row(m, "p15").ordinal, 15);
  assert.equal(row(m, "p16").isAnchor, false);
  assert.equal(row(m, "p17").ordinal, 17);
});

check("rows before the first anchor, and the anchor itself, have nothing to fall back on", () => {
  const m = model(anchored, T0 + 90 * MIN);
  for (const id of ["p1", "p14", "p15"]) {
    const r = row(m, id);
    assert.equal(r.state, "cold", id);
    assert.equal(r.anchorOrdinal, null, id);
    assert.equal(r.readTokens, Math.min(HEAD, r.prefixTokens), id); // head only
  }
});

check("partial lasts until the anchor's touch expires; then cold", () => {
  assert.equal(row(model(anchored, ANCHOR_UNTIL - 1), "p16").state, "partial");
  const p16 = row(model(anchored, ANCHOR_UNTIL), "p16");
  assert.equal(p16.state, "cold");
  assert.equal(p16.readTokens, 0); // nothing ran within the TTL either
  assert.equal(p16.writeTokens, 2510);
});

// ── compaction ────────────────────────────────────────────────────────────
function compacted(firstKeptId, exact) {
  const e = convo(16, { at: (i) => i * MIN });
  e.push(
    entry({ id: "c1", parentId: "a16", kind: "compaction", at: iso(T0 + 17 * MIN), firstKeptId, firstKeptExact: exact }),
    user("q", "c1", T0 + 18 * MIN), asst("aq", "q", T0 + 18 * MIN + SEC, rq(1300)),
  );
  return lin(e, "aq");
}

check("a compaction restarts the ordinals from the prompts it kept", () => {
  const ordinalOfQ = (kept, exact) => row(model(compacted(kept, exact), T0 + 30 * MIN), "q").ordinal;
  assert.equal(ordinalOfQ("p3", true), 15); // p3…p16 kept: 14 → q is 15th
  assert.equal(ordinalOfQ("p4", true), 14);
  assert.equal(ordinalOfQ("a2", false), 15); // first kept is after a2: p3…p16
  assert.equal(ordinalOfQ("a3", false), 14);
  assert.equal(ordinalOfQ(null, false), 1); // nothing kept
  const m = model(compacted("p3", true), T0 + 30 * MIN);
  assert.equal(row(m, "q").isAnchor, true);
  assert.equal(row(m, "p16").ordinal, 16); // earlier rows keep their own count
  assert.equal(row(m, "p15").isAnchor, true);
});

check("a compaction is a row between the prompts around it, on the path's lane", () => {
  const m = model(compacted("p3", true), T0 + 30 * MIN);
  const ids = m.rows.map((r) => r.id);
  assert.deepEqual(ids.slice(-3), ["p16", "c1", "q"]);
  const c = row(m, "c1");
  assert.equal(c.kind, "compaction");
  assert.equal(c.ts, T0 + 17 * MIN); // from the entry's ISO time
  assert.equal(c.graph.lane, 0);
  assert.deepEqual(c.graph.curves, []);
  assert.equal(m.counts.total, 17); // prompt rows only
  assert.equal(segs(c, "top")[0].state, segs(row(m, "p16"), "bottom")[0].state);
  assert.equal(segs(c, "bottom")[0].state, row(m, "q").state);
});

// ── prompts that are not rows ─────────────────────────────────────────────
check("agent-authored user entries are no rows but stay on the path", () => {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100), { text: "first" }),
    user("ua", "a1", T0 + 2 * SEC, "from a subagent", { agent: true }),
    asst("a1b", "ua", T0 + 5 * SEC, rq(1300), { text: "wrapped up" }),
    user("p2", "a1b", T0 + 10 * MIN), asst("a2", "p2", T0 + 10 * MIN + SEC, rq(1400)),
  ];
  const m = model(lin(e, "a2"), T0 + 20 * MIN);
  assert.deepEqual(m.rows.map((r) => r.id), ["p1", "p2"]);
  assert.equal(row(m, "p2").ordinal, 2); // the agent entry is not a conversational prompt
  assert.equal(row(m, "p1").reply, "wrapped up"); // its answer belongs to p1's turn
  assert.equal(row(m, "p1").forkEntryId, "a1b");
  assert.equal(row(m, "p1").prefixTokens, 1200); // first prompt: the head (smallest cacheRead of the tree)
  assert.equal(row(m, "p2").prefixTokens, 1300 + 10); // the context a1b left
  assert.equal(row(m, "p2").onCurrentPath, true);
  assert.equal(m.counts.total, 2);
});

check("rows sort by time, ties by tree order", () => {
  const e = [user("late", null, T0 + MIN), user("x", null, T0), user("y", null, T0)];
  assert.deepEqual(model(lin(e, "late"), T0).rows.map((r) => r.id), ["x", "y", "late"]);
});

// ── tips and files ────────────────────────────────────────────────────────
check("tips cover every file's leaf and every other leaf, with their cache state", () => {
  const m = model(branchy({ c: true, d: true }), T0 + 90 * MIN);
  assert.deepEqual(m.tips.map((t) => t.leafId), ["a2", "a2b", "a3b", "a2c"]);
  const [cur, side, deep, extra] = m.tips;
  assert.equal(cur.isCurrent, true);
  assert.equal(side.isCurrent, false);
  assert.deepEqual([cur.file, side.file, deep.file, extra.file], [CUR, FB, FD, CUR]);
  assert.deepEqual([cur.title, side.title], ["Main", "Side"]);
  assert.deepEqual(m.tips.map((t) => t.rowId), ["p2", "p2b", "p3b", "p2c"]);
  // touch = last request after the tip's own prompt
  assert.deepEqual(m.tips.map((t) => t.state), ["cold", "warm", "warm", "expiring"]);
  assert.equal(cur.until, T0 + 20 * MIN + SEC + HOUR);
  assert.equal(extra.until, T0 + 30 * MIN + SEC + HOUR);
  assert.equal(cur.tokens, 1200 + 100 + 10); // last assistant: input + cacheRead + cacheWrite + output
  near(side.price, 1310 * 1e-6);
  assert.deepEqual(row(m, "p2b").tipIndexes, [1]);
  assert.deepEqual(row(m, "p2").tipIndexes, [0]);
  assert.deepEqual(row(m, "p1").tipIndexes, []);
});

check("openFile names the newest family file holding a row that is not in the current one", () => {
  const m = model(branchy({ c: true, d: true }), T0 + 90 * MIN);
  assert.equal(row(m, "p2b").openFile, FD); // file B and file D both pass through p2b
  assert.equal(row(m, "p3b").openFile, FD);
  assert.equal(row(m, "p1").openFile, null);
  assert.equal(row(m, "p2c").openFile, null);
  const b = model(branchy(), T0 + 90 * MIN);
  assert.equal(row(b, "p2b").openFile, FB);
});

check("counts over a branched tree", () => {
  const m = model(branchy({ c: true, d: true }), T0 + 90 * MIN);
  assert.deepEqual(m.counts, { warm: 4, expiring: 0, partial: 0, cold: 1, unknown: 0, total: 5 });
});

check("a cache-warm entry refreshes its tip and keeps the head alive", () => {
  const warm = entry({ id: "w", parentId: "a2", kind: "warm", at: iso(T0 + 30 * MIN) }); // no `ts`: the ISO time counts
  const base = convo(2, { at: (i) => (i - 1) * 5 * MIN });
  const now = T0 + 70 * MIN;
  const cold = model(lin(base, "a2"), now);
  assert.equal(cold.tips[0].state, "cold");
  assert.equal(row(cold, "p2").readTokens, 0); // headLive off
  const m = model(lin([...base, warm], "w"), now);
  assert.equal(m.tips[0].leafId, "w");
  assert.equal(m.tips[0].state, "warm");
  assert.equal(m.tips[0].until, T0 + 30 * MIN + HOUR);
  assert.equal(row(m, "p2").state, "cold"); // a warm-up does not refresh older points
  assert.equal(row(m, "p2").readTokens, HEAD); // …but it keeps tools/system cached
});

check("a warm-up refreshes the anchor", () => {
  // p15 anchor; the warm entry is on its path, so p16's partial lasts until warm + ttl
  const e = convo(16, { at: (i) => i * MIN });
  const w = entry({ id: "w", parentId: "a16", kind: "warm", ts: T0 + 100 * MIN });
  const m = model(lin([...e, w], "w"), T0 + 150 * MIN);
  const p16 = row(m, "p16");
  assert.equal(p16.state, "partial");
  assert.equal(p16.until, T0 + 100 * MIN + HOUR);
});

// ── graph ─────────────────────────────────────────────────────────────────
check("lines take the state of the row they lead to", () => {
  const m = model(lin3, U(2) - 5 * MIN); // cold, expiring, warm
  const [p1, p2, p3] = ["p1", "p2", "p3"].map((id) => row(m, id));
  assert.equal(m.lanes, 1);
  assert.deepEqual(segs(p1, "bottom").map((s) => s.state), ["expiring"]);
  assert.deepEqual(segs(p1, "top"), []);
  assert.deepEqual(segs(p2, "top").map((s) => s.state), ["expiring"]);
  assert.deepEqual(segs(p2, "bottom").map((s) => s.state), ["warm"]);
  assert.deepEqual(segs(p3, "top").map((s) => s.state), ["warm"]);
  assert.deepEqual(segs(p3, "bottom"), []);
  for (const r of m.rows) assert.deepEqual(r.graph.curves, []);
});

check("one branch: lane 1, a curve out of its parent, a full line past rows in between", () => {
  const m = model(branchy(), T0 + 90 * MIN);
  assert.equal(m.lanes, 2);
  const [p1, p2, p2b] = ["p1", "p2", "p2b"].map((id) => row(m, id));
  assert.deepEqual([p1.graph.lane, p2.graph.lane, p2b.graph.lane], [0, 0, 1]);
  assert.deepEqual(p1.graph.curves, [{ fromLane: 0, toLane: 1, state: p2b.state }]);
  assert.deepEqual(segs(p1, "bottom"), [{ lane: 0, part: "bottom", state: p2.state }]);
  assert.deepEqual(segs(p2, "top"), [{ lane: 0, part: "top", state: p2.state }]);
  assert.deepEqual(segs(p2, "full"), [{ lane: 1, part: "full", state: p2b.state }]);
  assert.deepEqual(segs(p2b, "top"), [{ lane: 1, part: "top", state: p2b.state }]);
  assert.deepEqual(p2b.graph.curves, []);
  assert.equal(p2b.onCurrentPath, false);
  assert.equal(p2.onCurrentPath, true);
});

check("branches take the lowest lane free over their span", () => {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC),
    user("p2", "a1", T0 + 5 * MIN), asst("a2", "p2", T0 + 5 * MIN + SEC),
    user("x1", "a1", T0 + 10 * MIN, "x1", { inCurrent: false }), asst("ax", "x1", T0 + 10 * MIN + SEC, rq(1100), { inCurrent: false }),
    user("p3", "a2", T0 + 20 * MIN), asst("a3", "p3", T0 + 20 * MIN + SEC),
    user("y1", "a3", T0 + 30 * MIN, "y1", { inCurrent: false }), asst("ay", "y1", T0 + 30 * MIN + SEC, rq(1100), { inCurrent: false }),
  ];
  const files = [file(CUR, "a3", true), file(FX, "ax"), file(FB, "ay")];
  const m = model({ files, entries: e }, T0 + 40 * MIN);
  const lane = (id) => row(m, id).graph.lane;
  assert.deepEqual(m.rows.map((r) => r.id), ["p1", "p2", "x1", "p3", "y1"]);
  assert.deepEqual(["p1", "p2", "p3"].map(lane), [0, 0, 0]);
  assert.equal(lane("x1"), 1);
  assert.equal(lane("y1"), 1); // x1's branch is over before y1's starts
  assert.equal(m.lanes, 2);
  assert.deepEqual(row(m, "p3").graph.curves, [{ fromLane: 0, toLane: 1, state: row(m, "y1").state }]);
  const x1 = row(m, "x1");
  assert.deepEqual(segs(x1, "full").map((s) => s.lane), [0]); // the current path passes x1's row
  assert.deepEqual(segs(x1, "top").map((s) => s.lane), [1]);
});

check("overlapping branches get separate lanes", () => {
  const m = model(branchy({ c: true, d: true }), T0 + 90 * MIN);
  const lane = (id) => row(m, id).graph.lane;
  assert.deepEqual(["p1", "p2"].map(lane), [0, 0]);
  assert.equal(lane("p2b"), 1);
  assert.equal(lane("p3b"), 1); // same branch: continues p2b
  assert.equal(lane("p2c"), 2);
  assert.equal(m.lanes, 3);
});

check("an empty tree has no rows, lanes or tips", () => {
  const m = model({ files: [file(CUR, null, true)], entries: [] }, T0);
  assert.deepEqual(m.rows, []);
  assert.equal(m.lanes, 0);
  assert.deepEqual(m.tips, []);
  assert.equal(m.counts.total, 0);
  assert.equal(m.rates, null);
  assert.equal(m.ttlMs, null);
});

// ── prefix before the prompt ──────────────────────────────────────────────
check("a prompt's prefix is the context before it: the last reply, or the head for the first prompt", () => {
  const m = model(lin3, U(1));
  assert.equal(row(m, "p1").prefixTokens, HEAD);
  assert.equal(row(m, "p2").prefixTokens, 1000 + 100 + 10); // a1: input + cacheRead + cacheWrite + output
  assert.equal(row(m, "p3").prefixTokens, 1000 + 200 + 10);
  // re-asking replaces the prompt's own text: the request that answered it was bigger
  assert.ok(row(m, "p3").prefixTokens < 1300);
});

check("the prefix follows the row's own path, and a compaction cuts it off", () => {
  const f = model(branchy(), T0 + 90 * MIN);
  assert.equal(row(f, "p2b").prefixTokens, row(f, "p2").prefixTokens); // siblings share their parent's context
  const c = model(compacted("p3", true), T0 + 30 * MIN);
  // no request before q in its epoch: its own first request (aq, 1300 tokens) stands in, not the head
  assert.equal(row(c, "q").prefixTokens, 1300);
  const noReply = compacted("p3", true);
  noReply.entries = noReply.entries.filter((e) => e.id !== "aq");
  noReply.files[0].leafId = "q";
  assert.equal(row(model(noReply, T0 + 30 * MIN), "q").prefixTokens, HEAD); // no request at all: the head
  assert.equal(row(c, "p16").prefixTokens, 1000 + 1500 + 10);
});

check("an anchor as large as the row's prefix does not make it partial", () => {
  const e = convo(17, { at: (i) => (i <= 16 ? i * MIN : 60 * MIN) });
  e.find((x) => x.id === "a15").usage.output = 0; // p16's prefix is now exactly p15's through-anchor size
  const p16 = row(model(lin(e, "a17"), T0 + 90 * MIN), "p16");
  assert.equal(p16.prefixTokens, 2500);
  assert.equal(p16.state, "cold");
  const f = convo(17, { at: (i) => (i <= 16 ? i * MIN : 60 * MIN) });
  f.find((x) => x.id === "a15").usage.output = 1; // one token more: partial
  assert.equal(row(model(lin(f, "a17"), T0 + 90 * MIN), "p16").state, "partial");
});

// ── process boundary ──────────────────────────────────────────────────────
check("without `since` nothing is stale", () => {
  const m = model(lin3, U(1) - 5 * MIN);
  assert.deepEqual(m.rows.map((r) => r.staleProcess), [false, false, false]);
  assert.deepEqual(m.tips.map((t) => t.staleProcess), [false]);
  assert.deepEqual(model(lin3, U(1) - 5 * MIN), JSON.parse(JSON.stringify(buildModel(lin3, { now: U(1) - 5 * MIN, since: undefined }))));
});

check("requests before `since` stop counting as touches, but the head stays alive", () => {
  const now = U(1) - 5 * MIN; // without `since`: expiring, warm, warm
  const since = T0 + 30 * MIN; // only a3 (40 min) ran in this process
  const m = model(lin3, now, since);
  assert.deepEqual(states(m), ["cold", "cold", "warm"]);
  assert.deepEqual(m.rows.map((r) => r.staleProcess), [true, true, false]);
  assert.equal(m.tips[0].state, "warm"); // a3 is after `since`
  assert.equal(m.tips[0].staleProcess, false);
  assert.deepEqual(m.counts, { warm: 1, expiring: 0, partial: 0, cold: 2, unknown: 0, total: 3 });
  // the head is cached across processes: a cold row still reads it, and the price follows
  const p2 = row(m, "p2");
  assert.equal(p2.readTokens, HEAD);
  assert.equal(p2.writeTokens, p2.prefixTokens - HEAD);
  near(p2.price, HEAD * 1e-6 + (p2.prefixTokens - HEAD) * 4e-6);
  assert.equal(segs(row(m, "p1"), "bottom")[0].state, "cold"); // lines follow the new states
});

check("`since` is inclusive", () => {
  const now = U(1) - 5 * MIN;
  assert.equal(row(model(lin3, now, T0 + SEC), "p1").state, "expiring"); // a1 ran at exactly `since`
  const p1 = row(model(lin3, now, T0 + SEC + 1), "p1");
  assert.equal(p1.state, "cold");
  assert.equal(p1.staleProcess, true);
});

check("a tip touched only before `since` is cold and stale", () => {
  const m = model(branchy(), T0 + 55 * MIN, T0 + 30 * MIN);
  const [cur, side] = m.tips;
  assert.equal(cur.state, "cold"); // a2 ran at 20 min
  assert.equal(cur.staleProcess, true);
  assert.equal(side.state, "warm"); // a2b ran at 50 min
  assert.equal(side.staleProcess, false);
});

check("a sibling's re-ask after `since` still refreshes the prefix", () => {
  const warm = row(model(branchy(), T0 + 90 * MIN, T0 + 30 * MIN), "p2"); // p2b ran at 50 min
  assert.equal(warm.state, "warm");
  assert.equal(warm.staleProcess, false);
  const cold = row(model(branchy(), T0 + 90 * MIN, T0 + 55 * MIN), "p2");
  assert.equal(cold.state, "cold");
  assert.equal(cold.staleProcess, true);
});

check("`since` also cuts the anchor's touches; a partial row that stays partial is not stale", () => {
  const now = T0 + 90 * MIN;
  const kept = row(model(anchored, now, T0 + 30 * MIN), "p16"); // a17 (60 min) refreshes the anchor
  assert.equal(kept.state, "partial");
  assert.equal(kept.staleProcess, false);
  const m = model(anchored, now, T0 + 61 * MIN);
  const p16 = row(m, "p16");
  assert.equal(p16.state, "cold");
  assert.equal(p16.staleProcess, true);
  assert.equal(p16.readTokens, HEAD); // a17 still keeps the head alive
  assert.equal(row(m, "p17").staleProcess, true);
  assert.equal(row(m, "p1").staleProcess, false); // cold before and after
});

check("unknown ttl is never stale", () => {
  const m = model(lin(convo(3, { ttl: null }), "a3"), U(1), T0 + 50 * MIN);
  assert.deepEqual(m.rows.map((r) => r.staleProcess), [false, false, false]);
  assert.deepEqual(states(m), ["unknown", "unknown", "unknown"]);
});

// ── zero-usage replies ────────────────────────────────────────────────────
// An aborted or failed reply is saved with all-zero usage: it reports no context.
const zeroUsage = () => usage({ output: 0 });

check("a zero-usage reply is not a sizing source: the prefix falls back to the last real request", () => {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(20000)),
    user("p2", "a1", T0 + 10 * MIN), asst("ab", "p2", T0 + 10 * MIN + SEC, zeroUsage()),
    user("p3", "ab", T0 + 20 * MIN), asst("a3", "p3", T0 + 20 * MIN + SEC, rq(20300)),
  ];
  const m = model(lin(e, "a3"), T0 + 30 * MIN);
  assert.equal(row(m, "p3").prefixTokens, 20010); // a1's context, not 0
  assert.equal(row(m, "p2").prefixTokens, 20010);
  assert.equal(m.tips[0].tokens, 20310);
  // a leaf that is the zero-usage reply is sized by the request before it
  const aborted = model(lin(e.slice(0, 4), "ab"), T0 + 30 * MIN);
  assert.equal(aborted.tips[0].tokens, 20010);
  assert.ok(aborted.tips[0].price > 0);
});

check("a prompt answered only by a zero-usage reply has no first request to touch its prefix", () => {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + MIN), asst("ab", "p2", T0 + MIN + SEC, zeroUsage()),
    asst("a2", "ab", T0 + 5 * MIN, rq(1300)),
  ];
  const p2 = row(model(lin(e, "a2"), T0 + 10 * MIN), "p2");
  assert.equal(p2.state, "warm");
  assert.equal(p2.until, T0 + 5 * MIN + HOUR); // the first request that reported usage, not the aborted one
  const only = row(model(lin(e.slice(0, 4), "ab"), T0 + 10 * MIN), "p2");
  assert.equal(only.state, "cold");
  assert.equal(only.until, null);
});

check("a zero-usage reply on an anchor prompt does not shrink anchorTokens to 0", () => {
  const e = convo(17, { at: (i) => (i <= 16 ? i * MIN : 60 * MIN) });
  const a15 = e.find((x) => x.id === "a15");
  const ab = asst("ab15", "p15", T0 + 15 * MIN + 500, zeroUsage());
  const ok = [...e.slice(0, e.indexOf(a15)), ab, ...e.slice(e.indexOf(a15))]; // ab first, a15 stays the real answer
  const m = model(lin(ok, "a17"), T0 + 90 * MIN);
  assert.equal(row(m, "p16").state, "partial");
  assert.equal(row(m, "p16").readTokens, 2500);
});

// ── tips continue like a new prompt from the leaf ─────────────────────────
check("a tip is refreshed by the first request of a prompt asked from its leaf (branch)", () => {
  // branched at p2: the tab is at a1, p2 (file B) was asked 5 minutes ago
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + 2 * HOUR, "p2", { inCurrent: false }),
    asst("a2", "p2", T0 + 2 * HOUR + SEC, rq(1300), { inCurrent: false }),
  ];
  const files = [file(CUR, "a1", true), file(FB, "a2")];
  const now = T0 + 2 * HOUR + 5 * MIN;
  const m = model({ files, entries: e }, now);
  assert.equal(m.tips[0].leafId, "a1");
  assert.equal(m.tips[0].state, "warm");
  assert.equal(m.tips[0].until, T0 + 2 * HOUR + SEC + HOUR);
  const alone = model({ files: [file(CUR, "a1", true)], entries: e.slice(0, 2) }, now);
  assert.equal(alone.tips[0].state, "cold");
  // …but not once the process changed after that request
  const stale = model({ files, entries: e }, now, T0 + 2 * HOUR + MIN);
  assert.equal(stale.tips[0].state, "cold");
  assert.equal(stale.tips[0].staleProcess, true);
});

check("a fork point is refreshed by the prompt asked after it", () => {
  // forked at a2 after p3 was asked from a2
  const e = convo(3, { at: (i) => (i === 3 ? 2 * HOUR : (i - 1) * MIN) });
  const now = 2 * HOUR + T0 + 5 * MIN;
  const m = model(lin(e, "a2"), now);
  assert.equal(m.tips[0].leafId, "a2");
  assert.equal(m.tips[0].state, "warm");
  assert.equal(m.tips[0].until, T0 + 2 * HOUR + SEC + HOUR);
});

check("a cache-warm entry refreshes the rows asked from the node it warmed", () => {
  // omp layout: the warm-up w is the leaf, so the next prompt (p2b, not answered yet) hangs under w
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + 20 * MIN), asst("a2", "p2", T0 + 20 * MIN + SEC, rq(1300)),
    entry({ id: "w", parentId: "a1", kind: "warm", ts: T0 + 2 * HOUR, inCurrent: false }),
    user("p2b", "w", T0 + 2 * HOUR + MIN, "p2b", { inCurrent: false }),
  ];
  const files = [file(CUR, "a2", true), file(FB, "p2b")];
  const now = T0 + 2 * HOUR + 5 * MIN;
  const m = model({ files, entries: e }, now);
  assert.equal(row(m, "p2").state, "warm");
  assert.equal(row(m, "p2").until, T0 + 3 * HOUR);
  assert.equal(row(m, "p2b").state, "warm"); // same context key as p2
  const without = model({ files: [file(CUR, "a2", true)], entries: e.slice(0, 4) }, now);
  assert.equal(row(without, "p2").state, "cold");
  const stale = row(model({ files, entries: e }, now, T0 + 2 * HOUR + MIN), "p2");
  assert.equal(stale.state, "cold");
  assert.equal(stale.staleProcess, true);
});

// ── tips after a compaction ───────────────────────────────────────────────
check("requests before a compaction do not keep a tip after it cached", () => {
  const base = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + 10 * MIN), asst("a2", "p2", T0 + 10 * MIN + SEC, rq(1300)),
  ];
  const c = entry({ id: "c", parentId: "a2", kind: "compaction", at: iso(T0 + 12 * MIN), firstKeptId: "p2", firstKeptExact: true });
  const now = T0 + 15 * MIN;
  assert.equal(model(lin(base, "a2"), now).tips[0].state, "warm"); // control: no compaction
  const m = model(lin([...base, c], "c"), now);
  assert.equal(m.tips[0].leafId, "c");
  assert.equal(m.tips[0].state, "cold");
  assert.equal(m.tips[0].until, null);
  // a prompt after it with no request yet: still cold
  const q = user("q", "c", T0 + 13 * MIN);
  assert.equal(model(lin([...base, c, q], "q"), now).tips[0].state, "cold");
  // once it is answered, the tip is warm again
  const aq = asst("aq", "q", T0 + 13 * MIN + SEC, rq(1400));
  const done = model(lin([...base, c, q, aq], "aq"), now);
  assert.equal(done.tips[0].state, "warm");
  assert.equal(done.tips[0].until, T0 + 13 * MIN + SEC + HOUR);
});

// ── round-2 review fixes ──────────────────────────────────────────────────
check("rows and tips agree on what a touch is: a zero-usage reply is none", () => {
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + 10 * MIN), asst("ab", "p2", T0 + 10 * MIN + SEC, zeroUsage()),
  ];
  const m = model(lin(e, "ab"), T0 + 30 * MIN);
  assert.equal(row(m, "p2").state, "cold");
  assert.equal(m.tips[0].leafId, "ab");
  assert.equal(m.tips[0].state, "cold");
  assert.equal(m.tips[0].until, null);
  // …and it does not keep the tab's head alive either: a1 expired at 60 min, ab would have lasted to 70
  const late = model(lin(e, "ab"), T0 + 65 * MIN);
  assert.equal(row(late, "p2").readTokens, 0);
});

check("a prompt asked after a warm-up counts under the node that was warmed", () => {
  // omp makes the warm-up the leaf: p3's parent is w, and w itself warmed a2. ttl 5 minutes.
  const q = { ttl: 300 };
  const e = [
    user("p2", null, T0), asst("a2", "p2", T0 + SEC, rq(1100, q)),
    entry({ id: "w", parentId: "a2", kind: "warm", ts: T0 + 4.5 * MIN, inCurrent: false }),
    user("p3", "w", T0 + 6 * MIN, "p3", { inCurrent: false }),
    asst("a3", "p3", T0 + 6 * MIN + SEC, rq(1300, q), { inCurrent: false }),
  ];
  const files = [file(CUR, "a2", true), file(FB, "a3")]; // the tab forked at a2
  const m = model({ files, entries: e }, T0 + 10 * MIN);
  assert.equal(row(m, "p3").state, "expiring");
  assert.equal(row(m, "p3").until, T0 + 6 * MIN + SEC + 5 * MIN);
  const fork = m.tips.find((t) => t.leafId === "a2");
  assert.equal(fork.state, "expiring"); // the fork point is refreshed by the same re-ask
  assert.equal(fork.until, row(m, "p3").until);
  // the warm-up alone (p3 unanswered) is stale by now
  const unanswered = model({ files, entries: e.slice(0, 4) }, T0 + 10 * MIN);
  assert.equal(unanswered.tips.find((t) => t.leafId === "a2").state, "cold");
  assert.equal(row(unanswered, "p3").state, "cold");
});

check("a reply after a compaction does not make the prompt before it warm", () => {
  // overflow recovery: compaction c is appended under p2, then the post-compaction reply a2
  const head = [user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)), user("p2", "a1", T0 + MIN)];
  const c = entry({ id: "c", parentId: "p2", kind: "compaction", at: iso(T0 + 2 * MIN), firstKeptId: "p2", firstKeptExact: true });
  const a2 = asst("a2", "c", T0 + 3 * MIN, rq(1500));
  const now = T0 + 5 * MIN;
  const m = model(lin([...head, c, a2], "a2"), now);
  assert.equal(row(m, "p2").state, "cold");
  assert.equal(row(m, "p2").until, null);
  assert.equal(row(m, "p2").prefixTokens, 1110); // the uncompacted context a1 left
  const plain = model(lin([...head, asst("a2", "p2", T0 + 3 * MIN, rq(1500))], "a2"), now);
  assert.equal(row(plain, "p2").state, "warm"); // control: the same reply without a compaction
});

check("a compaction renders above the prompt sent after it, even if the prompt's ts is older", () => {
  // omp stamps a prompt when it is submitted, then compacts before sending it
  const e = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    entry({ id: "c", parentId: "a1", kind: "compaction", at: iso(T0 + 12 * MIN), firstKeptId: "p1", firstKeptExact: true }),
    user("q", "c", T0 + 11 * MIN), asst("aq", "q", T0 + 13 * MIN, rq(1300)),
  ];
  const m = model(lin(e, "aq"), T0 + 20 * MIN);
  assert.deepEqual(m.rows.map((r) => r.id), ["p1", "c", "q"]);
  assert.equal(row(m, "q").ts, T0 + 11 * MIN); // the displayed time is untouched
  const [p1, c, q] = ["p1", "c", "q"].map((id) => row(m, id));
  assert.deepEqual([p1.graph.lane, c.graph.lane, q.graph.lane], [0, 0, 0]);
  assert.deepEqual(segs(p1, "bottom"), [{ lane: 0, part: "bottom", state: q.state }]);
  assert.deepEqual(segs(c, "top"), [{ lane: 0, part: "top", state: q.state }]);
  assert.deepEqual(segs(c, "bottom"), [{ lane: 0, part: "bottom", state: q.state }]);
  assert.deepEqual(segs(q, "top"), [{ lane: 0, part: "top", state: q.state }]);
});

check("a tip at a compaction is sized like the prompts already asked from it", () => {
  const base = [
    user("p1", null, T0), asst("a1", "p1", T0 + SEC, rq(1100)),
    user("p2", "a1", T0 + 10 * MIN), asst("a2", "p2", T0 + 10 * MIN + SEC, rq(1300)),
    entry({ id: "c", parentId: "a2", kind: "compaction", at: iso(T0 + 12 * MIN), firstKeptId: "p2", firstKeptExact: true }),
  ];
  const q = [user("q", "c", T0 + 13 * MIN, "q", { inCurrent: false }), asst("aq", "q", T0 + 13 * MIN + SEC, rq(5000), { inCurrent: false })];
  const now = T0 + 20 * MIN;
  const withQ = model({ files: [file(CUR, "c", true), file(FB, "aq")], entries: [...base, ...q] }, now);
  const tip = withQ.tips.find((t) => t.leafId === "c");
  assert.equal(tip.tokens, 5000);
  assert.equal(tip.state, "warm"); // q's first reply read this very context
  near(tip.price, 5000 * 1e-6);
  assert.equal(row(withQ, "q").prefixTokens, 5000); // the row sizes the same way
  // nothing asked from it yet: the head
  const alone = model(lin(base, "c"), now);
  assert.equal(alone.tips[0].tokens, null);
  assert.equal(alone.tips[0].state, "cold");
  near(alone.tips[0].price, 1200 * 1e-6);
});

// ── head across branches ──────────────────────────────────────────────────
check("headLive counts requests on every branch, not only the current path", () => {
  // the tab sits at a2 (older point); a3, on another branch, ran 2 minutes ago with a 5 minute ttl
  const e = convo(3, { ttl: 300 });
  const files = [file(CUR, "a2", true), file(FB, "a3")];
  const m = model({ files, entries: e }, T0 + 42 * MIN);
  const p2 = row(m, "p2"); // touched at 20 min: cold
  assert.equal(p2.state, "cold");
  assert.equal(p2.readTokens, HEAD);
  const quiet = model({ files, entries: e }, T0 + 50 * MIN); // nothing ran within the ttl any more
  assert.equal(row(quiet, "p2").readTokens, 0);
});

console.log(`conversation-tree: ${passed} checks passed`);
