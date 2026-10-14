/* app/use-browser.jsx — the browser panel's state (docs/architecture/browser.md).
   Rust owns Chromium, the screencast and the annotation
   overlay (src-tauri/src/browser/); this hook tracks which tabs have the panel
   open, mirrors the `browser://` events of the open tab's page, and keeps the
   annotation chips. Painting and input forwarding are app/browser-screen.js.
   The panel element must stay mounted while `open` (the effect binds the
   `viewRef`/`canvasRef` elements of the commit that opened it). */

const { OMP_BROWSER: _UB, OMP_BROWSER_SCREEN: _UBS } = window;
const _UB_IDLE = Object.freeze({ status: "idle", error: null, url: "", loading: false, canBack: false, canForward: false });
const _UB_NO_TABS = Object.freeze([]);
let _ubChipSeq = 0;

function useBrowser({ bridge, activeSessionId, sessionIds, tweaks, setTweak }) {
  const sid = activeSessionId || null;
  const [openBy, setOpenBy] = React.useState(_UB.EMPTY); // sid → true
  const [fullView, setFullView] = React.useState(false);
  const [state, setState] = React.useState(_UB_IDLE);
  const [tabs, setTabs] = React.useState(_UB_NO_TABS);
  const [page, setPage] = React.useState(null); // { cssW, cssH } of the shown page
  const [annotate, setAnnotateState] = React.useState(false);
  const [pendingAny, setPending] = React.useState(null); // { sid, pick, image }
  const [chips, setChips] = React.useState(_UB.EMPTY); // sid → chip[]
  const canvasRef = React.useRef(null);
  const viewRef = React.useRef(null);
  const screenRef = React.useRef(null);
  const chipsRef = React.useRef(_UB.EMPTY);
  const open = Boolean(sid && openBy[sid]);
  const pending = pendingAny && pendingAny.sid === sid ? pendingAny : null;
  const wantUrl = React.useRef(null); // { sid, url } to navigate to once the panel is open
  // The active effect's open token; pending resizes stay local to that run.
  // A stale open completion must not release a newer run's queued work.
  const openInFlight = React.useRef(null);
  // What the Esc handler (bound once per open) must see current.
  const latest = React.useRef({});
  latest.current = { annotate, pending };
  // Bumped whenever annotate is left, so a capture that settles after the
  // pick has been dismissed (Esc / annotate toggled off) is dropped.
  const pickGen = React.useRef(0);

  const updateChips = React.useCallback((fn) => {
    chipsRef.current = fn(chipsRef.current);
    setChips(chipsRef.current);
  }, []);

  // A closed tab drops its panel state and chips.
  const idsKey = (sessionIds ?? []).join("\0");
  React.useEffect(() => {
    const ids = idsKey ? idsKey.split("\0") : [];
    setOpenBy((s) => _UB.prune(s, ids));
    updateChips((s) => _UB.prune(s, ids));
    setPending((p) => (p && ids.includes(p.sid) ? p : null));
  }, [idsKey, updateChips]);

  const setAnnotate = React.useCallback((on) => {
    if (!sid) return;
    if (!on) pickGen.current += 1; // a pick made before this must not land
    setAnnotateState(on);
    bridge?.browserAnnotate(sid, on);
  }, [bridge, sid]);

  // The open tab's panel: attach every listener, then open (the backend's
  // first `state` event fires during the open). Leaving (close, another tab)
  // stops the screencast; Chromium stays.
  React.useEffect(() => {
    const view = viewRef.current;
    const canvas = canvasRef.current;
    if (!bridge || !sid || !open || !view || !canvas) return undefined;
    let live = true;
    // While `browserOpenPanel` settles the view is not live: a resize is
    // queued here (latest wins) and a URL by `wantUrl`, both flushed once
    // the open resolves.
    const opening = { pending: true };
    openInFlight.current = opening;
    let pendingSize = null;
    setState(_UB_IDLE);
    setTabs(_UB_NO_TABS);
    setPage(null);
    const screen = _UBS.createScreen({
      view,
      canvas,
      send: (ev) => bridge.browserInput(sid, ev),
      onResize: (w, h, dpr) => {
        // While `browserOpenPanel` is in flight the view is not live; a
        // resize in that window is queued (latest wins) and flushed once
        // the open settles.
        if (opening.pending) pendingSize = { w, h, dpr };
        else bridge.browserResize(sid, w, h, dpr);
      },
      onPage: setPage,
      // Escape ends annotate mode; a desktop shortcut (tabs, panels, this
      // panel's toggle) is left to the app keymap instead of the page.
      swallowKey: (e) => (e.key === "Escape" && latest.current.annotate)
        || _UB.keyBelongsToApp(window.OMP_KEYMAP.chordFromEvent(e), window.OMP_KEYMAP.lookup),
    });
    screenRef.current = screen;
    const onPick = async (pick) => {
      // A generation stamp: if annotate is left (Esc / the toolbar toggle)
      // before the capture settles, this pick no longer stands.
      const gen = pickGen.current;
      const r = await bridge.browserCapture(sid, pick.rect);
      if (!live || gen !== pickGen.current) return;
      // A failed capture still opens the popover: `image: null` keeps the
      // text flowing (mergeIntoMessage skips it) and the popover shows the
      // failure note instead of a silent chip.
      const image = r.ok ? { type: "image", data: r.value.data, mimeType: r.value.mimeType } : null;
      setPending({ sid, pick, image });
    };
    const offs = [
      bridge.onBrowserEvent(sid, "frame", screen.frame),
      bridge.onBrowserEvent(sid, "tabs", (p) => setTabs(p?.tabs ?? _UB_NO_TABS)),
      bridge.onBrowserEvent(sid, "state", setState),
      bridge.onBrowserEvent(sid, "pick", onPick),
    ];
    // Esc leaves annotate mode (not while the comment popover is open: it
    // cancels itself). Bound on the panel, so Esc in the composer is not ours.
    const panel = view.closest(".browser-panel") ?? view;
    const onEsc = (e) => {
      if (e.key !== "Escape" || !latest.current.annotate || latest.current.pending) return;
      e.preventDefault();
      setAnnotate(false);
    };
    panel.addEventListener("keydown", onEsc);
    Promise.all(offs.map((o) => o.ready)).then(async () => {
      if (!live) return;
      const s = screen.size();
      // `openUrl` and the resize handler read `openInFlight` (set at effect
      // start) to know the view is not live yet and queue instead.
      try {
        await bridge.browserOpenPanel(sid, s.width, s.height, s.dpr);
      } finally {
        opening.pending = false;
      }
      if (!live) return;
      // From here on the view is live: apply the latest queued resize, then
      // the latest queued URL (a `/browser <url>` or localhost link asked for
      // while Chromium was still starting).
      if (pendingSize) {
        bridge.browserResize(sid, pendingSize.w, pendingSize.h, pendingSize.dpr);
        pendingSize = null;
      }
      const want = wantUrl.current;
      if (want?.sid === sid) {
        wantUrl.current = null;
        bridge.browserNavigate(sid, want.url);
      }
    });
    return () => {
      live = false;
      if (openInFlight.current === opening) openInFlight.current = null;
      panel.removeEventListener("keydown", onEsc);
      for (const off of offs) off();
      screen.destroy();
      screenRef.current = null;
      bridge.browserClosePanel(sid);
      setAnnotateState(false);
      setPending(null);
    };
  }, [bridge, sid, open, setAnnotate]);

  const setOpen = React.useCallback((on) => {
    if (!sid) return;
    setOpenBy((s) => {
      if (on) return { ...s, [sid]: true };
      const { [sid]: _closed, ...rest } = s;
      return rest;
    });
    if (!on) setFullView(false);
  }, [sid]);
  const toggle = React.useCallback(() => setOpen(!open), [setOpen, open]);
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  // Show `url` (already normalised) in the panel, opening it first if needed.
  // While `browserOpenPanel` is still in flight the backend has no view to
  // navigate yet (`panel not open`), so the URL is queued (latest wins) and
  // the open flushes it once the panel is live.
  const openUrl = React.useCallback((url) => {
    if (!sid) return;
    if (open && !openInFlight.current?.pending) {
      bridge?.browserNavigate(sid, url);
      return;
    }
    wantUrl.current = { sid, url };
    if (!open) setOpen(true);
  }, [bridge, sid, open, setOpen]);

  // A plain click on a localhost link in the chat opens it here (when the
  // tweak is on); a modifier (⌘/Ctrl) click opens it in the system browser
  // through the external opener — wry has no `on_new_window` handler, so
  // relying on the native new-window behaviour would open nothing.
  const localLinks = tweaks?.browserLocalhostInPanel ?? true;
  const openUrlRef = React.useRef(openUrl);
  openUrlRef.current = openUrl;
  const bridgeRef = React.useRef(bridge);
  bridgeRef.current = bridge;
  React.useEffect(() => {
    if (!localLinks || !sid) return undefined;
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = e.target instanceof Element ? e.target.closest(".md-content a[href]") : null;
      const url = a && _UB.localUrl(a.getAttribute("href"));
      if (!url) return;
      // ⌘/Ctrl (or Shift/Alt) means "open externally"; route it through the
      // external opener explicitly rather than the native new-window path.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        e.preventDefault();
        const open = bridgeRef.current?.openExternalUrl;
        if (!open) return;
        Promise.resolve(open(url)).then(
          (res) => { if (res && !res.ok) console.error("[browser] open failed:", res.error); },
          (err) => console.error("[browser] open failed:", err),
        );
        return;
      }
      e.preventDefault();
      openUrlRef.current(url);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [localLinks, sid]);

  const savePending = React.useCallback((comment) => {
    const text = comment.trim();
    if (!pending || !text) return;
    const chip = { id: `bc${++_ubChipSeq}`, pick: pending.pick, comment: text, image: pending.image };
    updateChips((s) => _UB.addChip(s, pending.sid, chip));
    setPending(null);
  }, [pending, updateChips]);
  const cancelPending = React.useCallback(() => setPending(null), []);
  const removeChip = React.useCallback((id) => updateChips((s) => _UB.removeChip(s, sid, id)), [sid, updateChips]);
  // A successful send spends exactly the chips it carried; chips added
  // while the send was in flight stay. `id` defaults to the tab shown (a
  // goal start settles later, possibly on another tab).
  const spendChips = React.useCallback((ids, id = sid) => updateChips((s) => _UB.removeChips(s, id, ids)), [sid, updateChips]);
  // A submit reserves its chip ids synchronously, so a second send before
  // the first settles cannot ship the same annotation twice. `id` defaults
  // to the tab shown (a goal start settles later, possibly on another tab).
  const reserveChips = React.useCallback((ids, id = sid) => updateChips((s) => _UB.reserveChips(s, id, ids)), [sid, updateChips]);
  // A failed or timed-out send puts its reserved chips back.
  const releaseChips = React.useCallback((ids, id = sid) => updateChips((s) => _UB.releaseChips(s, id, ids)), [sid, updateChips]);

  // Page actions on the open tab; a refused navigation shows in the page.
  const act = React.useMemo(() => ({
    navigate: (url) => bridge?.browserNavigate(sid, url),
    history: (delta) => bridge?.browserHistory(sid, delta),
    newTab: () => bridge?.browserTabNew(sid),
    closeTab: (id) => bridge?.browserTabClose(sid, id),
    activateTab: (id) => bridge?.browserTabActivate(sid, id),
    // After a crash the screencast is gone: open the panel again.
    restart: () => {
      pickGen.current += 1;
      setAnnotateState(false);
      setPending(null);
      const s = screenRef.current?.size();
      if (s) bridge?.browserOpenPanel(sid, s.width, s.height, s.dpr);
    },
  }), [bridge, sid]);

  const chipsList = _UB.chipsOf(chips, sid);
  // Reserved chips are out of circulation while their send settles: they
  // are excluded from every merge (`sendableChips`) and from the composer's
  // sendable count (`sendableCount`), so a pending send cannot be
  // re-triggered by its own chips. The strip still shows them, dimmed,
  // from the full list.
  const sendableChips = chipsList.filter((c) => !c.reserved);
  return {
    open, toggle, close, openUrl, fullView, setFullView,
    width: tweaks?.browserWidth ?? 0, // px; 0 = default (half the stage) — see OMP_BROWSER.clampWidth
    setWidth: (px) => setTweak("browserWidth", Math.round(px)),
    state, tabs, page, annotate, setAnnotate,
    pending, savePending, cancelPending,
    chips: chipsList, sendableChips, sendableCount: sendableChips.length,
    removeChip, spendChips, reserveChips, releaseChips,
    canvasRef, viewRef, ...act,
  };
}

window.useBrowser = useBrowser;
