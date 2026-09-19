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
    // Registry order only breaks ties *within* a resolution pass — it is not
    // itself the conflict-resolution order. `resolve()` is two-pass: every
    // explicitly configured action (including an explicit `[]` disable)
    // claims its chords before any action still on its default does,
    // regardless of where either row sits here. See `resolve`'s doc comment.
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

  /**
   * Join modifier flags (`[ctrl, shift, alt, super]`) and a base key into a
   * canonical chord string, in `MOD_PREFIXES` order. The single emit site
   * shared by `canonicalChord` and `chordFromEvent` so the two never drift.
   */
  function joinChord(flags, base) {
    let out = "";
    for (let i = 0; i < MOD_PREFIXES.length; i++) {
      if (flags[i]) out += MOD_PREFIXES[i];
    }
    return out + base;
  }

  /**
   * Keys that are never a chord's base: real modifiers, lock/IME/context
   * sentinels. A stray keydown for one of these (AltGr, CapsLock mid-record,
   * a dead-key compose step, an IME candidate window) must not turn into a
   * bogus binding — `chordFromEvent` returns `null` for all of them.
   */
  const NON_CHORD_KEYS = new Set([
    "Control", "Shift", "Alt", "Meta", "AltGraph",
    "CapsLock", "NumLock", "ScrollLock", "ContextMenu",
    "Process",
    // Additional modifier-key values from the UI Events `key` spec that
    // "Control"/"Shift"/"Alt"/"Meta" above don't cover: a UA reporting the
    // Super/Hyper key under one of these names must not let it fall through
    // to the generic base-key branch below and become a bogus recordable
    // chord (e.g. "super" or "super+super" while holding metaKey).
    "Super", "Hyper", "OS", "Fn", "FnLock", "Symbol", "SymbolLock",
    // "Unidentified" is deliberately NOT here — see chordFromEvent's
    // code-based recovery for it below. It still yields no chord when that
    // recovery fails (an unmapped printable character), so this doesn't
    // widen what ends up bindable, only what's *recoverable*.
  ]);

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
   * Chord canonicaliser — matches omp's `canonicalKeyId` exactly for
   * config-sourced chords. `canonicalKeyId` does infer `shift` for a bare
   * uppercase ASCII base letter (`Ctrl+P` → `ctrl+shift+p`), but only when
   * called on *live parsed terminal input* — a config value never reaches it
   * in that form: omp's `KeybindingsManager.#rebuild` lowercases every
   * `keybindings.yml`/user-config chord (`normalizeKeys`) *before*
   * canonicalising it, so the uppercase base a config file might spell is
   * already gone by the time shift-inference would run. `app.x: P` and
   * `app.x: p` are therefore identical to omp — this must not infer shift
   * from either. See the matching comment in `chord.rs`'s `canonical_chord`.
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
    // No shift-inference from a bare uppercase base — see the doc comment.
    let base = rest.trim().toLowerCase();
    if (base === "esc")    base = "escape";
    if (base === "return") base = "enter";
    if (!base) return "";
    return joinChord(flags, base);
  }

  /**
   * Derive a canonical chord string from a KeyboardEvent (or event-shaped object).
   * Returns `null` for bare modifier presses and for lock/IME/dead-key
   * sentinels that are never a real chord (see `NON_CHORD_KEYS`).
   *
   * `e.code` is read for recovery only when `e.altKey`/`e.ctrlKey` is set AND
   * `e.key` is a **non-ASCII** character (macOS composed-char recovery, e.g.
   * "µ" for Alt+M, or a `Dead` compose step). ASCII symbols produced by a
   * plain Shift combo (`Ctrl+Shift+/` → key `"?"`) are read from `e.key`
   * directly, matching the plan's "reads only `key`/modifier flags" contract
   * — recovering those from `e.code` too would canonicalise `Ctrl+Shift+2`
   * (key `"@"`, code `"Digit2"`) and `Ctrl+Shift+/` (key `"?"`, code
   * `"Slash"`) inconsistently, since only the digit has a `Key*`/`Digit*`
   * code pattern this recovery understands.
   *
   * Separately, a `key === "Unidentified"` event — the UA couldn't map the
   * physical key to a logical value, a real WebKitGTK/XKB failure mode
   * observed for Shift+Tab — is not bailed on outright via `NON_CHORD_KEYS`:
   * `code` is layout-independent and, for the named keys in `KEY_MAP`,
   * spelled identically ("Tab", "Escape", "Enter", …), so it recovers
   * exactly the cases `KEY_MAP` already covers. An "Unidentified" event
   * that isn't one of those named keys (an unmapped printable character)
   * still yields no chord — there is no reliable recovery for an arbitrary
   * character from `code` alone (layout-dependent).
   *
   * @param {Pick<KeyboardEvent, "key"|"code"|"ctrlKey"|"shiftKey"|"altKey"|"metaKey"|"isComposing">} e
   * @returns {string|null}
   */
  function chordFromEvent(e) {
    if (e.isComposing || NON_CHORD_KEYS.has(e.key)) return null;
    const flags = [e.ctrlKey, e.shiftKey, e.altKey, e.metaKey]; // ctrl, shift, alt, super

    // Resolve base name.
    let base = KEY_MAP[e.key];
    if (!base && e.key === "Unidentified") {
      base = KEY_MAP[e.code];
    }
    if (!base && e.key === "Unidentified") return null; // no code-based recovery available
    if (!base) {
      const k = e.key;
      if (k.length === 1 || k === "Dead") {
        // When a modifier (Alt, Ctrl) is held, the browser may report a
        // composed character for e.key (e.g. Alt+M on macOS → "µ") or, for
        // an incomplete compose sequence, the literal string "Dead".
        // Recover the physical Latin key from e.code when available.
        let effectiveKey = k;
        // Only recover from e.code when e.key is genuinely non-ASCII (or the
        // "Dead" sentinel) — a plain ASCII letter/digit/symbol ("a", "1",
        // "?", "@") is already the physical key the browser reported;
        // recovering those from e.code would break non-QWERTY layouts (e.g.
        // AZERTY: Ctrl+A has key:"a" but code:"KeyQ" — must stay ctrl+a) and
        // would canonicalise ASCII shifted symbols inconsistently (see the
        // doc comment above).
        if ((e.altKey || e.ctrlKey) && e.code && (k === "Dead" || k.charCodeAt(0) > 127)) {
          const fromCode = e.code.match(/^Key([A-Z])$|^Digit(\d)$/);
          if (fromCode) effectiveKey = fromCode[1] ?? fromCode[2];
        }
        // An unrecovered dead-key compose step is not a chord — bail rather
        // than binding the literal word "dead".
        if (effectiveKey === "Dead") return null;
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

    return joinChord(flags, base);
  }

  // ── Resolver ──────────────────────────────────────────────────────────────

  /**
   * Resolve effective bindings from a config map (omp + overlay merged) and
   * the action registry.
   *
   * Config values: string (single chord) | string[] | [] (disabled) | absent
   * (use defaultKeys).
   *
   * **Precedence is two-pass, not single-pass registry order**: every
   * explicitly configured action (a value present in `config`, including an
   * explicit `[]` disable) claims its chords before any action still on its
   * registry default does. This means a user's rebind always beats another
   * action's *default* chord regardless of which one appears first in
   * `KEYMAP_ACTIONS` — a plain first-claimant-wins single pass would let an
   * earlier action's default permanently shadow a later action's rebind.
   * Within each pass, ties still resolve in registry order.
   *
   * Returns:
   *   - `byAction`: Map<id, string[]>  — effective chords per action
   *   - `byChord`:  Map<chord, id>    — winner per the two-pass rule above
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
    if (/^f([1-9]|1[0-2])$/.test(chord)) return true;
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

  // Platform never changes at runtime — compute once rather than re-probing
  // `navigator` on every `formatChord` call (the Shortcuts modal formats
  // every visible chord on every render and filter keystroke).
  const IS_MAC = detectMac();

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
  function formatChord(chord, isMac = IS_MAC) {
    const parts = chord.split("+");
    return parts.map(p => {
      // The last part is the base; everything before is a modifier.
      if (p === "alt"   && isMac)  return "Option";
      if (p === "super" && isMac)  return "Cmd";
      if (DISPLAY_MAP[p])          return DISPLAY_MAP[p];
      // Capitalise first char of every part — single char → uppercase,
      // multi-char → title-case (e.g. "home"→"Home", "f5"→"F5").
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    }).join("+");
  }

  /**
   * The chord to display for an action, preferring the one matching the
   * current platform when more than one is effective. Registry defaults for
   * cross-platform actions (command bridge, history) list both a `ctrl+`
   * and a `super+` variant; naively taking `keysFor(id)[0]` would show
   * "Ctrl+K" on macOS instead of "⌘K" since the ctrl variant is listed
   * first. Falls back to the first effective chord when none match.
   * @param {string} actionId
   * @param {boolean} [isMac]
   */
  function displayChordFor(actionId, isMac = IS_MAC) {
    const chords = keysFor(actionId);
    if (!chords.length) return null;
    const bySuper = c => c.startsWith("super+");
    return (isMac ? chords.find(bySuper) : chords.find(c => !bySuper(c))) ?? chords[0];
  }

  /**
   * Full formatted chord for an action's current display chord (see
   * [`displayChordFor`]), or `""` when the action is explicitly unbound
   * (cleared in the Shortcuts screen). Callers distinguish this from
   * "registry not loaded yet" themselves — `window.OMP_KEYMAP` is always
   * defined by the time this can be called.
   * @param {string} actionId
   */
  function hintFor(actionId) {
    const chord = displayChordFor(actionId);
    return chord ? formatChord(chord) : "";
  }

  /**
   * Just the trailing base key of [`hintFor`]'s chord, for a chip placed
   * next to an icon that already conveys one modifier (e.g. a ⌘ glyph).
   * Only compresses when the chord is exactly a single ctrl/super modifier
   * + base; any other combination (no modifier, more than one, or a rebind
   * like `shift+alt+b`) returns the full formatted chord instead, so the
   * chip never advertises a modifier the binding doesn't have. Matching the
   * prefix directly (not `hintFor(id).split("+").pop()`) also survives a
   * base key that is itself `+` (e.g. `ctrl++`).
   * @param {string} actionId
   */
  function hintKeyFor(actionId) {
    const chord = displayChordFor(actionId);
    if (!chord) return "";
    const stripped = /^(?:ctrl|super)\+(.+)$/.exec(chord);
    return formatChord(stripped ? stripped[1] : chord);
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
    hintFor,
    hintKeyFor,
    detectMac,
  };
})();
