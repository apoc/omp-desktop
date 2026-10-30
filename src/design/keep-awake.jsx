/* The status bar clips descendants, so the chat control is portaled above it. */
function KeepAwakeCell({ awake, sessionId, onSettings }) {
  const [position, setPosition] = React.useState(null);
  const trigger = React.useRef(null);
  const panel = React.useRef(null);
  const root = React.useRef(null);
  const panelId = React.useId();
  root.current = {
    contains: (node) =>
      trigger.current?.contains(node) || panel.current?.contains(node),
  };
  const close = (refocus = true) => {
    setPosition(null);
    if (refocus) trigger.current?.focus();
  };
  window.usePopoverDismiss(!!position, root, () => close(false), close);
  React.useEffect(() => {
    if (!position) return undefined;
    panel.current?.querySelector("button:not(:disabled)")?.focus();
    const dismiss = () => close(false);
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [position]);
  const toggle = () => {
    if (position) {
      close();
      return;
    }
    const rect = trigger.current.getBoundingClientRect();
    setPosition({
      bottom: window.innerHeight - rect.top + 6,
      right: Math.max(
        8,
        Math.min(window.innerWidth - rect.right, window.innerWidth - 288),
      ),
      maxHeight: Math.max(80, rect.top - 12),
    });
  };
  const session = awake.session;
  const summary = window.OMP_KEEP_AWAKE.status(awake.snapshot, session);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="status-cell btn ghost keep-awake-trigger"
        disabled={!sessionId}
        onClick={toggle}
        aria-label="Keep computer awake"
        aria-haspopup="dialog"
        aria-expanded={!!position}
        aria-controls={position ? panelId : undefined}
        title={
          awake.error
            ? `Keep computer awake: ${awake.error}`
            : "Keep computer awake"
        }
      >
        <window.Icon
          name={awake.error ? "warn" : "clock"}
          size={11}
          color={
            awake.error
              ? "var(--rose)"
              : session?.enabled
                ? "var(--accent)"
                : "var(--fg-3)"
          }
        />
      </button>
      {position &&
        ReactDOM.createPortal(
          <div
            ref={panel}
            id={panelId}
            className="keep-awake-pop"
            style={position}
            role="dialog"
            aria-label="Keep computer awake"
          >
            <div className="keep-awake-heading">Keep computer awake</div>
            <p>Only for this chat and while the agent is working.</p>
            <div className="keep-awake-choice">
              <span>
                {session ? (session.enabled ? "On" : "Off") : "Unavailable"}
              </span>
              <button
                type="button"
                className="st-tgl"
                role="switch"
                aria-label="Keep computer awake for this chat"
                aria-checked={!!session?.enabled}
                disabled={!session || awake.pending}
                onClick={() => awake.setSession(!session.enabled)}
              />
            </div>
            <p className="keep-awake-state" aria-live="polite">
              {summary}
            </p>
            {awake.error && (
              <p className="keep-awake-error" role="alert">
                {awake.error}
              </p>
            )}
            <p>Manual locks and security policies still apply.</p>
            <div className="keep-awake-actions">
              <button
                type="button"
                disabled={
                  !session || session.overrideEnabled === null || awake.pending
                }
                onClick={() => awake.setSession(null)}
              >
                Use default
                {awake.snapshot
                  ? ` (${awake.snapshot.defaultEnabled ? "on" : "off"})`
                  : ""}
              </button>
              <button
                type="button"
                onClick={() => {
                  close(false);
                  onSettings();
                }}
              >
                Settings → Session
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
window.KeepAwakeCell = KeepAwakeCell;
