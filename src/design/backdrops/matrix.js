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
  (window.OMP_BACKDROP_RENDERERS ??= {}).matrix = {
    stepMs: 55,                  // ~18 steps/s: reads as rain, costs little
    plate: false,
    create(env) {
      const { initDrops } = window.OMP_MATRIX;
      const rows = Math.ceil(env.height / RAIN_FONT);
      return { rows, drops: initDrops(Math.ceil(env.width / RAIN_FONT), rows, env.rand), fresh: true };
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
  };
})();
