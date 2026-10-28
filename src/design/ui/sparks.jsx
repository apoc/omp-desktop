/* ui/sparks.jsx — Sparkline + ActivityRadar.
   Small ambient peripherals shown in the right rail. */

const { TOOL_META: _SP_TOOL_META } = window;

// ── Sparkline ─────────────────────────────────────────────────────────
// Drawn in a `width` × `height` box stretched to its container's width (the
// rail is resizable, #41); the stroke keeps its width.
const Sparkline = ({ values, width = 80, height = 18, color = "var(--accent)", glow = true }) => {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const stepX = width / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 2) - 1]);
  const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ");
  const fill = `${d} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#spark-grad)" />
      <path d={d} stroke={color} strokeWidth="1.25" fill="none" vectorEffect="non-scaling-stroke"
        style={{ filter: glow ? `drop-shadow(0 0 4px ${color})` : "none" }} />
    </svg>
  );
};

// ── Activity radar — 60s strip of tool calls colored by kind ─────────
const ActivityRadar = ({ activity, tps }) => {
  const cells = Array.from({ length: 60 }, (_, i) => activity.find((a) => a.t === i));
  return (
    <div className="radar">
      <div className="radar-row">
        {cells.map((c, i) => (
          <div key={i}
            className={`radar-cell ${c ? "on" : ""}`}
            style={{
              background: c ? _SP_TOOL_META[c.k]?.color : "transparent",
              animationDelay: `${i * 30}ms`,
            }}
            title={c ? `t-${60 - i}s · ${c.k}` : ""} />
        ))}
      </div>
      <div className="radar-foot">
        <span className="mono" style={{ color: "var(--fg-3)" }}>−60s</span>
        <span className="mono" style={{ color: "var(--accent)" }}>{tps} t/s</span>
        <span className="mono" style={{ color: "var(--fg-3)" }}>now</span>
      </div>
    </div>
  );
};


Object.assign(window, { Sparkline, ActivityRadar });
