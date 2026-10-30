// Start screen "orbit": the agent loop. The logo is the model; its tools
// ride a slow elliptical orbit around it. Each turn fires 1–3 parallel calls
// out to tools, the tools execute, results fly back and ripple into the
// model, which thinks briefly and goes again. Pure rules: app/backdrops.js.
// Renderer contract: design/backdrops/backdrop.jsx. Plain-script IIFE.
(function () {
  const SPIN = (2 * Math.PI) / (30 * 150);  // one revolution in ~2.5 min
  const STAGGER = 7;             // steps between a turn's parallel launches
  const TAIL = 14;               // tail dots behind a packet
  const TAIL_GAP = 0.014;        // path progress between tail dots
  const FLASH_STEPS = 26;        // node burst on a call's arrival / departure
  const RIPPLE_STEPS = 52;       // the model "reading" a result
  const LOG_LINES = 5;
  const LOG_FADE = [0.85, 0.55, 0.36, 0.22, 0.12];
  const TAU = Math.PI * 2;
  // Context dust: motes in a band around the track, inner ones faster
  // (Kepler-ish), so the screen keeps a quiet motion between calls.
  const DUST = 90, DUST_COMPACT = 26;
  // The logo is the model: a light sweep crosses its letters as a turn
  // starts (thinking), the letters facing a tool glint as a call leaves
  // (faint) and as its result lands (cyan, rose on failure), and the ripple
  // starts as an echo of the letters themselves.
  const SWEEP_STEPS = 44;
  const GLINT_STEPS = 40;
  const ECHO_STEPS = 34;
  const SWEEP_ALPHA = 0.7;

  /** Offscreen copy of the logo in one colour (light glow, baked once per
   *  size/dpr/theme): the source for the per-cell highlights and the echo. */
  function logoLayer(fit, cells, font, colour, glow, dpr, pad) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((fit.width + pad * 2) * dpr);
    canvas.height = Math.ceil((fit.height + pad * 2) * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.font = font;
    ctx.textBaseline = "top";
    ctx.fillStyle = colour;
    ctx.shadowColor = colour;
    ctx.shadowBlur = glow;
    for (const c of cells) ctx.fillText(c.ch, c.x - fit.x + pad, c.y - fit.y + pad);
    return canvas;
  }

  /** Control point bending C → P to one side (`dir` ±1): the out and back
   *  legs bend opposite ways, so every call draws a closed loop. */
  function bend(c, p, dir, out) {
    const dx = p.x - c.x, dy = p.y - c.y;
    out.x = (c.x + p.x) / 2 - dy * 0.3 * dir;
    out.y = (c.y + p.y) / 2 + dx * 0.3 * dir;
    return out;
  }

  /** A packet at progress `t` on a leg: faint trace of the path so far, a
   *  tapering tail and a haloed head. A moving cursor is a faint gravity
   *  well bending the path as it passes. */
  function packet(ctx, a, c, b, t, colour, compact, well) {
    const { bezier, pullToward } = window.OMP_BACKDROPS;
    const scale = compact ? 0.6 : 1;
    const sigma = compact ? 22 : 80;
    const at = (u) => {
      const q = bezier(a, c, b, u);
      return well.strength > 0 ? pullToward(q, well, sigma) : q;
    };
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.13;
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const q = at((t * i) / 14);
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    }
    ctx.stroke();
    for (let k = TAIL; k >= 1; k--) {
      const tk = t - k * TAIL_GAP;
      if (tk < 0) continue;
      const q = at(tk);
      ctx.globalAlpha = 0.55 * (1 - k / (TAIL + 1));
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.6 * scale * (1 - k / (TAIL + 3)), 0, TAU);
      ctx.fill();
    }
    const h = at(t);
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 8 * scale, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 3 * scale, 0, TAU);
    ctx.fill();
  }

  /** Issue the next turn: its calls launch staggered, and go to the log. */
  function startTurn(s, env) {
    const { nextTurn, callSpans } = window.OMP_BACKDROPS;
    s.turnAt = s.n;
    nextTurn(env.rand).forEach((call, i) => {
      Object.assign(call, { start: s.n + i * STAGGER, spans: callSpans(call), dir: env.rand() < 0.5 ? 1 : -1, arrived: false });
      s.calls.push(call);
      s.log.push({ call, done: false });
    });
    while (s.log.length > LOG_LINES) s.log.shift();
  }

  (window.OMP_BACKDROP_RENDERERS ??= {}).orbit = {
    stepMs: 33,
    plate: true,                 // packets leave from behind the logo
    create(env) {
      const { orbitRadii, nextCall } = window.OMP_BACKDROPS;
      const { width, height, fit, compact, rand } = env;
      const cx = fit ? fit.x + fit.width / 2 : width / 2;
      const cy = fit ? fit.y + fit.height / 2 : height / 2;
      const { rx, ry } = orbitRadii(width, height, fit, compact ? { gap: 10, margin: 12 } : undefined);
      // The model's own extent: ripples start here, hugging the logo.
      const core = fit ? { rx: fit.width * 0.56, ry: fit.height * 0.75 } : { rx: 5, ry: 5 };
      // An earlier history in the log, so the first frame isn't empty.
      const log = [];
      for (let i = 0; i < 3; i++) log.push({ call: nextCall(rand), done: true });
      const { gauss } = window.OMP_BACKDROPS;
      const count = compact ? DUST_COMPACT : DUST;
      const dust = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const k = Math.min(1.3, Math.max(0.6, 0.98 + gauss(rand) * 0.13));
        dust[i * 3] = rand() * TAU;
        dust[i * 3 + 1] = k;
        dust[i * 3 + 2] = (SPIN * 2.2) / (k * Math.sqrt(k));
      }
      return {
        cx, cy, rx, ry, core, log, dust, n: 0, spin: rand() * TAU, calls: [], ripples: [], nextTurnAt: 4,
        turnAt: -1e9, glints: [], layers: null,
        logLines: compact ? 0 : window.OMP_BACKDROPS.logRoom(height, { cx, cy, rx, ry }, { max: LOG_LINES }),
        nodes: [], flash: new Float64Array(8).fill(-1e9),
        from: { x: cx, y: cy }, ctrl: { x: 0, y: 0 },
      };
    },
    step(ctx, s, env, theme) {
      const { TOOLS, ellipsePoint, callPhase, easeInOut, logLine, proximity } = window.OMP_BACKDROPS;
      const { width, height, fit, compact, pointer } = env;
      const { cx, cy, rx, ry, ctrl } = s;
      s.n++;
      // A moving cursor eases the orbit, as if the user were looking closer.
      s.spin += SPIN * (1 - 0.7 * pointer.strength);
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, height);
      if (!(rx > 0 && ry > 0)) return;

      // Orbit rings: the track, and a dashed outer ring drifting against it.
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.line;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = theme.fg4;
      ctx.globalAlpha = 0.28;
      ctx.setLineDash(compact ? [1, 5] : [2, 9]);
      ctx.lineDashOffset = s.n * 0.15;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * 1.07 + 4, ry * 1.07 + 4, 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);

      // Dust, dimmer at the back of the tilted orbit.
      const { dust } = s;
      const mote = compact ? 1 : 1.4;
      ctx.fillStyle = theme.fg3;
      for (let i = 0; i < dust.length; i += 3) {
        const a = (dust[i] += dust[i + 2] * (1 - 0.7 * pointer.strength));
        const sin = Math.sin(a);
        ctx.globalAlpha = 0.14 + 0.26 * (sin + 1) / 2;
        ctx.fillRect(cx + Math.cos(a) * rx * dust[i + 1], cy + sin * ry * dust[i + 1], mote, mote);
      }

      // Node positions; depth 0 at the back (top) of the tilted orbit, 1 in front.
      for (let i = 0; i < TOOLS.length; i++) {
        const a = s.spin + (i * TAU) / TOOLS.length;
        const p = ellipsePoint(a, cx, cy, rx, ry);
        p.a = a;
        p.depth = (Math.sin(a) + 1) / 2;
        p.busy = null;
        s.nodes[i] = p;
      }

      if (!s.calls.length && s.n >= s.nextTurnAt) startTurn(s, env);

      // Calls: out (accent), executing at the tool, back (cyan, rose on failure).
      // Legs start at the model's edge facing the tool, so the logo's plate
      // doesn't swallow most of a short path.
      const from = s.from;
      for (let i = s.calls.length - 1; i >= 0; i--) {
        const call = s.calls[i];
        const node = s.nodes[call.tool];
        const { phase, t } = callPhase(s.n - call.start, call.spans);
        if (phase === "wait") continue;
        from.x = cx + Math.cos(node.a) * s.core.rx * 0.85;
        from.y = cy + Math.sin(node.a) * s.core.ry * 0.85;
        if (!call.left) {
          call.left = true;
          s.glints.push({ born: s.n, x: from.x, y: from.y, tone: 0, power: 0.4 });
        }
        if (phase === "out") {
          packet(ctx, from, bend(from, node, call.dir, ctrl), node, easeInOut(t), theme.accent, compact, pointer);
        } else if (phase === "exec") {
          if (!call.arrived) { call.arrived = true; s.flash[call.tool] = s.n; }
          node.busy = call;
          // The open connection while the tool runs, and the track lit
          // around the busy tool.
          ctx.strokeStyle = theme.accent;
          ctx.globalAlpha = 0.09;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          bend(from, node, call.dir, ctrl);
          ctx.quadraticCurveTo(ctrl.x, ctrl.y, node.x, node.y);
          ctx.stroke();
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, node.a - 0.2, node.a + 0.2);
          ctx.stroke();
          ctx.lineWidth = 1;
        } else if (phase === "back") {
          packet(ctx, node, bend(node, from, call.dir, ctrl), from, easeInOut(t), call.ok ? theme.cyan : theme.rose, compact, pointer);
        } else {
          s.calls.splice(i, 1);
          s.ripples.push({ born: s.n, ok: call.ok });
          s.glints.push({ born: s.n, x: from.x, y: from.y, tone: call.ok ? 1 : 2, power: 1 });
          const entry = s.log.find(e => e.call === call);
          if (entry) entry.done = true;
          if (!s.calls.length) s.nextTurnAt = s.n + 10 + env.rand() * 24;  // thinking
        }
      }
      for (let i = s.glints.length - 1; i >= 0; i--) {
        if (s.n - s.glints[i].born >= GLINT_STEPS) s.glints.splice(i, 1);
      }

      // Ripples: the model reading a result, spreading out from the logo.
      for (let i = s.ripples.length - 1; i >= 0; i--) {
        const r = s.ripples[i];
        const k = (s.n - r.born) / RIPPLE_STEPS;
        if (k >= 1) { s.ripples.splice(i, 1); continue; }
        const grow = easeInOut(Math.min(1, k * 1.2));
        ctx.strokeStyle = r.ok ? theme.cyan : theme.rose;
        ctx.globalAlpha = 0.4 * (1 - k) * (1 - k);
        ctx.lineWidth = 1.4 - k * 0.6;
        ctx.beginPath();
        ctx.ellipse(cx, cy, s.core.rx + (rx * 0.92 - s.core.rx) * grow, s.core.ry + (ry * 0.92 - s.core.ry) * grow, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.lineWidth = 1;

      // Without the logo, a core dot stands in for the model; it breathes
      // slowly, quicker while thinking between turns.
      if (!fit) {
        const thinking = !s.calls.length;
        const breath = (Math.sin(s.n * (thinking ? 0.22 : 0.08)) + 1) / 2;
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.12 + 0.12 * breath;
        ctx.beginPath();
        ctx.arc(cx, cy, (compact ? 6 : 10) + 2 * breath, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, compact ? 2.6 : 4, 0, TAU);
        ctx.fill();
      }

      // Tool nodes; they never overlap, so no depth sort.
      const labels = !compact;
      if (labels) {
        ctx.font = `11px ${theme.mono}`;
        ctx.textBaseline = "middle";
      }
      for (let i = 0; i < s.nodes.length; i++) {
        const p = s.nodes[i];
        // Nodes near a moving cursor swell and brighten a little.
        const hover = pointer.strength * proximity(pointer.x, pointer.y, p.x, p.y, compact ? 60 : 180);
        const near = Math.min(1, 0.55 + 0.45 * p.depth + 0.4 * hover);
        const r = (compact ? 2.4 : 4.2) * (0.8 + 0.3 * p.depth) * (1 + 0.55 * hover);
        const f = Math.max(0, 1 - (s.n - s.flash[i]) / FLASH_STEPS);
        if (f > 0) {
          ctx.strokeStyle = theme.accent;
          ctx.globalAlpha = 0.6 * f;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + (1 - f) * (compact ? 8 : 16), 0, TAU);
          ctx.stroke();
        }
        ctx.globalAlpha = p.busy ? 1 : near;
        ctx.fillStyle = p.busy ? theme.accent : theme.bg;
        ctx.strokeStyle = p.busy ? theme.accent : theme.fg3;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
        ctx.stroke();
        if (p.busy) {
          // A spinner: the tool is executing.
          const a0 = s.n * 0.21;
          ctx.globalAlpha = 0.75;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + (compact ? 3 : 5), a0, a0 + Math.PI * 1.3);
          ctx.stroke();
        }
        ctx.lineWidth = 1;
        if (!labels) continue;
        // Label on the outward side of the node, away from the logo.
        const ox = Math.cos(p.a), oy = Math.sin(p.a);
        const d = r + 11;
        ctx.textAlign = ox > 0.35 ? "left" : ox < -0.35 ? "right" : "center";
        const lx = p.x + ox * d, ly = p.y + oy * d * 0.9;
        ctx.globalAlpha = p.busy ? 1 : Math.min(1, 0.5 + 0.4 * p.depth + 0.5 * hover);
        ctx.fillStyle = p.busy ? theme.fg : theme.fg3;
        ctx.fillText(TOOLS[i].name, lx, ly);
        if (p.busy) {
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = theme.fg3;
          ctx.fillText(p.busy.label, lx, ly + (oy < -0.35 ? -14 : 14));
        }
      }

      // Call log, bottom-left: newest at the bottom, older lines fading up.
      // Only as many lines as clear the orbit (none in a tile).
      if (!s.logLines) return;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `11px ${theme.mono}`;
      const x = 24, y0 = height - 24;
      for (let j = 0; j < s.log.length; j++) {
        const age = s.log.length - 1 - j;
        if (age >= s.logLines) continue;
        const { call, done } = s.log[j];
        const y = y0 - age * 17;
        const fade = LOG_FADE[age] ?? 0;
        const blink = done ? 1 : 0.35 + 0.65 * ((Math.sin(s.n * 0.25) + 1) / 2);
        ctx.globalAlpha = fade * blink;
        ctx.fillStyle = !done ? theme.accent : call.ok ? theme.cyan : theme.rose;
        ctx.beginPath();
        ctx.arc(x + 3, y, 2.5, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = fade;
        ctx.fillStyle = theme.fg2;
        ctx.fillText(logLine(call, done), x + 13, y);
      }
    },

    logo(ctx, s, env, theme) {
      const { logoSweep, proximity, easeInOut } = window.OMP_BACKDROPS;
      const { fit, logo, pointer } = env;
      const { cells } = logo;
      const dpr = ctx.getTransform().a || 1;
      const key = `${fit.x}|${fit.y}|${fit.width}|${fit.height}|${dpr}|${theme.fg}|${theme.cyan}|${theme.rose}|${theme.mono}`;
      if (s.layers?.key !== key) {
        const pad = Math.ceil(fit.font);
        const font = `${fit.font}px ${theme.mono}`;
        const glow = fit.font * 0.35;
        s.layers = {
          key, pad,
          tones: [theme.fg, theme.cyan, theme.rose].map(c => logoLayer(fit, cells, font, c, glow, dpr, pad)),
          weights: [0, 1, 2].map(() => new Float32Array(cells.length)),
        };
      }
      const { pad, tones, weights } = s.layers;
      const lx = fit.x - pad, ly = fit.y - pad;
      const lw = fit.width + pad * 2, lh = fit.height + pad * 2;
      const mx = fit.x + fit.width / 2, my = fit.y + fit.height / 2;

      // The echo: a result's ripple leaves as a copy of the letters
      // swelling outward, behind the logo itself.
      for (const r of s.ripples) {
        const k = (s.n - r.born) / ECHO_STEPS;
        if (k >= 1) continue;
        const grow = 1 + 0.1 * easeInOut(k);
        ctx.globalAlpha = 0.24 * (1 - k) * (1 - k);
        ctx.drawImage(tones[r.ok ? 1 : 2], mx - (mx - lx) * grow, my - (my - ly) * grow, lw * grow, lh * grow);
      }
      ctx.globalAlpha = 1;
      logo.paintDefault(ctx);

      // Per-cell highlights: sweep and pointer (fg), glints by tone.
      const sweepK = (s.n - s.turnAt) / SWEEP_STEPS;
      const sx = fit.width * 0.2, sy = fit.height * 0.9;
      const reach = fit.font * 9;
      for (const w of weights) w.fill(0);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
        let hot = SWEEP_ALPHA * logoSweep(c.col, c.row, sweepK);
        if (pointer.strength) hot += 0.3 * pointer.strength * proximity(pointer.x, pointer.y, ccx, ccy, reach);
        weights[0][i] = hot;
        for (const g of s.glints) {
          const k = (s.n - g.born) / GLINT_STEPS;
          const fade = k < 0.15 ? k / 0.15 : ((1 - k) / 0.85) ** 2;
          const dx = (ccx - g.x) / sx, dy = (ccy - g.y) / sy;
          weights[g.tone][i] += g.power * fade * Math.exp(-(dx * dx + dy * dy));
        }
      }
      for (let t = 0; t < tones.length; t++) {
        const src = tones[t], w = weights[t];
        for (let i = 0; i < cells.length; i++) {
          if (w[i] < 0.03) continue;
          const c = cells[i];
          ctx.globalAlpha = Math.min(0.9, w[i]);
          ctx.drawImage(src, (c.x - lx) * dpr, (c.y - ly) * dpr, c.w * dpr, c.h * dpr, c.x, c.y, c.w, c.h);
        }
      }
    },
  };
})();
