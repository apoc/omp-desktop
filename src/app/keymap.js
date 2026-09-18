// Keyboard shortcut registry, chord algebra, and dispatch helpers.
//
// Exposes `window.OMP_KEYMAP`; wrapped as an IIFE per the project rule for
// plain <script> tags (see CLAUDE.md "IIFE rule").
//
// This file has no dependencies and must load before any Babel file that
// references OMP_KEYMAP (currently: composer.jsx, use-keymap.jsx, and
// shortcuts-modal.jsx). See index.html script-order comment.
(function () {
  "use strict";

  // ── Registry ──────────────────────────────────────────────────────────────
  //
  // KEEP IN SYNC WITH `ACTION_IDS` in src-tauri/src/keybindings/mod.rs.
  // The Rust side validates overlay writes against that list; adding an id
  // here without adding it there will cause every setKeybinding call for the
  // new id to fail at runtime.

  /** @type {Array<{id: string, label: string, group: string, scope: "global"|"composer", defaultKeys: string[]}>} */
  const KEYMAP_ACTIONS = [
    // Registry order = conflict-resolution order: first claimant wins.
    // Must match the plan §5 table row-for-row and Rust ACTION_IDS.
    { id: "app.interrupt",           label: "Interrupt turn",          group: "Session", scope: "global",   defaultKeys: ["escape"] },
    { id: "app.thinking.cycle",      label: "Cycle thinking level",    group: "Agent",   scope: "global",   defaultKeys: ["shift+tab"] },
    { id: "app.model.cycleForward",  label: "Cycle model forward",     group: "Agent",   scope: "global",   defaultKeys: ["ctrl+p"] },
    { id: "app.model.cycleBackward", label: "Cycle model backward",    group: "Agent",   scope: "global",   defaultKeys: ["ctrl+shift+p"] },
    { id: "app.model.select",        label: "Select model",            group: "Agent",   scope: "global",   defaultKeys: ["alt+m"] },
    { id: "app.plan.toggle",         label: "Toggle plan mode",        group: "Mode",    scope: "global",   defaultKeys: ["shift+alt+p"] },
    { id: "app.message.followUp",    label: "Send message",            group: "Session", scope: "composer", defaultKeys: ["ctrl+q", "ctrl+enter"] },
    { id: "app.session.new",         label: "New session",             group: "Session", scope: "global",   defaultKeys: [] },
    { id: "app.session.resume",      label: "Resume session",          group: "Session", scope: "global",   defaultKeys: [] },
    { id: "desktop.commands.open",   label: "Command bridge",          group: "View",    scope: "global",   defaultKeys: ["ctrl+k", "super+k"] },
    { id: "desktop.history.open",    label: "Session history",         group: "View",    scope: "global",   defaultKeys: ["ctrl+h", "super+h"] },
    { id: "desktop.shortcuts.open",  label: "Keyboard shortcuts",      group: "View",    scope: "global",   defaultKeys: ["ctrl+/", "super+/"] },
    { id: "desktop.tab.new",         label: "New tab",                 group: "Tabs",    scope: "global",   defaultKeys: ["ctrl+t", "super+t"] },
    { id: "desktop.tab.close",       label: "Close tab",               group: "Tabs",    scope: "global",   defaultKeys: ["ctrl+w", "super+w"] },
    { id: "desktop.tab.next",        label: "Next tab",                group: "Tabs",    scope: "global",   defaultKeys: ["ctrl+tab"] },
    { id: "desktop.tab.prev",        label: "Previous tab",            group: "Tabs",    scope: "global",   defaultKeys: ["ctrl+shift+tab"] },
    { id: "desktop.panel.todo",      label: "Plan kanban",             group: "View",    scope: "global",   defaultKeys: [] },
    { id: "desktop.panel.changes",   label: "Working-tree changes",    group: "View",    scope: "global",   defaultKeys: [] },
    { id: "desktop.panel.rules",     label: "Approval rules",          group: "View",    scope: "global",   defaultKeys: [] },
    { id: "desktop.session.compact", label: "Compact session",         group: "Session", scope: "global",   defaultKeys: [] },
    { id: "desktop.session.export",  label: "Export session to HTML",  group: "Session", scope: "global",   defaultKeys: [] },
  ];

  // ── Chord algebra ─────────────────────────────────────────────────────────

  /** Modifier prefix strip order and canonical output order. */
  const MOD_PREFIXES = ["ctrl+", "shift+", "alt+", "super+"];

  /** Named key map: KeyboardEvent.key → canonical base name. */
  const KEY_MAP = {
    Escape: "escape", Enter: "enter", Tab: "tab", " ": "space",
    Backspace: "backspace", Delete: "delete", Insert: "insert",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
    F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
  };

  /**
   * Chord canonicaliser — port of omp's `canonicalKeyId` with one deliberate
   * deviation: omp infers `shift` for any single uppercase ASCII base when
   * `shift` is not already present, regardless of other modifiers
   * (`Ctrl+P` → `ctrl+shift+p` in the TUI). This implementation only infers
   * shift when **no** modifier is present (`P` → `shift+p`; `Ctrl+P` → `ctrl+p`).
   * Consequence: a `keybindings.yml` entry spelled `app.x: Ctrl+P` maps to
   * `ctrl+shift+p` in the TUI but `ctrl+p` in the desktop dispatcher. Users who
   * write all-lowercase chord spellings (omp's own defaults do) get identical
   * behaviour in both. See the matching comment in yaml.rs `canonical_chord`.
   *
   * Returns `""` when there is no base (invalid chord).
   * @param {string} raw
   * @returns {string}
   */
  function canonicalChord(raw) {
    let rest = raw.trim();
    const flags = [false, false, false, false]; // ctrl, shift, alt, super
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < MOD_PREFIXES.length; i++) {
        const p = MOD_PREFIXES[i];
        if (rest.slice(0, p.length).toLowerCase() === p) {
          flags[i] = true;
          rest = rest.slice(p.length).trimStart();
          changed = true;
          break;
        }
      }
    }
    // Bare uppercase ASCII letter with no other modifiers implies shift.
    if (rest.length === 1 && rest >= "A" && rest <= "Z" && !flags.some(Boolean)) {
      flags[1] = true;
    }
    let base = rest.toLowerCase();
    if (base === "esc")    base = "escape";
    if (base === "return") base = "enter";
    if (!base) return "";
    let out = "";
    for (let i = 0; i < MOD_PREFIXES.length; i++) {
      if (flags[i]) out += MOD_PREFIXES[i];
    }
    return out + base;
  }

  /**
   * Derive a canonical chord string from a KeyboardEvent (or event-shaped object).
   * Returns `null` for bare modifier presses.
   *
   * `e.code` is read when `e.altKey`/`e.ctrlKey` is set AND `e.key` is a
   * non-ASCII-alphanumeric character (macOS composed-char recovery, e.g. "µ"
   * for Alt+M). Plain ASCII keys always use `e.key` directly so AZERTY/Dvorak
   * layouts are not broken. Note: on Windows, AltGr is reported as
   * `ctrlKey+altKey`, so AltGr+E ("€", code "KeyE") canonicalises to
   * `ctrl+alt+e` — a user who binds that chord will accidentally claim AltGr+E.
   *
   * @param {Pick<KeyboardEvent, "key"|"code"|"ctrlKey"|"shiftKey"|"altKey"|"metaKey">} e
   * @returns {string|null}
   */
  function chordFromEvent(e) {
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
    const flags = [e.ctrlKey, e.shiftKey, e.altKey, e.metaKey]; // ctrl, shift, alt, super

    // Resolve base name.
    let base = KEY_MAP[e.key];
    if (!base) {
      const k = e.key;
      if (k.length === 1) {
        // When a modifier (Alt, Ctrl) is held, the browser may report a
        // composed character for e.key (e.g. Alt+M on macOS → "µ").
        // Recover the physical Latin key from e.code when available.
        let effectiveKey = k;
        // Only recover from e.code when e.key is already a non-ASCII-alphanumeric
        // character (e.g. "µ" on macOS Alt+M). When e.key is already a plain
        // ASCII letter/digit ("a", "1", …) the browser reported the physical key
        // correctly — using e.code there would break non-QWERTY layouts (e.g.
        // AZERTY: Ctrl+A has key:"a" but code:"KeyQ" — must stay ctrl+a).
        if ((e.altKey || e.ctrlKey) && e.code && !/^[a-zA-Z0-9]$/.test(k)) {
          const fromCode = e.code.match(/^Key([A-Z])$|^Digit(\d)$/);
          if (fromCode) effectiveKey = fromCode[1] ?? fromCode[2];
        }
        const lower = effectiveKey.toLowerCase();
        base = lower;
        // A non-[a-z0-9] character already encodes the shift state (e.g. `?`
        // is produced by Shift+/ — drop the redundant shift flag).
        if (!lower.match(/^[a-z0-9]$/)) {
          flags[1] = false;
        }
      } else {
        base = e.key.toLowerCase();
      }
    }

    let out = "";
    for (let i = 0; i < MOD_PREFIXES.length; i++) {
      // For super use metaKey (index 3 in flags maps to index 3 in MOD_PREFIXES).
      if (flags[i]) out += MOD_PREFIXES[i];
    }
    return out + base;
  }

  // ── Resolver ──────────────────────────────────────────────────────────────

  /**
   * Resolve effective bindings from a config map (omp + overlay merged) and
   * the action registry.
   *
   * Config values: string (single chord) | string[] | [] (disabled) | absent
   * (use defaultKeys).
   *
   * Returns:
   *   - `byAction`: Map<id, string[]>  — effective chords per action
   *   - `byChord`:  Map<chord, id>    — first claimant wins; later ones are conflicts
   *   - `conflicts`: [{chord, actions:[winner,loser]}]
   *
   * @param {typeof KEYMAP_ACTIONS} actions
   * @param {Record<string, string|string[]>} config
   */
  function resolve(actions, config) {
    const byAction = new Map();
    const byChord  = new Map();
    const conflicts = [];

    function chordsFor(action) {
      const raw = config[action.id];
      let chords;
      if (Array.isArray(raw)) {
        chords = raw.map(canonicalChord).filter(Boolean);
      } else if (typeof raw === "string") {
        const c = canonicalChord(raw);
        chords = c ? [c] : [];
      } else {
        // Absent/null/other → registry default.
        chords = action.defaultKeys.slice();
      }
      const seen = new Set();
      const deduped = [];
      for (const c of chords) {
        if (!seen.has(c)) { seen.add(c); deduped.push(c); }
      }
      byAction.set(action.id, deduped);
      return { chords: deduped, configured: config[action.id] !== undefined };
    }

    function claim(action, chords) {
      for (const chord of chords) {
        if (byChord.has(chord)) {
          conflicts.push({ chord, actions: [byChord.get(chord), action.id] });
        } else {
          byChord.set(chord, action.id);
        }
      }
    }

    // Pre-compute chords for all actions (fills byAction).
    const computed = actions.map(a => ({ action: a, ...chordsFor(a) }));

    // Pass 1: explicitly configured actions claim their chords first.
    // This ensures a user rebind beats any other action's default chord,
    // regardless of registry order.
    for (const { action, chords, configured } of computed) {
      if (configured) claim(action, chords);
    }
    // Pass 2: actions using registry defaults claim remaining chords.
    for (const { action, chords, configured } of computed) {
      if (!configured) claim(action, chords);
    }

    return { byAction, byChord, conflicts };
  }

  // ── Module-level resolved state ───────────────────────────────────────────

  let _current = resolve(KEYMAP_ACTIONS, {});

  function setResolved(r) { _current = r; }
  function lookup(chord)   { return _current.byChord.get(chord) ?? null; }
  function keysFor(id)     { return _current.byAction.get(id) ?? []; }

  /**
   * True when the keyboard event matches the given action id, using the
   * current resolution.
   * @param {KeyboardEvent} e
   * @param {string} actionId
   */
  function matches(e, actionId) {
    const chord = chordFromEvent(e);
    if (!chord) return false;
    return lookup(chord) === actionId;
  }

  // ── Input guard ───────────────────────────────────────────────────────────

  /**
   * True for elements that are text-input targets (INPUT, TEXTAREA,
   * contentEditable). Duck-typed so plain objects work in tests.
   */
  function isTypingTarget(el) {
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || !!el.isContentEditable;
  }

  /**
   * True when the chord should fire even while focus is in a typing target.
   * Everything that contains `ctrl+`, `alt+`, `super+` is a command shortcut,
   * not typing; `escape`, `shift+tab`, and Fn keys are also safe.
   */
  function allowedInInput(chord) {
    if (chord.includes("ctrl+") || chord.includes("alt+") || chord.includes("super+")) return true;
    if (chord === "escape" || chord === "shift+tab") return true;
    if (/^f\d{1,2}$/.test(chord)) return true;
    return false;
  }

  // ── Display ───────────────────────────────────────────────────────────────

  /**
   * Detect macOS. Guarded for missing `navigator` so the file also loads
   * under Node (test-keymap.mjs stubs `window` but not `navigator`).
   */
  function detectMac() {
    try {
      return (
        (typeof navigator !== "undefined") &&
        // UA Client Hints platform value on macOS is "macOS" (lowercase m);
        // navigator.platform is "MacIntel". Use case-insensitive match for both.
        /mac/i.test(
          navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? ""
        )
      );
    } catch (_) {
      return false;
    }
  }

  const DISPLAY_MAP = {
    ctrl: "Ctrl", shift: "Shift", alt: "Alt", super: "Super",
    escape: "Esc", enter: "Enter", tab: "Tab", space: "Space",
    backspace: "Backspace", delete: "Delete",
    pageup: "PgUp", pagedown: "PgDn",
    up: "↑", down: "↓", left: "←", right: "→",
  };

  /**
   * Human-readable display form of a canonical chord.
   * @param {string} chord
   * @param {boolean} [isMac]
   */
  function formatChord(chord, isMac = detectMac()) {
    const parts = chord.split("+");
    return parts.map(p => {
      // The last part is the base; everything before is a modifier.
      if (p === "alt"   && isMac)  return "Option";
      if (p === "super" && isMac)  return "Cmd";
      if (DISPLAY_MAP[p])          return DISPLAY_MAP[p];
      // Capitalise first char of every part — single char → uppercase,
      // multi-char → title-case (e.g. "home"→"Home", "f5"→"F5").
      // The `!isLast` guard for modifiers is redundant now since they all
      // hit DISPLAY_MAP first, but kept for clarity.
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    }).join("+");
  }

  // ── Export ────────────────────────────────────────────────────────────────

  window.OMP_KEYMAP = {
    KEYMAP_ACTIONS,
    canonicalChord,
    chordFromEvent,
    resolve,
    setResolved,
    lookup,
    keysFor,
    matches,
    isTypingTarget,
    allowedInInput,
    formatChord,
    detectMac,
  };
})();
