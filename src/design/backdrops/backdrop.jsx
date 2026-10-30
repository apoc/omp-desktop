/* ═════════════════════════════════════════════════════════════════════
   backdrops/backdrop.jsx — canvas host for the start screens

   One <canvas> running one screen renderer from
   window.OMP_BACKDROP_RENDERERS (design/backdrops/<id>.js), with the
   ASCII-art OMP-DESKTOP logo (geometry: app/matrix-rain.js) on top. Used
   by the empty workspace (logo on) and by the Settings → Appearance start
   screen tiles (logo off, live previews). An unknown `screen` runs matrix.

   Renderer contract (plain-script IIFEs, looked up when the effect runs):
     { stepMs, plate, create(env) → state, step(ctx, state, env, theme),
       logo?(ctx, state, env, theme) }
   - `create` runs on every layout (resize, scale-factor change, screen or
     logo switch) and returns the renderer's own state, so nothing cached
     there needs keying on size, fit or dpr.
   - `step` advances one step and paints the whole canvas in CSS px (the
     host has set the dpr transform); it owns the background.
   - `plate`: the host lays a soft background plate under the logo, for
     screens busy enough to fight with it.
   - theme: the tokens in THEME_VARS plus `light` (the theme's own
     color-scheme). The same object until a token changes, so a renderer
     caches theme-dependent art by identity (`s.art?.theme !== theme`).
   - env: { width, height, dpr, fit (logo rect or null), logo, compact (a
     small preview tile), rand, pointer, layer(paint), halo(colour) }.
     `layer(paint)`: a full-size offscreen canvas, `paint(g)` drawing in
     CSS px. `halo(colour)`: a soft round sprite in `colour`, cached per
     theme; draw it scaled to the size wanted. (Offscreen art:
     design/backdrops/art.js.)
   - env.pointer: { x, y, strength } in CSS px of the canvas, always set.
     `strength` (0..1) eases up while the mouse moves over the canvas and
     back down once it rests (~1.2 s) or leaves; renderers scale a subtle
     reaction by it (OMP_BACKDROPS.proximity), so a parked cursor leaves
     the screen as it was.
   - `logo` (optional): paints the OMP-DESKTOP logo in the screen's own
     style, every step after `step` (and after the plate); only called with
     a logo, so env.logo is set there. Without it the host paints the
     default: the accent glyphs with their glow. env.logo (null without a
     logo): { cells, solid, edges, sub, bake(pad, paint), draw(ctx, img,
     dx, dy), glyphs(g, cells, colour, { alpha, glow, blur }),
     paintDefault(ctx) }. `cells` (OMP_MATRIX.logoCells): every drawn cell
     in canvas px, `solid` for the letters' █ blocks, else a box-drawing
     shadow edge; `solid`/`edges` split them; `sub` how many square
     sub-cells stack in a cell. `bake` pre-renders `paint(g)` (canvas px)
     around the logo with `pad` px of room for blur; `draw` puts a baked
     image back, moved by (dx, dy); `glyphs` writes cells as their
     characters (in a bake: its glow is shadowBlur). `paintDefault` draws
     the default logo (honours ctx.globalAlpha).
   Paused (the `paused` prop, or the canvas out of view) steps nothing.
   Reduced motion: no loop and no pointer reaction; the host paints
   STILL_STEPS steps once (a frozen frame) and repaints on resize and when
   a theme token changes.
   ═════════════════════════════════════════════════════════════════════ */

const { fitLogo: _BD_fitLogo, logoCells: _BD_logoCells } = window.OMP_MATRIX;
const { canvas: _BD_canvas, halo: _BD_halo, logoApi: _BD_logoApi } = window.OMP_BACKDROP_ART;

const _BD_STILL_STEPS = 90;
const _BD_POINTER_REST_MS = 1200;
const _BD_THEME_VARS = {
  bg: "--bg-window", accent: "--accent", glow: "--accent-glow", fg: "--fg", fg2: "--fg-2", fg3: "--fg-3",
  fg4: "--fg-4", line: "--line-bright", mono: "--font-mono", cyan: "--cyan", amber: "--amber", rose: "--rose",
  lilac: "--lilac", magenta: "--magenta", lime: "--lime", scheme: "color-scheme",
};

function _BD_readTheme(el) {
  const cs = getComputedStyle(el);
  const theme = {};
  for (const k in _BD_THEME_VARS) theme[k] = cs.getPropertyValue(_BD_THEME_VARS[k]).trim();
  theme.light = theme.scheme === "light";
  return theme;
}

const _BD_themeKey = (theme) => Object.values(theme).join("|");

/** The soft background plate under the logo. */
function _BD_renderPlate(logo, fit, theme) {
  return logo.bake(Math.ceil(fit.font * 4), g => {
    const m = fit.font * 1.5;
    g.fillStyle = theme.bg;
    g.shadowColor = theme.bg;
    g.shadowBlur = fit.font * 2.5;
    g.globalAlpha = 0.86;
    g.fillRect(fit.x - m, fit.y - m, fit.width + m * 2, fit.height + m * 2);
  });
}

