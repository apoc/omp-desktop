#!/usr/bin/env node
// Regression script for src/app/backdrops.js and backdrops-{latent,orbit,
// neural,attention}.js — the start screens (the empty workspace's animated
// backdrops): the screen list, shared math and the pure rules of the
// latent-space, next-token, agent-loop, forward-pass and attention screens.
// Run: node tests/test-backdrops.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// Load order as in index.html: the screen files add to the base object.
for (const f of ["backdrops.js", "backdrops-latent.js", "backdrops-orbit.js", "backdrops-neural.js", "backdrops-attention.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, "src/app", f), "utf8"))(win);
}
const B = win.OMP_BACKDROPS;

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

/** Deterministic rand: mulberry32. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── screens ──

check("six screens, matrix first and the default", () => {
  assert.deepEqual(B.SCREENS.map(s => s.id), ["matrix", "latent", "sampling", "orbit", "neural", "attention"]);
  assert.equal(B.DEFAULT_SCREEN, "matrix");
  for (const s of B.SCREENS) assert.ok(s.label && s.blurb, s.id);
});

check("a stale or missing stored screen falls back to the default", () => {
  assert.equal(B.screenOf("orbit"), "orbit");
  assert.equal(B.screenOf("starfield"), "matrix");
  assert.equal(B.screenOf(undefined), "matrix");
  assert.equal(B.screenOf(null), "matrix");
});

// ── shared math ──

check("softmax sums to 1, keeps order, and temperature sharpens", () => {
  const logits = [2, 1, 0.5, -1];
  const p = B.softmax(logits, 1);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  for (let i = 1; i < p.length; i++) assert.ok(p[i - 1] > p[i]);
  assert.ok(B.softmax(logits, 0.3)[0] > p[0], "low temperature favours the top logit");
  assert.ok(B.softmax(logits, 5)[0] < p[0], "high temperature flattens");
  assert.deepEqual(B.softmax([1000, 1000], 1), [0.5, 0.5], "large logits don't overflow");
});

check("easeInOut and bezier hit their endpoints", () => {
  assert.equal(B.easeInOut(0), 0);
  assert.equal(B.easeInOut(1), 1);
  assert.equal(B.easeInOut(0.5), 0.5);
  const a = { x: 0, y: 0 }, c = { x: 50, y: 100 }, b = { x: 100, y: 0 };
  assert.deepEqual(B.bezier(a, c, b, 0), a);
  assert.deepEqual(B.bezier(a, c, b, 1), b);
  assert.deepEqual(B.bezier(a, c, b, 0.5), { x: 50, y: 50 });
});

// ── latent space ──

check("cloud: one blob per cluster, labels from its words, links stay in the cluster", () => {
  const { points, centres } = B.makeCloud(12, seeded(1));
  assert.equal(points.length, 12 * B.CLUSTERS.length);
  assert.equal(centres.length, B.CLUSTERS.length);
  for (const p of points) {
    assert.notEqual(p.link, -1);
    assert.equal(points[p.link].cluster, p.cluster);
    assert.notEqual(points[p.link], p);
    if (p.label) assert.ok(B.CLUSTERS[p.cluster].includes(p.label));
  }
  assert.equal(points.filter(p => p.label).length, B.CLUSTERS.flat().length);
});

check("every query names a real cluster", () => {
  for (const [text, c] of B.QUERIES) assert.ok(text && B.CLUSTERS[c], text);
});

check("rotation keeps distance from the origin", () => {
  const p = { x: 0.3, y: -0.4, z: 0.5 };
  const r = B.rotate(p, 1.1, -0.4);
  assert.ok(Math.abs(Math.hypot(r.x, r.y, r.z) - Math.hypot(p.x, p.y, p.z)) < 1e-12);
  assert.deepEqual(B.rotate(p, 0, 0), p);
});

check("perspective: a farther point shrinks towards the centre", () => {
  const near = B.project({ x: 1, y: 1, z: -0.5 }, 100, 100, 50);
  const far = B.project({ x: 1, y: 1, z: 0.5 }, 100, 100, 50);
  assert.ok(near.k > 1 && far.k < 1);
  assert.ok(far.x - 100 < near.x - 100);
  assert.deepEqual(B.project({ x: 0, y: 0, z: 0 }, 100, 80, 50), { x: 100, y: 80, k: 1 });
});

check("nearest returns the k closest, nearest first", () => {
  const pts = [{ x: 5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }];
  assert.deepEqual(B.nearest(pts, { x: 0, y: 0, z: 0 }, 3), [1, 3, 2]);
  assert.equal(B.nearest(pts, { x: 0, y: 0, z: 0 }, 10).length, 4);
});

check("projectCloud matches rotate + project point by point", () => {
  const { points } = B.makeCloud(5, seeded(2));
  const n = points.length;
  const out = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), k: new Float32Array(n) };
  B.projectCloud(points, 0.7, -0.3, 200, 150, 120, out);
  points.forEach((p, i) => {
    const r = B.rotate(p, 0.7, -0.3);
    const s = B.project(r, 200, 150, 120);
    for (const [got, want] of [[out.x[i], s.x], [out.y[i], s.y], [out.z[i], r.z], [out.k[i], s.k]]) {
      assert.ok(Math.abs(got - want) < 1e-3, `${i}: ${got} vs ${want}`);
    }
  });
});

check("depthOrder sorts far to near and keeps every index", () => {
  const z = [0.1, -0.8, 0.9, 0.3, -0.2];
  const order = B.depthOrder([0, 1, 2, 3, 4], z);
  assert.deepEqual(order, [2, 3, 0, 4, 1]);
  z[2] = -1;  // the cloud turned: re-sorting last frame's order catches up
  assert.deepEqual(B.depthOrder(order, z), [3, 0, 4, 1, 2]);
});

check("retrieve returns labelled points only, best score first", () => {
  const { points, centres } = B.makeCloud(14, seeded(3));
  const hits = B.retrieve(points, centres[3], 4);
  assert.equal(hits.length, 4);
  for (const h of hits) assert.ok(points[h.i].label && h.score > 0 && h.score <= 1);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  assert.equal(points[hits[0].i].cluster, 3, "a query at a centre finds its own cluster first");
  assert.equal(B.retrieve(points, points[hits[0].i], 1)[0].score, 1);
});

check("retrieval timeline: type, fly, rays in turn, then fade out within the cycle", () => {
  const R = B.RETRIEVAL;
  const chars = Math.max(...B.QUERIES.map(([q]) => q.length));
  const landed = chars * R.perChar + R.pause + R.fly;
  const start = B.retrievalAt(0, chars, 4);
  assert.deepEqual([start.typed, start.fly, start.alpha], [0, 0, 1]);
  assert.equal(B.retrievalAt(landed - R.fly - 1, chars, 4).typed, chars, "typed out before the fly-in");
  const mid = B.retrievalAt(landed + R.stagger, chars, 4);
  assert.equal(mid.fly, 1);
  assert.ok(mid.rays[0] > mid.rays[1] && mid.rays[1] === 0, "hits light one after another");
  const lit = landed + 3 * R.stagger + R.ray;
  assert.ok(lit < R.hold, "every ray is drawn before the fade starts");
  assert.deepEqual(B.retrievalAt(lit, chars, 4).rays, [1, 1, 1, 1]);
  assert.equal(B.retrievalAt(R.hold + R.fade, chars, 4).alpha, 0);
  assert.ok(R.hold + R.fade <= R.cycle);
});

check("proximity: full on the pointer, fading to nothing at the radius", () => {
  assert.equal(B.proximity(10, 10, 10, 10, 50), 1);
  const near = B.proximity(0, 0, 10, 0, 50), far = B.proximity(0, 0, 40, 0, 50);
  assert.ok(near > far && far > 0);
  assert.equal(B.proximity(0, 0, 50, 0, 50), 0);
  assert.equal(B.proximity(0, 0, 0, 90, 50), 0);
});

check("pickCluster: a clear cluster, never the last one, any other when all are hidden", () => {
  const at = [{ x: 50, y: 50 }, { x: 500, y: 50 }, { x: 55, y: 60 }, { x: 600, y: 300 }];
  const logo = { x: 0, y: 0, w: 100, h: 100 };
  const rand = seeded(4);
  const seen = new Set();
  for (let n = 0; n < 50; n++) seen.add(B.pickCluster(at, logo, 1, rand));
  assert.deepEqual([...seen], [3]);
  for (let n = 0; n < 50; n++) assert.notEqual(B.pickCluster(at, null, 2, rand), 2);
  const hidden = at.map(() => ({ x: 10, y: 10 }));
  for (let n = 0; n < 50; n++) assert.notEqual(B.pickCluster(hidden, logo, 0, rand), 0);
});

check("logo cloud: every shadow edge has arms; dots stay in their cell, some tinted", () => {
  const m = {};
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, "src/app/matrix-rain.js"), "utf8"))(m);
  const cells = m.OMP_MATRIX.logoCells({ x: 0, y: 0, width: 910, height: 120 });
  for (const c of cells) if (!c.solid) assert.ok(B.EDGE_ARMS[c.ch], c.ch);
  const solid = cells.filter(c => c.solid);
  const dots = B.logoDots(solid, seeded(9), { perCell: 2 });
  assert.equal(dots.length, solid.length * 2);
  dots.forEach((d, i) => {
    const c = solid[i >> 1];
    assert.ok(Math.abs(d.x - (c.x + c.w / 2)) < c.w && d.y > c.y - c.h / 2 && d.y < c.y + c.h * 1.5);
    assert.ok(d.z >= -1 && d.z <= 1 && d.tint >= -1 && d.tint < B.CLUSTERS.length);
  });
  const tinted = dots.filter(d => d.tint >= 0).length / dots.length;
  assert.ok(tinted > 0.03 && tinted < 0.15, String(tinted));
});

check("segmentDist and driftAt", () => {
  assert.equal(B.segmentDist(5, 3, 0, 0, 10, 0), 3);
  assert.equal(B.segmentDist(-4, 3, 0, 0, 10, 0), 5);
  assert.equal(B.segmentDist(3, 4, 0, 0, 0, 0), 5);
  const { out, hold, back } = B.DRIFT;
  assert.equal(B.driftAt(0), 0);
  assert.equal(B.driftAt(out + 1), 1);
  assert.equal(B.driftAt(out + hold + back), 0);
  assert.ok(B.driftAt(out / 2) > 0 && B.driftAt(out + hold + back / 2) < 1);
});

// ── next token ──

check("tokenize is lossless and splits code into tokens", () => {
  for (const src of B.SNIPPETS) assert.equal(B.tokenize(src).join(""), src);
  assert.deepEqual(B.tokenize("let r: f32 = 0.5;"), ["let", " ", "r", ":", " ", "f32", " ", "=", " ", "0.5", ";"]);
  assert.deepEqual(B.tokenize("x = \"a b\""), ["x", " ", "=", " ", "\"a b\""]);
  assert.deepEqual(B.tokenize(""), []);
});

check("token kinds colour keywords, strings, numbers and space", () => {
  assert.equal(B.tokenKind("async"), "keyword");
  assert.equal(B.tokenKind("\"seed\""), "string");
  assert.equal(B.tokenKind("20"), "number");
  assert.equal(B.tokenKind("suite"), "ident");
  assert.equal(B.tokenKind("{"), "punct");
  assert.equal(B.tokenKind("\n    "), "space");
});

check("candidates: the true token wins, distinct, probabilities sum to 1", () => {
  const rand = seeded(7);
  for (let i = 0; i < 200; i++) {
    const c = B.candidates("softmax", 5, rand);
    assert.equal(c.length, 5);
    assert.equal(c[0].tok, "softmax");
    assert.equal(new Set(c.map(x => x.tok)).size, 5);
    assert.ok(Math.abs(c.reduce((a, x) => a + x.p, 0) - 1) < 1e-9);
    for (let j = 1; j < c.length; j++) assert.ok(c[j - 1].p >= c[j].p);
  }
  assert.deepEqual(B.candidates("a", 4, seeded(1), { vocab: ["a", "b"] }).map(x => x.tok).sort(), ["a", "b"],
    "a small vocabulary gives fewer candidates, never duplicates");
});

check("the distractor pool has no whitespace and no duplicates", () => {
  assert.equal(new Set(B.VOCAB).size, B.VOCAB.length);
  assert.ok(B.VOCAB.every(t => B.tokenKind(t) !== "space"));
});

check("layoutTokens places each token at its line and column", () => {
  const at = B.layoutTokens("if x {\n    y();\n}");
  const pos = (tok) => { const t = at.find(a => a.tok === tok); return [t.line, t.col, t.kind]; };
  assert.deepEqual(pos("if"), [0, 0, "keyword"]);
  assert.deepEqual(pos("{"), [0, 5, "punct"]);
  assert.deepEqual(pos("y"), [1, 4, "ident"]);
  assert.deepEqual(pos("}"), [2, 0, "punct"]);
  assert.deepEqual(B.layoutTokens("a\n\n  b").at(-1), { tok: "b", kind: "ident", line: 2, col: 2 }, "blank lines count");
  for (const src of B.SNIPPETS) {
    const lines = src.split("\n");
    for (const t of B.layoutTokens(src)) {
      if (t.kind !== "space") assert.equal(lines[t.line].slice(t.col, t.col + t.tok.length), t.tok);
    }
  }
  assert.equal(B.SNIPPET_FILES.length, B.SNIPPETS.length);
});

// ── agent loop ──

check("orbit clears the logo and stays inside the area", () => {
  const fit = { x: 200, y: 300, width: 600, height: 120 };
  const { rx, ry } = B.orbitRadii(1000, 720, fit);
  assert.ok(rx >= fit.width / 2 && rx <= 1000 / 2);
  assert.ok(ry >= fit.height / 2 && ry <= 720 / 2);
  const tiny = B.orbitRadii(200, 90, null);
  assert.ok(tiny.rx > 0 && tiny.rx <= 100 && tiny.ry >= 0 && tiny.ry <= 45);
  assert.deepEqual(B.orbitRadii(10, 10, null), { rx: 0, ry: 0 });
});

check("ellipsePoint and nextCall", () => {
  const p = B.ellipsePoint(0, 100, 50, 40, 20);
  assert.deepEqual(p, { x: 140, y: 50 });
  const q = B.ellipsePoint(Math.PI / 2, 100, 50, 40, 20);
  assert.ok(Math.abs(q.x - 100) < 1e-9 && Math.abs(q.y - 70) < 1e-9);
  const rand = seeded(3);
  for (let i = 0; i < 50; i++) {
    const call = B.nextCall(rand);
    assert.ok(B.TOOLS[call.tool].calls.includes(call.label));
  }
});

check("calls: outcome, wall time in the tool's range, failures only where possible", () => {
  const rand = seeded(7);
  let failed = 0;
  for (let i = 0; i < 400; i++) {
    const call = B.nextCall(rand);
    const { secs: [lo, hi], fail } = B.TOOLS[call.tool];
    assert.ok(call.secs >= lo - 1e-9 && call.secs <= hi + 1e-9, `${call.secs} in [${lo}, ${hi}]`);
    if (!call.ok) { failed++; assert.ok(fail > 0, B.TOOLS[call.tool].name); }
  }
  assert.ok(failed > 0, "some calls fail");
  assert.equal(B.nextCall(rand, B.TOOLS, 3).tool, 3);
});

check("a turn is 1–3 parallel calls to distinct tools, mostly one", () => {
  const rand = seeded(11);
  const sizes = [0, 0, 0, 0];
  for (let i = 0; i < 300; i++) {
    const turn = B.nextTurn(rand);
    sizes[turn.length]++;
    assert.equal(new Set(turn.map(c => c.tool)).size, turn.length);
  }
  assert.equal(sizes[0], 0);
  assert.ok(sizes[1] > sizes[2] && sizes[2] > sizes[3] && sizes[3] > 0, sizes.join());
});

check("callPhase walks out → exec → back → done; slower calls execute longer", () => {
  const fast = B.callSpans({ secs: 0.2 }), slow = B.callSpans({ secs: 4 });
  assert.ok(slow.exec > fast.exec);
  assert.equal(B.callSpans({ secs: 60 }).exec, B.callSpans({ secs: 6 }).exec);
  const s = { out: 10, exec: 5, back: 10 };
  assert.deepEqual(B.callPhase(-1, s), { phase: "wait", t: 0 });
  assert.deepEqual(B.callPhase(0, s), { phase: "out", t: 0 });
  assert.deepEqual(B.callPhase(5, s), { phase: "out", t: 0.5 });
  assert.deepEqual(B.callPhase(10, s), { phase: "exec", t: 0 });
  assert.deepEqual(B.callPhase(15, s), { phase: "back", t: 0 });
  assert.deepEqual(B.callPhase(24, s), { phase: "back", t: 0.9 });
  assert.deepEqual(B.callPhase(25, s), { phase: "done", t: 1 });
});

check("logLine: tool column, label, then pending, ok or failed", () => {
  const bash = B.TOOLS.findIndex(t => t.name === "bash");
  const call = { tool: bash, label: "cargo test", ok: true, secs: 1.4 };
  assert.equal(B.logLine(call, false), "bash  cargo test  …");
  assert.equal(B.logLine(call, true), "bash  cargo test  ✓ 1.4s");
  assert.equal(B.logLine({ ...call, ok: false }, true), "bash  cargo test  ✗ exit 1");
  assert.equal(B.logLine({ tool: B.TOOLS.findIndex(t => t.name === "lsp"), label: "hover", ok: true, secs: 0.3 }, true), "lsp   hover  ✓ 0.3s");
});

check("logRoom: full log under a roomy orbit, fewer lines as it closes in, none when it can't fit", () => {
  assert.equal(B.logRoom(720, { cx: 550, cy: 360, rx: 406, ry: 245 }), 5);
  const tight = B.logRoom(460, { cx: 350, cy: 230, rx: 266, ry: 160 });
  assert.ok(tight >= 2 && tight < 5, String(tight));
  assert.equal(B.logRoom(300, { cx: 300, cy: 150, rx: 280, ry: 140 }), 0);
  assert.equal(B.logRoom(720, { cx: 150, cy: 360, rx: 100, ry: 100 }), 0);  // log would reach past the centre
});

check("logoSweep: dark before and after, a band crossing left to right, leaning", () => {
  for (const k of [0, 1, -0.2, 1.5]) assert.equal(B.logoSweep(45, 3, k), 0);
  // Every cell is dark at both ends of the sweep, lit exactly once mid-way.
  for (const col of [0, 45, 90]) for (const row of [0, 5]) {
    assert.equal(B.logoSweep(col, row, 0.001), 0);
    assert.equal(B.logoSweep(col, row, 0.999), 0);
    const peak = Math.max(...Array.from({ length: 200 }, (_, i) => B.logoSweep(col, row, i / 200)));
    assert.ok(peak > 0.9 && peak <= 1, `${col},${row}: ${peak}`);
  }
  // Left lights before right; the bottom row leads the top (the band leans).
  const firstLit = (col, row) => Array.from({ length: 200 }, (_, i) => B.logoSweep(col, row, i / 200)).findIndex(w => w > 0.5);
  assert.ok(firstLit(10, 3) < firstLit(80, 3));
  assert.ok(firstLit(45, 5) < firstLit(45, 0));
});

check("pullToward: no pull at rest, towards the well, weaker farther, never past it", () => {
  const p = { x: 100, y: 0 };
  assert.deepEqual(B.pullToward(p, { x: 0, y: 0, strength: 0 }, 80), p);
  const well = { x: 0, y: 0, strength: 1 };
  const near = B.pullToward(p, well, 80), far = B.pullToward({ x: 400, y: 0 }, well, 80);
  assert.ok(near.x < 100 && near.x > 0 && near.y === 0);
  assert.ok(100 - near.x > 400 - far.x);
  const at = B.pullToward({ x: 1, y: 1 }, well, 80, 1);
  assert.ok(at.x >= 0 && at.y >= 0);
});

// ── forward pass ──

check("layer layout spans the rect, each layer centred", () => {
  const rect = { x: 10, y: 20, width: 300, height: 200 };
  const nodes = B.layerLayout([3, 5, 2], rect);
  assert.deepEqual(nodes.map(l => l.length), [3, 5, 2]);
  assert.equal(nodes[0][0].x, 10);
  assert.equal(nodes[2][0].x, 310);
  assert.deepEqual(nodes[1].map(n => n.y), [20, 70, 120, 170, 220], "the tallest layer fills the height");
  for (const layer of nodes) {
    const mid = (layer[0].y + layer[layer.length - 1].y) / 2;
    assert.equal(mid, 120);
  }
});

check("band layout keeps the logo band clear, halves centred, downward order", () => {
  const rect = { x: 0, y: 0, width: 500, height: 400 };
  const band = { top: 150, bottom: 250 };
  const nodes = B.bandLayout([5, 12, 3], rect, band);
  assert.deepEqual(nodes.map(l => l.length), [5, 12, 3]);
  for (const layer of nodes) {
    for (let i = 1; i < layer.length; i++) assert.ok(layer[i].y > layer[i - 1].y, "indices read downwards");
    for (const n of layer) {
      assert.ok(n.y < band.top || n.y > band.bottom, "nothing in the band");
      assert.ok(n.y >= rect.y && n.y <= rect.y + rect.height, "inside the rect");
    }
    const ups = layer.filter(n => n.y < band.top);
    assert.equal(ups.length, Math.ceil(layer.length / 2), "upper half takes the odd node");
  }
  // Halves of a smaller layer centred on the tallest layer's halves.
  const mid = ns => (ns[0].y + ns[ns.length - 1].y) / 2;
  assert.ok(Math.abs(mid(nodes[0].slice(0, 3)) - mid(nodes[1].slice(0, 6))) < 1e-9);
  assert.equal(B.bandLayout([5, 12, 3], rect, band, 10)[1][6].y, band.bottom + 5, "maxGap caps the spacing");
  assert.deepEqual(B.bandLayout([3, 5], rect, null), B.layerLayout([3, 5], rect));
});

check("pulses fan out to distinct next-layer nodes; the last layer fires none", () => {
  const rand = seeded(11);
  const p = B.firePulses([4, 6, 3], 0, 2, 4, rand);
  assert.equal(p.length, 4);
  assert.equal(new Set(p.map(x => x.to)).size, 4);
  for (const x of p) {
    assert.equal(x.l, 0);
    assert.equal(x.from, 2);
    assert.ok(x.to >= 0 && x.to < 6 && x.w > 0.35 && x.w <= 1 && x.t === 0);
  }
  assert.equal(B.firePulses([4, 6, 3], 1, 0, 9, rand).length, 3, "fanout capped by the layer size");
  assert.deepEqual(B.firePulses([4, 6, 3], 2, 0, 3, rand), []);
});

check("the forward-pass sequence is the snippets' non-space tokens", () => {
  assert.ok(B.SEQUENCE.length > 50);
  assert.ok(B.SEQUENCE.every(t => B.tokenKind(t) !== "space"));
});

check("a forward pass always reaches the output, sparse but never dead", () => {
  const rand = seeded(5);
  const { minFire, maxFire } = B.PASS_RULES;
  for (const sizes of [[5, 9, 12, 12, 9, 5], [4, 6, 7, 6, 4], [2, 1, 3]]) {
    for (let run = 0; run < 40; run++) {
      const pass = B.startPass(sizes, rand);
      assert.equal(pass.count[0], sizes[0], "every input fires");
      let steps = 0;
      while (!pass.done) {
        B.advancePass(pass, 0.05, rand);
        assert.ok(++steps < 400, "pass finishes");
      }
      assert.ok(steps > 4 * (sizes.length - 1), "pulses take time to cross each layer");
      assert.equal(pass.pulses.length, 0, "nothing left in flight once the output settles");
      assert.ok(pass.inflight.every(n => n === 0));
      for (let l = 1; l < sizes.length; l++) {
        const fired = pass.fired[l].filter(Boolean).length;
        assert.equal(fired, pass.count[l]);
        assert.ok(fired >= Math.min(minFire, sizes[l]), `layer ${l} fires at least minFire`);
        assert.ok(fired <= Math.max(Math.ceil(sizes[l] * maxFire), Math.min(minFire, sizes[l])), `layer ${l} stays sparse`);
      }
    }
  }
});

check("advancePass reports landings and firings; rankOutputs puts a fired node first", () => {
  const rand = seeded(8);
  const pass = B.startPass([3, 4, 3], rand);
  assert.deepEqual(pass.events.map(e => [e.l, e.fire]), [[0, true], [0, true], [0, true]]);
  const seen = [];
  while (!pass.done) seen.push(...B.advancePass(pass, 0.1, rand));
  const landings = seen.filter(e => !e.fire);
  assert.ok(landings.length > 0 && landings.every(e => e.l >= 1 && e.w >= 0.35 && e.w <= 1));
  assert.equal(seen.filter(e => e.fire).length, pass.count[1] + pass.count[2]);
  const rank = B.rankOutputs(pass);
  assert.deepEqual([...rank].sort(), [0, 1, 2]);
  assert.ok(pass.fired[2][rank[0]]);
  const fired = rank.filter(i => pass.fired[2][i]);
  for (let k = 1; k < fired.length; k++) assert.ok(pass.acc[2][fired[k - 1]] >= pass.acc[2][fired[k]]);
});

check("the pointer's ease makes nodes fire more readily, still within the cap", () => {
  const sizes = [5, 9, 12, 12, 9, 5];
  const total = (ease) => {
    const rand = seeded(21);
    let fired = 0;
    for (let run = 0; run < 60; run++) {
      const pass = B.startPass(sizes, rand);
      while (!pass.done) B.advancePass(pass, 0.05, rand, ease);
      pass.count.forEach((n, l) => assert.ok(l === 0 || n <= Math.ceil(sizes[l] * B.PASS_RULES.maxFire)));
      fired += pass.count.reduce((a, b) => a + b, 0);
    }
    return fired;
  };
  assert.ok(total(() => 1) > total(null) * 1.05);
});

// ── attention ──

const toks = (src) => B.tokenize(src).filter(t => B.tokenKind(t) !== "space");

check("causal mask: no head in any layer attends to a later token; weights sum to 1", () => {
  const tokens = B.windowAt(17, 12);
  for (let l = 0; l < B.LAYERS; l++) {
    const maps = B.attentionMaps(tokens, l);
    assert.equal(maps.length, B.HEADS.length);
    for (const m of maps) {
      m.forEach((row, q) => {
        assert.equal(row.length, tokens.length);
        row.forEach((w, k) => (k > q ? assert.equal(w, 0, `q${q} k${k}`) : assert.ok(w > 0)));
        assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9);
      });
    }
  }
  for (const h of B.HEADS) assert.ok(B.headScores(tokens, 4, h.id).slice(5).every(v => v === -Infinity));
});

const argmax = (row) => row.indexOf(Math.max(...row));

check("head patterns pick what they claim", () => {
  const t = toks("const runs = f(a, g(b, runs));");
  // const runs = f ( a , g ( b , runs ) ) ;
  // 0     1    2 3 4 5 6 7 8 9 10 11  12 13 14
  assert.equal(t.length, 15);
  for (let l = 0; l < B.LAYERS; l++) {
    for (const q of [1, 5, 9, 13]) assert.equal(argmax(B.attend(t, q, "prev", l)), q - 1, "previous token");
    assert.equal(argmax(B.attend(t, 9, "bracket", l)), 8, "inside g( … → its (");
    assert.equal(argmax(B.attend(t, 12, "bracket", l)), 8, ") → its own (");
    assert.equal(argmax(B.attend(t, 13, "bracket", l)), 4, "outer ) → f's (");
    assert.equal(argmax(B.attend(t, 11, "ident", l)), 1, "runs → the earlier runs");
    assert.equal(argmax(B.attend(t, 5, "ident", l)), 0, "nothing to match: the sink");
    // The broad head spreads out: flatter than every other head.
    const top = (id) => Math.max(...B.attend(t, 13, id, l));
    for (const id of ["prev", "bracket", "ident"]) assert.ok(top("broad") < top(id), id);
  }
  assert.ok(Math.max(...B.attend(t, 13, "prev", 3)) > Math.max(...B.attend(t, 13, "prev", 0)), "deeper layers sharper");
  assert.equal(B.enclosingOpen(t, 2), -1);
  assert.equal(B.enclosingOpen(t, 14), -1, "all closed by the ;");
});

check("windowAt slides one token per step and wraps round the sequence", () => {
  const n = 10, len = B.SEQUENCE.length;
  assert.deepEqual(B.windowAt(3, n), B.SEQUENCE.slice(3, 3 + n));
  for (const k of [0, 41, len - 4, len + 2]) {
    const a = B.windowAt(k, n), b = B.windowAt(k + 1, n);
    assert.deepEqual(b.slice(0, -1), a.slice(1), "drops the oldest, keeps the order");
    assert.equal(b[n - 1], B.windowAt(k + n, 1)[0], "appends the token after the window");
  }
  assert.deepEqual(B.windowAt(len - 2, 4), [B.SEQUENCE[len - 2], B.SEQUENCE[len - 1], B.SEQUENCE[0], B.SEQUENCE[1]]);
  assert.deepEqual(B.windowAt(-1, 2), B.windowAt(len - 1, 2));
});

check("phaseAt walks attention then MLP layer by layer, then output and the slide", () => {
  const seen = [];
  let last = -1;
  for (let t = 0; t < B.CYCLE; t++) {
    const p = B.phaseAt(t);
    assert.ok(p.u >= 0 && p.u < 1);
    assert.ok(p.layer >= last, "layers only rise");
    last = p.layer;
    const tag = `${p.stage}${p.stage === "attn" || p.stage === "mlp" ? p.layer : ""}`;
    if (seen[seen.length - 1] !== tag) seen.push(tag);
  }
  assert.deepEqual(seen, ["attn0", "mlp0", "attn1", "mlp1", "attn2", "mlp2", "attn3", "mlp3", "out", "slide"]);
  // The reduced-motion still frame (90 steps in) shows a layer's arcs.
  assert.ok(["attn", "mlp"].includes(B.phaseAt(89).stage));
});

check("layout: inside the canvas, clear of the logo, slots in order, heatmaps apart", () => {
  const boxed = (r, W, H) => r.x >= 0 && r.y >= 0 && r.x + r.size <= W && r.y + r.size <= H;
  for (const [W, H] of [[700, 460], [1300, 1000], [1600, 1000], [2400, 1300]]) {
    const fit = { font: 12, x: W * 0.15, y: H * 0.45, width: W * 0.7, height: H * 0.1 };
    const L = B.attentionLayout({ width: W, height: H, fit, compact: false });
    assert.equal(L.slots.length, L.n + 1, "a slot for the prediction");
    assert.ok(L.n >= 5 && L.n <= 12);
    for (let i = 1; i < L.slots.length; i++) assert.ok(L.slots[i] > L.slots[i - 1]);
    assert.ok(L.slots[0] > 0 && L.slots[L.n] < W && L.rowY < H - 20);
    const below = fit.y + fit.height, above = fit.y;
    assert.equal(L.layers.length, B.LAYERS);
    L.layers.forEach((ly, l) => {
      assert.ok(ly.top >= below && ly.bottom < L.rowY, `layer ${l} between logo and tokens`);
      assert.ok(ly.attnY > ly.normY && ly.normY > ly.mlpY, "attention, add & norm, then MLP, rising");
      assert.ok(ly.attnY - ly.cap >= ly.top, "arcs stay in their layer");
      if (l) assert.ok(ly.bottom <= L.layers[l - 1].top + 1e-9, "layer 0 at the bottom");
    });
    assert.equal(L.heads.length, B.HEADS.length);
    L.heads.forEach((r, h) => {
      assert.ok(boxed(r, W, H) && r.y + r.size < above, "heatmap above the logo");
      if (h) assert.ok(r.x > L.heads[h - 1].x + L.heads[h - 1].size, "no overlap");
    });
  }
  const tile = B.attentionLayout({ width: 230, height: 92, fit: null, compact: true });
  assert.equal(tile.caption, null);
  for (const r of tile.heads) assert.ok(boxed(r, 230, 92) && r.x > tile.slots[tile.n]);
  assert.ok(tile.layers.every(ly => ly.attnY - ly.cap >= 0 && ly.attnY < tile.rowY));
});

check("slotAt picks the nearest slot, nothing past the row's ends", () => {
  const slots = [100, 150, 200, 250];
  assert.equal(B.slotAt(100, slots), 0);
  assert.equal(B.slotAt(162, slots), 1);
  assert.equal(B.slotAt(176, slots), 2);
  assert.equal(B.slotAt(74, slots), -1);
  assert.equal(B.slotAt(276, slots), -1);
});

check("logo: columns spread over the window and rows over the heads evenly; the mask sweep hides what's ahead", () => {
  for (const [count, n] of [[91, 12], [91, 5], [12, 4]]) {
    const counts = new Array(n).fill(0);
    for (let i = 0; i < count; i++) counts[B.bandOf(i, count, n)]++;
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${count} over ${n}`);
    assert.equal(B.bandOf(0, count, n), 0);
    assert.equal(B.bandOf(count - 1, count, n), n - 1);
  }
  assert.deepEqual(B.maskSweep(30, 0, 20), { masked: true, glow: 0 });
  assert.equal(B.maskSweep(20, 0, 20).glow, 1, "the front itself glows");
  assert.ok(B.maskSweep(17, 0, 20).glow > 0 && B.maskSweep(17, 0, 20).glow < 1);
  assert.equal(B.maskSweep(5, 0, 20).glow, 0, "long passed: plain");
  assert.ok(!B.maskSweep(15, 0, 20).masked && B.maskSweep(15, 3, 20).masked, "the front leans: lower rows lag");
});

console.log(`backdrops: ${passed} checks passed`);
