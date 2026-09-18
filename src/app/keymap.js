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
   * Port of omp's `canonicalKeyId`. Strips modifier prefixes (case-insensitive,
   * any order), lowercases the base, aliases `esc`→`escape` / `return`→`enter`,
   * infers `shift` for a bare uppercase ASCII letter (no other modifiers), then
   * emits in `ctrl, shift, alt, super` order.
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
   * @param {Pick<KeyboardEvent, "key"|"ctrlKey"|"shiftKey"|"altKey"|"metaKey">} e
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
        // Single printable character.
        // When the base is a non-[a-z0-9] character (shifted symbol, e.g. `?`),
        // the shift modifier is already encoded in the character itself — drop it
        // so `Shift+?` doesn't become `shift+?` (mirrors omp's `addKeyAliases`).
        const lower = k.toLowerCase();
        base = lower;
        // A non-[a-z0-9] character already encodes the shift state (e.g. `?`
        // is produced by Shift+/ but `?` itself is the base — mirrors omp's
        // `addKeyAliases`). Drop the redundant shift flag.
        if (!lower.match(/^[a-z0-9]$/)) {
          flags[1] = false;
        }
      } else {
        // Multi-char key names (rare, e.g. "Dead", "Unidentified") — pass through lowercased.
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

    for (const action of actions) {
      const raw = config[action.id];
      let chords;
      if (Array.isArray(raw)) {
        chords = raw.map(canonicalChord).filter(Boolean);
      } else if (typeof raw === "string") {
        const c = canonicalChord(raw);
        chords = c ? [c] : [];
      } else if (raw === undefined || raw === null) {
        // Absent: use registry default.
        chords = action.defaultKeys.slice();
      } else {
        chords = action.defaultKeys.slice();
      }
      // De-duplicate within this action's chord list.
      const seen = new Set();
      const deduped = [];
      for (const c of chords) {
        if (!seen.has(c)) { seen.add(c); deduped.push(c); }
      }
      byAction.set(action.id, deduped);

      for (const chord of deduped) {
        if (byChord.has(chord)) {
          conflicts.push({ chord, actions: [byChord.get(chord), action.id] });
        } else {
          byChord.set(chord, action.id);
        }
      }
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
        (navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "")
          .includes("Mac")
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
    return parts.map((p, idx) => {
      // The last part is the base; everything before is a modifier.
      const isLast = idx === parts.length - 1;
      if (p === "alt"   && isMac)  return "Option";
      if (p === "super" && isMac)  return "Cmd";
      if (DISPLAY_MAP[p])          return DISPLAY_MAP[p];
      if (!isLast)                 return p.charAt(0).toUpperCase() + p.slice(1);
      // Base key: single char → uppercase, otherwise as-is.
      return p.length === 1 ? p.toUpperCase() : p;
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