function Backdrop({ screen, logo = true, paused = false, className }) {
  const canvasRef = React.useRef(null);
  // Read by the loop, not an effect dependency: pausing keeps the state.
  const pausedRef = React.useRef(paused);
  const resumeRef = React.useRef(null);
  React.useEffect(() => {
    pausedRef.current = paused;
    if (!paused) resumeRef.current?.();
  }, [paused]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const renderers = window.OMP_BACKDROP_RENDERERS ?? {};
    const renderer = renderers[screen] ?? renderers.matrix;
    if (!ctx || !renderer) return undefined;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, strength: 0 };
    const halos = new Map();
    let halosTheme = null, plate = null;
    const env = {
      width: 0, height: 0, dpr: 1, fit: null, logo: null, compact: false, rand: Math.random, pointer,
      layer: (paint) => _BD_canvas(env.width, env.height, env.dpr, 0, 0, paint),
      halo: (colour) => {
        if (halosTheme !== theme) { halos.clear(); halosTheme = theme; }
        if (!halos.has(colour)) halos.set(colour, _BD_halo(colour, env.dpr));
        return halos.get(colour);
      },
    };
    let state = null, raf = 0, last = 0, visible = true, broken = false;
    let theme = null, themeKey = "", themeDirty = true;
    let inside = false, movedAt = -Infinity, easedAt = 0;

    // Re-read only after the root's class/style changed (every theme and
    // accent write lands there); a new object only when a token changed.
    const syncTheme = () => {
      if (!themeDirty) return;
      themeDirty = false;
      const next = _BD_readTheme(canvas);
      const key = _BD_themeKey(next);
      if (key === themeKey) return;
      theme = next;
      themeKey = key;
    };

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      env.width = rect.width; env.height = rect.height; env.dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(env.width * env.dpr);
      canvas.height = Math.round(env.height * env.dpr);
      ctx.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
      env.compact = env.height < 160 || env.width < 260;
      env.fit = null;
      env.logo = null;
      themeDirty = true;
      themeKey = "";  // a new theme object: renderer caches rebuild too
      syncTheme();
      if (logo) {
        // Monospace: one measurement per 1px of font size covers every cell.
        ctx.font = `100px ${theme.mono}`;
        const m = ctx.measureText("█");
        const cellW = m.width / 100;
        const cellH = ((m.actualBoundingBoxAscent ?? 80) + (m.actualBoundingBoxDescent ?? 20)) / 100;
        env.fit = _BD_fitLogo(env.width, env.height, { cellW, cellH });
        if (env.fit) env.logo = _BD_logoApi(env, env.fit, _BD_logoCells(env.fit), () => theme);
      }
      state = renderer.create(env);
    };

    // The reaction fades in while the mouse moves and out once it rests or
    // leaves; eased by wall time, so screens with any step rate match.
    const easePointer = (now) => {
      const target = inside && now - movedAt < _BD_POINTER_REST_MS ? 1 : 0;
      const k = 1 - Math.exp(-(now - easedAt) / (target ? 120 : 420));
      pointer.strength += (target - pointer.strength) * k;
      if (pointer.strength < 0.001) pointer.strength = 0;
      easedAt = now;
    };
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      inside = true;
      movedAt = performance.now();
    };
    const onLeave = () => { inside = false; };

    const step = () => {
      ctx.save();
      renderer.step(ctx, state, env, theme);
      ctx.restore();
    };
    const frame = () => {
      // A move to a monitor with another scale factor changes the ratio but
      // not the CSS size, so the ResizeObserver never fires for it.
      if ((window.devicePixelRatio || 1) !== env.dpr) layout();
      easePointer(performance.now());
      syncTheme();
      step();
      if (!env.logo) return;
      if (renderer.plate) {
        if (plate?.theme !== theme) plate = { theme, img: _BD_renderPlate(env.logo, env.fit, theme) };
        env.logo.draw(ctx, plate.img);
      }
      if (renderer.logo) {
        ctx.save();
        renderer.logo(ctx, state, env, theme);
        ctx.restore();
      } else {
        env.logo.paintDefault(ctx);
      }
    };
    const still = () => {
      layout();
      for (let i = 1; i < _BD_STILL_STEPS; i++) step();
      frame();
    };

    // A renderer error stops this canvas only: thrown from the effect it
    // would unmount the whole React tree, and from the loop it would
    // repeat every frame.
    const run = (fn) => {
      if (broken) return;
      try {
        fn();
      } catch (err) {
        broken = true;
        cancelAnimationFrame(raf);
        console.error(`start screen "${screen}" stopped:`, err);
      }
    };

    const themeObserver = new MutationObserver(() => {
      themeDirty = true;
      if (reduceMotion && themeKey !== _BD_themeKey(_BD_readTheme(canvas))) run(still);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    if (reduceMotion) {
      const observer = new ResizeObserver(() => run(still));
      observer.observe(canvas);
      return () => { observer.disconnect(); themeObserver.disconnect(); };
    }

    const live = () => visible && !pausedRef.current && !broken;
    const loop = t => {
      if (!live()) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      if (t - last < renderer.stepMs) return;
      last = t;
      run(frame);
    };
    const resume = () => { if (!raf && live()) raf = requestAnimationFrame(loop); };
    resumeRef.current = resume;
    // Scrolled out of view, or in a display:none ancestor: no steps.
    const viewObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; resume(); });
    viewObserver.observe(canvas);
    const relayout = () => { layout(); frame(); };
    const observer = new ResizeObserver(() => run(relayout));
    observer.observe(canvas);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    run(relayout);
    resume();
    return () => {
      cancelAnimationFrame(raf);
      resumeRef.current = null;
      observer.disconnect();
      viewObserver.disconnect();
      themeObserver.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [screen, logo]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

Object.assign(window, { Backdrop });
