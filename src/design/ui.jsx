/* ═════════════════════════════════════════════════════════════════════
   ui.jsx — small reusable building blocks (icons, sparkline, gauge)
   Exposed on window for the Babel script-scope dance.
   ═════════════════════════════════════════════════════════════════════ */

// Inline SVG icon set. Hand-tuned for 14px stroke-1.5.
const Icon = ({ name, size = 14, color = "currentColor", ...rest }) => {
  const paths = {
    plus:    <path d="M8 3v10M3 8h10" />,
    cog:     <><circle cx="8" cy="8" r="2" /><path d="M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" /></>,
    close:   <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
    chev:    <path d="M5 6l3 3 3-3" />,
    chevR:   <path d="M6 5l3 3-3 3" />,
    search:  <><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></>,
    file:    <><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></>,
    folder:  <path d="M2 5l2-2h3l1 1h6v8H2z" />,
    edit:    <path d="M2 12V14h2l8-8-2-2-8 8z M9 4l2 2" />,
    diff:    <><path d="M5 2v12M11 2v12" /><path d="M3 5h4M9 11h4" /></>,
    bash:    <><path d="M3 4l3 3-3 3" /><path d="M8 11h5" /></>,
    sparkle: <path d="M8 2l1.2 3.2L13 6l-3.8 0.8L8 10l-1.2-3.2L3 6l3.8-0.8z" />,
    bolt:    <path d="M9 1L3 9h4l-1 6 6-8H8z" />,
    check:   <path d="M3 8l3 3 7-7" />,
    circle:  <circle cx="8" cy="8" r="3" />,
    dot:     <circle cx="8" cy="8" r="2" />,
    arrow:   <><path d="M3 8h10" /><path d="M9 4l4 4-4 4" /></>,
    arrowUp: <><path d="M8 13V3" /><path d="M4 7l4-4 4 4" /></>,
    stop:    <rect x="4" y="4" width="8" height="8" rx="1" />,
    play:    <path d="M5 3l8 5-8 5z" />,
    plan:    <><rect x="2" y="3" width="3" height="10" /><rect x="6.5" y="3" width="3" height="6" /><rect x="11" y="3" width="3" height="8" /></>,
    radar:   <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="1" /></>,
    grid:    <><rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" /><rect x="2" y="9" width="5" height="5" /><rect x="9" y="9" width="5" height="5" /></>,
    minimap: <><rect x="2" y="2" width="12" height="12" rx="1" /><rect x="4" y="6" width="8" height="3" /></>,
    sidebar: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M6 3v10" /></>,
    voice:   <><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M3 8a5 5 0 0 0 10 0M8 13v2" /></>,
    image:   <><rect x="2" y="3" width="12" height="10" rx="1" /><circle cx="6" cy="7" r="1.2" /><path d="M3 12l3-3 3 2 2-2 4 4" /></>,
    thinking:<><path d="M5 3a3 3 0 0 1 6 0c0 1.5-1.5 2-1.5 3.5h-3C6.5 5 5 4.5 5 3z" /><path d="M6.5 9.5h3M7 12h2" /></>,
    branch:  <><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="8" r="1.5" /><path d="M4 4.5v7M4 8h2a4 4 0 0 0 4-4" /></>,
    split:   <><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M8 2v12" /></>,
    layers:  <><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></>,
    spool:   <><circle cx="8" cy="8" r="6" /><path d="M8 4v4l3 2" /></>,
    cmd:     <path d="M5 4a2 2 0 1 0-2 2h2zM5 4v8M5 12a2 2 0 1 0 2-2H5zM11 12a2 2 0 1 0 2-2h-2zM11 12V4M11 4a2 2 0 1 0-2 2h2z" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {paths[name] || null}
    </svg>
  );
};

// Tool name → color + icon
const TOOL_META = {
  read:    { color: "var(--cyan)",    icon: "file",   label: "read" },
  search:  { color: "var(--lilac)",   icon: "search", label: "find" },
  edit:    { color: "var(--accent)",  icon: "diff",   label: "edit" },
  bash:    { color: "var(--amber)",   icon: "bash",   label: "bash" },
  write:   { color: "var(--magenta)", icon: "edit",   label: "write" },
  todo:    { color: "var(--lime)",    icon: "plan",   label: "todo" },
};

// ── Sparkline ─────────────────────────────────────────────────────────
const Sparkline = ({ values, width = 80, height = 18, color = "var(--accent)", glow = true }) => {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const stepX = width / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 2) - 1]);
  const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ");
  const fill = `${d} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#spark-grad)" />
      <path d={d} stroke={color} strokeWidth="1.25" fill="none"
        style={{ filter: glow ? `drop-shadow(0 0 4px ${color})` : "none" }} />
    </svg>
  );
};

// ── Token gauge — radial, with usage + budget tick ───────────────────
const TokenGauge = ({ used, total, pct, label, sub }) => {
  const r = 22;
  const C = 2 * Math.PI * r;
  const dash = (Math.min(pct, 100) / 100) * C;
  const tone = pct > 80 ? "var(--rose)" : pct > 60 ? "var(--amber)" : "var(--accent)";
  return (
    <div className="token-gauge">
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={r} stroke="var(--line)" strokeWidth="3" fill="none" />
        <circle cx="28" cy="28" r={r}
          stroke={tone}
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${dash} ${C}`}
          transform="rotate(-90 28 28)"
          style={{ filter: `drop-shadow(0 0 4px ${tone})`, transition: "stroke-dasharray 600ms var(--ease-out)" }}
        />
        <text x="28" y="31" textAnchor="middle" fontSize="11" fontFamily="var(--font-mono)" fill="var(--fg)">
          {pct}%
        </text>
      </svg>
      <div>
        <div style={{ fontSize: "var(--d-text-sm)", color: "var(--fg-2)", fontFamily: "var(--font-mono)" }}>{label}</div>
        <div style={{ fontSize: "var(--d-text-xs)", color: "var(--fg-4)" }}>{sub}</div>
      </div>
    </div>
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
              background: c ? TOOL_META[c.k]?.color : "transparent",
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

Object.assign(window, { Icon, TOOL_META, Sparkline, TokenGauge, ActivityRadar });
