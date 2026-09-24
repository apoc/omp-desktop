/* app/use-updater.jsx — drives the in-app updater (issue #19): the
   app/updater.js reducer, the background check timer, install progress,
   and whether the update modal is open. `autoCheck` and `skipped` are the
   `updateCheck`/`skippedUpdate` tweaks, so both persist like any other
   preference.

   A background check never opens anything — a found update only surfaces
   as the tab-bar pill, which just opens the modal on what the last check
   found. A manual check (the tab-bar version label, `/check-updates`,
   keymap) opens the modal immediately so "checking…" / "up to date" / the
   error are visible. */

// Frozen and loaded before this file (index.html), so safe to read once.
const UPDATER = window.OMP_UPDATER;

function useUpdater({ bridge, autoCheck, skipped, setTweak }) {
  const [state, dispatch] = React.useReducer(UPDATER.reduce, undefined, UPDATER.initialState);
  const [open, setOpen] = React.useState(false);
  const [version, setVersion] = React.useState(null);

  // Read by the stable callbacks below, so the timer effect never has to
  // re-arm (and restart its startup delay) on every state change.
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    bridge?.appVersion().then(setVersion);
  }, [bridge]);

  // `manual` stays private: only the timer passes false. Gates the IPC call
  // itself — the reducer would merely drop the transition. A check already
  // running feeds the modal just opened; one during an install would race it.
  const runCheck = React.useCallback(async (manual) => {
    if (manual) setOpen(true);
    if (!bridge || UPDATER.isBusy(stateRef.current)) return;
    dispatch({ type: "check-start" });
    const res = await bridge.checkForUpdate();
    dispatch(res.ok
      ? { type: "check-done", info: res.value }
      : { type: "check-failed", error: res.error });
    if (!res.ok && !manual) console.warn("[updater] background check failed:", res.error);
  }, [bridge]);

  // The public entry point is always a manual check, and takes no argument,
  // so it can be handed straight to onClick / a keymap handler.
  const check = React.useCallback(() => { runCheck(true); }, [runCheck]);

  React.useEffect(() => {
    if (!autoCheck || !bridge) return undefined;
    const first = setTimeout(() => runCheck(false), UPDATER.STARTUP_DELAY_MS);
    const every = setInterval(() => runCheck(false), UPDATER.CHECK_INTERVAL_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [autoCheck, bridge, runCheck]);

  const install = React.useCallback(async () => {
    if (!bridge || !UPDATER.canStartInstall(stateRef.current)) return;
    dispatch({ type: "install-start" });
    const res = await bridge.installUpdate(p =>
      dispatch({ type: "progress", downloaded: p?.downloaded, total: p?.total }));
    dispatch(res.ok ? { type: "install-done" } : { type: "install-failed", error: res.error });
  }, [bridge]);

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
    pillVersion: UPDATER.pillVersion(state, skipped),
    openModal: React.useCallback(() => setOpen(true), []),
    close: React.useCallback(() => setOpen(false), []),
    check,
    install,
    skip,
    openRelease,
  };
}

Object.assign(window, { useUpdater });
