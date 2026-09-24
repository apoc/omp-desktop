/* ═════════════════════════════════════════════════════════════════════
   app/updater.js — in-app update state (issue #19). Pure functions only.

   The Rust side (src-tauri/src/updater.rs) owns the feed, signature check,
   install and relaunch; this is the UI's view of it. `reduce` is a plain
   useReducer reducer driven by app/use-updater.jsx:

     idle ─check-start→ checking ─check-done→ available | uptodate
                                  └check-failed→ error (or back to
                                    available when an earlier check found
                                    one — a flaky background check must not
                                    hide an update the user already saw)
     available ─install-start→ downloading ─install-done→ restarting
                                           └install-failed→ available

   `downloading → restarting` is terminal: the process is replaced.
   Regression: test-updater.mjs.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // First background check waits for startup to settle (sessions spawning,
  // profile list, external opens) instead of competing with it.
  const STARTUP_DELAY_MS = 15 * 1000;
  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

  const initialState = () => ({
    phase: "idle",
    update: null,     // normalized UpdateInfo, or null
    progress: null,   // { downloaded, total|null } while downloading
    error: null,
    lastChecked: null,
  });

  const str = (v) => (typeof v === "string" && v ? v : null);

  // `app_update_check`'s payload → the shape the UI renders, or null. A
  // payload without a version can't be shown or installed, so it reads as
  // "nothing to offer" rather than rendering "vundefined".
  function normalizeInfo(raw) {
    const version = str(raw?.version);
    if (!version) return null;
    return {
      version,
      currentVersion: str(raw.currentVersion),
      notes: str(raw.notes),
      date: str(raw.date),
      canInstall: raw.canInstall === true,
      releaseUrl: str(raw.releaseUrl),
    };
  }

  const isBusy = (phase) => phase === "checking" || phase === "downloading" || phase === "restarting";

  function reduce(state, action) {
    switch (action?.type) {
      case "check-start":
        if (isBusy(state.phase)) return state;
        return { ...state, phase: "checking", error: null };

      case "check-done": {
        if (state.phase !== "checking") return state;
        const update = normalizeInfo(action.info);
        return { ...state, phase: update ? "available" : "uptodate", update, error: null, lastChecked: action.at ?? null };
      }

      case "check-failed":
        if (state.phase !== "checking") return state;
        return {
          ...state,
          phase: state.update ? "available" : "error",
          error: String(action.error ?? "update check failed"),
          lastChecked: action.at ?? null,
        };

      case "install-start":
        if (!canStartInstall(state)) return state;
        return { ...state, phase: "downloading", progress: { downloaded: 0, total: null }, error: null };

      case "progress": {
        if (state.phase !== "downloading") return state;
        const downloaded = Number(action.downloaded);
        if (!Number.isFinite(downloaded)) return state;
        const total = Number.isFinite(action.total) && action.total > 0 ? action.total : null;
        return { ...state, progress: { downloaded, total } };
      }

      case "install-done":
        if (state.phase !== "downloading") return state;
        return { ...state, phase: "restarting" };

      case "install-failed":
        if (state.phase !== "downloading") return state;
        return { ...state, phase: "available", progress: null, error: String(action.error ?? "update failed") };

      default:
        return state;
    }
  }

  // Selectors ────────────────────────────────────────────────────────────

  const canStartInstall = (state) =>
    state.phase === "available" && state.update?.canInstall === true;

  // The tab-bar pill: an update exists and the user hasn't skipped this
  // exact version. A skipped version stays hidden until a newer one
  // appears; an install in flight always shows (it was chosen explicitly).
  function shouldShowPill(state, skippedVersion) {
    if (!state.update) return false;
    if (state.phase === "downloading" || state.phase === "restarting") return true;
    return state.update.version !== skippedVersion;
  }

  // Whole percent, or null while the size is unknown (indeterminate bar).
  function progressPct(progress) {
    if (!progress?.total) return null;
    return Math.max(0, Math.min(100, Math.floor((progress.downloaded / progress.total) * 100)));
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Tabs a restart would interrupt: mid-turn or waiting on the user. A
  // `failed` tab has no live process left to lose.
  function busyTabCount(sessions) {
    if (!Array.isArray(sessions)) return 0;
    return sessions.filter((s) => s?.runState === "running" || s?.runState === "waiting-user").length;
  }

  window.OMP_UPDATER = Object.freeze({
    STARTUP_DELAY_MS,
    CHECK_INTERVAL_MS,
    initialState,
    normalizeInfo,
    reduce,
    canStartInstall,
    shouldShowPill,
    progressPct,
    formatBytes,
    busyTabCount,
  });
})();
