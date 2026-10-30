// Start screen "attention": a small transformer writing code one token at
// a time. Below the logo the stack: a residual stream rises from each token
// of the context window through four layers (attention → add & norm →
// MLP); the newest token is the query, its activation climbs layer by
// layer and in each layer its heads attend back to the cached tokens,
// drawn as arcs in the head's colour, thickness and alpha the weight. Above
// the logo, each head's causal (lower-triangular) attention matrix for the
// running layer. At the top of the stack the next token is predicted, it
// joins the window and the window slides. The logo: attention-logo.js.
// Rules: app/backdrops-attention.js. Renderer contract:
// design/backdrops/backdrop.jsx. Plain-script IIFE.
(function () {
  const STEP_MS = 40;
  const HEAD_COLOUR = ["cyan", "amber", "lilac", "rose"];
  const HEAD_LIFT = [1, 0.84, 0.68, 0.52];  // arc height per head, so the heads nest
  const KIND_COLOUR = { keyword: "fg", string: "fg2", number: "fg2", ident: "fg2", punct: "fg3" };
  const FONT = 12;
  const SWEEP = 3;          // logo columns per step of the causal-mask sweep
  const STREAM_GAP = 18;    // px between a token and the foot of its stream

  const { clamp } = window.OMP_BACKDROPS;
  const { LOGO_COLS } = window.OMP_MATRIX;

  /** A fresh context window at `k`: its tokens, every layer's attention
   *  maps, and the prediction (the token after the window). */
  function load(s, k, rand) {
    const B = window.OMP_BACKDROPS;
    s.k = k;
    s.tokens = B.windowAt(k, s.n);
    s.maps = Array.from({ length: B.LAYERS }, (_, l) => B.attentionMaps(s.tokens, l));
    const truth = B.windowAt(k + s.n, 1)[0];
    s.pred = { tok: truth, p: B.candidates(truth, 4, rand)[0].p };
  }

  /** Paint the static layer (once per layout/theme): background, the
   *  stack's bands, streams, nodes and labels, the heatmap frames with
   *  their masked upper triangles, and the head labels. */
  function paintStatic(g, s, env, theme) {
    g.fillStyle = theme.bg;
    g.fillRect(0, 0, env.width, env.height);
    const { slots, layers, heads, rowY } = s.L, n = s.n;
    const slotW = slots[1] - slots[0];
    g.strokeStyle = theme.fg4;
    g.fillStyle = theme.fg4;

    if (!env.compact) {
      const left = slots[0] - slotW / 2, right = slots[n] + slotW / 2;
      const layerH = layers[0].bottom - layers[0].top;
      const top = layers[layers.length - 1].top;
      // Layer bands.
      g.globalAlpha = 0.05;
      layers.forEach(ly => g.fillRect(left, ly.top + 3, right - left, layerH - 6));
      // Residual streams, one per window slot.
      g.globalAlpha = 0.4;
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < n; i++) { g.moveTo(slots[i], rowY - STREAM_GAP); g.lineTo(slots[i], top + 4); }
      g.stroke();
      const box = { w: Math.min(slotW * 0.42, 26), h: clamp(layerH * 0.16, 4, 10) };
      const r = clamp(layerH * 0.045, 1.6, 3.2);
      for (const ly of layers) {
        for (let i = 0; i < n; i++) {
          const x = slots[i];
          g.globalAlpha = 0.65;
          g.beginPath(); g.arc(x, ly.attnY, r, 0, Math.PI * 2); g.fill();
          g.fillStyle = theme.bg;
          g.fillRect(x - box.w / 2, ly.mlpY - box.h / 2, box.w, box.h);
          g.fillStyle = theme.fg4;
          g.strokeRect(x - box.w / 2, ly.mlpY - box.h / 2, box.w, box.h);
          if (layerH >= 36) {
            const rr = r + 1.2;
            g.globalAlpha = 0.5;
            g.fillStyle = theme.bg;
            g.beginPath(); g.arc(x, ly.normY, rr, 0, Math.PI * 2); g.fill(); g.stroke();
            g.fillStyle = theme.fg4;
            g.beginPath();
            g.moveTo(x - rr * 0.6, ly.normY); g.lineTo(x + rr * 0.6, ly.normY);
            g.moveTo(x, ly.normY - rr * 0.6); g.lineTo(x, ly.normY + rr * 0.6);
            g.stroke();
          }
        }
      }
      s.box = box;
      // Labels left of the stack; "attn" / "mlp" only where they don't crowd.
      g.font = `10px ${theme.mono}`;
      g.textBaseline = "middle";
      g.globalAlpha = 0.9;
      const roomy = layerH >= 44;
      layers.forEach((ly, l) => {
        g.textAlign = "right";
        if (roomy) {
          g.fillText("attn", left - 6, ly.attnY);
          g.fillText("mlp", left - 6, ly.mlpY);
        }
        g.textAlign = "left";
        g.fillText(`L${l + 1}`, Math.max(4, left - (roomy ? 58 : 24)), (ly.top + ly.bottom) / 2);
      });
      // Under the row: what each slot is.
      g.textAlign = "center";
      g.textBaseline = "top";
      g.globalAlpha = 0.7;
      const capY = rowY + 13;
      g.fillText("cached k, v", (slots[0] + slots[n - 2]) / 2, capY);
      g.fillText("query", slots[n - 1], capY);
      g.fillText("next", slots[n], capY);
      g.globalAlpha = 0.35;
      g.beginPath();
      g.moveTo(slots[0] - 6, capY - 3); g.lineTo(slots[n - 2] + 6, capY - 3);
      g.stroke();
    }
    // The prediction's slot: a dashed box.
    g.globalAlpha = 0.45;
    g.setLineDash([3, 3]);
    const pw = env.compact ? slotW * 0.75 : Math.min(slotW - 8, 90), ph = env.compact ? 7 : 20;
    g.strokeRect(slots[n] - pw / 2, rowY - ph / 2, pw, ph);
    g.setLineDash([]);

    // Heatmap frames: masked (future) cells as faint dots, the head label.
    heads.forEach((hm, h) => {
      const cell = hm.size / n;
      g.globalAlpha = 0.35;
      g.strokeStyle = theme.fg4;
      g.strokeRect(hm.x - 0.5, hm.y - 0.5, hm.size + 1, hm.size + 1);
      g.fillStyle = theme.fg4;
      g.globalAlpha = 0.45;
      const d = Math.max(1, cell * 0.12);
      for (let q = 0; q < n; q++) {
        for (let k = q + 1; k < n; k++) g.fillRect(hm.x + (k + 0.5) * cell - d / 2, hm.y + (q + 0.5) * cell - d / 2, d, d);
      }
      if (!env.compact) {
        g.globalAlpha = 0.9;
        g.font = `10px ${theme.mono}`;
        g.textAlign = "left";
        g.textBaseline = "top";
        g.fillStyle = theme[HEAD_COLOUR[h]];
        g.fillText(`h${h + 1} ${window.OMP_BACKDROPS.HEADS[h].label}`, hm.x, hm.y + hm.size + 6);
      }
    });
  }

  /** Arcs from query slot `q` back to its keys at row `y`, one family per
   *  head: grown `grow` (0..1) of the way, `alpha` overall. Each arc is a
   *  cubic "bridge" (vertical at both ends), so far keys still read as
   *  arcs under the height cap; a partial one is its de Casteljau prefix. */
  function drawArcs(ctx, s, theme, weights, q, ly, grow, alpha, thin) {
    if (alpha < 0.01 || grow <= 0) return;
    const xs = s.L.slots, y = ly.attnY;
    ctx.lineCap = "round";
    weights.forEach((row, h) => {
      ctx.strokeStyle = ctx.fillStyle = theme[HEAD_COLOUR[h]];
      for (let k = 0; k < q; k++) {
        const w = row[q][k];
        if (w < 0.04) continue;
        // Height grows with the distance, so the arcs nest: neighbours low,
        // the farthest key at the layer's cap.
        const reach = (xs[q] - xs[k]) / (xs[s.n - 1] - xs[0]);
        const lift = ly.cap * (0.22 + 0.78 * reach) * HEAD_LIFT[h] * (4 / 3);
        // The de Casteljau prefix of (X0, y) → (X0, y − lift) →
        // (X0 + dX, y − lift) → (X0 + dX, y), as scalars: control points
        // (X0, ay) and (bx, by), end (ex, ey).
        const X0 = xs[q], dX = xs[k] - X0, g = grow, lg = lift * g;
        const ay = y - lg, bx = X0 + dX * g * g, by = y - lg * (2 - g);
        const ex = X0 + dX * g * g * (3 - 2 * g), ey = y - 3 * lg * (1 - g);
        ctx.globalAlpha = alpha * (0.1 + 0.9 * w ** 0.7);
        ctx.lineWidth = (thin ? 0.5 : 0.8) + w * (thin ? 1.6 : 3.4);
        ctx.beginPath();
        ctx.moveTo(X0, y);
        ctx.bezierCurveTo(X0, ay, bx, by, ex, ey);
        ctx.stroke();
        if (grow > 0.97 && !thin) {
          ctx.beginPath(); ctx.arc(xs[k], y, 1.4 + w * 3.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    });
  }

  /** Each head's matrix: earlier rows (computed for earlier tokens) a
   *  little dimmer, the query row filling in as its attention runs; `focus`
   *  (a hovered row, or -1) and cells near the pointer brighten. */
  function drawHeatmaps(ctx, s, env, theme, maps, grow, focus) {
    const { proximity } = window.OMP_BACKDROPS;
    const n = s.n, pt = env.pointer;
    s.L.heads.forEach((hm, h) => {
      const cell = hm.size / n, inset = cell > 6 ? 1 : 0.5;
      ctx.fillStyle = theme[HEAD_COLOUR[h]];
      for (let q = 0; q < n; q++) {
        const rowA = q === n - 1 ? grow : q === focus ? 1 : 0.62;
        for (let k = 0; k <= q; k++) {
          const x = hm.x + k * cell, y = hm.y + q * cell;
          let a = rowA * (0.06 + 0.94 * maps[h][q][k] ** 0.6);
          a += proximity(pt, x + cell / 2, y + cell / 2, hm.size * 0.4) * 0.35;
          if (a < 0.02) continue;
          ctx.globalAlpha = Math.min(1, a);
          ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2);
        }
      }
      // The query row's outline (accent), and the hovered one's.
      ctx.lineWidth = 1;
      for (const [q, colour, a] of [[n - 1, theme.accent, 0.8], [focus, theme.fg, 0.5]]) {
        if (q < 0 || (q === n - 1 && colour !== theme.accent)) continue;
        ctx.globalAlpha = a;
        ctx.strokeStyle = colour;
        ctx.strokeRect(hm.x - 1.5, hm.y + q * cell - 0.5, hm.size + 3, cell + 1);
      }
    });
  }

  /** The query the pointer picks: the hovered token slot, or the row of a
   *  hovered heatmap; -1 when neither. */
  function hoverQuery(s, env) {
    const pt = env.pointer;
    if (pt.strength < 0.01) return -1;
    for (const hm of s.L.heads) {
      if (pt.x >= hm.x && pt.x < hm.x + hm.size && pt.y >= hm.y && pt.y < hm.y + hm.size) {
        return Math.floor(((pt.y - hm.y) / hm.size) * s.n);
      }
    }
    const ly = s.L.layers, top = env.compact ? 0 : ly[ly.length - 1].top;
    if (pt.y < top || pt.y > s.L.rowY + 16) return -1;
    const j = window.OMP_BACKDROPS.slotAt(pt.x, s.L.slots);
    return j < s.n ? j : -1;
  }

  /** The token row: the window (sliding one slot left during the slide),
   *  the query in the accent, the prediction appearing in the last slot. */
  function drawTokens(ctx, s, env, theme, ph, focus) {
    const { tokenKind, easeInOut } = window.OMP_BACKDROPS;
    const xs = s.L.slots, n = s.n, slotW = xs[1] - xs[0], y = s.L.rowY;
    const shift = ph.stage === "slide" ? easeInOut(ph.u) * slotW : 0;
    const predA = ph.stage === "out" ? clamp((ph.u - 0.45) / 0.35, 0, 1) : ph.stage === "slide" ? 1 : 0;
    const all = [...s.tokens, s.pred.tok];
    if (env.compact) {
      const w = slotW * 0.62, h = 5;
      all.forEach((tok, i) => {
        const a = i === n ? predA : i === 0 ? 1 - shift / slotW : 1;
        if (a < 0.02) return;
        const q = i === n - 1 && !shift;
        ctx.globalAlpha = a * (q || i === n ? 1 : 0.55);
        ctx.fillStyle = q || i === n ? theme.accent : theme[KIND_COLOUR[tokenKind(tok)] ?? "fg2"];
        ctx.fillRect(xs[i] - shift - w / 2, y - h / 2, w, h);
      });
      return;
    }
    ctx.font = `${FONT}px ${theme.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    s.charW ??= ctx.measureText("0").width;
    const max = Math.max(2, Math.floor((slotW - 8) / s.charW));
    all.forEach((tok, i) => {
      const a = i === n ? predA : i === 0 ? 1 - shift / slotW : 1;
      if (a < 0.02) return;
      const text = tok.length > max ? `${tok.slice(0, max - 1)}…` : tok;
      const x = xs[i] - shift, q = i === n - 1 && !shift;
      ctx.globalAlpha = a * (q || i === n ? 1 : 0.8);
      ctx.fillStyle = q || i === n ? theme.accent : theme[KIND_COLOUR[tokenKind(tok)] ?? "fg2"];
      ctx.fillText(text, x, y);
      if (i === focus && !q && !shift) {
        // The hovered token, now a query too: lifted to full strength.
        ctx.globalAlpha = env.pointer.strength;
        ctx.fillStyle = theme.fg;
        ctx.fillText(text, x, y);
      }
      if (i === n && ph.stage === "out") {
        ctx.globalAlpha = predA * 0.85;
        ctx.fillStyle = theme.fg4;
        ctx.font = `10px ${theme.mono}`;
        ctx.fillText(`p ${s.pred.p.toFixed(2)}`, x, y - 20);
        ctx.font = `${FONT}px ${theme.mono}`;
      }
    });
  }

  (window.OMP_BACKDROP_RENDERERS ??= {}).attention = {
    stepMs: STEP_MS,
    plate: false,            // the stack and heatmaps keep clear of the logo
    create(env) {
      const B = window.OMP_BACKDROPS;
      const L = B.attentionLayout(env);
      const s = { L, n: L.n, t: 0, art: null, logoW: new Float32Array(L.n * B.HEADS.length), front: -6 };
      load(s, Math.floor(env.rand() * B.SEQUENCE.length), env.rand);
      return s;
    },
    step(ctx, s, env, theme) {
      const B = window.OMP_BACKDROPS;
      if (s.art?.theme !== theme) s.art = { theme, base: env.layer(g => paintStatic(g, s, env, theme)) };

      // ── simulate ──
      if (++s.t >= B.CYCLE) {
        s.t = 0;
        load(s, s.k + 1, env.rand);
        s.front = -6;
      }
      const ph = B.phaseAt(s.t);
      if (s.front != null && (s.front += SWEEP) > LOGO_COLS + 24) s.front = null;
      const grow = ph.stage === "attn" ? B.easeInOut(Math.min(1, ph.u / 0.55)) : 1;
      const fade = ph.stage === "out" ? 1 - ph.u * 0.4 : ph.stage === "slide" ? 0.6 * (1 - ph.u) : 1;
      // The logo follows the query's attention, a band of rows per head.
      const q = s.n - 1, maps = s.maps[ph.layer];
      maps.forEach((m, h) => {
        for (let k = 0; k < s.n; k++) {
          const i = h * s.n + k;
          s.logoW[i] += (m[q][k] ** 0.6 * grow * fade - s.logoW[i]) * 0.12;
        }
      });

      // ── paint ──
      ctx.drawImage(s.art.base, 0, 0, env.width, env.height);
      const { layers, slots } = s.L;
      // Heatmaps cross-fade from the previous layer as a new one starts.
      const prev = ph.layer > 0 && ph.stage === "attn" ? s.maps[ph.layer - 1] : null;
      const blend = prev ? Math.min(1, ph.u / 0.3) : 1;
      const shown = blend < 1 ? maps.map((m, h) => m.map((r, i) => r.map((w, k) => prev[h][i][k] + (w - prev[h][i][k]) * blend))) : maps;
      const focus = hoverQuery(s, env);
      drawHeatmaps(ctx, s, env, theme, shown, ph.stage === "slide" ? 1 - ph.u : grow, focus);
      if (s.L.caption) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = theme.fg4;
        ctx.font = `10px ${theme.mono}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(`layer ${ph.layer + 1}/${B.LAYERS} · masked multi-head self-attention`, s.L.caption.x, s.L.caption.y);
      }

      // The query's activation climbing its residual stream.
      if (!env.compact) {
        const x = slots[q], y0 = s.L.rowY - STREAM_GAP;
        const lyTop = layers[layers.length - 1].top;
        const climb = Math.min(1, s.t / (B.LAYERS * (B.TIMELINE.attn + B.TIMELINE.mlp)));
        const fy = y0 + (lyTop + 4 - y0) * climb;
        ctx.globalAlpha = 0.85 * fade;
        ctx.strokeStyle = ctx.fillStyle = theme.accent;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, fy); ctx.stroke();
        // MLP boxes the query has passed light up.
        layers.forEach((ly, l) => {
          const lit = l < ph.layer || ph.stage === "out" || ph.stage === "slide" ? 0.55 : l === ph.layer && ph.stage === "mlp" ? 0.4 + 0.6 * ph.u : 0;
          if (!lit) return;
          ctx.globalAlpha = lit * fade;
          ctx.fillRect(x - s.box.w / 2, ly.mlpY - s.box.h / 2, s.box.w, s.box.h);
        });
        ctx.globalAlpha = fade;
        ctx.drawImage(env.halo(theme.accent), x - 12, fy - 12, 24, 24);
        ctx.beginPath(); ctx.arc(x, fy, 2.6, 0, Math.PI * 2); ctx.fill();
        // Out of the top: unembed, and the prediction drops into its slot.
        if (ph.stage === "out") {
          const p0 = { x, y: lyTop + 4 }, p2 = { x: slots[s.n], y: s.L.rowY - 26 };
          const c = { x: p2.x + (p2.x - p0.x) * 0.4, y: p0.y };
          const g = B.easeInOut(Math.min(1, ph.u / 0.5)), end = B.bezier(p0, c, p2, g);
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.quadraticCurveTo(p0.x + (c.x - p0.x) * g, p0.y + (c.y - p0.y) * g, end.x, end.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Arcs: earlier layers' faint, the running layer's growing in.
      const thin = env.compact;
      if (!env.compact) {
        for (let l = 0; l < ph.layer; l++) drawArcs(ctx, s, theme, s.maps[l], q, layers[l], 1, 0.16 * fade, true);
      }
      drawArcs(ctx, s, theme, maps, q, layers[ph.layer], grow, fade, thin);
      if (focus >= 0 && focus !== q) {
        drawArcs(ctx, s, theme, maps, focus, layers[ph.layer], 1, env.pointer.strength * 0.9, thin);
      }
      drawTokens(ctx, s, env, theme, ph, focus);
    },
    logo(ctx, s, env, theme) {
      window.OMP_ATTENTION_LOGO.paint(ctx, s, env, theme);
    },
  };
})();
