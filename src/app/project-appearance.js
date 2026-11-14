// Per-project appearance: a folder can override the global theme and accent
// (Settings → Appearance → Project colours). Keys are the tab's recorded
// project folder normalised the same way the sidebar groups tabs
// (`OMP_PROJECT_NAV.normPath`); paths that reach the frontend from the OS are
// already canonicalised in Rust, so a symlinked folder shares its target's
// entry.
//
// Exposes `window.OMP_PROJECT_APPEARANCE`; an IIFE (AGENTS.md "IIFE rule").
(function () {
  const { normPath } = window.OMP_PROJECT_NAV; // app/project-nav.js

  /** Comparable key for an absolute project folder, "" for anything else.
   *  Relative paths never become keys: tab paths are absolute by contract. */
  function key(path) {
    const p = normPath(path);
    return p.startsWith("/") || /^[a-z]:(\/|$)/i.test(p) || p.startsWith("//") ? p : "";
  }

  /** The override for `path`, or null. */
  function forProject(map, path) {
    const k = key(path);
    return k && map ? map[k] ?? null : null;
  }

  function isHex(color) {
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(color ?? "").trim());
  }

  /** `{theme, accent}` → only the values worth storing. `undefined` clears a
   *  field, which is how the Settings row removes one half of an override. */
  function patchValues(patch) {
    const out = {};
    for (const [name, value] of Object.entries(patch || {})) {
      if (name === "theme") {
        if (value === undefined) out.theme = undefined;
        else if (typeof value === "string" && value.trim()) out.theme = value.trim();
      } else if (name === "accent") {
        if (value === undefined) out.accent = undefined;
        else if (isHex(value)) out.accent = String(value).trim().toLowerCase();
      }
    }
    return out;
  }

  /** New map with `patch` merged into `path`'s entry; an entry left empty is
   *  removed. Returns the input map unchanged for an unusable path. */
  function set(map, path, patch) {
    const k = key(path);
    if (!k) return map || {};
    const values = patchValues(patch);
    const current = (map || {})[k] || {};
    const merged = { ...current, ...values };
    for (const name of ["theme", "accent"]) if (merged[name] === undefined) delete merged[name];
    const next = { ...(map || {}) };
    if (Object.keys(merged).length) next[k] = merged;
    else delete next[k];
    return next;
  }

  /** New map with `path`'s override removed. */
  function clear(map, path) {
    const k = key(path);
    if (!k || !map || !(k in map)) return map || {};
    const next = { ...map };
    delete next[k];
    return next;
  }

  /** What the window should render for `path`: the project's own values when
   *  set, the global ones otherwise. `themed` / `accented` say which half is
   *  the project's. */
  function resolve(tweaks, path) {
    const override = forProject(tweaks?.projectAppearance, path);
    return {
      theme: override?.theme || tweaks?.theme,
      accent: override?.accent || tweaks?.accent,
      themed: !!override?.theme,
      accented: !!override?.accent,
    };
  }

  window.OMP_PROJECT_APPEARANCE = { key, forProject, set, clear, resolve, isHex };
})();
