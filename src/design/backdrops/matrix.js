// Start screen "matrix": digital rain (geometry: app/matrix-rain.js).
// Renderer contract: design/backdrops/backdrop.jsx. Plain-script IIFE.
(function () {
  const RAIN_FONT = 14;          // px per rain cell
  const TRAIL_FADE = 0.09;       // background alpha laid over each step
  const HEAD_ALPHA = 0.55;
  // Pointer lens: drop heads inside it brighten and a few stray glyphs
  // spark there, left to the trail fade like the rain itself.
  const LENS_RADIUS = 120;
  const LENS_SPARKS = 5;
  // Logo: the default glow; a letter block the rain passes through flashes
  // brighter and fades back over a few steps, more readily under the
  // pointer. Nothing is drawn over the letters but the flash itself.
  const FLASH_STEPS = 4;
  const FLASH_ALPHA = 0.32;
  const HEAD_FLASH = 0.5;         // chance a drop head inside the logo lights its block
  const LENS_FLASH = 0.06;        // per-step chance of a block right under the pointer
  // The flash lightens: toward fg on a dark theme, toward bg on a light one
  // (a darkening flash on daylight reads as a dead pixel).
  (window.OMP_BACKDROP_RENDERERS ??= {}).matrix = {
    stepMs: 55,                  // ~18 steps/s: reads as rain, costs little
    plate: false,
    create(env) {
      const { initDrops, LOGO_COLS } = window.OMP_MATRIX;
      const rows = Math.ceil(env.height / RAIN_FONT);
      const cellAt = new Map();
      env.logo?.cells.forEach((c, i) => cellAt.set(c.row * LOGO_COLS + c.col, i));
      return { rows, drops: initDrops(Math.ceil(env.width / RAIN_FONT), rows, env.rand), fresh: true, cellAt, flash: new Map() };
    },
    step(ctx, s, env, theme) {
      const { stepDrops, randomGlyph } = window.OMP_MATRIX;
      // Fade the previous steps into the background, leaving trails; the
      // first step after a layout clears fully (the canvas was reset).
      ctx.globalAlpha = s.fresh ? 1 : TRAIL_FADE;
      s.fresh = false;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, env.width, env.height);
      ctx.font = `${RAIN_FONT}px ${theme.mono}`;
      ctx.textBaseline = "top";
      // The leading glyph only, dimmed: the trail does the rest.
      const { pointer } = env;
      const lens = pointer.strength > 0;
      const radius = env.compact ? LENS_RADIUS / 3 : LENS_RADIUS;
      ctx.fillStyle = theme.accent;
      for (let i = 0; i < s.drops.length; i++) {
        const y = s.drops[i] * RAIN_FONT;
        if (y < 0 || y > env.height) continue;
        const x = i * RAIN_FONT;
        const near = lens ? Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / radius) : 0;
        ctx.globalAlpha = HEAD_ALPHA + (1 - HEAD_ALPHA) * near * pointer.strength;
        ctx.fillText(randomGlyph(env.rand), x, y);
      }
      if (lens) {
        ctx.fillStyle = theme.fg;
        for (let n = 0; n < LENS_SPARKS; n++) {
          const a = env.rand() * Math.PI * 2;
          const r = Math.sqrt(env.rand()) * radius;
          ctx.globalAlpha = 0.45 * pointer.strength * (1 - r / radius);
          const col = Math.floor((pointer.x + Math.cos(a) * r) / RAIN_FONT);
          const row = Math.floor((pointer.y + Math.sin(a) * r) / RAIN_FONT);
          ctx.fillText(randomGlyph(env.rand), col * RAIN_FONT, row * RAIN_FONT);
        }
      }
      stepDrops(s.drops, s.rows, env.rand);
    },
    logo(ctx, s, env, theme) {
      const { LOGO_COLS } = window.OMP_MATRIX;
      const { cells, paintDefault } = env.logo;
      const { fit, pointer, rand } = env;
      paintDefault(ctx);
      const { w, h } = cells[0];
      const light = (i) => { if (cells[i].solid) s.flash.set(i, FLASH_STEPS); };
      // Drop heads (half a row above their stepped position) inside the logo.
      for (let i = 0; i < s.drops.length; i++) {
        const y = (s.drops[i] - 0.5) * RAIN_FONT;
        if (y < fit.y || y >= fit.y + fit.height || rand() > HEAD_FLASH) continue;
        const col = Math.floor(((i + 0.5) * RAIN_FONT - fit.x) / w);
        const at = s.cellAt.get(Math.floor((y - fit.y) / h) * LOGO_COLS + col);
        if (at !== undefined) light(at);
      }
      if (pointer.strength > 0) {
        const { proximity } = window.OMP_BACKDROPS;
        const radius = fit.font * 8;
        cells.forEach((c, i) => {
          if (rand() < LENS_FLASH * proximity(pointer, c.x + w / 2, c.y + h / 2, radius)) light(i);
        });
      }
      ctx.fillStyle = theme.light ? theme.bg : theme.fg;
      for (const [i, left] of s.flash) {
        const c = cells[i];
        ctx.globalAlpha = FLASH_ALPHA * (left / FLASH_STEPS);
        ctx.fillRect(c.x, c.y, w, h);
        if (left <= 1) s.flash.delete(i);
        else s.flash.set(i, left - 1);
      }
    },
  };
})();
