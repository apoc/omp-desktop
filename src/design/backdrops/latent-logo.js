// The "latent" start screen's logo: OMP-DESKTOP as a cloud of embedded
// points that lean with the cloud, drift off to clusters and queries, and
// glint as retrievals land (pure rules: app/backdrops-latent.js). Used by
// design/backdrops/latent.js, which owns the renderer state `s` this reads:
// tiltYaw, sway, pitch, yaw, cx, cy, scale, stretch, steps, cloud, proj,
// art.sprites, and the frame's query view qx, qy, at, hits, landAge.
// Plain-script IIFE.
(function () {
  const DRIFTERS = 16;           // logo dots that drift off and settle back
  const LOGO_DEPTH = 2.6;        // logo parallax: px per unit of depth per rad of lean, in font sizes
  const LAYER_Z = [0.95, 0.6, 0, -0.6];  // edges, far, mid and near dots

  /** The logo's points and their per-dot state (only with a logo).
   *  `colours`: the theme key of each cloud cluster, by cluster index. */
  function makeMark(env, rand, colours) {
    const B = window.OMP_BACKDROPS;
    const { cells, solid, sub } = env.logo, font = env.fit.font;
    const dots = B.logoDots(solid, rand, sub);
    const n = dots.length;
    const layer = new Uint8Array(n), phase = new Float32Array(n), speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const z = dots[i].z;
      layer[i] = z > 0.3 ? 1 : z < -0.3 ? 3 : 2;
      phase[i] = rand() * Math.PI * 2;
      speed[i] = 0.018 + rand() * 0.03;
    }
    // The drifters: tinted tokens, drawn live (left out of the cached layers).
    const drifters = [];
    const live = new Uint8Array(n);
    while (drifters.length < DRIFTERS) {
      const i = Math.floor(rand() * n);
      if (live[i]) continue;
      live[i] = 1;
      if (dots[i].tint < 0) dots[i].tint = Math.floor(rand() * colours.length);
      drifters.push({ i, start: -1e9, dx: 0, dy: 0, bend: 0 });
    }
    return {
      dots, layer, phase, speed, live, drifters, font, colours,
      edges: cells.filter(c => !c.solid),
      r: Math.min(solid[0].w, solid[0].h / sub) * 0.29,
      theme: null, layers: null, spark: "", nextIdle: 30,
    };
  }

  const dotColour = (m, d, theme) => (d.tint < 0 ? theme.accent : theme[m.colours[d.tint]]);
  const dotAlpha = (z) => 0.92 - (z + 1) * 0.17;
  const dotRadius = (m, z) => m.r * (1 - z * 0.3);

  /** The static logo, pre-rendered per layout/theme: the shadow edges
   *  as hairline links, then the dots in three depth layers that lean
   *  apart with the cloud (glow baked in: no per-frame shadowBlur). */
  function renderLayers(m, logo, theme) {
    const B = window.OMP_BACKDROPS;
    const { font } = m, pad = Math.ceil(font * 2);
    const edges = logo.bake(pad, g => {
      g.strokeStyle = theme.fg3;
      g.fillStyle = theme.fg3;
      g.lineWidth = Math.max(0.7, font * 0.07);
      g.lineCap = "round";
      g.globalAlpha = 0.5;
      g.beginPath();
      for (const c of m.edges) {
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        for (const arm of B.EDGE_ARMS[c.ch]) {
          g.moveTo(cx, cy);
          if (arm === "l") g.lineTo(c.x, cy);
          else if (arm === "r") g.lineTo(c.x + c.w, cy);
          else if (arm === "u") g.lineTo(cx, c.y);
          else g.lineTo(cx, c.y + c.h);
        }
      }
      g.stroke();
      // A node where a link turns a corner.
      g.globalAlpha = 0.7;
      g.beginPath();
      for (const c of m.edges) {
        if (B.EDGE_ARMS[c.ch] === "lr" || B.EDGE_ARMS[c.ch] === "ud") continue;
        g.moveTo(c.x + c.w / 2 + m.r * 0.55, c.y + c.h / 2);
        g.arc(c.x + c.w / 2, c.y + c.h / 2, m.r * 0.55, 0, Math.PI * 2);
      }
      g.fill();
    });
    const dots = [1, 2, 3].map(l => logo.bake(pad, g => {
      g.shadowBlur = font * 0.6;
      m.dots.forEach((d, i) => {
        if (m.layer[i] !== l || m.live[i]) return;
        g.globalAlpha = dotAlpha(d.z);
        g.fillStyle = dotColour(m, d, theme);
        g.shadowColor = d.tint < 0 ? theme.glow : g.fillStyle;
        g.beginPath();
        g.arc(d.x, d.y, dotRadius(m, d.z), 0, Math.PI * 2);
        g.fill();
      });
    }));
    return [edges, ...dots];
  }

  /** Send drifter `d` off towards (tx, ty), `dist` px out. */
  function launch(d, m, steps, tx, ty, dist, rand) {
    const home = m.dots[d.i];
    const len = Math.hypot(tx - home.x, ty - home.y) || 1;
    d.dx = ((tx - home.x) / len) * dist;
    d.dy = ((ty - home.y) / len) * dist;
    d.bend = (rand() - 0.5) * 0.8;
    d.start = steps;
  }

  /** Paint the logo for this step (the renderer's `logo` hook). */
  function paint(ctx, s, env, theme) {
    const m = s.mark;
    const B = window.OMP_BACKDROPS;
    const { width: w, height: h } = env;
    if (m.theme !== theme) {
      m.theme = theme;
      m.layers = renderLayers(m, env.logo, theme);
      // A glint lights up: the foreground on a dark theme, but that is
      // ink on a light one, where the accent itself sparkles instead.
      m.spark = theme.light ? theme.accent : theme.fg;
    }

    // The logo sits in the cloud's space: its depth layers lean apart
    // with the pointer and sway with the cloud's slow nod.
    const D = LOGO_DEPTH * m.font, lx = s.tiltYaw * D, ly = -s.sway * D;
    m.layers.forEach((img, l) => env.logo.draw(ctx, img, LAYER_Z[l] * lx, LAYER_Z[l] * ly));

    // Drifters: a token pulled off its letter (towards its cluster, or
    // towards a query as it lands), still linked home, settling back.
    const { steps } = s, rand = env.rand, at = s.at;
    if (s.landAge === 0) {
      const near = m.drifters.filter(d => B.driftAt(steps - d.start) === 0)
        .sort((a, b) => Math.hypot(m.dots[a.i].x - s.qx, m.dots[a.i].y - s.qy) - Math.hypot(m.dots[b.i].x - s.qx, m.dots[b.i].y - s.qy));
      for (const d of near.slice(0, 3)) launch(d, m, steps, s.qx, s.qy, m.font * (2 + rand()), rand);
    }
    if (steps >= m.nextIdle) {
      m.nextIdle = steps + 60 + rand() * 90;
      const idle = m.drifters.filter(d => B.driftAt(steps - d.start) === 0);
      if (idle.length) {
        const d = idle[Math.floor(rand() * idle.length)];
        const o = B.project(B.rotate(s.cloud.centres[m.dots[d.i].tint], s.yaw + s.tiltYaw, s.pitch), s.cx, s.cy, s.scale, s.stretch);
        launch(d, m, steps, o.x, o.y, m.font * (1.2 + rand() * 0.8), rand);
      }
    }
    ctx.lineWidth = Math.max(0.6, m.font * 0.05);
    for (const d of m.drifters) {
      const dot = m.dots[d.i], f = B.driftAt(steps - d.start);
      const z = LAYER_Z[m.layer[d.i]];
      const hx = dot.x + z * lx, hy = dot.y + z * ly;
      const arc = Math.sin(Math.PI * f) * d.bend;
      const x = hx + d.dx * f - d.dy * arc, y = hy + d.dy * f + d.dx * arc;
      ctx.fillStyle = ctx.strokeStyle = dotColour(m, dot, theme);
      if (f > 0) {
        ctx.globalAlpha = f * 0.4;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.globalAlpha = dotAlpha(dot.z);
      ctx.beginPath();
      ctx.arc(x, y, dotRadius(m, dot.z) * (1 + f * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }

    // Glints: a twinkle now and then; a wave through the letters as a
    // query lands; letters near a growing retrieval ray; the pointer.
    const R = B.RETRIEVAL, reach = m.font * 5;
    const waveV = Math.max(w, h) / 45, band = m.font * 3;
    const wave = at && s.landAge >= 0 && s.landAge < 60 ? at.alpha : 0;
    const glow = s.art.sprites.accent, gr = m.r * 9;
    ctx.fillStyle = m.spark;
    for (let i = 0; i < m.dots.length; i++) {
      if (m.live[i]) continue;
      const dot = m.dots[i], z = LAYER_Z[m.layer[i]];
      const x = dot.x + z * lx, y = dot.y + z * ly;
      const tw = Math.sin(steps * m.speed[i] + m.phase[i]);
      let g = tw > 0.985 ? ((tw - 0.985) / 0.015) * 0.55 : 0;
      if (wave > 0) {
        const off = Math.abs(Math.hypot(x - s.qx, y - s.qy) - s.landAge * waveV);
        if (off < band) g += (1 - off / band) * 0.75 * wave;
      }
      if (at && at.alpha > 0 && s.landAge >= 0) {
        for (let n = 0; n < at.rays.length; n++) {
          const grow = at.rays[n];
          if (grow <= 0) continue;
          const amp = (grow < 1 ? grow : Math.max(0, 1 - (s.landAge - n * R.stagger - R.ray) / 40)) * at.alpha;
          if (amp <= 0) continue;
          const hit = s.hits[n].i, e = B.easeInOut(grow);
          const tx = s.qx + (s.proj.x[hit] - s.qx) * e, ty = s.qy + (s.proj.y[hit] - s.qy) * e;
          const dist = B.segmentDist(x, y, s.qx, s.qy, tx, ty);
          if (dist < reach) g += amp * (1 - dist / reach) ** 2 * 0.9;
        }
      }
      g += B.proximity(env.pointer, x, y, m.font * 7) * 0.5;
      if (g < 0.03) continue;
      g = Math.min(1, g);
      ctx.globalAlpha = g * 0.5;
      ctx.drawImage(glow, x - gr / 2, y - gr / 2, gr, gr);
      ctx.globalAlpha = g * 0.75;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius(m, dot.z) * (0.75 + g * 0.45), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  window.OMP_LATENT_LOGO = { makeMark, paint };
})();
