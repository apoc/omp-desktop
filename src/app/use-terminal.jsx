/* ═════════════════════════════════════════════════════════════════════
   app/use-terminal.jsx — per-tab terminal view for app-live.jsx.
   Rust owns each tab's shell (folder, program, lifetime, output ring);
   this hook renders it. One xterm `Terminal` per tab (built by
   app/terminal-xterm.js), kept in a Map ref and mounted into its panel's
   node (design/terminal-panel.jsx); an instance stays mounted until its
   tab goes. Panel state (open / created / Rust's status) is the pure
   reducer in app/terminal.js.

   Output sync: the decisions (instance adoption, seq dedupe, gap →
   replay, the queue while a replay runs, which writes are acked) are the
   pure stream reducer in app/terminal-stream.js; this hook runs its
   actions. It subscribes, waits until both listeners are registered, asks
   Rust for the status and replays the ring, so nothing emitted before the
   subscription is lost; replays run one after another on a per-tab
   promise chain.

   View policy stays here: the shell starts the first time a tab's panel
   is shown with no shell yet, at the fitted size; Enter in an exited
   (or failed) shell starts a new one; auto-open, height and focus (a
   panel hidden while it holds the focus hands it to the composer).

   Returns `{ state, height, toggle, setHeight, mountFor,
   copySelection }`. `height` is the panel height every
   panel shares, the `terminalHeight` tweak (its default lives in
   TWEAK_DEFAULTS). Every panel body is watched with a ResizeObserver:
   sidebar, tree, subagent pane and window changes all end in a
   (debounced) refit.
   ═════════════════════════════════════════════════════════════════════ */

const {
  EMPTY: _UT_EMPTY, openPanel: _UT_open, togglePanel: _UT_toggle,
  applyStatus: _UT_applyStatus, applyExit: _UT_applyExit, spawnFailed: _UT_spawnFailed,
  needsSpawn: _UT_needsSpawn, shellLive: _UT_shellLive, canRestart: _UT_canRestart,
  entryOf: _UT_entryOf,
} = window.OMP_TERMINAL;
const { pruneEntries: _UT_pruneEntries } = window.OMP_SESSION_UI;
const {
  SKIPPED_LINE: _UT_SKIPPED, exitLine: _UT_exitLine, failLine: _UT_failLine, theme: _UT_theme,
  applyWindowsPty: _UT_applyWindowsPty, createXterm: _UT_createXterm, copySelection: _UT_copySelection,
  scrollbackLines: _UT_scrollbackLines,
} = window.OMP_TERMINAL_XTERM;
const {
  EMPTY: _UT_STREAM, beginSync: _UT_beginSync, onEvent: _UT_onEvent, replayCursor: _UT_replayCursor,
  onReplay: _UT_onReplay, endSync: _UT_endSync, onAttach: _UT_onAttach, onOpened: _UT_onOpened,
} = window.OMP_TERMINAL_STREAM;

const _UT_FONT_PX = 13;

