/* ═════════════════════════════════════════════════════════════════════
   update-modal.jsx — in-app update check / install (issue #19).

   Props: { updater, busyTabs }
     updater  — result of useUpdater() (app/use-updater.jsx); closing is
                `updater.close`
     busyTabs — tabs a restart would interrupt (OMP_UPDATER.busyTabCount)

   Mounted only while open (app-live.jsx gates on `updater.open`), same
   as the other panels. Release notes render as plain text, not markdown:
   they come from the feed's `notes`, which the updater signature does
   not cover, and this webview has `window.__TAURI__`.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _UpdIcon } = window;

function UpdateModal({ updater, busyTabs }) {
  const U = window.OMP_UPDATER;
  const { state, version, close } = updater;
  const { phase, update, progress, error } = state;
  const pct = U.progressPct(progress);
  const inFlight = U.isInstalling(state);
  const panelRef = React.useRef(null);

  // Take focus on open (so Tab walks the modal's buttons, not the composer
  // underneath) and hand it back on close (ui/use-modal-focus.js). Nothing
  // is focused by default: Enter must not install and restart by accident.
  window.useModalFocus(panelRef);

  // Capture phase on `window`, not the panel's own onKeyDown: focus can
  // leave the panel while it is open — the composer refocuses itself when
  // a turn ends, and a failed install unmounts the focused button — and a
  // keystroke must then neither type into nor Enter-send the hidden
  // composer. Same guard as prompt-history-modal.jsx. Every unmodified key
  // belongs to the modal and never reaches the global keymap (Shift+Tab is
  // `app.thinking.cycle` there); stopping propagation leaves native
  // Tab/Enter/Space on the buttons intact. Escape closes except mid-install;
  // a key aimed outside the panel is cancelled and focus pulled back.
  // Ctrl/Alt/Meta chords pass through as global shortcuts.
  React.useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (!inFlight) close();
      } else if (!panelRef.current?.contains(e.target)) {
        e.preventDefault();
        panelRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inFlight, close]);

  return (
    <div className="bridge-scrim" onClick={inFlight ? undefined : close} style={{ paddingTop: "12vh" }}>
      <div className="update-panel" ref={panelRef} tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="update-head">
          <_UpdIcon name="arrowUp" size={13} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>{OMP_TR("updates · OMP Desktop")} {version ? `v${version}` : ""}</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} title={OMP_TR("check again")}
            onClick={updater.check} disabled={U.isBusy(state)}>
            <_UpdIcon name="refresh" size={11} />
          </button>
          {!inFlight && (
            <button className="btn icon ghost" onClick={close} title={OMP_TR("close")}>
              <_UpdIcon name="close" size={11} />
            </button>
          )}
        </div>

        <div className="update-body">
          {phase === "idle" && <div className="panel-empty mono">{OMP_TR("not checked yet")}</div>}
          {phase === "checking" && !update && <div className="panel-empty mono">{OMP_TR("checking for updates…")}</div>}
          {phase === "uptodate" && <div className="panel-empty mono">{OMP_TR("you're on the latest version")}</div>}
          {phase === "error" && <div className="panel-empty mono update-error">{error}</div>}

          {update && (
            <>
              <div className="update-title">
                <span className="mono" style={{ color: "var(--accent)" }}>v{update.version}</span>
                <span className="mono" style={{ color: "var(--fg-4)" }}>
                  {OMP_TR("available")}{update.date ? ` · ${update.date.slice(0, 10)}` : ""}
                </span>
              </div>
              {update.notes && <pre className="update-notes selectable">{update.notes}</pre>}
              {error && <div className="update-error mono">{OMP_TR(error)}</div>}
              {!update.canInstall && (
                <div className="update-hint mono">
                  {OMP_TR("This installation is managed outside the app (system package or source build) — download the new version from the release page.")}
                </div>
              )}
              {update.canInstall && busyTabs > 0 && !inFlight && (
                <div className="update-hint mono">
                  {busyTabs === 1
                    ? OMP_TR("1 tab is still working — restarting interrupts it (unfinished turns and background jobs are lost).")
                    : OMP_TR("{n} tabs are still working — restarting interrupts them (unfinished turns and background jobs are lost).", { n: busyTabs })}
                </div>
              )}
              {inFlight && (
                <div className="update-progress">
                  <span className="status-bar-tube update-tube">
                    {/* Unknown size: the segment's width lives with its keyframes in CSS. */}
                    <span className={`status-bar-fill ${pct == null ? "update-indeterminate" : ""}`}
                      style={pct == null ? undefined : { width: `${pct}%` }} />
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
            <button className="btn ghost" onClick={updater.skip} title={OMP_TR("hide the notice until a newer version")}>{OMP_TR("skip this version")}</button>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={close}>{OMP_TR("later")}</button>
            {update.canInstall ? (
              <>
                <button className="btn outlined" onClick={updater.openRelease}>
                  <_UpdIcon name="external" size={11} /> {OMP_TR("release page")}
                </button>
                <button className="btn primary" onClick={updater.install} disabled={!U.canStartInstall(state)}>
                  {OMP_TR("install & restart")}
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={updater.openRelease}>
                <_UpdIcon name="external" size={11} /> {OMP_TR("open release page")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

window.UpdateModal = UpdateModal;
