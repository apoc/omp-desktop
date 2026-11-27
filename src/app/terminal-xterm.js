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

  // The addon scans at most 2048 characters forwards and backwards through
  // wrapped lines and may return only a prefix. Its stock expression also
  // rejects a final `]`, so the first alternative covers bracketed IPv6
  // (with optional port/path).
  const WEB_LINK_OPTIONS = {
    urlRegex: /(https?|HTTPS?):[/]{2}(?:\[[\da-fA-F:.]+\](?::\d+)?(?:[/?#](?:[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>])?)?|[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>])/,
  };
  // A logical line longer than this is not scanned: the addon itself stops
  // at 2,048 characters, and a URL that long is not worth opening from a
  // terminal. Bounds the cell walk when a click activates a link.
  const MAX_LINK_LINE = 2048;
  const MAX_LINK_ROWS = 64;
  const LINK_BREAK = /[\s"'`<>]/;
  const TOKEN_OPENERS = "([{";
  const TOKEN_TRAILING = /[.,;:!?]/;
  const TOKEN_PAIRS = { ")": "(", "]": "[", "}": "{" };

  /**
   * The visible text of the logical (wrapped) line around buffer row `y`
   * (0-based), and cell column `x`'s (1-based) UTF-16 offset in it. Cells are
   * read one by one, so a wide character contributes its own string length
   * and a following continuation cell contributes nothing; a combining
   * character stays part of its base cell. An erased or skipped-over cell
   * (ECH, or a cursor moved across it) holds no characters but still covers
   * a column, so it reads as one space, as xterm's own `translateToString`
   * shows it. The one empty cell that is no content is the pad a wrapped row
   * gets when its last column cannot take a wide character: xterm leaves
   * that column empty and starts the next, wrapped row with the width-2
   * character, so only that empty last cell is dropped (and only there).
   * Concealed cells (SGR 8) become spaces: their text is not on screen and
   * may not become part of a URL.
   *
   * The unused columns after the last cell with content on the final row are
   * no text either: they are trimmed before the cap applies, so a long URL on
   * a wide terminal is not refused for the padding behind it. A gap before
   * content on that row stays a space.
   *
   * Null for a line beyond the scan cap or an `x` that is not on it. The cap
   * applies in both directions: a wrapped line that continues past
   * `MAX_LINK_ROWS` is not returned in part, because its token could
   * continue on the rows that are not read.
   */
  function logicalLineAt(buffer, y, x) {
    let first = y;
    while (first > 0 && buffer.getLine(first)?.isWrapped && y - first < MAX_LINK_ROWS) first--;
    if (y - first >= MAX_LINK_ROWS) return null;
    const cell = buffer.getNullCell();
    const nextCell = buffer.getNullCell();
    let text = "";
    let offset = -1;
    for (let row = first; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) return null;
      const nextLine = buffer.getLine(row + 1);
      const nextWrapped = Boolean(nextLine?.isWrapped);
      // xterm's pad: a wide character that cannot fit the last column is
      // moved to the next, wrapped row, so that row starts width-2 while the
      // column here stays empty. No other empty last cell is a pad.
      let padColumn = -1;
      if (nextWrapped && nextLine.length) {
        nextLine.getCell(0, nextCell);
        if (nextCell.getWidth() === 2) padColumn = line.length - 1;
      }
      // Where the final row's last content cell ends: the empty columns after
      // it are unused terminal width, not text, so they stay out of `text`
      // and of the cap. A gap before later content stays a space.
      let trailing = -1;
      const lastRow = !nextWrapped;
      for (let col = 0; col < line.length; col++) {
        if (row === y && col === x - 1) offset = text.length;
        line.getCell(col, cell);
        if (!cell.getWidth()) continue;
        const chars = cell.getChars();
        if (cell.isInvisible?.()) {
          text += " ".repeat(Math.max(1, chars.length));
          trailing = -1;
        } else if (chars) {
          text += chars;
          trailing = -1;
        } else if (col !== padColumn) {
          if (trailing < 0) trailing = text.length;
          text += " ";
        }
        if (!lastRow && text.length > MAX_LINK_LINE) return null;
      }
      if (lastRow) {
        if (trailing >= 0) text = text.slice(0, trailing);
        break;
      }
      if (row - first + 1 >= MAX_LINK_ROWS) return null;
    }
    if (text.length > MAX_LINK_LINE) return null;
    return offset < 0 ? null : { text, offset };
  }

  /**
   * The whitespace/quote-delimited token around the addon's match at
   * `offset`, without enclosing prose brackets or trailing punctuation.
   * Brackets only come off when they are unmatched, so an IPv6 host keeps
   * its `[`/`]`, and balanced parentheses inside a path stay. Null when the
   * token starts before the match (the addon found a URL inside a larger
   * token), which would make the target ambiguous.
   */
  function linkTokenAt(text, offset, matchLength) {
    let start = offset;
    while (start > 0 && !LINK_BREAK.test(text[start - 1])) start--;
    let end = offset + matchLength;
    while (end < text.length && !LINK_BREAK.test(text[end])) end++;
    while (start < offset && TOKEN_OPENERS.includes(text[start])) start++;
    for (;;) {
      while (end > start && TOKEN_TRAILING.test(text[end - 1])) end--;
      const close = text[end - 1];
      const open = TOKEN_PAIRS[close];
      if (!open) break;
      let opens = 0;
      let closes = 0;
      for (let i = start; i < end; i++) {
        if (text[i] === open) opens++;
        else if (text[i] === close) closes++;
      }
      if (closes <= opens) break;
      end--;
    }
    return start === offset && end > offset ? text.slice(start, end) : null;
  }

  /**
   * The URL to open for the addon's hovered `url`: the whole token at the
   * hovered cell range, read from the visible cells. Null when the visible
   * text there is not exactly the matched text (a concealed cell reads as a
   * space) or when the full token's host, username or password differ from
   * the matched text's (a bracketed IPv6 match followed by `@other-host`, or
   * a `(user):pw@` suffix, must not change where the link goes).
   */
  function completeWebLink(buffer, hovered, url) {
    const range = hovered && hovered.range;
    if (!hovered || hovered.text !== url || !range) return null;
    const line = logicalLineAt(buffer, range.start.y - 1, range.start.x);
    if (!line || line.text.slice(line.offset, line.offset + url.length) !== url) return null;
    const token = linkTokenAt(line.text, line.offset, url.length);
    if (!token) return null;
    try {
      const matched = new URL(url);
      const target = new URL(token);
      const same = matched.host === target.host && matched.username === target.username
        && matched.password === target.password;
      return same ? token : null;
    } catch {
      return null;
    }
  }

  /** A primary click with the platform's link modifier (Cmd on macOS, Ctrl
   *  elsewhere); checked before the buffer is read. */
  function linkGesture(event) {
    if (event.button !== 0) return false;
    return window.OMP_KEYMAP.detectMac() ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
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
    let hovered = null;
    const linkOptions = {
      ...WEB_LINK_OPTIONS,
      hover(_event, text, range) { hovered = { text, range }; },
    };
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event, url) => {
      if (!linkGesture(event)) return;
      const target = completeWebLink(term.buffer.active, hovered, url);
      if (target) onLink(event, target);
    }, linkOptions));
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
