// Start screen "latent": token embeddings drifting in 3-D, a query
// retrieving its nearest neighbours.
//
// Plain-script IIFE (AGENTS.md "IIFE rule"); adds its rules to
// `window.OMP_BACKDROPS` (app/backdrops.js, which must load first). Drawing:
// design/backdrops/latent.js. Pure, covered by test-backdrops.mjs.
(function () {
  const { gauss } = window.OMP_BACKDROPS;

  // One semantic neighbourhood per cluster; a query lands near the cluster
  // whose index it names.
  const CLUSTERS = Object.freeze([
    ["async", "await", "Promise", "spawn", "join", "Future", "select!", "Mutex"],
    ["fn", "impl", "trait", "struct", "enum", "match", "Result", "Option"],
    ["git", "diff", "commit", "rebase", "merge", "branch", "HEAD", "stash"],
    ["test", "assert", "expect", "mock", "fixture", "bench", "snapshot", "fuzz"],
    ["prompt", "token", "context", "embed", "attention", "logit", "softmax", "agent"],
    ["map", "filter", "reduce", "fold", "zip", "iter", "collect", "flatMap"],
  ]);
  const QUERIES = Object.freeze([
    ["make this concurrent", 0],
    ["refactor into a trait", 1],
    ["squash these commits", 2],
    ["why is CI red?", 3],
    ["shrink the context", 4],
    ["make it a one-liner", 5],
  ]);
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  /** Cluster centres spread over a sphere of `radius` (golden spiral), so
   *  no two neighbourhoods collapse onto each other. */
  function clusterCentres(n, radius) {
    const out = [];
    for (let c = 0; c < n; c++) {
      const y = 1 - (2 * (c + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      out.push({ x: Math.cos(c * GOLDEN) * r * radius, y: y * radius, z: Math.sin(c * GOLDEN) * r * radius });
    }
    return out;
  }

  /** A gaussian blob of `perCluster` points around each centre; the first
   *  points of a blob carry its words as labels. `link`: the index of the
   *  nearest other point of the same cluster, for the constellation lines. */
  function makeCloud(perCluster, rand, { radius = 0.62, spread = 0.17 } = {}) {
    const centres = clusterCentres(CLUSTERS.length, radius);
    const points = [];
    centres.forEach((o, c) => {
      for (let i = 0; i < perCluster; i++) {
        points.push({
          x: o.x + gauss(rand) * spread, y: o.y + gauss(rand) * spread, z: o.z + gauss(rand) * spread,
          cluster: c, label: CLUSTERS[c][i] ?? null, link: -1,
        });
      }
    });
    for (const p of points) {
      let best = Infinity;
      points.forEach((q, j) => {
        if (q === p || q.cluster !== p.cluster) return;
        const d = dist2(p, q);
        if (d < best) { best = d; p.link = j; }
      });
    }
    return { points, centres };
  }

  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

  /** Rotate about the Y axis by `yaw`, then about X by `pitch`. */
  function rotate(p, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x = p.x * cy + p.z * sy;
    const z = -p.x * sy + p.z * cy;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return { x, y: p.y * cp - z * sp, z: p.y * sp + z * cp };
  }

  /** Perspective projection, camera `dist` in front of the origin looking
   *  along +z: a farther point (larger z) lands closer to the centre and
   *  gets a smaller `k` (its size/brightness factor). */
  function project(p, cx, cy, scale, dist = 3) {
    const k = dist / (dist + p.z);
    return { x: cx + p.x * scale * k, y: cy + p.y * scale * k, k };
  }

  /** Indices of the `k` points nearest to `q`, nearest first. */
  function nearest(points, q, k) {
    return points.map((p, i) => [i, dist2(p, q)]).sort((a, b) => a[1] - b[1]).slice(0, k).map(e => e[0]);
  }

  /** rotate + project every point into `out` ({x, y, z, k} typed arrays of
   *  the cloud's length), inlined so a frame allocates nothing. */
  function projectCloud(points, yaw, pitch, cx, cy, scale, out, dist = 3) {
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const x = p.x * cyw + p.z * syw;
      const z0 = -p.x * syw + p.z * cyw;
      const y = p.y * cp - z0 * sp;
      const z = p.y * sp + z0 * cp;
      const k = dist / (dist + z);
      out.x[i] = cx + x * scale * k; out.y[i] = cy + y * scale * k; out.z[i] = z; out.k[i] = k;
    }
  }

  /** Sort `order` (point indices) far to near by `z`, in place. Insertion
   *  sort: the cloud turns slowly, so last frame's order is nearly sorted
   *  and this is ~linear. */
  function depthOrder(order, z) {
    for (let i = 1; i < order.length; i++) {
      const v = order[i], zv = z[v];
      let j = i - 1;
      while (j >= 0 && z[order[j]] < zv) { order[j + 1] = order[j]; j--; }
      order[j + 1] = v;
    }
    return order;
  }

  /** The `k` labelled points (the indexed "documents") nearest to `q`, best
   *  first, with a similarity score in (0, 1] that falls with distance. */
  function retrieve(points, q, k) {
    const docs = [];
    points.forEach((p, i) => { if (p.label) docs.push(i); });
    return nearest(docs.map(i => points[i]), q, k).map(j => {
      const i = docs[j];
      return { i, score: 1 / (1 + Math.sqrt(dist2(points[i], q))) };
    });
  }

  // One retrieval, in steps: type the query, embed it (the point flies in),
  // light the hits one by one, hold, fade. RETRIEVAL.cycle steps in all.
  const RETRIEVAL = Object.freeze({ perChar: 2, pause: 8, fly: 30, stagger: 7, ray: 12, hold: 210, fade: 30, cycle: 270 });

  /** Where a retrieval stands `t` steps in, for a query of `chars`
   *  characters and `k` hits: characters typed, fly-in progress, each
   *  ray's growth (all 0..1), and the overall opacity. */
  function retrievalAt(t, chars, k) {
    const R = RETRIEVAL;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const flyStart = chars * R.perChar + R.pause;
    const landed = flyStart + R.fly;
    const rays = [];
    for (let i = 0; i < k; i++) rays.push(clamp01((t - landed - i * R.stagger) / R.ray));
    return {
      typed: Math.min(chars, Math.floor(t / R.perChar)),
      fly: clamp01((t - flyStart) / R.fly),
      rays,
      alpha: 1 - clamp01((t - R.hold) / R.fade),
    };
  }

  /** Which cluster the next query asks about: a random one whose centre
   *  (projected, `at[c] = {x, y}`) stays clear of `rect` (the logo, or
   *  null), never the `last` one asked; any other one when all are hidden. */
  function pickCluster(at, rect, last, rand) {
    const others = at.map((_, c) => c).filter(c => c !== last);
    const clear = others.filter(c => !rect
      || at[c].x < rect.x || at[c].x > rect.x + rect.w || at[c].y < rect.y || at[c].y > rect.y + rect.h);
    const pool = clear.length ? clear : others;
    return pool[Math.floor(rand() * pool.length)];
  }

  Object.assign(window.OMP_BACKDROPS, {
    CLUSTERS, QUERIES, clusterCentres, makeCloud, rotate, project, nearest,
    projectCloud, depthOrder, retrieve, RETRIEVAL, retrievalAt, pickCluster,
  });
})();
