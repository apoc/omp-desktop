/* ═════════════════════════════════════════════════════════════════════
   backdrops/backdrop.jsx — canvas host for the start screens

   One <canvas> running one screen renderer from
   window.OMP_BACKDROP_RENDERERS (design/backdrops/<id>.js), with the
   ASCII-art OMP-DESKTOP logo (geometry: app/matrix-rain.js) on top. Used
   by the empty workspace (logo on) and by the Settings → Appearance start
   screen tiles (logo off, live previews).

   Renderer contract (plain-script IIFEs, looked up when the effect runs):
     { stepMs, plate, create(env) → state, step(ctx, state, env, theme),
       logo?(ctx, state, env, theme) }
   - `create` runs on every layout (resize, scale-factor change, screen or
     logo switch) and returns the renderer's own state.
   - `step` advances one step and paints the whole canvas in CSS px (the
     host has set the dpr transform); it owns the background.
   - `plate`: the host lays a soft background plate under the logo, for
     screens busy enough to fight with it.
   - env: { width, height, fit (logo rect or null), logo, compact (a small
     preview tile), rand, pointer }; theme: readTheme below, re-read every
     step so a theme switch applies live.
   - `logo` (optional): paints the OMP-DESKTOP logo in the screen's own
     style, every step after `step` (and after the plate). Without it the
     host paints the default: the accent glyphs with their glow.
     env.logo (null when there is no logo): { cells, paintDefault(ctx) }.
     `cells` (OMP_MATRIX.logoCells): every drawn cell in canvas px, `solid`
     for the letters' █ blocks, else a box-drawing shadow edge.
     `paintDefault(ctx)` draws the default logo (cached; honours
     ctx.globalAlpha), for a style that builds on it.
   - env.pointer: { x, y, strength } in CSS px of the canvas. `strength`
     (0..1) eases up while the mouse moves over the canvas and back down
     once it rests (~1.2 s) or leaves; renderers scale a subtle reaction
     by it, so a parked cursor leaves the screen as it was.
   Reduced motion: no loop and no pointer reaction; the host paints
   STILL_STEPS steps once (a frozen frame) and repaints on resize/theme
   change.
   ═════════════════════════════════════════════════════════════════════ */

const { LOGO: _BD_LOGO, fitLogo: _BD_fitLogo, logoCells: _BD_logoCells } = window.OMP_MATRIX;

const _BD_STILL_STEPS = 90;
const _BD_POINTER_REST_MS = 1200;
const _BD_THEME_VARS = {
  bg: "--bg-window", accent: "--accent", glow: "--accent-glow", fg: "--fg", fg2: "--fg-2", fg3: "--fg-3",
  fg4: "--fg-4", line: "--line-bright", mono: "--font-mono", cyan: "--cyan", amber: "--amber", rose: "--rose",
  lilac: "--lilac", magenta: "--magenta", lime: "--lime",
};

function _BD_readTheme(el) {
  const cs = getComputedStyle(el);
  const theme = {};
  for (const [k, name] of Object.entries(_BD_THEME_VARS)) theme[k] = cs.getPropertyValue(name).trim();
  return theme;
}

const _BD_themeKey = (theme) => Object.values(theme).join("|");

/** Offscreen canvas around the logo rect, `pad` px of room for blur. */
function _BD_logoCanvas(fit, dpr, pad, paint) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((fit.width + pad * 2) * dpr);
  canvas.height = Math.ceil((fit.height + pad * 2) * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  paint(ctx);
  return { canvas, pad };
}

/** The soft background plate under the logo, pre-rendered per size/theme. */
function _BD_renderPlate(fit, theme, dpr) {
  const pad = Math.ceil(fit.font * 4);
  return _BD_logoCanvas(fit, dpr, pad, ctx => {
    const m = fit.font * 1.5;
    ctx.fillStyle = theme.bg;
    ctx.shadowColor = theme.bg;
    ctx.shadowBlur = fit.font * 2.5;
    ctx.globalAlpha = 0.86;
    ctx.fillRect(pad - m, pad - m, fit.width + m * 2, fit.height + m * 2);
  });
}

/** The default logo (accent glyphs with their glow), pre-rendered once per
 *  size/theme: shadowBlur on ~400 glyphs every frame would dominate the
 *  frame budget. */
