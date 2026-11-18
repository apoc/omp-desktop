/* ═════════════════════════════════════════════════════════════════════
   persona-strip.jsx — Ompy's state strip above the Ompy chat, plus the
   CSS-only face the sidebar's pinned entry draws.

   The strip reads `persona_status` through `OMP_PERSONA.statusView`
   (app/persona.js: label, next wake, token budget bar) and keeps its own
   clock, so "in 12 min" stays true while the window sits idle. Its
   controls are the service's: pause/resume, a manual wake while running,
   and Enable while the service is not connected. A `persona://error` the
   app cannot act on (protocol mismatch, another account's pipe) replaces
   the details with one sentence instead of a retry loop. The app's own
   sidecar-refresh failure has its own slot, so a connection error never
   replaces it and it never replaces the details.
   ═════════════════════════════════════════════════════════════════════ */

const _PS_TICK_MS = 30_000;


/** The pinned entry's glyph: a mint circle with two punched-out dots.
 *  Decorative — the row's name is its accessible text. */
function PersonaFace() {
  return <span className="persona-face" aria-hidden="true" />;
}

/**
 * status: `persona_status`'s StatusInfo, or null while the service is not
 *         connected.
 * error:  the connection's last `persona://error` (`{kind, message}`), or
 *         null.
 * refreshError: the app-side sidecar refresh failure (`kind: "refresh"`), or
 *         null. Shown next to the details, never instead of them, and never
 *         replaced by a connection error.
 * bridge: OMP_BRIDGE; pause/resume/wake/enable are its persona commands.
 */
function PersonaStrip({ status, error, refreshError, bridge }) {
  // `statusView` shows the next wake against the local clock; a strip that
  // never re-rendered would keep saying "in 12 min" while the window idles.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!status) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), _PS_TICK_MS);
    return () => clearInterval(timer);
  }, [status]);
  const view = window.OMP_PERSONA.statusView(status, now);
  // One request at a time: a second click would race the first reply.
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);

  const run = call => {
    if (busy || !bridge) return;
    setBusy(true);
    setFailure(null);
    Promise.resolve()
      .then(call)
      .then(result => {
        if (result?.ok === false) {
          setFailure(OMP_TR("failed: {error}", { error: result.error || OMP_TR("unknown error") }));
        }
      })
      .catch(err => setFailure(OMP_TR("failed: {error}", { error: err?.message ?? String(err) })))
      .finally(() => setBusy(false));
  };

  // `errorView` names the failure in the user's language and keeps the
  // platform's own text for the tooltip: an OS error string is never the line.
  // A service the user just disabled is absent on purpose, so the connection
  // `io` error of that expected absence is not shown.
  const expectedOff = bridge?.personaExpectedOff?.() === true;
  const connectionProblem = error && expectedOff && !status && error.kind === "io" ? null : error;
  const connectionView = window.OMP_PERSONA.errorView(connectionProblem);
  const refreshView = window.OMP_PERSONA.errorView(refreshError);
  const dot = !view.online ? ""
    : view.state === "running" ? " live"
    : view.state === "paused" || view.state === "budget_exhausted" ? " warn"
    : view.state === "error" ? " error"
    : "";

  return (
    <div className={`persona-strip${view.online ? "" : " off"}`} role="group" aria-label={OMP_TR("Ompy")}>
      <div className="persona-line">
        <span className={`dot persona-dot${dot}`} />
        <span className="persona-title">
          {view.online ? `${OMP_TR("Ompy")} · ${view.label}` : view.label}
        </span>
        {connectionView ? (
          <span className="persona-error" role="status" title={connectionView.detail || undefined}>
            {connectionView.text}
          </span>
        ) : view.online ? (<>
          <span className="persona-note">{OMP_TR("next wake-up")} {view.nextWake}</span>
          <span className="persona-sep" aria-hidden="true">·</span>
          <span className="persona-note">{view.tokensText}</span>
        </>) : null}
        {refreshView && (
          <span className="persona-error" role="status" title={refreshView.detail || undefined}>
            {refreshView.text}
          </span>
        )}
        {failure && <span className="persona-failure" role="status">{failure}</span>}
        <span className="persona-spacer" />
        {!view.online ? (
          <button type="button" className="btn outlined persona-action" disabled={busy}
            onClick={() => run(() => bridge?.personaEnable())}>
            {OMP_TR("Enable")}
          </button>
        ) : (<>
          {view.state === "running" && (
            <button type="button" className="btn ghost persona-action" disabled={busy}
              onClick={() => run(() => bridge?.personaWakeNow())}>
              {OMP_TR("Wake now")}
            </button>
          )}
          {view.canResume ? (
            <button type="button" className="btn outlined persona-action" disabled={busy}
              onClick={() => run(() => bridge?.personaResume())}>
              {OMP_TR("Resume")}
            </button>
          ) : view.canPause ? (
            <button type="button" className="btn outlined persona-action" disabled={busy}
              onClick={() => run(() => bridge?.personaPause())}>
              {OMP_TR("Pause")}
            </button>
          ) : null}
        </>)}
      </div>
      {view.online && (
        <div className="persona-bar" aria-hidden="true">
          <span className="persona-bar-fill" style={{ width: `${view.tokensPct}%` }} />
        </div>
      )}
    </div>
  );
}

Object.assign(window, { PersonaFace, PersonaStrip });
