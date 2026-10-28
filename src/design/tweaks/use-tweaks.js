// tweaks/use-tweaks.js — source-of-truth hook for tweak values.
// Persists to localStorage under the key below; merged over defaults
// so new keys added to TWEAK_DEFAULTS are picked up on first load.

// Wrapped in an IIFE so `useTweaks` doesn't leak into document scope.
(function () {

const STORAGE_KEY = "omp-desktop:tweaks";

function _load(defaults) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const stored = JSON.parse(raw);
    const migrated = window.OMP_AMBIENT_RAIL.migrate(stored);
    if (migrated !== stored) _save(migrated);
    return { ...defaults, ...migrated };
  } catch {
    return defaults;
  }
}

function _save(values) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)); } catch {}
}

function useTweaks(defaults) {
  const [values, setValues] = React.useState(() => _load(defaults));

  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === "object" && keyOrEdits !== null
      ? keyOrEdits : { [keyOrEdits]: val };
    setValues(prev => {
      const next = { ...prev, ...edits };
      _save(next);
      return next;
    });
    window.dispatchEvent(new CustomEvent("tweakchange", { detail: edits }));
  }, []);

  return [values, setTweak];
}

window.useTweaks = useTweaks;
// The stored tweaks merged over `defaults` (TWEAK_DEFAULTS when omitted),
// for code outside React that needs a value before any component mounts:
// live.js reads the session prefs at load, before the boot tab restore.
window.OMP_TWEAKS_STORE = Object.freeze({
  read(defaults = window.TWEAK_DEFAULTS) { return _load(defaults); },
});
})();
