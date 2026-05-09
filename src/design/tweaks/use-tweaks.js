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
    return { ...defaults, ...JSON.parse(raw) };
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
})();
