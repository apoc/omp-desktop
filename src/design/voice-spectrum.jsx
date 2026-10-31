/* The composer's voice spectrum: an equalizer of the microphone while voice
   to text or a live call records. `source` is the ref useVoiceSpectrum keeps
   Rust's newest frame in; the canvas redraws on animation frames with the
   bar physics of app/voice-spectrum.js, so no frame re-renders React. */

// Theme colours, re-read now and then so a theme switch shows up.
function _VS_colors(el) {
  const css = getComputedStyle(el);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    low: v("--accent", "#8AF0C8"),
    mid: v("--cyan", "#6EE7FF"),
    high: v("--lilac", "#B59BFF"),
    glow: v("--accent-glow", "rgba(138,240,200,.45)"),
    cap: v("--fg", "#E8ECF4"),
  };
}

function _VS_bar(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
  else ctx.fillRect(x, y, w, h);
}

function _VS_draw(ctx, w, h, state, colors) {
  const dpr = window.devicePixelRatio || 1;
  const { values, peaks } = state;
  const n = values.length;
  const pad = 10 * dpr;
  const slot = (w - pad * 2) / n;
  const barW = Math.max(1, slot * 0.62);
  const baseline = Math.round(h * 0.74);
  const room = baseline - 3 * dpr;
  const reflect = h - baseline - 1 * dpr;
  const radius = Math.min(barW / 2, 3 * dpr);
  const minBar = 2 * dpr;

  ctx.clearRect(0, 0, w, h);
  const hue = ctx.createLinearGradient(pad, 0, w - pad, 0);
  hue.addColorStop(0, colors.low);
  hue.addColorStop(0.55, colors.mid);
  hue.addColorStop(1, colors.high);

  for (let i = 0; i < n; i++) {
    const v = values[i];
    const x = pad + i * slot + (slot - barW) / 2;
    const bh = Math.max(minBar, v * room);
    // Bar: brighter and glowing as it rises.
    ctx.fillStyle = hue;
    ctx.globalAlpha = 0.45 + 0.55 * v;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 10 * dpr * v;
    _VS_bar(ctx, x, baseline - bh, barW, bh, radius);
    // Reflection under the baseline, faint and short.
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.12 + 0.12 * v;
    _VS_bar(ctx, x, baseline + 1 * dpr, barW, Math.max(1, Math.min(reflect, bh * 0.35)), radius);
    // Peak cap, resting above a bar that has dropped.
    const p = peaks[i];
    if (p > 0.04) {
      ctx.globalAlpha = 0.35 + 0.5 * p;
      ctx.fillStyle = colors.cap;
      ctx.fillRect(x, Math.round(baseline - p * room - 3 * dpr), barW, 1.5 * dpr);
    }
  }
  ctx.globalAlpha = 1;
}

function VoiceSpectrum({ source }) {
  const canvasRef = React.useRef(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    const VS = window.OMP_VOICE_SPECTRUM;
    let state = VS.createState();
    let colors = _VS_colors(canvas);
    let colorsAt = performance.now();
    let last = performance.now();
    let raf = 0;
    let dirty = true;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      dirty = true;
    };
    const resize = new ResizeObserver(fit);
    resize.observe(canvas);
    fit();
    const tick = now => {
      raf = requestAnimationFrame(tick);
      if (now - colorsAt > 1000) { colors = _VS_colors(canvas); colorsAt = now; dirty = true; }
      const frame = source.current;
      // The bar count follows the frames (Settings may change it mid-call).
      if (frame && frame.length !== state.values.length) { state = VS.createState(frame.length); dirty = true; }
      const moving = VS.step(state, frame, now - last);
      last = now;
      if (moving || dirty) { _VS_draw(ctx, canvas.width, canvas.height, state, colors); dirty = false; }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); resize.disconnect(); };
  }, [source]);
  return (
    <div className="voice-spectrum" role="img" aria-label="Microphone spectrum">
      <canvas ref={canvasRef} />
    </div>
  );
}

Object.assign(window, { VoiceSpectrum });
