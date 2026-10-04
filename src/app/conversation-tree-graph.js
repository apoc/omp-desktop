// Conversation tree shape: the index over the `conversation_tree` command's
// merged entries (parents, children, positions, times, paths) and the
// git-style lane layout of the navigator's rows. No cache facts: the model
// (app/conversation-tree.js) decides the row order, the tips' order and the
// state each line is drawn in.
//
// Exposes `window.OMP_CONV_GRAPH`; IIFE per the project rule for plain
// <script> tags. Regression: test-conversation-tree.mjs (through buildModel).
(function () {
  "use strict";

  const finite = (v) => (Number.isFinite(v) ? v : null);
  const timeOf = (e) => finite(e.ts ?? Date.parse(e.at));

  /** Adjacency, positions and times of the merged entries. A parent that is
   *  missing, or does not precede its child, makes the child a root. */
  function indexTree(tree) {
    const entries = tree.entries ?? [];
    const byId = new Map();
    const pos = new Map();
    entries.forEach((e, i) => {
      byId.set(e.id, e);
      pos.set(e.id, i);
    });
    const par = new Map();
    const kids = new Map();
    const time = new Map();
    entries.forEach((e, i) => {
      const ok = e.parentId != null && pos.has(e.parentId) && pos.get(e.parentId) < i;
      par.set(e.id, ok ? e.parentId : null);
      time.set(e.id, timeOf(e));
      if (ok) {
        if (!kids.has(e.parentId)) kids.set(e.parentId, []);
        kids.get(e.parentId).push(e.id);
      }
    });
    const path = (id) => {
      const out = [];
      for (let c = id; c != null; c = par.get(c)) out.push(c);
      return out.reverse();
    };
    /** The context an entry's children continue: omp makes a warm-up the leaf,
     *  so the next prompt's parent is the warm entry, not the node it warmed. */
    const ctxKey = (id) => {
      let c = id;
      while (c != null && byId.get(c).kind === "warm") c = par.get(c);
      return c;
    };
    return { entries, byId, pos, par, kids, time, path, ctxKey, files: tree.files ?? [] };
  }

  /** Assigns every row a lane: the first tip's rows take lane 0, then each
   *  further tip puts its unplaced rows into the lowest lane free over the
   *  span from their parent row to their last row. */
  function assignLanes(index, tipRows, up) {
    const lane = new Map();
    const busy = [];
    for (const last of tipRows) {
      const chain = [];
      for (let c = last; c != null && !lane.has(c); c = up(c)) chain.push(c);
      if (!chain.length) continue;
      const parent = up(chain[chain.length - 1]);
      // Rows are ordered top-down along a path: the chain runs from the tip's
      // last row up, and its parent row sits above them all.
      const from = index.get(parent ?? chain[chain.length - 1]);
      const to = index.get(chain[0]);
      let l = lane.size === 0 ? 0 : 1;
      while ((busy[l] ?? []).some(([a, b]) => a <= to && from <= b)) l++;
      (busy[l] ??= []).push([from, to]);
      for (const id of chain) lane.set(id, l);
    }
    return lane;
  }

  /** Vertical lines and branch curves per row; each takes the state of the row
   *  it leads to. */
  function drawGraph(rows, index, lane, up, stateOf) {
    const graph = new Map(rows.map((r) => [r.id, { lane: lane.get(r.id) ?? 0, segments: [], curves: [] }]));
    rows.forEach((r, ci) => {
      const p = up(r.id);
      const pi = p == null ? -1 : index.get(p);
      if (pi < 0 || pi >= ci) return;
      const state = stateOf(r);
      const to = graph.get(r.id).lane;
      const from = graph.get(p).lane;
      graph.get(r.id).segments.push({ lane: to, part: "top", state });
      if (from === to) graph.get(p).segments.push({ lane: to, part: "bottom", state });
      else graph.get(p).curves.push({ fromLane: from, toLane: to, state });
      for (let k = pi + 1; k < ci; k++) graph.get(rows[k].id).segments.push({ lane: to, part: "full", state });
    });
    return graph;
  }

  /** The graph of `rows` (top-down; every row below the row above it on its
   *  path, `up(id)`). `tipRows`: each tip's last row (or null), in the order
   *  the tips claim lanes. `stateOf(row)`: the state of the lines leading to
   *  `row`. Returns each row's `{lane, segments, curves}` and the lane count. */
  function layout(rows, tipRows, up, stateOf) {
    const index = new Map(rows.map((r, i) => [r.id, i]));
    const graph = drawGraph(rows, index, assignLanes(index, tipRows, up), up, stateOf);
    let lanes = 0;
    for (const g of graph.values()) lanes = Math.max(lanes, g.lane + 1);
    return { graph, lanes };
  }

  window.OMP_CONV_GRAPH = { indexTree, layout };
})();
