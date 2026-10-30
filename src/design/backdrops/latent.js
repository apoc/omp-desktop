// Start screen "latent": code-token embeddings turning in 3-D, a search
// query embedding into the cloud and retrieving its nearest neighbours
// (pure rules: app/backdrops.js). Renderer contract:
// design/backdrops/backdrop.jsx. Plain-script IIFE.
(function () {
  const CLUSTER_COLOURS = ["cyan", "amber", "rose", "lime", "lilac", "magenta"];
  const HITS = 4;                // neighbours a query retrieves
  const YAW_STEP = 0.0032;       // rad per step: a full turn in ~65 s
  const START_T = 60;            // first query mid-flight, so the reduced-motion still (90 steps) shows its hits
  const LOOKAHEAD = 100;         // steps from picking a query to its hits lighting up, roughly
  const PITCH = -0.34;           // looking slightly down onto the cloud
  const LABEL_FONT = 10.5;
  const BOX_W = 340;             // the search box: fixed, so it doesn't jump while typing

  /** A soft round glow per colour, tinted through an alpha mask, rebuilt on
   *  a theme switch: a gradient per point per step would cost far more. */
  function glowSprites(theme) {
    const sprites = {};
    for (const name of [...CLUSTER_COLOURS, "accent"]) {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(0.35, "rgba(0,0,0,0.35)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = theme[name];
      g.fillRect(0, 0, 64, 64);
      sprites[name] = c;
    }
    return sprites;
  }

  const buffers = (n) => ({ x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), k: new Float32Array(n) });
  // Near points read bright, far ones recede into the background.
  const depthAlpha = (z) => Math.min(1, Math.max(0.12, 0.62 - z * 0.55));

  function diamond(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
  }

  /** The next query: about a cluster that will be clear of the logo when
   *  its hits light up (the cloud keeps turning meanwhile). */
  function newQuery(s, rand, pitch) {
    const B = window.OMP_BACKDROPS;
    const yaw = s.yaw + s.tiltYaw + YAW_STEP * LOOKAHEAD;
    const at = s.cloud.centres.map(o => {
      const p = B.project(B.rotate(o, yaw, pitch), s.cx, s.cy, s.scale);
      return { x: s.cx + (p.x - s.cx) * s.stretch, y: p.y };
    });
    const cluster = B.pickCluster(at, s.avoid, s.query ? s.query.cluster : -1, rand);
    const asks = B.QUERIES.filter(([, c]) => c === cluster);
    const [text] = asks[Math.floor(rand() * asks.length)];
    const o = s.cloud.centres[cluster];
    const q = { x: o.x + B.gauss(rand) * 0.07, y: o.y + B.gauss(rand) * 0.07, z: o.z + B.gauss(rand) * 0.07 };
    s.query = { text, cluster, q, hits: B.retrieve(s.cloud.points, q, HITS), from: rand() };
  }

  /** The query as typed into a search box, the hits listed under it as
   *  each ray lands (best score in the accent). */
  function drawSearchBox(ctx, s, at, theme) {
    const { x: bx, y: by } = s.box;
    const { text, hits } = s.query;
    const landed = at.rays.reduce((n, g) => n + (g >= 1), 0);
    ctx.globalAlpha = at.alpha * 0.92;
    ctx.fillStyle = theme.bg;
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx + 0.5, by + 0.5, BOX_W, landed ? 48 : 26, 6);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = at.alpha;
    ctx.font = `12px ${theme.mono}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.accent;
    ctx.fillText(">", bx + 10, by + 13);
    ctx.fillStyle = theme.fg2;
    const typed = text.slice(0, at.typed);
    ctx.fillText(typed, bx + 24, by + 13);
    if (at.fly < 1 && (s.t >> 4) % 2 === 0) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(bx + 25 + ctx.measureText(typed).width, by + 7, 6, 12);
    }
    ctx.font = `${LABEL_FONT}px ${theme.mono}`;
    let x = bx + 24;
    for (let n = 0; n < landed; n++) {
      const word = s.cloud.points[hits[n].i].label, score = hits[n].score.toFixed(2).slice(1);
      ctx.fillStyle = theme.fg2;
      ctx.fillText(word, x, by + 35);
      x += ctx.measureText(word).width + 4;
      ctx.fillStyle = n === 0 ? theme.accent : theme.fg4;
      ctx.fillText(score, x, by + 35);
      x += ctx.measureText(score).width + 14;
    }
  }

  (window.OMP_BACKDROP_RENDERERS ??= {}).latent = {
    stepMs: 33,
    plate: true,
    create(env) {
      const B = window.OMP_BACKDROPS;
      const { width: w, height: h, fit, compact, rand } = env;
      const cloud = B.makeCloud(compact ? 11 : 22, rand, { spread: 0.16 });
      const dust = [];
      while (dust.length < (compact ? 24 : 80)) {
        const p = { x: rand() * 2 - 1, y: rand() * 2 - 1, z: rand() * 2 - 1 };
        if (p.x * p.x + p.y * p.y + p.z * p.z < 1) dust.push({ x: p.x * 1.3, y: p.y * 1.3, z: p.z * 1.3 });
      }
      const n = cloud.points.length;
      const scale = Math.min(w * 0.36, h * (compact ? 0.62 : 0.5));
      const s = {
        cloud, dust, proj: buffers(n), dustProj: buffers(dust.length),
        order: Uint16Array.from({ length: n }, (_, i) => i), lens: new Float32Array(n),
        tiltYaw: 0, tiltPitch: 0, labels: new Float32Array(HITS * 3),  // placed hit words: x, y, width
        cx: w / 2, cy: fit ? fit.y + fit.height / 2 : h / 2, scale,
        // Wide canvases get an ellipsoid reaching towards the sides, so the
        // clusters orbit around the logo instead of hiding behind it.
        stretch: Math.min(2.1, Math.max(1, (w * 0.36) / (scale * 0.62))),
        yaw: rand() * Math.PI * 2, steps: 0,
        t: START_T, query: null,
        spritesKey: "", sprites: null,
      };
      // The search box sits low under the logo (clear of it and of the
      // densest part of the cloud), or above the logo when there's no room.
      if (!compact) {
        const below = fit ? Math.max(fit.y + fit.height + fit.font * 5, h * 0.8 - 24) : h - 64;
        s.box = { x: Math.round(w / 2 - BOX_W / 2), y: Math.round(below + 56 < h ? below : (fit ? fit.y - fit.font * 4 - 48 : 16)) };
      }
      s.logo = fit ? { x: fit.x - fit.font * 2, y: fit.y - fit.font * 2, w: fit.width + fit.font * 4, h: fit.height + fit.font * 4 } : null;
      // Queries land clear of the logo and of the search box: one rect
      // around both (the box sits in the middle column, under or over it).
      const keep = [s.logo, s.box && { x: s.box.x, y: s.box.y, w: BOX_W, h: 56 }].filter(Boolean);
      const x0 = Math.min(...keep.map(r => r.x)), y0 = Math.min(...keep.map(r => r.y));
      s.avoid = keep.length
        ? { x: x0, y: y0, w: Math.max(...keep.map(r => r.x + r.w)) - x0, h: Math.max(...keep.map(r => r.y + r.h)) - y0 }
        : null;
      newQuery(s, rand, PITCH);
      return s;
    },
    step(ctx, s, env, theme) {
      const B = window.OMP_BACKDROPS;
      const { width: w, height: h, compact } = env;
      const key = CLUSTER_COLOURS.map(c => theme[c]).join("|") + theme.accent;
      if (key !== s.spritesKey) { s.spritesKey = key; s.sprites = glowSprites(theme); }

      s.steps++;
      s.yaw += YAW_STEP;
      // The pointer: the cloud leans a little towards it (eased, so it never
      // snaps) and points under it light up; a resting cursor fades out.
      const ptr = env.pointer, ps = ptr ? ptr.strength : 0;
      const leanYaw = ps > 0 ? ((ptr.x - s.cx) / w) * 0.45 * ps : 0;
      const leanPitch = ps > 0 ? ((ptr.y - s.cy) / h) * 0.3 * ps : 0;
      s.tiltYaw += (leanYaw - s.tiltYaw) * 0.06;
      s.tiltPitch += (leanPitch - s.tiltPitch) * 0.06;
      const yaw = s.yaw + s.tiltYaw;
      const pitch = PITCH + Math.sin(s.steps * 0.0041) * 0.1 - s.tiltPitch;
      const { points } = s.cloud;
      const P = s.proj, D = s.dustProj, lens = s.lens;
      B.projectCloud(points, yaw, pitch, s.cx, s.cy, s.scale, P);
      B.projectCloud(s.dust, yaw, pitch, s.cx, s.cy, s.scale, D);
      const reach = compact ? 45 : 130;
      for (let i = 0; i < P.x.length; i++) {
        P.x[i] = s.cx + (P.x[i] - s.cx) * s.stretch;
        lens[i] = ps > 0 ? B.proximity(ptr.x, ptr.y, P.x[i], P.y[i], reach) * ps : 0;
      }
      for (let i = 0; i < D.x.length; i++) D.x[i] = s.cx + (D.x[i] - s.cx) * s.stretch;
      B.depthOrder(s.order, P.z);

      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, w, h);

      // Dust: unclustered tokens, far behind everything.
      ctx.fillStyle = theme.fg4;
      for (let i = 0; i < D.x.length; i++) {
        ctx.globalAlpha = depthAlpha(D.z[i]) * 0.55;
        const r = D.k[i] * 0.9;
        ctx.fillRect(D.x[i] - r / 2, D.y[i] - r / 2, r, r);
      }

      // Constellations: each point to its in-cluster nearest neighbour.
      ctx.lineWidth = compact ? 0.6 : 0.8;
      for (let i = 0; i < points.length; i++) {
        const j = points[i].link;
        if (points[j].link === i && j < i) continue;  // a mutual pair: drawn once
        ctx.globalAlpha = depthAlpha((P.z[i] + P.z[j]) / 2) * 0.32 + Math.max(lens[i], lens[j]) * 0.4;
        ctx.strokeStyle = theme[CLUSTER_COLOURS[points[i].cluster]];
        ctx.beginPath();
        ctx.moveTo(P.x[i], P.y[i]);
        ctx.lineTo(P.x[j], P.y[j]);
        ctx.stroke();
      }

      // Points, far to near; the near ones get a soft glow.
      const base = compact ? 1.2 : 1.9;
      for (const i of s.order) {
        const colour = CLUSTER_COLOURS[points[i].cluster];
        const a = depthAlpha(P.z[i]) + (1 - depthAlpha(P.z[i])) * lens[i] * 0.9;
        const r = base * P.k[i] * P.k[i] * (1 + lens[i] * 0.5);
        if (P.z[i] < -0.2 || lens[i] > 0.15) {
          const g = r * 9;
          ctx.globalAlpha = Math.max(a * 0.22, lens[i] * 0.3);
          ctx.drawImage(s.sprites[colour], P.x[i] - g / 2, P.y[i] - g / 2, g, g);
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = theme[colour];
        ctx.beginPath();
        ctx.arc(P.x[i], P.y[i], r, 0, Math.PI * 2);
        ctx.fill();
      }

      const { query } = s;
      const chars = query.text.length;
      const at = B.retrievalAt(s.t, chars, HITS);
      const R = B.RETRIEVAL;
      const landedAt = chars * R.perChar + R.pause + R.fly;
      const hitOf = new Set();
      for (let n = 0; n < HITS; n++) if (at.rays[n] >= 1) hitOf.add(query.hits[n].i);

      if (!compact) {
        ctx.font = `${LABEL_FONT}px ${theme.mono}`;
        ctx.textBaseline = "middle";
        ctx.fillStyle = theme.fg3;
        const L = s.logo;
        for (let i = 0; i < points.length; i++) {
          if (!points[i].label || hitOf.has(i)) continue;
          const x = P.x[i], y = P.y[i];
          if (L && x > L.x && x < L.x + L.w && y > L.y && y < L.y + L.h) continue;
          ctx.globalAlpha = Math.min(1, Math.max(0, depthAlpha(P.z[i]) - 0.15) * 0.9 + lens[i]);
          ctx.fillText(points[i].label, x + 5, y);
        }
      }

      // The query: typed into the box, embedded (flies into the cloud),
      // then rays to its nearest neighbours.
      const qr = B.project(B.rotate(query.q, yaw, pitch), s.cx, s.cy, s.scale);
      const qx = s.cx + (qr.x - s.cx) * s.stretch, qy = qr.y;
      let origin;
      if (s.box) {
        ctx.font = `12px ${theme.mono}`;
        origin = { x: s.box.x + 28 + ctx.measureText(query.text.slice(0, at.typed)).width, y: s.box.y + 13 };
      } else {
        // No box (a preview tile): the query arrives from a side edge.
        origin = { x: query.from < 0.5 ? -10 : w + 10, y: h * (0.2 + query.from * 0.6) };
      }

      ctx.fillStyle = theme.accent;
      ctx.strokeStyle = theme.accent;
      if (at.fly > 0 && at.fly < 1) {
        // A comet along a curve bowed away from the centre.
        const c = { x: (origin.x + qx) / 2, y: Math.min(origin.y, qy) - h * 0.18 };
        for (let n = 7; n >= 0; n--) {
          const t = B.easeInOut(Math.max(0, at.fly - n * 0.025));
          const p = B.bezier(origin, c, { x: qx, y: qy }, t);
          ctx.globalAlpha = at.alpha * (1 - n / 8) * 0.9;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (compact ? 1.6 : 2.6) * (1 - n / 10), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (at.fly >= 1) {
        ctx.lineWidth = compact ? 0.8 : 1.1;
        let placed = 0;
        for (let n = 0; n < HITS; n++) {
          const g = at.rays[n];
          if (g <= 0) continue;
          const { i } = query.hits[n];
          const e = B.easeInOut(g);
          ctx.globalAlpha = at.alpha * 0.75;
          ctx.beginPath();
          ctx.moveTo(qx, qy);
          ctx.lineTo(qx + (P.x[i] - qx) * e, qy + (P.y[i] - qy) * e);
          ctx.stroke();
          if (g < 1) continue;
          // A hit: halo, a ring that spreads once as it lands, its word.
          const age = s.t - (landedAt + n * R.stagger + R.ray);
          const halo = (compact ? 12 : 22) * P.k[i];
          ctx.globalAlpha = at.alpha * 0.5;
          ctx.drawImage(s.sprites.accent, P.x[i] - halo / 2, P.y[i] - halo / 2, halo, halo);
          if (age < 24) {
            ctx.globalAlpha = at.alpha * (1 - age / 24) * 0.8;
            ctx.beginPath();
            ctx.arc(P.x[i], P.y[i], 3 + age * (compact ? 0.35 : 0.7), 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.globalAlpha = at.alpha;
          ctx.beginPath();
          ctx.arc(P.x[i], P.y[i], (compact ? 1.6 : 2.4) * P.k[i], 0, Math.PI * 2);
          ctx.fill();
          if (!compact) {
            // Hits sit close together: nudge a word down past any earlier
            // hit's word it would overprint.
            ctx.font = `${LABEL_FONT}px ${theme.mono}`;
            ctx.textBaseline = "middle";
            const word = points[i].label, lx = P.x[i] + 7, lw = ctx.measureText(word).width;
            let ly = P.y[i];
            for (let m = 0; m < placed; m++) {
              const px = s.labels[m * 3], py = s.labels[m * 3 + 1], pw = s.labels[m * 3 + 2];
              if (Math.abs(ly - py) < 12 && lx < px + pw && lx + lw > px) { ly = py + 12; m = -1; }
            }
            s.labels[placed * 3] = lx; s.labels[placed * 3 + 1] = ly; s.labels[placed * 3 + 2] = lw;
            placed++;
            ctx.fillStyle = theme.fg;
            ctx.fillText(word, lx, ly);
            ctx.fillStyle = theme.accent;
          }
        }
        // The query point itself: a diamond in a frame, pulsing gently,
        // with a ripple as it lands.
        const r = (compact ? 2.6 : 4.2) * (1 + Math.sin(s.t * 0.15) * 0.12);
        const sinceLanding = s.t - landedAt;
        ctx.globalAlpha = at.alpha * 0.5;
        ctx.drawImage(s.sprites.accent, qx - r * 4, qy - r * 4, r * 8, r * 8);
        ctx.globalAlpha = at.alpha;
        diamond(ctx, qx, qy, r);
        ctx.fill();
        if (!compact) {
          ctx.globalAlpha = at.alpha * 0.55;
          ctx.lineWidth = 1;
          diamond(ctx, qx, qy, r * 2.2);
          ctx.stroke();
        }
        if (sinceLanding < 30) {
          ctx.globalAlpha = at.alpha * (1 - sinceLanding / 30) * 0.7;
          ctx.beginPath();
          ctx.arc(qx, qy, r + sinceLanding * (compact ? 0.6 : 1.4), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Last, so the cloud passes behind it rather than through the text.
      if (s.box) drawSearchBox(ctx, s, at, theme);

      if (++s.t >= R.cycle) {
        s.t = 0;
        newQuery(s, env.rand, pitch);
      }
    },
  };
})();
