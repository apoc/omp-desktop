// Start screens: offscreen art the canvas host (backdrop.jsx) builds for
// itself and hands to the renderers through `env` — dpr-scaled canvases,
// the halo sprite and the `env.logo` API (contract: backdrop.jsx header).
//
// Exposes `window.OMP_BACKDROP_ART`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
(function () {
  /** A `w`×`h` CSS px offscreen canvas at `dpr`; `paint(g)` draws in CSS
   *  px, moved by (dx, dy). */
  function canvas(w, h, dpr, dx, dy, paint) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, dx * dpr, dy * dpr);
    paint(g);
    return c;
  }

  /** A soft round sprite from stacked translucent discs: a gradient to
   *  "transparent" tints towards black in canvas. */
  function halo(colour, dpr) {
    const size = 64;
    return canvas(size, size, dpr, 0, 0, g => {
      g.fillStyle = colour;
      g.globalAlpha = 0.075;
      for (let i = 0; i < 16; i++) {
        g.beginPath();
        g.arc(size / 2, size / 2, (size / 2) * (1 - i / 16), 0, Math.PI * 2);
        g.fill();
      }
    });
  }

  /** env.logo for the logo fitted at `fit` (`cells`: OMP_MATRIX.logoCells),
   *  reading `env.dpr` and the current `theme()` when it draws. */
  function logoApi(env, fit, cells, theme) {
    let glyph = null;
    const logo = {
      cells,
      solid: cells.filter(c => c.solid),
      edges: cells.filter(c => !c.solid),
      sub: Math.max(1, Math.round(cells[0].h / cells[0].w)),
      bake: (pad, paint) => ({
        canvas: canvas(fit.width + pad * 2, fit.height + pad * 2, env.dpr, pad - fit.x, pad - fit.y, paint),
        pad,
      }),
      draw: (target, img, dx = 0, dy = 0) => target.drawImage(img.canvas, fit.x - img.pad + dx, fit.y - img.pad + dy,
        img.canvas.width / env.dpr, img.canvas.height / env.dpr),
      /** `list` cells as their glyphs in `colour`; `glow` adds a shadow of
       *  `blur` font sizes (bake only: shadowBlur is too slow per frame). */
      glyphs(g, list, colour, { alpha = 1, glow = null, blur = 0 } = {}) {
        g.font = `${fit.font}px ${theme().mono}`;
        g.textBaseline = "top";
        g.fillStyle = colour;
        g.globalAlpha = alpha;
        g.shadowColor = glow ?? "transparent";
        g.shadowBlur = glow ? fit.font * blur : 0;
        for (const c of list) g.fillText(c.ch, c.x, c.y);
      },
      /** The default logo: the accent glyphs with their glow, baked once per
       *  theme (shadowBlur on ~400 glyphs every frame would dominate). */
      paintDefault(target) {
        const t = theme();
        if (glyph?.theme !== t) {
          glyph = { theme: t, img: logo.bake(Math.ceil(fit.font), g => logo.glyphs(g, cells, t.accent, { glow: t.glow, blur: 0.8 })) };
        }
        logo.draw(target, glyph.img);
      },
    };
    return logo;
  }

  window.OMP_BACKDROP_ART = { canvas, halo, logoApi };
})();
