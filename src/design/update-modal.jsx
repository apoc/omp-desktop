/* ═════════════════════════════════════════════════════════════════════
   update-modal.jsx — in-app update check / install (issue #19).

   Props: { updater, busyTabs, onClose }
     updater  — result of useUpdater() (app/use-updater.jsx)
     busyTabs — tabs a restart would interrupt (OMP_UPDATER.busyTabCount)

   Mounted only while open (app-live.jsx gates on `updater.open`), same
   as the other panels. Release notes render as plain text, not markdown:
   they come from the feed's `notes`, which the updater signature does
   not cover, and this webview has `window.__TAURI__`.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _UpdIcon } = window;

function UpdateModal({ updater, busyTabs, onClose }) {
  const U = window.OMP_UPDATER;
  const { state, version } = updater;
  const { phase, update, progress, error } = state;
  const pct = U.progressPct(progress);
  const inFlight = phase === "downloading" || phase === "restarting";
  const panelRef = React.useRef(null);

  // Take focus on open (so Tab walks the modal's buttons, not the composer
  // underneath) and hand it back on close — same pattern as
  // prompt-history-modal.jsx. Nothing is focused by default: Enter must not
  // install and restart by accident.
  React.useEffect(() => {
    const restore = document.activeElement;
    requestAnimationFrame(() => panelRef.current?.focus());
    return () => { restore?.focus?.(); };
  }, []);

  // Capture phase on `window`, not the panel's own onKeyDown: focus can
  // leave the panel while it is open — the composer refocuses itself when
  // a turn ends, and a failed install unmounts the focused button — and a
  // keystroke must then neither type into nor Enter-send the hidden
  // composer. Same guard as prompt-history-modal.jsx. Escape closes except
  // mid-install; any other unmodified key aimed outside the panel is
  // swallowed and focus pulled back. Modified keys pass (global shortcuts).
  React.useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (!inFlight) onClose();
      } else if (!panelRef.current?.contains(e.target)) {
        e.preventDefault(); e.stopPropagation();
        panelRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inFlight, onClose]);

  return (
    <div className="bridge-scrim" onClick={inFlight ? undefined : onClose} style={{ paddingTop: "12vh" }}>
      <div className="update-panel" ref={panelRef} tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="update-head">
          <_UpdIcon name="arrowUp" size={13} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>updates · OMP Desktop {version ? `v${version}` : ""}</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} title="check again"
            onClick={() => updater.check(true)} disabled={phase === "checking" || inFlight}>
            <_UpdIcon name="refresh" size={11} />
          </button>
          {!inFlight && (
            <button className="btn icon ghost" onClick={onClose} title="close">
              <_UpdIcon name="close" size={11} />
            </button>
          )}
        </div>

        <div className="update-body">
          {phase === "idle" && <div className="panel-empty mono">not checked yet</div>}
          {phase === "checking" && !update && <div className="panel-empty mono">checking for updates…</div>}
          {phase === "uptodate" && <div className="panel-empty mono">you're on the latest version</div>}
          {phase === "error" && <div className="panel-empty mono update-error">{error}</div>}

          {update && (
            <>
              <div className="update-title">
                <span className="mono" style={{ color: "var(--accent)" }}>v{update.version}</span>
                <span className="mono" style={{ color: "var(--fg-4)" }}>
                  available{update.date ? ` · ${update.date.slice(0, 10)}` : ""}
                </span>
              </div>
              {update.notes && <pre className="update-notes selectable">{update.notes}</pre>}
              {error && <div className="update-error mono">{error}</div>}
              {!update.canInstall && (
                <div className="update-hint mono">
                  This installation is managed outside the app (system package or source build) —
                  download the new version from the release page.
                </div>
              )}
              {update.canInstall && busyTabs > 0 && !inFlight && (
                <div className="update-hint mono">
                  {busyTabs === 1 ? "1 tab is" : `${busyTabs} tabs are`} mid-turn — restarting interrupts
                  {busyTabs === 1 ? " it" : " them"} (unfinished turns are not saved).
                </div>
              )}
              {inFlight && (
                <div className="update-progress">
                  <span className="status-bar-tube update-tube">
                    <span className={`status-bar-fill ${pct == null ? "update-indeterminate" : ""}`}
                      style={{ width: `${pct ?? 30}%` }} />
                  </span>
                  <span className="mono" style={{ color: "var(--fg-3)" }}>
                    {phase === "restarting"
                      ? "restarting…"
                      : `${U.formatBytes(progress?.downloaded ?? 0)}${progress?.total ? ` / ${U.formatBytes(progress.total)}` : ""}`}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {update && !inFlight && (
          <div className="update-foot">
            <button className="btn ghost" onClick={updater.skip} title="hide the notice until a newer version">skip this version</button>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={onClose}>later</button>
            {update.canInstall ? (
              <>
                <button className="btn outlined" onClick={updater.openRelease}>
                  <_UpdIcon name="external" size={11} /> release page
                </button>
                <button className="btn primary" onClick={updater.install} disabled={!U.canStartInstall(state)}>
                  install &amp; restart
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={updater.openRelease}>
                <_UpdIcon name="external" size={11} /> open release page
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

window.UpdateModal = UpdateModal;
