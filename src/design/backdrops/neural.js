// Start screen "neural": a forward pass. A window of five code tokens feeds
// a small layered network; pulses carry activations layer to layer, nodes
// fire when their input crosses a threshold, and the strongest output names
// the next token. Then the window slides one token and the next pass runs.
// Simulation: app/backdrops.js (forward pass). Renderer contract:
// design/backdrops/backdrop.jsx. Plain-script IIFE.
(function () {
  const SIZES = [5, 9, 12, 12, 9, 5];
  const SIZES_COMPACT = [4, 6, 7, 6, 4];
  const CAPTIONS = ["tokens", "embed", "attn", "mlp", "attn", "logits"];
  const SPEED = 0.045;        // edge lengths per step: ~0.7 s per layer
  const HOLD = 14;            // steps the prediction stands before the next pass
  const DECAY = 0.94;         // per-step fade of a fired node's glow
  const TAIL = 0.22;          // pulse tail, as a fraction of its edge
  const FONT = 12;
  const MAX_GAP = 60;         // px between nodes at most
  const MAX_TOK = 13;         // longer tokens (string literals) are clipped
  const FADE = 12;            // steps for the window slide and label cross-fade
  const KIND_COLOUR = { keyword: "lilac", string: "amber", number: "cyan", ident: "fg2", punct: "fg3" };
  const { LOGO_COLS } = window.OMP_MATRIX;
  const { clamp } = window.OMP_BACKDROPS;

  const clip = tok => (tok.length > MAX_TOK ? `${tok.slice(0, MAX_TOK - 1)}…` : tok);

  /** Node positions: margins leave room for the token labels either side;
   *  with the logo up, the layers part around it (the plate would hide the
   *  middle nodes and labels), else spacing is capped so tall windows
   *  don't stretch the net. */
  function layout(env, sizes) {
    const { layerLayout, bandLayout } = window.OMP_BACKDROPS;
    const { width: W, height: H, compact, fit } = env;
    const padL = compact ? W * 0.08 : clamp(W * 0.13, 90, 180);
    const padR = compact ? W * 0.08 : clamp(W * 0.17, 130, 220);
    const padY = compact ? H * 0.14 : Math.max(44, H * 0.12);
    const width = Math.min(W - padL - padR, 1500);
    const x = padL + (W - padL - padR - width) / 2;
    if (fit) {
      const m = fit.font * 2.4;
      const band = { top: fit.y - m, bottom: fit.y + fit.height + m };
      return bandLayout(sizes, { x, y: padY, width, height: H - padY * 2 }, band, MAX_GAP);
    }
    const height = Math.min(H - padY * 2, (Math.max(...sizes) - 1) * MAX_GAP);
    return layerLayout(sizes, { x, y: (H - height) / 2, width, height });
  }

  /** The static layers, once per layout/theme: background, faint wiring,
   *  idle node rings and captions; plus the same wiring in the accent,
   *  revealed around the pointer. */
  function renderStatic(s, env, theme) {
    const wires = (g) => {
      g.beginPath();
      for (let l = 0; l + 1 < s.nodes.length; l++) {
        for (const a of s.nodes[l]) for (const b of s.nodes[l + 1]) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
      }
      g.stroke();
    };
    const base = env.layer((g) => {
      g.fillStyle = theme.bg;
      g.fillRect(0, 0, env.width, env.height);
      // One path: crossings don't stack, so the wiring stays an even haze.
      g.strokeStyle = theme.fg4;
      g.lineWidth = 0.7;
      g.globalAlpha = env.compact ? 0.3 : 0.22;
      wires(g);
      g.globalAlpha = 1;
      g.fillStyle = theme.bg;
      g.strokeStyle = theme.fg4;
      g.lineWidth = 1;
      for (const layer of s.nodes) {
        for (const n of layer) { g.beginPath(); g.arc(n.x, n.y, s.r, 0, Math.PI * 2); g.fill(); g.stroke(); }
      }
      if (!env.compact) {
        g.font = `10px ${theme.mono}`;
        g.textAlign = "center";
        g.textBaseline = "top";
        g.fillStyle = theme.fg4;
        const y = Math.max(...s.nodes.flat().map(n => n.y)) + s.gap * 0.9;
        s.nodes.forEach((layer, l) => g.fillText(CAPTIONS[l] ?? "", layer[0].x, y));
      }
    });
    const lit = env.layer((g) => {
      g.strokeStyle = theme.accent;
      g.lineWidth = 0.9;
      wires(g);
    });
    return { base, lit };
  }

  /** The prediction for window `k` (its first token SEQUENCE[k], the
   *  truth the token after the input layer): the ranked output nodes
   *  paired with candidates, the true token first. */
  function predict(s, k, order, rand) {
    const { tokenAt, candidates } = window.OMP_BACKDROPS;
    const truth = tokenAt(k + s.sizes[0]);
    const cands = candidates(truth, order.length, rand);
    return { labels: order.map((node, r) => ({ node, ...cands[r] })), age: 0 };
  }

  (window.OMP_BACKDROP_RENDERERS ??= {}).neural = {
    stepMs: 33,
    plate: true,
    create(env) {
      const { startPass, SEQUENCE } = window.OMP_BACKDROPS;
      const sizes = env.compact ? SIZES_COMPACT : SIZES;
      const nodes = layout(env, sizes);
      const gap = nodes[0][1].y - nodes[0][0].y;
      const s = {
        sizes, nodes, gap, r: clamp(gap * 0.16, 2.2, 6.5),
        glow: sizes.map(n => new Float32Array(n)), heat: sizes.map(n => new Float32Array(n)),
        k: Math.floor(env.rand() * SEQUENCE.length), slide: FADE, passes: [], wait: -1,
        pred: null, prev: null, art: null, front: null,
        colGlow: new Float32Array(LOGO_COLS), colSeed: new Float32Array(LOGO_COLS),
      };
      // Open on the previous window's prediction (now the last input token),
      // so the outputs are labelled from the first frame.
      const order = sizes[sizes.length - 1];
      s.pred = predict(s, s.k - 1, Array.from({ length: order }, (_, i) => i).sort(() => env.rand() - 0.5), env.rand);
      s.pred.age = FADE * 2;
      s.passes.push(startPass(sizes, env.rand));
      absorb(s, s.passes[0].events);
      return s;
    },
    step(ctx, s, env, theme) {
      const { advancePass, startPass, rankOutputs, proximity, SEQUENCE, tokenAt, tokenKind } = window.OMP_BACKDROPS;
      if (s.art?.theme !== theme) s.art = { theme, ...renderStatic(s, env, theme) };
      const { base, lit } = s.art, halo = env.halo(theme.accent), dpr = env.dpr;
      const last = s.sizes.length - 1;
      const pt = env.pointer;
      const reach = env.compact ? 46 : 170;

      // ── simulate ──
      const ease = (l, i) => proximity(pt, s.nodes[l][i].x, s.nodes[l][i].y, reach);
      for (const pass of s.passes) {
        absorb(s, advancePass(pass, SPEED, env.rand, ease));
        if (pass.done && !pass.reported) {
          pass.reported = true;
          s.prev = s.pred;
          s.pred = predict(s, s.k, rankOutputs(pass), env.rand);
          s.glow[last][s.pred.labels[0].node] = 1.6;
          s.wait = HOLD;
        }
      }
      s.passes = s.passes.filter(p => !p.done);
      if (s.wait >= 0 && s.wait-- === 0) {
        s.k = (s.k + 1) % SEQUENCE.length;
        s.slide = 0;
        const pass = startPass(s.sizes, env.rand);
        s.passes.push(pass);
        absorb(s, pass.events);
      }
      s.slide = Math.min(FADE, s.slide + 1);
      s.pred.age++;

      // ── paint ──
      ctx.drawImage(base, 0, 0, env.width, env.height);
      if (pt.strength > 0.01) {
        // The wiring under the cursor surfaces in the accent: three nested
        // clips stack into a soft falloff without per-frame gradients.
        for (const f of [1, 0.66, 0.36]) {
          const rr = reach * f;
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
          ctx.clip();
          ctx.globalAlpha = 0.16 * pt.strength;
          const sx = clamp(pt.x - rr, 0, env.width), sy = clamp(pt.y - rr, 0, env.height);
          const sw = clamp(pt.x + rr, 0, env.width) - sx, sh = clamp(pt.y + rr, 0, env.height) - sy;
          if (sw > 0 && sh > 0) ctx.drawImage(lit, sx * dpr, sy * dpr, sw * dpr, sh * dpr, sx, sy, sw, sh);
          ctx.restore();
        }
      }

      ctx.strokeStyle = theme.accent;
      ctx.fillStyle = theme.accent;
      ctx.lineCap = "round";
      ctx.lineWidth = env.compact ? 1 : 1.4;
      let frontX = 0, frontN = 0;
      for (const pass of s.passes) {
        for (const p of pass.pulses) {
          if (p.t <= 0) continue;
          const a = s.nodes[p.l][p.from], b = s.nodes[p.l + 1][p.to];
          const dx = b.x - a.x, dy = b.y - a.y, hx = a.x + dx * p.t, hy = a.y + dy * p.t;
          frontX += hx; frontN++;
          // A long faint tail under a short bright one reads as a taper.
          for (const [len, alpha] of [[TAIL, 0.12 + 0.3 * p.w], [TAIL / 3, 0.3 + 0.5 * p.w]]) {
            const t0 = Math.max(0, p.t - len);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.moveTo(a.x + dx * t0, a.y + dy * t0);
            ctx.lineTo(hx, hy);
            ctx.stroke();
          }
          if (!env.compact) {
            ctx.globalAlpha = 0.5 * p.w;
            ctx.drawImage(halo, hx - 7, hy - 7, 14, 14);
          }
          ctx.globalAlpha = 0.6 + 0.4 * p.w;
          ctx.beginPath();
          ctx.arc(hx, hy, env.compact ? 1.2 : 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // The mean pulse x: where the pass is, for the logo's sweep.
      s.front = frontN ? frontX / frontN : null;
      // Logo columns the pass crosses fire (painted in `logo`); kept here so
      // the reduced-motion still frame has the decaying trail too.
      if (env.fit) {
        const cw = env.fit.width / LOGO_COLS;
        for (let c = 0; c < LOGO_COLS; c++) {
          const near = s.front != null && Math.abs(env.fit.x + (c + 0.5) * cw - s.front) < cw * 1.5;
          if (near && s.colGlow[c] < 0.4) { s.colGlow[c] = 1; s.colSeed[c] = env.rand(); }
          else s.colGlow[c] *= 0.93;
        }
      }

      ctx.lineWidth = 1.2;
      for (let l = 0; l <= last; l++) {
        for (let i = 0; i < s.sizes[l]; i++) {
          const n = s.nodes[l][i], g = s.glow[l][i], h = s.heat[l][i], hover = proximity(pt, n.x, n.y, reach);
          s.glow[l][i] = g * DECAY;
          s.heat[l][i] = h * 0.96;
          const ring = Math.max(g, h, hover * 0.8);
          if (ring < 0.03) continue;
          if (g > 0.05) {
            const hs = s.r * (g > 1 ? 11 : 7);
            ctx.globalAlpha = Math.min(1, g) * 0.6;
            ctx.drawImage(halo, n.x - hs / 2, n.y - hs / 2, hs, hs);
            ctx.globalAlpha = Math.min(1, g) * 0.9;
            ctx.beginPath(); ctx.arc(n.x, n.y, s.r * 0.72, 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = Math.min(1, ring);
          ctx.beginPath(); ctx.arc(n.x, n.y, s.r, 0, Math.PI * 2); ctx.stroke();
        }
      }
      if (env.compact) return;

      // ── labels: the token window on the left, the prediction on the right ──
      ctx.font = `${FONT}px ${theme.mono}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      const ins = s.nodes[0], gap = s.gap;
      const e = window.OMP_BACKDROPS.easeInOut(s.slide / FADE);
      const slot = j => (j < 0 ? ins[0].y - gap : j >= ins.length ? ins[ins.length - 1].y + gap : ins[j].y);
      for (let j = -1; j < ins.length; j++) {
        const tok = tokenAt(s.k + j);
        // Each token rises from the slot below it as the window slides.
        const y = slot(j + 1) + (slot(j) - slot(j + 1)) * e;
        const x = ins[0].x - s.r * 2 - 12;
        const fade = j < 0 ? 1 - e : j === ins.length - 1 ? e : 1;
        if (fade < 0.02) continue;
        ctx.globalAlpha = 0.85 * fade;
        ctx.fillStyle = theme[KIND_COLOUR[tokenKind(tok)] ?? "fg2"];
        ctx.fillText(clip(tok), x, y);
        const g = j >= 0 ? s.glow[0][j] : 0;
        if (g > 0.05) { ctx.globalAlpha = g * fade; ctx.fillStyle = theme.accent; ctx.fillText(clip(tok), x, y); }
      }
      ctx.textAlign = "left";
      // Old labels fade out fully before the new ones fade in: they share
      // the same spots, and overlapping text reads as garbage.
      const age = s.pred.age;
      if (s.prev && age < FADE) drawPrediction(ctx, s, theme, s.prev, 1 - age / FADE);
      else drawPrediction(ctx, s, theme, s.pred, s.prev ? Math.min(1, (age - FADE) / FADE) : 1);
    },
    // The logo as a grid of neurons: each solid block a lit node (two
    // stacked per cell, so the lattice is square), the box-drawing shadow
    // a faint wiring layer; columns fire as the forward pass sweeps by.
    logo(ctx, s, env, theme) {
      const { solid, sub } = env.logo, fit = env.fit;
      if (s.logoArt?.theme !== theme) s.logoArt = { theme, ...renderLogo(env.logo, fit, theme, env.rand) };
      const art = s.logoArt, rad = art.rad;
      env.logo.draw(ctx, art.img);
      const reach = fit.font * 9, proximity = window.OMP_BACKDROPS.proximity;
      const halo = env.halo(theme.accent), hs = rad * 7;
      ctx.fillStyle = theme.accent;
      for (let k = 0; k < solid.length; k++) {
        const c = solid[k];
        // Each sweep lights a fresh random half of a column's neurons, so
        // it sparkles instead of moving as a solid bar.
        const g = s.colGlow[c.col] * ((art.noise[k] + s.colSeed[c.col]) % 1 < 0.55 ? 1 : 0.2);
        const lit = Math.max(g, proximity(env.pointer, c.x, c.y, reach) * 0.6);
        if (lit < 0.04) continue;
        for (let j = 0; j < sub; j++) {
          const x = c.x + c.w / 2, y = c.y + (c.h * (j + 0.5)) / sub;
          ctx.globalAlpha = lit * 0.45;
          ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs);
          ctx.globalAlpha = lit;
          ctx.beginPath(); ctx.arc(x, y, rad * (1 + 0.25 * lit), 0, Math.PI * 2); ctx.fill();
        }
      }
    },
  };

  /** Fold one step's landings and firings into the node glow. */
  function absorb(s, events) {
    for (const ev of events) {
      if (ev.fire) s.glow[ev.l][ev.i] = 1;
      else s.heat[ev.l][ev.i] = Math.min(0.55, s.heat[ev.l][ev.i] + 0.22 * ev.w);
    }
  }

  /** The resting logo, once per layout/theme: shadow wiring, a soft glow
   *  (shadowBlur here only, never per frame) and the neuron dots. */
  function renderLogo(logo, fit, theme, rand) {
    const { solid, sub } = logo;
    const { w, h } = solid[0];
    const rad = Math.min(w, h / sub) * 0.4;
    const img = logo.bake(Math.ceil(fit.font * 1.5), (g) => {
      logo.glyphs(g, logo.edges, theme.accent, { alpha: 0.32 });
      const dots = () => {
        g.beginPath();
        for (const c of solid) {
          for (let j = 0; j < sub; j++) {
            const y = c.y + (c.h * (j + 0.5)) / sub;
            g.moveTo(c.x + c.w / 2 + rad, y);
            g.arc(c.x + c.w / 2, y, rad, 0, Math.PI * 2);
          }
        }
        g.fill();
      };
      g.globalAlpha = 0.85;
      g.shadowColor = theme.glow;
      g.shadowBlur = fit.font * 0.8;
      dots();
      g.shadowBlur = 0;
      dots();
    });
    return { img, rad, noise: solid.map(() => rand()) };
  }

  function drawPrediction(ctx, s, theme, pred, alpha) {
    const outs = s.nodes[s.nodes.length - 1];
    pred.labels.forEach(({ node, tok, p }, rank) => {
      const n = outs[node], x = n.x + s.r * 2 + 12, win = rank === 0;
      const text = clip(tok);
      ctx.globalAlpha = alpha * (win ? 1 : 0.7);
      ctx.fillStyle = win ? theme.accent : theme.fg3;
      ctx.fillText(text, x, n.y);
      const w = ctx.measureText(text).width;
      ctx.globalAlpha = alpha * (win ? 0.9 : 0.6);
      ctx.fillStyle = theme.fg4;
      ctx.fillText(p.toFixed(2), x + w + 8, n.y);
      // Probability bar under the token.
      ctx.globalAlpha = alpha * (win ? 0.75 : 0.35);
      ctx.fillStyle = win ? theme.accent : theme.fg4;
      ctx.fillRect(x, n.y + FONT * 0.75, Math.max(2, p * 72), 2);
    });
  }
})();
