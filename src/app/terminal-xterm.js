// Terminal xterm setup: building one tab's xterm.js instance and the text
// the hook writes into it, for app/use-terminal.jsx (which owns the
// instances and their sync with Rust).
//
// - `createXterm(opts)`: a `window.Terminal` with the fit and web-links
//   addons, OSC 8 swallowed and the key routing (restart on Enter, copy /
//   paste chords, chords handed back to the global keymap — the decisions
//   themselves are app/keymap.js's `guestShouldBypass` and
//   app/terminal.js's `clipboardAction`).
// - `applyWindowsPty(term, status)`: Rust's ConPTY info onto the instance.
// - `copySelection(term)`: the selection to the clipboard (ctrl+shift+c,
//   the panel's right-click).
// - `theme()`: xterm colours from the active theme's CSS variables.
// - `scrollbackLines(pref)`: the `terminalScrollback` tweak as xterm's
//   `scrollback` option.
// - `exitLine(code)`, `failLine(error)`, `SKIPPED_LINE`: what the xterm shows
//   for an exited shell, a failed start, and output Rust's ring dropped.
//
// Exposes `window.OMP_TERMINAL_XTERM`; an IIFE (AGENTS.md "IIFE rule").
// `window.Terminal`, `window.FitAddon` (vendored xterm),
// `window.OMP_TERMINAL` and `window.OMP_KEYMAP` are looked up at call time,
// not at load.
// app/use-terminal.jsx destructures it at top level, so it must load
// before it.
(function () {
  const SKIPPED_LINE = "\r\n\x1b[2m[output skipped]\x1b[0m\r\n";

  function exitLine(code) {
    const label = code == null ? "" : ` (code ${code})`;
    return `\r\n\x1b[2mshell exited${label} \u2014 press Enter to restart\x1b[0m\r\n`;
  }

  function failLine(error) {
    return `\r\n\x1b[31mcould not start the shell: ${error}\x1b[0m \u2014 press Enter to retry\r\n`;
  }

  /** xterm colours from the active theme's CSS variables. */
  function theme() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      background: v("--bg-window", "#0B0D14"),
      foreground: v("--fg", "#E6E9F2"),
      cursor: v("--accent", "#8AF0C8"),
      selectionBackground: v("--accent-soft", "rgba(138, 240, 200, 0.25)"),
    };
  }

  const SCROLLBACK_DEFAULT = 5000;
  const SCROLLBACK_MAX = 100000;

  /** The `terminalScrollback` tweak as xterm's `scrollback` (lines): a
   *  whole number in 0..100000, the default for anything else. */
  function scrollbackLines(pref) {
    if (typeof pref !== "number" || !Number.isFinite(pref)) return SCROLLBACK_DEFAULT;
    return Math.min(SCROLLBACK_MAX, Math.max(0, Math.round(pref)));
  }

  /**
   * Rust's `TerminalStatus.windowsPty` (`{ backend: "conpty", buildNumber }`
   * on Windows, null elsewhere) tells xterm how ConPTY reflows wrapped
   * lines. Set only when it differs, so a repeated status changes no option.
   */
  function applyWindowsPty(term, status) {
    const pty = status?.windowsPty;
    if (!pty) return;
    const cur = term.options.windowsPty;
    if (cur?.backend === pty.backend && cur?.buildNumber === pty.buildNumber) return;
    term.options.windowsPty = { backend: pty.backend, buildNumber: pty.buildNumber };
  }

  /** ctrl+shift+v (Linux, Windows): the clipboard's text into the shell. */
  async function paste(term) {
    // `window.navigator`, not the bare global: the module only touches what
    // it is handed (Node 20 has no global `navigator` for the tests).
    const clipboard = window.navigator?.clipboard;
    if (!clipboard?.readText) return;
    try {
      const text = await clipboard.readText();
      if (text) term.paste(text);
    } catch (err) {
      console.warn("[terminal] clipboard read failed:", err);
    }
  }

  /** Copy `term`'s selection to the clipboard; true when there was one. */
  function copySelection(term) {
    if (!term.hasSelection()) return false;
    window.copyText(term.getSelection());
    return true;
  }

  /**
   * A new xterm and its fit addon. `tryRestart()` is asked on an Enter
   * keydown: true when it restarted the shell (that Enter then never reaches
   * the shell). `onData(data)` gets what xterm would send to the pty,
   * `onResize({ cols, rows })` every size change.
   *
   * Key routing: the custom key handler's `false` hands a keydown back to
   * the page (the global keymap); keyup / keypress stay xterm's. A
   * restarting Enter is `preventDefault`ed, so the browser fires no
   * keypress (which xterm would send as "\r"), and one that comes anyway is
   * swallowed until that Enter's keyup. ctrl+shift+c / v (Linux, Windows)
   * copy the selection and paste; `preventDefault` keeps the keymap and the
   * WebView's own paste out of them. macOS keeps native ⌘C / ⌘V.
   */
  function createXterm({ fontSize, scrollback, theme: colours, tryRestart, onData, onResize, onLink }) {
    const T = window.OMP_TERMINAL;
    const term = new window.Terminal({
      scrollback: scrollbackLines(scrollback), fontSize, theme: colours, allowProposedApi: false, cursorBlink: true,
    });
    // OSC 8 hyperlinks are on by default in xterm 6, and every one a program
    // prints keeps an invisible link entry for as long as its cells live —
    // unbounded for a shell that streams them. Only visible URL text is
    // linkified by the web-links addon: swallow OSC 8 before output arrives.
    term.parser.registerOscHandler(8, () => true);
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon(onLink));
    let restartEnter = false;
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && restartEnter) {
        if (e.type === "keyup") restartEnter = false;
        if (e.type !== "keydown") return false;
      }
      if (e.type !== "keydown") return true;
      if (e.key === "Enter" && tryRestart()) {
        e.preventDefault();
        restartEnter = true;
        return false;
      }
      const clip = T.clipboardAction(e);
      if (clip) {
        e.preventDefault();
        if (clip === "paste") void paste(term);
        else copySelection(term);
        return false;
      }
      return !window.OMP_KEYMAP.guestShouldBypass(e);
    });
    term.onData(onData);
    term.onResize(onResize);
    return { term, fit };
  }

  window.OMP_TERMINAL_XTERM = {
    SKIPPED_LINE,
    exitLine,
    failLine,
    theme,
    scrollbackLines,
    applyWindowsPty,
    createXterm,
    copySelection,
  };
})();
