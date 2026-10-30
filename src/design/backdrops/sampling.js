// Start screen "sampling": a model writing code one token at a time, the
// top-k candidates for each next token shown as probability bars at the
// cursor (snippets and sampling: app/backdrops.js "next token").
// Renderer contract: design/backdrops/backdrop.jsx. Plain-script IIFE.
(function () {
  const STEP_MS = 33;
  const K = 5;
  const TEMPERATURE = 0.7;
  const GROW = 7;          // steps for the bars to grow in
  const FLASH = 16;        // steps a committed token stays lit
  const HOLD = 90;         // a finished snippet stays this long...
  const FADE = 24;         // ...then fades out
  const KIND_COLOUR = { keyword: "lilac", call: "cyan", string: "amber", number: "rose", ident: "fg", punct: "fg3" };
  // The logo is editor text: typed in as accepted ghost text on create, and
  // re-run by the cursor (a quick reformat sweep) whenever a snippet starts.
  const TYPE_DELAY = 6;    // steps before the logo starts typing
  const TYPE_RATE = 1.6;   // logo columns typed per step (all 91 in ~2 s)
  const SWEEP_RATE = 3.2;  // columns per step of the snippet-start sweep
  const GHOST = 0.22;      // alpha of the not-yet-typed logo

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const easeOut = (t) => 1 - (1 - t) ** 3;
  // A peaked distribution commits fast, a flat one makes the model "hesitate".
  const cycleLen = (p) => Math.round(8 + (1 - p) * 18);

  function load(s, n) {
    const { SNIPPETS, layoutTokens } = window.OMP_BACKDROPS;
    s.snip = n % SNIPPETS.length;
    s.toks = layoutTokens(SNIPPETS[s.snip]);
    s.toks.forEach((t, i) => { if (t.kind === "ident" && s.toks[i + 1]?.tok === "(") t.kind = "call"; });
    s.words = s.toks.filter(t => t.kind !== "space").length;
    s.born = new Float64Array(s.toks.length).fill(-1e9);
    s.idx = 0; s.phase = "gen"; s.t = 0; s.scroll = 0; s.cand = null; s.sweepAt = s.n;
  }

  /** Commit whitespace instantly, then draw the candidates for the next word. */
  function next(s, env) {
    while (s.idx < s.toks.length && s.toks[s.idx].kind === "space") s.idx++;
    s.t = 0;
    if (s.idx >= s.toks.length) { s.phase = "hold"; s.cand = null; return; }
    // A moving mouse warms the sampler: flatter bars, a more hesitant model.
    s.temp = TEMPERATURE + 0.5 * (env.pointer?.strength ?? 0);
    s.cand = window.OMP_BACKDROPS.candidates(s.toks[s.idx].tok, K, env.rand, { temperature: s.temp });
    s.len = cycleLen(s.cand[0].p);
  }

  function advance(s, env) {
    s.n++; s.t++;
    if (s.phase === "gen" && s.t > s.len) {
      s.born[s.idx++] = s.n;
      s.rate = s.rate * 0.85 + 0.15 * (1000 / (s.len * STEP_MS));
      next(s, env);
    } else if (s.phase === "hold" && s.t > HOLD) { s.phase = "fade"; s.t = 0; }
    else if (s.phase === "fade" && s.t > FADE) { load(s, s.snip + 1); next(s, env); }
  }

  /** Where the next token goes (after its indentation), or the end of the code. */
  function cursorOf(s) {
    if (s.idx < s.toks.length) return s.toks[s.idx];
    const last = s.toks[s.toks.length - 1];
    return { line: last.line, col: last.col + last.tok.length };
  }

  function geometry(env) {
    const { width: W, height: H, fit } = env;
    if (env.compact) {
      const pad = 8, w = W - pad * 2, h = H - pad * 2, head = 8;
      const lh = Math.min(8, (h - head - 6) / 7.2);
      return { compact: true, x: pad, y: pad, w, h, head, foot: 0, lh, gutter: 10,
        cw: Math.min(2.6, (w - 16) / 72), codeTop: pad + head + 4, rows: Math.floor((h - head - 6) / lh) };
    }
    const font = clamp(Math.round(Math.min(W / 60, H / 30)), 10, 14);
    const lh = Math.round(font * 1.6), head = Math.round(font * 2.3), foot = Math.round(font * 2.1);
    const chrome = head + foot + 12;
    const w = Math.min(W - 32, font * 48);
    const below = fit ? H - (fit.y + fit.height) : 0;
    let y, h;
    if (fit && below - 30 >= chrome + lh * 4) {
      // Room under the logo: the editor sits there and the logo stays clear.
      y = fit.y + fit.height + clamp(below * 0.1, 14, 34);
      h = Math.min(H - y - 16, chrome + lh * 8);
    } else {
      h = Math.min(H - 32, chrome + lh * 8);
      y = (H - h) / 2;
    }
    return { compact: false, font, x: Math.round((W - w) / 2), y: Math.round(y), w, h: Math.round(h), head, foot, lh,
      codeTop: Math.round(y) + head + 6, rows: Math.max(1, Math.floor((h - chrome) / lh)) };
  }

  /** 0..1 weight of the pointer lens at (x, y): hovering code reveals
   *  its token boundaries, the way a tokenizer viewer does. */
  function lensAt(p, x, y, r) {
    if (!p || p.strength <= 0.01) return 0;
    return p.strength * window.OMP_BACKDROPS.proximity(p.x, p.y, x, y, r);
  }

  function charWidth(ctx, s, font) {
    return (s.cw[font] ??= ctx.measureText("0").width);
  }

  function panel(ctx, g, theme, r) {
    ctx.beginPath();
    ctx.roundRect(g.x + 0.5, g.y + 0.5, g.w - 1, g.h - 1, r);
    ctx.globalAlpha = 0.035; ctx.fillStyle = theme.fg; ctx.fill();
    ctx.globalAlpha = 0.75; ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.stroke();
  }

  function drawFull(ctx, s, env, theme) {
    const g = s.geo, cur = cursorOf(s), { lh, font } = g;
    const mono = `${font}px ${theme.mono}`, small = `${font - 2}px ${theme.mono}`;
    panel(ctx, g, theme, 8);
    ctx.textBaseline = "middle";
    // Header: file tab and generation progress; footer: sampler settings.
    ctx.fillStyle = theme.line; ctx.globalAlpha = 0.6;
    ctx.fillRect(g.x + 1, g.y + g.head, g.w - 2, 1);
    ctx.fillRect(g.x + 1, g.y + g.h - g.foot, g.w - 2, 1);
    let done = 0;
    for (let i = 0; i < s.idx; i++) if (s.toks[i].kind !== "space") done++;
    ctx.font = small;
    const hy = g.y + g.head / 2, fy = g.y + g.h - g.foot / 2;
    ctx.globalAlpha = s.phase === "gen" ? 0.6 + 0.4 * Math.sin(s.n / 6) ** 2 : 0.5;
    ctx.fillStyle = theme.accent;
    ctx.beginPath(); ctx.arc(g.x + 15, hy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = theme.fg2;
    ctx.fillText(window.OMP_BACKDROPS.SNIPPET_FILES[s.snip], g.x + 26, hy);
    ctx.fillStyle = theme.fg3;
    ctx.fillText(`T=${s.temp.toFixed(1)} · top-k ${K} · ${s.rate.toFixed(1)} tok/s`, g.x + 14, fy);
    ctx.textAlign = "right";
    ctx.fillStyle = theme.fg4;
    ctx.fillText(`${done}/${s.words} tok`, g.x + g.w - 14, hy);
    ctx.fillText(`Ln ${cur.line + 1}, Col ${cur.col + 1}`, g.x + g.w - 14, fy);

    // Code, clipped to its area so long snippets scroll and long lines clip.
    ctx.font = mono;
    const cw = charWidth(ctx, s, mono);
    const gutter = cw * 3 + font * 1.4, codeX = g.x + gutter;
    const lineY = (line) => g.codeTop + (line - s.scroll) * lh;
    ctx.save();
    ctx.beginPath(); ctx.rect(g.x + 1, g.y + g.head + 1, g.w - 2, g.h - g.head - g.foot - 1); ctx.clip();
    const fade = s.phase === "fade" ? 1 - s.t / FADE : 1;
    ctx.globalAlpha = 0.07 * fade; ctx.fillStyle = theme.accent;
    ctx.fillRect(g.x + 1, lineY(cur.line), g.w - 2, lh);
    for (let line = Math.max(0, Math.floor(s.scroll)); line <= cur.line; line++) {
      ctx.globalAlpha = fade; ctx.fillStyle = line === cur.line ? theme.fg2 : theme.fg4;
      ctx.fillText(String(line + 1), codeX - font * 0.9, lineY(line) + lh / 2);
    }
    ctx.textAlign = "left";
    for (let i = 0; i < s.idx; i++) {
      const t = s.toks[i];
      if (t.kind === "space") continue;
      const ty = lineY(t.line);
      if (ty < g.y || ty > g.y + g.h) continue;
      const tx = codeX + t.col * cw, age = s.n - s.born[i], tw = t.tok.length * cw;
      const lens = lensAt(env.pointer, tx + tw / 2, ty + lh / 2, font * 9);
      if (lens > 0) {
        ctx.globalAlpha = 0.2 * lens * fade; ctx.fillStyle = i % 2 ? theme.cyan : theme.accent;
        ctx.fillRect(tx - 1, ty + 3, tw + 2, lh - 6);
      }
      if (age < FLASH) {
        ctx.globalAlpha = 0.3 * (1 - age / FLASH) * fade; ctx.fillStyle = theme.accent;
        ctx.fillRect(tx - 2, ty + 2, tw + 4, lh - 4);
      }
      ctx.globalAlpha = fade; ctx.fillStyle = theme[KIND_COLOUR[t.kind]];
      ctx.fillText(t.tok, tx, ty + lh / 2);
    }
    const cx = codeX + cur.col * cw, cy = lineY(cur.line);
    const hl = s.cand ? clamp((s.t - GROW) / 4, 0, 1) : 0;
    if (hl > 0) {  // the winner as inline ghost text before it commits
      ctx.globalAlpha = 0.4 * hl; ctx.fillStyle = theme.accent;
      ctx.fillText(s.cand[0].tok, cx, cy + lh / 2);
    }
    if (s.phase === "gen" || Math.floor(s.n / 15) % 2 === 0) {
      ctx.globalAlpha = fade; ctx.fillStyle = theme.accent;
      ctx.fillRect(cx - 1, cy + lh * 0.18, 2, lh * 0.64);
    }
    ctx.restore();
    if (s.cand) drawPopup(ctx, s, theme, cx, cy, cw * s.cand[0].tok.length);
  }

  function drawPopup(ctx, s, theme, cx, cy, ghostW) {
    const g = s.geo, fs = g.font - 1, font = `${fs}px ${theme.mono}`;
    ctx.font = font;
    const cws = charWidth(ctx, s, font), rh = Math.round(fs * 1.6);
    const labW = cws * 11, barW = fs * 7, pctW = cws * 4;
    const pw = Math.round(22 + labW + 10 + barW + 10 + pctW + 8), ph = K * rh + 10;
    const top = g.y + g.head + 3, bottom = g.y + g.h - 3;
    // Below the cursor line (not yet written), else beside it, else above.
    let px = clamp(cx - 16, g.x + 6, g.x + g.w - pw - 6), py = cy + g.lh + 2;
    if (py + ph > bottom) {
      px = cx + ghostW + 12; py = clamp(cy - 4, top, bottom - ph);
      if (px + pw > g.x + g.w - 6) { px = clamp(cx - 16, g.x + 6, g.x + g.w - pw - 6); py = Math.max(top, cy - ph - 2); }
    }
    if (s.px == null) { s.px = px; s.py = py; }
    s.px += (px - s.px) * 0.35; s.py += (py - s.py) * 0.35;
    const x = Math.round(s.px), y = Math.round(s.py);
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, pw, ph, 6);
    ctx.globalAlpha = 0.97; ctx.fillStyle = theme.bg; ctx.fill();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = theme.line; ctx.stroke();
    const hl = clamp((s.t - GROW) / 4, 0, 1), { tokenKind } = window.OMP_BACKDROPS;
    const bx = x + 22 + labW + 10;
    ctx.textBaseline = "middle";
    s.cand.forEach((c, i) => {
      const ry = y + 5 + i * rh, my = ry + rh / 2, win = i === 0;
      const grow = easeOut(clamp((s.t - i * 0.9) / GROW, 0, 1));
      const dim = win ? 1 : 1 - 0.5 * hl;
      if (win && hl > 0) {
        ctx.globalAlpha = 0.14 * hl; ctx.fillStyle = theme.accent;
        ctx.fillRect(x + 3, ry, pw - 5, rh);
        ctx.globalAlpha = hl; ctx.textAlign = "left";
        ctx.fillText("›", x + 8, my);
      }
      ctx.textAlign = "left"; ctx.globalAlpha = dim;
      ctx.fillStyle = theme[KIND_COLOUR[tokenKind(c.tok)]];
      ctx.fillText(c.tok.length > 10 ? `${c.tok.slice(0, 9)}…` : c.tok, x + 22, my);
      ctx.globalAlpha = 0.08; ctx.fillStyle = theme.fg;
      ctx.fillRect(bx, my - 2.5, barW, 5);
      ctx.globalAlpha = dim * (win ? 0.55 + 0.45 * hl : 0.6);
      ctx.fillStyle = win ? theme.accent : theme.fg3;
      ctx.fillRect(bx, my - 2.5, Math.max(1, barW * c.p * grow), 5);
      ctx.textAlign = "right"; ctx.globalAlpha = dim;
      ctx.fillStyle = win && hl > 0 ? theme.accent : theme.fg3;
      ctx.fillText(`${Math.round(c.p * 100 * grow)}%`, x + pw - 8, my);
    });
  }

  // Preview tile: text would turn to mush, so tokens are coloured blocks
  // (a minimap of the code) and the popup keeps only its bars.
  function drawCompact(ctx, s, env, theme) {
    const g = s.geo, cur = cursorOf(s), { lh, cw } = g;
    panel(ctx, g, theme, 5);
    ctx.globalAlpha = 0.5; ctx.fillStyle = theme.line;
    ctx.fillRect(g.x + 1, g.y + g.head, g.w - 2, 1);
    ctx.globalAlpha = 0.8; ctx.fillStyle = theme.accent;
    ctx.fillRect(g.x + 6, g.y + g.head / 2 - 1, 18, 2);
    const codeX = g.x + g.gutter, lineY = (line) => g.codeTop + (line - s.scroll) * lh;
    const fade = s.phase === "fade" ? 1 - s.t / FADE : 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(g.x + 1, g.y + g.head + 1, g.w - 2, g.h - g.head - 2); ctx.clip();
    for (let line = 0; line <= cur.line; line++) {
      ctx.globalAlpha = 0.6 * fade; ctx.fillStyle = theme.fg4;
      ctx.fillRect(g.x + 4, lineY(line) + lh * 0.35, 3, lh * 0.3);
    }
    for (let i = 0; i < s.idx; i++) {
      const t = s.toks[i];
      if (t.kind === "space") continue;
      const lit = clamp(1 - (s.n - s.born[i]) / FLASH, 0, 1);
      const tx = codeX + t.col * cw, ty = lineY(t.line), tw = Math.max(1, t.tok.length * cw - 0.8);
      const lens = lensAt(env.pointer, tx + tw / 2, ty + lh / 2, 28);
      ctx.globalAlpha = Math.min(1, 0.75 + 0.25 * lit + 0.25 * lens) * fade;
      ctx.fillStyle = lit > 0.3 ? theme.accent : theme[KIND_COLOUR[t.kind]];
      ctx.fillRect(tx, ty + lh * (0.22 - 0.12 * lens), tw, lh * (0.56 + 0.24 * lens));
    }
    const cx = codeX + cur.col * cw, cy = lineY(cur.line);
    const hl = s.cand ? clamp((s.t - GROW) / 4, 0, 1) : 0;
    if (hl > 0) {
      ctx.globalAlpha = 0.4 * hl; ctx.fillStyle = theme.accent;
      ctx.fillRect(cx, cy + lh * 0.22, s.cand[0].tok.length * cw, lh * 0.56);
    }
    if (s.phase === "gen" || Math.floor(s.n / 15) % 2 === 0) {
      ctx.globalAlpha = fade; ctx.fillStyle = theme.accent;
      ctx.fillRect(cx - 0.5, cy, 1.2, lh);
    }
    ctx.restore();
    if (!s.cand) return;
    const pw = 46, ph = K * 4 + 6;
    let py = cy + lh + 1;
    if (py + ph > g.y + g.h - 2) py = cy - ph - 1;
    const px = clamp(cx - 6, g.x + 4, g.x + g.w - pw - 4);
    if (s.px == null) { s.px = px; s.py = py; }
    s.px += (px - s.px) * 0.35; s.py += (py - s.py) * 0.35;
    ctx.beginPath(); ctx.roundRect(s.px + 0.5, s.py + 0.5, pw, ph, 3);
    ctx.globalAlpha = 0.97; ctx.fillStyle = theme.bg; ctx.fill();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.stroke();
    s.cand.forEach((c, i) => {
      const grow = easeOut(clamp((s.t - i * 0.9) / GROW, 0, 1)), win = i === 0;
      ctx.globalAlpha = win ? 0.6 + 0.4 * hl : 0.6 - 0.3 * hl;
      ctx.fillStyle = win ? theme.accent : theme.fg3;
      ctx.fillRect(s.px + 4, s.py + 4 + i * 4, Math.max(1, (pw - 8) * c.p * grow), 2.5);
    });
  }

  /** The logo as editor text, pre-rendered per size/dpr/theme: solid █
   *  cells in the accent (with its glow), box-drawing edges as punctuation
   *  in a syntax colour. */
  function logoImage(s, env, theme) {
    const dpr = window.devicePixelRatio || 1, key = `${dpr}|${Object.values(theme).join("|")}`;
    if (s.logoImg?.key === key) return s.logoImg;
    const { fit, logo } = env, pad = Math.ceil(fit.font);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((fit.width + pad * 2) * dpr);
    canvas.height = Math.ceil((fit.height + pad * 2) * dpr);
    const c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    c.font = `${fit.font}px ${theme.mono}`;
    c.textBaseline = "top";
    const at = (cell) => [pad + cell.x - fit.x, pad + cell.y - fit.y];
    c.fillStyle = theme.lilac; c.globalAlpha = 0.9;
    for (const cell of logo.cells) if (!cell.solid) c.fillText(cell.ch, ...at(cell));
    c.fillStyle = theme.accent; c.globalAlpha = 1;
    c.shadowColor = theme.glow; c.shadowBlur = fit.font * 0.8;
    for (const cell of logo.cells) if (cell.solid) c.fillText(cell.ch, ...at(cell));
    return (s.logoImg = { key, canvas, pad, dpr });
  }

  /** Columns [from, to) of the pre-rendered logo, `from`'s left and `to`'s
   *  right side extended into the glow padding at the logo's ends. */
  function drawColumns(ctx, img, fit, cellW, from, to) {
    const { canvas, pad, dpr } = img;
    const x0 = from <= 0 ? 0 : pad + from * cellW;
    const x1 = to >= window.OMP_MATRIX.LOGO_COLS ? canvas.width / dpr : pad + to * cellW;
    if (x1 <= x0) return;
    ctx.drawImage(canvas, x0 * dpr, 0, (x1 - x0) * dpr, canvas.height,
      fit.x - pad + x0, fit.y - pad, x1 - x0, canvas.height / dpr);
  }

  function drawLogo(ctx, s, env, theme) {
    const { fit } = env, cols = window.OMP_MATRIX.LOGO_COLS, img = logoImage(s, env, theme);
    const cellW = fit.width / cols, m = fit.font * 1.5;
    // Typed so far (create), and the sweep's position (snippet start).
    const typed = clamp(Math.floor((s.n - TYPE_DELAY) * TYPE_RATE), 0, cols);
    const sweep = (s.n - s.sweepAt) * SWEEP_RATE;
    const sweeping = typed === cols && sweep < cols;
    const edge = typed < cols ? typed : sweeping ? Math.floor(sweep) : cols;
    // The logo is the current line: a faint line highlight behind it.
    ctx.globalAlpha = 0.06; ctx.fillStyle = theme.accent;
    ctx.fillRect(fit.x - m, fit.y - fit.font * 0.5, fit.width + m * 2, fit.height + fit.font);
    // Cell edges on device pixels, so neighbouring translucent cells don't seam.
    const dpr = img.dpr, px = (v) => Math.round(v * dpr) / dpr, rows = window.OMP_MATRIX.LOGO_ROWS;
    const cellH = fit.height / rows, colX = (col) => px(fit.x + col * cellW), rowY = (row) => px(fit.y + row * cellH);
    // Pointer: a soft selection around the hovered letters, seen in the gaps.
    const p = env.pointer;
    if (p?.strength > 0.01) {
      const r = fit.font * 7, c0 = Math.floor((p.x - r - fit.x) / cellW), c1 = Math.ceil((p.x + r - fit.x) / cellW);
      ctx.fillStyle = theme.accent;
      for (let col = Math.max(0, c0); col < Math.min(cols, c1); col++) {
        for (let row = 0; row < rows; row++) {
          const lens = lensAt(p, fit.x + (col + 0.5) * cellW, fit.y + (row + 0.5) * cellH, r);
          if (lens < 0.01) continue;
          ctx.globalAlpha = 0.2 * lens;
          ctx.fillRect(colX(col), rowY(row), colX(col + 1) - colX(col), rowY(row + 1) - rowY(row));
        }
      }
    }
    // Freshly written columns stay lit a moment, like a committed token:
    // behind the typing, or behind the latest sweep once typing is done.
    const swept = s.sweepAt > TYPE_DELAY + cols / TYPE_RATE;
    const origin = swept ? s.sweepAt : TYPE_DELAY, rate = swept ? SWEEP_RATE : TYPE_RATE;
    const head = swept ? Math.min(cols, Math.floor(sweep)) : typed;
    ctx.fillStyle = theme.accent;
    for (let col = Math.max(0, Math.floor(head - FLASH * rate)); col < head; col++) {
      const age = s.n - (origin + (col + 1) / rate);
      if (age >= FLASH) continue;
      ctx.globalAlpha = 0.28 * (1 - age / FLASH);
      ctx.fillRect(colX(col), fit.y - fit.font * 0.25, colX(col + 1) - colX(col), fit.height + fit.font * 0.5);
    }
    // Text: typed columns in full, the rest as inline ghost text.
    ctx.globalAlpha = 1;
    drawColumns(ctx, img, fit, cellW, 0, typed);
    if (typed < cols) { ctx.globalAlpha = GHOST; drawColumns(ctx, img, fit, cellW, typed, cols); }
    // Cursor: a block riding the edge while writing, then a caret parked
    // after the logo that follows the editor's (steady while generating).
    ctx.fillStyle = theme.accent;
    if (edge < cols) {
      ctx.globalAlpha = 0.6;
      ctx.fillRect(fit.x + edge * cellW, fit.y - fit.font * 0.25, cellW, fit.height + fit.font * 0.5);
    } else if (s.phase === "gen" || Math.floor(s.n / 15) % 2 === 0) {
      ctx.globalAlpha = 0.75;
      ctx.fillRect(fit.x + fit.width + cellW * 0.6, fit.y - fit.font * 0.25, Math.max(2, cellW * 0.45),
        fit.height + fit.font * 0.5);
    }
  }

  (window.OMP_BACKDROP_RENDERERS ??= {}).sampling = {
    stepMs: STEP_MS,
    plate: true,           // the editor sits behind the logo when space is short
    create(env) {
      const s = { n: 0, cw: {}, px: null, py: null, temp: TEMPERATURE, geo: geometry(env) };
      load(s, Math.floor(env.rand() * window.OMP_BACKDROPS.SNIPPETS.length));
      // Start part-way through so even the first (or a frozen reduced-motion)
      // frame shows code being written.
      const words = [];
      s.toks.forEach((t, i) => { if (t.kind !== "space") words.push(i); });
      s.idx = words[Math.floor(words.length * (0.3 + env.rand() * 0.25))];
      next(s, env);
      s.sweepAt = -1e9;  // the first snippet's logo is typed, not swept
      s.rate = 1000 / (s.len * STEP_MS);
      return s;
    },
    step(ctx, s, env, theme) {
      advance(s, env);
      const g = s.geo, cur = cursorOf(s);
      // Keep the cursor line in view, with a spare line under it for the popup.
      const target = Math.max(0, cur.line - g.rows + 1 + (g.rows >= 5 ? 1 : 0));
      s.scroll = s.n === 1 ? target : s.scroll + (target - s.scroll) * 0.15;
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, env.width, env.height);
      if (g.compact) drawCompact(ctx, s, env, theme);
      else drawFull(ctx, s, env, theme);
    },
    logo(ctx, s, env, theme) {
      if (env.logo) drawLogo(ctx, s, env, theme);
    },
  };
})();
