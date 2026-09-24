/* app/use-updater.jsx — drives the in-app updater (issue #19): the
   app/updater.js reducer, the background check timer, download progress,
   and whether the update modal is open. `autoCheck` and `skipped` are the
   `updateCheck`/`skippedUpdate` tweaks, so both persist like any other
   preference.

   A background check never opens anything — a found update only surfaces
   as the tab-bar pill, which just opens the modal on what the last check
   found. A manual check (the tab-bar version label, `/check-updates`,
   keymap) opens the modal immediately so "checking…" / "up to date" / the
   error are visible. */

function useUpdater({ bridge, autoCheck, skipped, setTweak }) {
  const U = window.OMP_UPDATER;
  const [state, dispatch] = React.useReducer(U.reduce, undefined, U.initialState);
  const [open, setOpen] = React.useState(false);
  const [version, setVersion] = React.useState(null);

  // Read by the stable callbacks below, so the timer effect never has to
  // re-arm (and restart its startup delay) on every state change.
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    bridge?.appVersion().then(setVersion);
  }, [bridge]);

  const check = React.useCallback(async (manual) => {
    if (manual) setOpen(true);
    if (!bridge) return;
    const phase = stateRef.current.phase;
    // Already checking: the result lands in the modal just opened above.
    // Downloading/restarting: a new check would race the install.
    if (phase === "checking" || phase === "downloading" || phase === "restarting") return;
    dispatch({ type: "check-start" });
    const res = await bridge.checkForUpdate();
    dispatch(res.ok
      ? { type: "check-done", info: res.value }
      : { type: "check-failed", error: res.error });
    if (!res.ok && !manual) console.warn("[updater] background check failed:", res.error);
  }, [bridge]);

  React.useEffect(() => {
    if (!autoCheck || !bridge) return undefined;
    const first = setTimeout(() => check(false), U.STARTUP_DELAY_MS);
    const every = setInterval(() => check(false), U.CHECK_INTERVAL_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [autoCheck, bridge, check, U]);

  React.useEffect(() => {
    if (!bridge) return undefined;
    let unlisten = null;
    let disposed = false;
    bridge.onUpdateProgress(p => dispatch({ type: "progress", downloaded: p?.downloaded, total: p?.total }))
      .then(fn => { if (disposed) fn(); else unlisten = fn; })
      .catch(err => console.error("[updater] progress listener failed:", err));
    return () => { disposed = true; unlisten?.(); };
  }, [bridge]);

  const install = React.useCallback(async () => {
    if (!bridge || !U.canStartInstall(stateRef.current)) return;
    dispatch({ type: "install-start" });
    const res = await bridge.installUpdate();
    dispatch(res.ok ? { type: "install-done" } : { type: "install-failed", error: res.error });
  }, [bridge, U]);

  const skip = React.useCallback(() => {
    const v = stateRef.current.update?.version;
    if (v) setTweak("skippedUpdate", v);
    setOpen(false);
  }, [setTweak]);

  const openRelease = React.useCallback(async () => {
    const url = stateRef.current.update?.releaseUrl;
    if (!url || !bridge) return;
    // For a notify-only install this is the modal's only action; a launcher
    // that can't start (no xdg-open) must at least leave a trace.
    const res = await bridge.openExternalUrl(url);
    if (!res.ok) console.error("[updater] opening the release page failed:", res.error);
  }, [bridge]);

  return {
    state,
    version,
    open,
    showPill: U.shouldShowPill(state, skipped),
    openModal: React.useCallback(() => setOpen(true), []),
    close: React.useCallback(() => setOpen(false), []),
    check,
    install,
    skip,
    openRelease,
  };
}

Object.assign(window, { useUpdater });