function useTerminal({ bridge, activeSessionId, sessionIds, tweaks, setTweak }) {
  const [state, setState] = React.useState(_UT_EMPTY);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  // Bumped when a tab's initial sync settles, so the spawn effect re-checks.
  const [syncTick, setSyncTick] = React.useState(0);

  // sid → rec: { term, fit, mounted, disposed, subs, stream, sync, spawning,
  // opened, observer, fitTimer }. `stream` = the output sync record
  // (app/terminal-stream.js), `sync` = the promise chain its replays run
  // on; `opened` = the live instance the last `terminal_open` returned
  // (ahead of the rendered panel state until the next render).
  // sid → stable ref callback for the panel's mount node.
  const recs = React.useRef(new Map());
  const mountRefs = React.useRef(new Map());

  const fontSize = Math.round((_UT_FONT_PX * (tweaks.fontSize ?? 100)) / 100);
  // Read by `create`, whose ref callback outlives the render that made it.
  const fontSizeRef = React.useRef(fontSize);
  fontSizeRef.current = fontSize;
  const scrollback = _UT_scrollbackLines(tweaks.terminalScrollback);
  const scrollbackRef = React.useRef(scrollback);
  scrollbackRef.current = scrollback;
  const height = tweaks.terminalHeight;

  const fit = React.useCallback((sid) => {
    const rec = recs.current.get(sid);
    if (!rec?.mounted) return;
    try {
      rec.fit.fit();
      // Output written while the panel was hidden is parsed but not painted.
      rec.term.refresh(0, rec.term.rows - 1);
    } catch { /* hidden or detached: refit on reveal */ }
  }, []);

  /** Rust reported the tab's shell: panel state, and xterm's ConPTY mode. */
  const noteStatus = React.useCallback((sid, status) => {
    const rec = recs.current.get(sid);
    if (rec && !rec.disposed) _UT_applyWindowsPty(rec.term, status);
    setState((s) => _UT_applyStatus(s, sid, status));
  }, []);

  /** Ask Rust for the tab's status (a shell we have not been told about). */
  const refreshStatus = React.useCallback(async (sid) => {
    noteStatus(sid, await bridge.terminalStatus(sid));
  }, [bridge, noteStatus]);

  // Runs the stream reducer's actions (app/terminal-stream.js) for one tab.
  // `run` and `replay` reference each other (a replay's end runs queued
  // events, which may replay again): plain functions over refs, rebuilt
  // with `bridge`, reached through `ops.current` by long-lived callbacks.
  const ops = React.useRef(null);
  ops.current = React.useMemo(() => {
    /** Store the next stream record and perform its actions, in order. */
    function run(sid, rec, { stream, actions }) {
      rec.stream = stream;
      for (const a of actions) {
        if (a.type === "write") {
          const { ack } = a;
          if (ack) rec.term.write(a.bytes, () => bridge.terminalAck(sid, ack.instance, ack.n));
          else rec.term.write(a.bytes);
        } else if (a.type === "skipped") {
          rec.term.write(_UT_SKIPPED);
        } else if (a.type === "exit") {
          setState((s) => _UT_applyExit(s, sid, a.instance, a.code));
          if (_UT_entryOf(stateRef.current, sid).status?.instance !== a.instance) void refreshStatus(sid);
        } else if (a.type === "exitLine") {
          rec.term.write(_UT_exitLine(a.code));
        } else if (a.type === "status") {
          void refreshStatus(sid);
        } else if (a.type === "replay") {
          replay(sid, rec);
        }
      }
    }

    /** Chain `step` (async; already counted by `beginSync`) on the rec's
     *  sync chain; its end runs the events queued meanwhile. */
    function chain(sid, rec, step) {
      rec.sync = rec.sync
        .then(() => (rec.disposed ? undefined : step()))
        .catch((err) => console.error("[terminal] sync failed:", err))
        .finally(() => { if (!rec.disposed) run(sid, rec, _UT_endSync(rec.stream)); });
    }

    /** Rust's held output after the stream's `lastSeq` (written unacked). */
    function replay(sid, rec) {
      chain(sid, rec, async () => {
        const { instance, afterSeq } = _UT_replayCursor(rec.stream);
        const r = await bridge.terminalReplay(sid, instance, afterSeq);
        if (!rec.disposed) run(sid, rec, _UT_onReplay(rec.stream, afterSeq, r));
      });
    }

    const handle = (sid, rec, ev) => { if (!rec.disposed) run(sid, rec, _UT_onEvent(rec.stream, ev)); };

    /** First sync of a new xterm: listeners first, then status, then replay. */
    function attach(sid, rec) {
      const data = bridge.onTerminalData(sid, (p) => handle(sid, rec, { kind: "data", ...p }));
      const exit = bridge.onTerminalExit(sid, (p) => handle(sid, rec, { kind: "exit", ...p }));
      rec.subs = [data, exit];
      rec.stream = _UT_beginSync(rec.stream);
      chain(sid, rec, async () => {
        await Promise.all([data.ready, exit.ready]);
        if (rec.disposed) return;
        const status = await bridge.terminalStatus(sid);
        if (rec.disposed) return;
        noteStatus(sid, status);
        const r = status ? await bridge.terminalReplay(sid, status.instance, 0) : null;
        if (!rec.disposed) run(sid, rec, _UT_onAttach(rec.stream, status, r));
      });
      rec.sync = rec.sync.finally(() => { if (!rec.disposed) setSyncTick((n) => n + 1); });
    }

    /** Start the tab's shell (Rust returns a live one as is), then fetch
     *  whatever it printed before the reply. */
    async function spawn(sid) {
      const rec = recs.current.get(sid);
      if (!rec || rec.spawning || rec.disposed) return;
      rec.spawning = true;
      // A resize while the open is in flight is not sent (no live shell):
      // compared with the size the shell starts at once the reply is in.
      const { cols, rows } = rec.term;
      const res = await bridge.terminalOpen(sid, cols, rows);
      rec.spawning = false;
      if (rec.disposed) return;
      if (!res.ok) {
        // Shown as an exited shell: Enter tries again.
        rec.term.write(_UT_failLine(res.error));
        setState((s) => _UT_spawnFailed(s, sid, res.error));
        return;
      }
      const { status } = res;
      if (status.state !== "exited") {
        rec.opened = Math.max(rec.opened, status.instance);
        if (rec.term.cols !== cols || rec.term.rows !== rows) {
          bridge.terminalResize(sid, rec.term.cols, rec.term.rows);
        }
      }
      noteStatus(sid, status);
      run(sid, rec, _UT_onOpened(rec.stream, status));
    }

    return { attach, spawn };
  }, [bridge, noteStatus, refreshStatus]);

  const spawn = React.useCallback((sid) => ops.current.spawn(sid), []);

  const respawn = React.useCallback((sid) => {
    const rec = recs.current.get(sid);
    if (!rec || rec.spawning) return;
    rec.term.reset();
    spawn(sid);
  }, [spawn]);

  const create = React.useCallback((sid) => {
    // `rec` (declared below) exists by the time any of these callbacks runs.
    const { term, fit: fitAddon } = _UT_createXterm({
      fontSize: fontSizeRef.current,
      scrollback: scrollbackRef.current,
      theme: _UT_theme(),
      tryRestart: () => {
        if (!_UT_canRestart(_UT_entryOf(stateRef.current, sid), rec.opened)) return false;
        respawn(sid);
        return true;
      },
      onData: (data) => bridge.terminalWrite(sid, data),
      // Only a live shell has a pty to resize; the size a shell starts at is
      // the one `spawn` sends (and corrects once the reply is in).
      onResize: ({ cols, rows }) => {
        if (_UT_shellLive(_UT_entryOf(stateRef.current, sid), rec.opened)) bridge.terminalResize(sid, cols, rows);
      },
    });
    const rec = {
      term, fit: fitAddon, mounted: false, disposed: false, subs: [],
      stream: _UT_STREAM, sync: Promise.resolve(), spawning: false, opened: 0, observer: null, fitTimer: 0,
    };
    recs.current.set(sid, rec);
    ops.current.attach(sid, rec);
    return rec;
  }, [bridge, respawn]);

  const dispose = React.useCallback((sid) => {
    const rec = recs.current.get(sid);
    if (rec) {
      rec.disposed = true;
      for (const sub of rec.subs) sub.stop();
      rec.observer?.disconnect();
      clearTimeout(rec.fitTimer);
      rec.term.dispose();
    }
    recs.current.delete(sid);
    mountRefs.current.delete(sid);
  }, []);

  // The panel's mount node: the first time it appears the tab's xterm opens
  // into it. (The shell itself is spawned by the effect below, once visible.)
  const mountFor = React.useCallback((sid) => {
    if (!mountRefs.current.has(sid)) {
      mountRefs.current.set(sid, (node) => {
        if (!node || !bridge) return;
        const rec = recs.current.get(sid) ?? create(sid);
        if (rec.mounted) return;
        rec.term.open(node);
        rec.mounted = true;
        // Layout changes that resize the body without a window resize
        // (sidebar, tree, subagent pane) still refit. A hidden panel reports
        // 0×0: nothing to fit, the reveal observes the real size.
        rec.observer = new ResizeObserver((entries) => {
          const { width, height: h } = entries[entries.length - 1].contentRect;
          if (width === 0 || h === 0) return;
          clearTimeout(rec.fitTimer);
          rec.fitTimer = setTimeout(() => fit(sid), 50);
        });
        rec.observer.observe(node);
      });
    }
    return mountRefs.current.get(sid);
  }, [bridge, create, fit]);

  /** Right-click on a selection copies it; true when it did (no menu then). */
  const copySelection = React.useCallback((sid) => {
    const term = recs.current.get(sid)?.term;
    return term ? _UT_copySelection(term) : false;
  }, []);

  const focus = React.useCallback((sid) => recs.current.get(sid)?.term.focus(), []);
  // Hiding a panel that holds the focus (xterm's textarea) would drop it
  // on <body>, where keys reach nothing: the composer's prompt box takes
  // it instead.
  const toggle = React.useCallback((sid) => {
    if (!sid) return;
    if (_UT_entryOf(stateRef.current, sid).open) {
      const panel = recs.current.get(sid)?.term.element?.closest(".term-panel");
      if (panel?.contains(document.activeElement)) document.querySelector(".composer-input textarea")?.focus();
    }
    setState((s) => _UT_toggle(s, sid));
  }, []);
  const setHeight = React.useCallback((px) => setTweak("terminalHeight", px), [setTweak]);

  // A visible panel: size the xterm to it, start the shell of a tab that has
  // none (once its initial sync settled), and focus the terminal that was
  // just opened. Runs on every open/close, tab switch, height change and
  // settled sync.
  const prevOpen = React.useRef(null);
  React.useEffect(() => {
    const entry = _UT_entryOf(state, activeSessionId);
    const rec = recs.current.get(activeSessionId);
    if (entry.open && rec?.mounted) {
      fit(activeSessionId);
      if (_UT_needsSpawn(entry) && rec.stream.syncing === 0) spawn(activeSessionId);
      if (prevOpen.current !== activeSessionId) focus(activeSessionId);
    }
    prevOpen.current = entry.open ? activeSessionId : null;
  }, [state, activeSessionId, height, syncTick, fit, spawn, focus]);

  // Tab list changes: drop the panel state and the instance of closed tabs
  // (`closeSession` in live.js already had Rust end the tab and its shell),
  // and open the panel of a new tab when "open with new tab" is on. A tab
  // restored at launch counts as new; its shell starts once it is active.
  const seen = React.useRef(new Set());
  const idsKey = sessionIds.join("\0");
  React.useEffect(() => {
    const fresh = sessionIds.filter((sid) => !seen.current.has(sid));
    seen.current = new Set(sessionIds);
    setState((s) => {
      let next = _UT_pruneEntries(s, sessionIds);
      if (tweaks.terminalAutoOpen) for (const sid of fresh) next = _UT_open(next, sid);
      return next;
    });
    for (const sid of [...recs.current.keys()]) if (!sessionIds.includes(sid)) dispose(sid);
  }, [idsKey, dispose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme, font and scrollback follow the tweaks for every instance.
  React.useEffect(() => {
    for (const [sid, rec] of recs.current) {
      rec.term.options.theme = _UT_theme();
      rec.term.options.fontSize = fontSize;
      if (rec.term.options.scrollback !== scrollback) rec.term.options.scrollback = scrollback;
      fit(sid);
    }
  }, [tweaks.theme, tweaks.accent, fontSize, scrollback, fit]);

  return { state, height, toggle, setHeight, mountFor, copySelection };
}

Object.assign(window, { useTerminal });
