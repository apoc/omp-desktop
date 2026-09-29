/* ═════════════════════════════════════════════════════════════════════
   empty-workspace.jsx — the session column while no tab is open

   The app starts without a tab (no pathless launch session), and closing
   the last tab returns here. Opening a project is the sidebar's and the
   tab bar's job; this space is a welcome screen — "digital rain" behind an
   ASCII-art OMP-DESKTOP logo (geometry: app/matrix-rain.js) — plus any note
   the bridge filed while no tab existed (e.g. a failed "Open with"), which
   would otherwise have no transcript to land in.
   ═════════════════════════════════════════════════════════════════════ */

const { MarkdownContent } = window;
const { LOGO, fitLogo, initDrops, stepDrops, randomGlyph } = window.OMP_MATRIX;

const RAIN_FONT = 14;          // px per rain cell
const RAIN_STEP_MS = 55;       // ~18 steps/s: reads as rain, costs little
const TRAIL_FADE = 0.09;       // background alpha laid over each step

/** Theme colours, re-read every step so a theme switch applies live. */
function readTheme(el) {
  const cs = getComputedStyle(el);
  const v = name => cs.getPropertyValue(name).trim();
  return { bg: v("--bg-window"), accent: v("--accent"), glow: v("--accent-glow"), fg: v("--fg"), mono: v("--font-mono") };
}

/** Pre-render the logo (with its glow) once per size/theme: shadowBlur on
 *  ~400 glyphs every frame would dominate the frame budget. */
function renderLogo(fit, theme, dpr) {
  const pad = Math.ceil(fit.font);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((fit.width + pad * 2) * dpr);
  canvas.height = Math.ceil((fit.height + pad * 2) * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = `${fit.font}px ${theme.mono}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.accent;
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = fit.font * 0.8;
  const cellW = fit.width / LOGO[0].length;
  const cellH = fit.height / LOGO.length;
  LOGO.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== " ") ctx.fillText(row[c], pad + c * cellW, pad + r * cellH);
    }
  });
  return { canvas, pad };
}

function MatrixBackdrop() {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return undefined;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, dpr = 1;
    let drops = [], rows = 0, logo = null, fit = null;
    let themeKey = "", raf = 0, last = 0;

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height; dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const theme = readTheme(canvas);
      // Monospace: one measurement per 1px of font size covers every cell.
      ctx.font = `100px ${theme.mono}`;
      const m = ctx.measureText("█");
      const cellW = m.width / 100;
      const cellH = ((m.actualBoundingBoxAscent ?? 80) + (m.actualBoundingBoxDescent ?? 20)) / 100;
      fit = fitLogo(width, height, { cellW, cellH });
      rows = Math.ceil(height / RAIN_FONT);
      drops = initDrops(Math.ceil(width / RAIN_FONT), rows, Math.random);
      themeKey = "";  // force a logo re-render below
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, height);
    };

    const frame = () => {
      // A move to a monitor with another scale factor changes the ratio but
      // not the CSS size, so the ResizeObserver never fires for it.
      if ((window.devicePixelRatio || 1) !== dpr) layout();
      const theme = readTheme(canvas);
      const key = `${theme.accent}|${theme.glow}|${theme.mono}`;
      if (key !== themeKey) {
        themeKey = key;
        logo = fit ? renderLogo(fit, theme, dpr) : null;
      }
      // Fade the previous steps into the background, leaving trails. With no
      // rain there are no trails to keep: a full clear, or a theme switch
      // would leave the old background and logo ghosting underneath.
      ctx.globalAlpha = reduceMotion ? 1 : TRAIL_FADE;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
      if (!reduceMotion) {
        ctx.font = `${RAIN_FONT}px ${theme.mono}`;
        ctx.textBaseline = "top";
        for (let i = 0; i < drops.length; i++) {
          const y = drops[i] * RAIN_FONT;
          if (y < 0 || y > height) continue;
          // The leading glyph brightest, like the head of a falling drop.
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = theme.accent;
          ctx.fillText(randomGlyph(Math.random), i * RAIN_FONT, y);
        }
        ctx.globalAlpha = 1;
        stepDrops(drops, rows, Math.random);
      }
      if (logo) {
        ctx.drawImage(logo.canvas, fit.x - logo.pad, fit.y - logo.pad, logo.canvas.width / dpr, logo.canvas.height / dpr);
      }
    };

    const loop = t => {
      raf = requestAnimationFrame(loop);
      if (t - last < RAIN_STEP_MS) return;
      last = t;
      frame();
    };

    const onResize = () => { layout(); frame(); };
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas);
    onResize();
    // Reduced motion: the static logo only, redrawn on resize/theme change.
    if (reduceMotion) {
      const themeObserver = new MutationObserver(() => frame());
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
      return () => { observer.disconnect(); themeObserver.disconnect(); };
    }
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} className="empty-ws-canvas" aria-hidden="true" />;
}

function EmptyWorkspace({ notes }) {
  return (
    <div className="empty-ws" aria-label="no project open">
      <MatrixBackdrop />
      {notes.length > 0 && (
        <div className="empty-ws-notes">
          {notes.map((note, i) => (
            <div key={i} className="empty-ws-note">
              <MarkdownContent text={note} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { EmptyWorkspace });
