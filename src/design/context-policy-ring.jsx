/* The inner arc is measured usage; the outer marker is the editable target. */
function ContextPolicyRing({
  usage,
  target,
  bounds,
  editing,
  disabled,
  onPercent,
  onStart,
  onCancel,
}) {
  const T = window.OMP_CONTEXT_TARGET;
  const drag = React.useRef(null);
  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  const safeTarget = finite(target) ? target : 0;
  const percentLabel = finite(usage) ? `${usage.toFixed(1)}%` : "—";
  const tone =
    usage > 80 ? "var(--rose)" : usage > 60 ? "var(--amber)" : "var(--accent)";
  if (!editing) {
    const angle = (safeTarget * 3.6 * Math.PI) / 180;
    const x1 = 28 + 24 * Math.sin(angle),
      y1 = 28 - 24 * Math.cos(angle);
    const x2 = 28 + 27 * Math.sin(angle),
      y2 = 28 - 27 * Math.cos(angle);
    const circumference = 2 * Math.PI * 22;
    return (
      <svg
        className="context-policy-small-ring"
        width="56"
        height="56"
        viewBox="0 0 56 56"
        role="img"
        aria-label={
          finite(usage)
            ? `Context usage ${percentLabel}`
            : "Context usage unavailable"
        }
      >
        <circle
          cx="28"
          cy="28"
          r="22"
          className="context-policy-ring-track"
          strokeWidth="3"
        />
        {finite(usage) && (
          <circle
            cx="28"
            cy="28"
            r="22"
            fill="none"
            stroke={tone}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(T.clamp(usage, 0, 100) / 100) * circumference} ${circumference}`}
            transform="rotate(-90 28 28)"
          />
        )}
        {finite(target) && (
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            className="context-policy-ring-tick"
          />
        )}
        <text
          x="28"
          y="31"
          textAnchor="middle"
          className="context-policy-ring-text"
        >
          {percentLabel}
        </text>
      </svg>
    );
  }
  const start = T.point(0, 58, 72),
    end = T.point(100, 58, 72);
  const targetPoint = T.point(safeTarget, 64, 72);
  const usedEnd = T.point(T.clamp(usage || 0, 0, 100), 52, 72);
  const position = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      cx: rect.width / 2,
      cy: rect.height / 2,
      radius: Math.min(rect.width, rect.height) / 2,
    };
  };
  const pointerDown = (event) => {
    if (
      disabled ||
      !bounds ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;
    const p = position(event);
    if (!T.pointerHit(p.x, p.y, p.cx, p.cy, p.radius)) return;
    event.preventDefault();
    drag.current = {
      ...T.startDrag(p.x, p.y, p.cx, p.cy, bounds),
      pointerId: event.pointerId,
    };
    onStart();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    onPercent(drag.current.percent);
  };
  const pointerMove = (event) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const p = position(event),
      before = drag.current;
    drag.current = {
      ...before,
      ...T.moveDrag(before, p.x, p.y, p.cx, p.cy, bounds),
    };
    onPercent(drag.current.percent);
  };
  const finish = (event, cancel) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    if (cancel) onCancel();
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className="context-policy-large-ring"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Auto-compaction target"
      aria-valuemin={bounds?.min}
      aria-valuemax={bounds?.max}
      aria-valuenow={T.clamp(safeTarget, bounds?.min ?? 0, bounds?.max ?? 100)}
      aria-valuetext={`${safeTarget.toFixed(2)} percent`}
      aria-disabled={disabled || undefined}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onLostPointerCapture={(e) => finish(e, true)}
      onKeyDown={(event) => {
        if (disabled || !bounds) return;
        const value = T.keyPercent(event.key, safeTarget, bounds);
        if (value != null) {
          event.preventDefault();
          event.stopPropagation();
          onPercent(value);
        }
      }}
    >
      <svg viewBox="0 0 144 144" aria-hidden="true">
        <path
          d={`M ${start.x} ${start.y} A 58 58 0 1 1 ${end.x} ${end.y}`}
          className="context-policy-ring-track"
          strokeWidth="3"
        />
        {finite(usage) && usage > 0 && (
          <path
            d={`M ${T.point(0, 52, 72).x} ${T.point(0, 52, 72).y} A 52 52 0 ${usage > 66.6667 ? 1 : 0} 1 ${usedEnd.x} ${usedEnd.y}`}
            fill="none"
            stroke={tone}
            strokeWidth="4"
            strokeLinecap="round"
          />
        )}
        <circle
          cx={targetPoint.x}
          cy={targetPoint.y}
          r="5"
          className="context-policy-ring-marker"
        />
        <text
          x="72"
          y="70"
          textAnchor="middle"
          className="context-policy-ring-large-text"
        >
          {percentLabel}
        </text>
        <text
          x="72"
          y="86"
          textAnchor="middle"
          className="context-policy-ring-caption"
        >
          used
        </text>
      </svg>
    </div>
  );
}
window.ContextPolicyRing = ContextPolicyRing;