function _BD_renderGlyphs(fit, theme, dpr) {
  const pad = Math.ceil(fit.font);
  return _BD_logoCanvas(fit, dpr, pad, ctx => {
    ctx.font = `${fit.font}px ${theme.mono}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.accent;
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = fit.font * 0.8;
    const cellW = fit.width / _BD_LOGO[0].length;
    const cellH = fit.height / _BD_LOGO.length;
    _BD_LOGO.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== " ") ctx.fillText(row[c], pad + c * cellW, pad + r * cellH);
      }
    });
  });
}

function Backdrop({ screen, logo = true, className }) {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const renderers = window.OMP_BACKDROP_RENDERERS ?? {};
    const renderer = renderers[screen] ?? renderers.matrix;
    if (!ctx || !renderer) return undefined;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, strength: 0 };
    const env = { width: 0, height: 0, fit: null, logo: null, compact: false, rand: Math.random, pointer };
    let dpr = 1, state = null, themeKey = "", raf = 0, last = 0;
    let theme = null, plateImg = null, glyphImg = null;
    const drawLogoImg = (target, img) => {
      const { fit } = env;
      target.drawImage(img.canvas, fit.x - img.pad, fit.y - img.pad, img.canvas.width / dpr, img.canvas.height / dpr);
    };
    const paintDefault = (target) => {
      glyphImg ??= _BD_renderGlyphs(env.fit, theme, dpr);
      drawLogoImg(target, glyphImg);
    };
    let inside = false, movedAt = -Infinity, easedAt = 0;

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      env.width = rect.width; env.height = rect.height; dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(env.width * dpr);
      canvas.height = Math.round(env.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      env.compact = env.height < 160 || env.width < 260;
      env.fit = null;
      env.logo = null;
      if (logo) {
        // Monospace: one measurement per 1px of font size covers every cell.
        ctx.font = `100px ${_BD_readTheme(canvas).mono}`;
        const m = ctx.measureText("█");
        const cellW = m.width / 100;
        const cellH = ((m.actualBoundingBoxAscent ?? 80) + (m.actualBoundingBoxDescent ?? 20)) / 100;
        env.fit = _BD_fitLogo(env.width, env.height, { cellW, cellH });
        if (env.fit) env.logo = { cells: _BD_logoCells(env.fit), paintDefault };
      }
      state = renderer.create(env);
      themeKey = "";  // force a logo re-render on the next step
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

    const frame = () => {
      // A move to a monitor with another scale factor changes the ratio but
      // not the CSS size, so the ResizeObserver never fires for it.
      if ((window.devicePixelRatio || 1) !== dpr) layout();
      easePointer(performance.now());
      theme = _BD_readTheme(canvas);
      const key = _BD_themeKey(theme);
      if (key !== themeKey) {
        themeKey = key;
        plateImg = env.fit && renderer.plate ? _BD_renderPlate(env.fit, theme, dpr) : null;
        glyphImg = null;  // re-rendered on first use
      }
      ctx.save();
      renderer.step(ctx, state, env, theme);
      ctx.restore();
      if (!env.fit) return;
      if (plateImg) drawLogoImg(ctx, plateImg);
      if (renderer.logo) {
        ctx.save();
        renderer.logo(ctx, state, env, theme);
        ctx.restore();
      } else {
        paintDefault(ctx);
      }
    };

    const still = () => {
      layout();
      for (let i = 1; i < _BD_STILL_STEPS; i++) {
        ctx.save();
        renderer.step(ctx, state, env, _BD_readTheme(canvas));
        ctx.restore();
      }
      frame();
    };

    // A renderer error stops this canvas only: thrown from the effect it
    // would unmount the whole React tree, and from the loop it would
    // repeat every frame.
    let broken = false;
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

    const loop = t => {
      if (broken) return;
      raf = requestAnimationFrame(loop);
      if (t - last < renderer.stepMs) return;
      last = t;
      run(frame);
    };

    if (reduceMotion) {
      const observer = new ResizeObserver(() => run(still));
      observer.observe(canvas);
      const themeObserver = new MutationObserver(() => run(still));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
      return () => { observer.disconnect(); themeObserver.disconnect(); };
    }
    const relayout = () => { layout(); frame(); };
    const observer = new ResizeObserver(() => run(relayout));
    observer.observe(canvas);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    run(relayout);
    if (!broken) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [screen, logo]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

Object.assign(window, { Backdrop });
