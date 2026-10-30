// The "attention" start screen's logo: OMP-DESKTOP as a heatmap of the
// query's attention. Each █ block is two square cells; the logo's columns
// spread over the window's tokens and its rows over the heads (head 1 on
// top), so each cell glows with the weight that head gives that token in
// the running layer, shifting as layers run and tokens are generated. Each
// new token sweeps a causal-mask diagonal across it. Used by
// design/backdrops/attention.js, which owns the renderer state `s` this
// reads: n, logoW (per head and slot glow, 0..1, `h * n + slot`), front
// (the sweep, or null). Plain-script IIFE.
(function () {
  const LOGO_COLS = window.OMP_MATRIX.LOGO[0].length, LOGO_ROWS = window.OMP_MATRIX.LOGO.length;
  // Resting alphas of the cells (glow pass, crisp pass) and the shadow
  // edges: dim on a dark theme so the heatmap glow reads, near solid on a
  // light one, where a thin accent washes out against the paper and the
  // logo would stop being the hero.
  const REST = { dark: { glow: 0.32, crisp: 0.16, edge: 0.24 }, light: { glow: 0.62, crisp: 0.45, edge: 0.4 } };
  const LEVELS = 8;      // the live overlay's alpha steps (one fill each)

  /** Relative lightness (0..1) of a CSS colour, read back through a 1px
   *  canvas so any colour syntax works; once per theme change. */
  function lightness(colour) {
    const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    g.fillStyle = colour;
    g.fillRect(0, 0, 1, 1);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    return (0.2126 * r + 0.7152 * gr + 0.0722 * b) / 255;
  }

  /** The resting logo, once per size/theme: faint box-drawing shadow, the
   *  cells' soft glow (shadowBlur here only, never per frame) and the cells
   *  themselves at their REST strength. */
  function render(cells, fit, theme, dpr) {
    const rest = REST[lightness(theme.bg) > 0.5 ? "light" : "dark"];
    const pad = Math.ceil(fit.font * 1.5);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((fit.width + pad * 2) * dpr);
    canvas.height = Math.ceil((fit.height + pad * 2) * dpr);
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    g.translate(pad - fit.x, pad - fit.y);
    const solid = cells.filter(c => c.solid);
    const { w, h } = solid[0];
    const sub = Math.max(1, Math.round(h / w));
    const side = Math.min(w, h / sub) * 0.84;
    const squares = [];
    for (const c of solid) {
      for (let j = 0; j < sub; j++) {
        squares.push({ col: c.col, row: c.row * sub + j, x: c.x + (c.w - side) / 2, y: c.y + (c.h / sub) * (j + 0.5) - side / 2 });
      }
    }
    g.font = `${fit.font}px ${theme.mono}`;
    g.textBaseline = "top";
    g.fillStyle = theme.accent;
    g.globalAlpha = rest.edge;
    for (const c of cells) if (!c.solid) g.fillText(c.ch, c.x, c.y);
    const fill = () => {
      g.beginPath();
      for (const q of squares) g.rect(q.x, q.y, side, side);
      g.fill();
    };
    g.globalAlpha = rest.glow;
    g.shadowColor = theme.glow;
    g.shadowBlur = fit.font * 0.7;
    fill();
    g.shadowBlur = 0;
    g.globalAlpha = rest.crisp;
    fill();
    return { canvas, pad, squares, side, sub };
  }

  /** Paint the logo: the cached rest, then each cell's glow on top, binned
   *  into LEVELS alphas so the overlay is a handful of fills. */
  function paint(ctx, s, env, theme) {
    const { bandOf, maskSweep, proximity, HEADS } = window.OMP_BACKDROPS;
    const fit = env.fit, dpr = window.devicePixelRatio || 1;
    const key = `${fit.x}|${fit.y}|${fit.width}|${fit.height}|${dpr}|${theme.bg}|${theme.accent}|${theme.glow}|${theme.mono}`;
    if (key !== s.logoKey) { s.logoKey = key; s.logoArt = render(env.logo.cells, fit, theme, dpr); }
    const art = s.logoArt;
    ctx.drawImage(art.canvas, fit.x - art.pad, fit.y - art.pad, art.canvas.width / dpr, art.canvas.height / dpr);
    const pt = env.pointer, hover = pt && pt.strength > 0.01;
    const reach = fit.font * 9;
    const bins = Array.from({ length: LEVELS }, () => []);
    const rows = LOGO_ROWS * art.sub;
    for (const q of art.squares) {
      let lit = s.logoW[bandOf(q.row, rows, HEADS.length) * s.n + bandOf(q.col, LOGO_COLS, s.n)];
      if (s.front != null) {
        const m = maskSweep(q.col, q.row / art.sub, s.front);
        lit = m.masked ? 0 : Math.max(lit, m.glow);
      }
      if (hover) lit += proximity(pt.x, pt.y, q.x, q.y, reach) * pt.strength * 0.6;
      const b = Math.min(LEVELS, Math.round(lit * LEVELS));
      if (b > 0) bins[b - 1].push(q);
    }
    ctx.fillStyle = theme.accent;
    bins.forEach((list, b) => {
      if (!list.length) return;
      ctx.globalAlpha = (b + 1) / LEVELS;
      ctx.beginPath();
      for (const q of list) ctx.rect(q.x, q.y, art.side, art.side);
      ctx.fill();
    });
  }

  window.OMP_ATTENTION_LOGO = { paint };
})();
