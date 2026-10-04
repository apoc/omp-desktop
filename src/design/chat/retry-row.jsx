/* chat/retry-row.jsx — omp retrying a failed request by itself (the `retry`
   entry of app/turn-status.js `retryStarted`): which attempt, omp's error, a
   countdown to the next attempt or how long the one in flight has waited,
   and Stop. One row per run, hidden once omp ends the retries (turn-status
   `isHidden`) and gone when the run ends; the failed attempts it
   stands for leave no reply bubbles of their own. */

const { Icon: _RR_Icon, TOOL_META: _RR_TOOL_META } = window;

const _RR_META = _RR_TOOL_META.retry;
const _RR_CLOCK = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** `7 s`, `2 min 5 s`; never negative. */
function _RR_span(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const RetryRow = React.memo(function RetryRow({ msg, idx, highlighted, onStop }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Stop is pending until omp ends the run (the row goes) or the phase moves
  // on; a refusal shows under the button.
  const [stop, setStop] = React.useState({ busy: false, error: null });
  React.useEffect(() => { setStop({ busy: false, error: null }); }, [msg.phase, msg.failed]);

  const waiting = msg.phase === "waiting";
  const f = msg.failure;
  const where = [f?.provider, f?.model].filter(Boolean).join(" · ");
  const title = msg.maxAttempts ? `Retrying · attempt ${msg.attempt} of ${msg.maxAttempts}` : `Retrying · attempt ${msg.attempt}`;
  const status = waiting
    ? `next try in ${_RR_span(msg.since + msg.delayMs - now)}`
    : `sent ${_RR_span(now - msg.since)} ago, waiting for the provider`;
  const failed = `failed ${msg.failed} time${msg.failed === 1 ? "" : "s"} since ${_RR_CLOCK.format(new Date(msg.firstFailedAt))}`;

  const stopNow = async () => {
    setStop({ busy: true, error: null });
    const res = await onStop?.();
    if (res && !res.ok) setStop({ busy: false, error: res.error ?? "could not stop" });
  };

  return (
    <div className={`row tool fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="tool-glyph retry-glyph" style={{ borderColor: _RR_META.color, color: _RR_META.color }}>
          <_RR_Icon name={_RR_META.icon} size={11} color={_RR_META.color} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className="tool-card retry-card">
        <div className="tool-card-head">
          <span className="tool-tag" style={{
            color: _RR_META.color,
            background: `color-mix(in oklab, ${_RR_META.color} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${_RR_META.color} 30%, var(--line))`,
          }}>{_RR_META.label}</span>
          <span className="tool-title">{title}</span>
          <div className="tool-card-spacer" />
          {where && <span className="chip muted mono retry-where">{where}</span>}
        </div>
        <div className="retry-body">
          {f && <div className="retry-error selectable" title={f.raw}>{f.headline}</div>}
          <div className="retry-foot">
            <span className="retry-status mono">{status} · {failed}</span>
            <button type="button" className="btn outlined retry-stop" disabled={stop.busy} onClick={stopNow}
              title={waiting ? "Stop retrying: the run ends on the last failure" : "Stop the attempt in flight, as Esc does"}>
              {waiting ? "Stop retrying" : "Stop"}
            </button>
          </div>
          {stop.error && <div className="retry-stop-error">{stop.error}</div>}
        </div>
      </div>
    </div>
  );
});

Object.assign(window, { RetryRow });
