/* app/use-keymap.jsx — load keybindings from the backend, drive the
   resolver, and install the global dispatch listener.

   useKeymap(bridge, profileId)
     → { payload, conflicts, error, reload, setBinding, resetBinding }

   useKeymapDispatch(handlersRef)
     — installs one window keydown listener; reads handlers through a ref
       so the effect never re-subscribes when handlers change. */

function useKeymap(bridge, profileId) {
  const [payload,   setPayload]   = React.useState(null);
  const [conflicts, setConflicts] = React.useState([]);
  const [error,     setError]     = React.useState(null);
  // Cache the last-known overlay path so the error banner can print it even
  // if the most recent load failed (corrupt file → null payload).
  const overlayPathRef = React.useRef(null);
  // Staleness guard: each reload increments the generation; an async response
  // that arrives after a newer reload has started is silently discarded.
  // Without this, two quick tab switches can apply the earlier profile's map.
  const genRef = React.useRef(0);

  const applyPayload = React.useCallback((p) => {
    if (!p) {
      const r = window.OMP_KEYMAP.resolve(window.OMP_KEYMAP.KEYMAP_ACTIONS, {});
      window.OMP_KEYMAP.setResolved(r);
      setPayload(null);
      setConflicts(r.conflicts);
      setError("Keybinding configuration could not be loaded.");
      return;
    }
    overlayPathRef.current = p.overlayPath;
    const config = { ...p.omp, ...p.overlay };
    const r = window.OMP_KEYMAP.resolve(window.OMP_KEYMAP.KEYMAP_ACTIONS, config);
    window.OMP_KEYMAP.setResolved(r);
    setPayload(p);
    setConflicts(r.conflicts);
    setError(null);
  }, []);

  const reload = React.useCallback(async () => {
    if (!bridge) return;
    const gen = ++genRef.current;
    const result = await bridge.listKeybindings();
    if (gen !== genRef.current) return; // stale — a newer reload started, discard
    applyPayload(result);
  }, [bridge, applyPayload]);

  React.useEffect(() => {
    reload();
  }, [bridge, profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setBinding = React.useCallback(async (action, keys) => {
    if (!bridge) return "no bridge";
    const res = await bridge.setKeybinding(action, keys);
    if (res.ok) {
      // Bump generation so any in-flight reload() response is discarded —
      // the mutation result is authoritative.
      ++genRef.current;
      applyPayload(res.value);
      return null;
    }
    return res.error;
  }, [bridge, applyPayload]);

  const resetBinding = React.useCallback(async (action) => {
    if (!bridge) return "no bridge";
    const res = await bridge.resetKeybinding(action);
    if (res.ok) {
      ++genRef.current;
      applyPayload(res.value);
      return null;
    }
    return res.error;
  }, [bridge, applyPayload]);

  return {
    payload,
    conflicts,
    error,
    overlayPath: payload?.overlayPath ?? overlayPathRef.current ?? null,
    reload,
    setBinding,
    resetBinding,
  };
}

function useKeymapDispatch(handlersRef) {
  // Single [] effect: the handler map is read through a ref, so we never
  // re-subscribe when individual handlers change — avoids listener churn on
  // every render.
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      if (e.repeat) return; // ignore auto-repeat; prevents tab-close/new storms on Ctrl+W/Ctrl+T hold
      const chord = window.OMP_KEYMAP.chordFromEvent(e);
      if (!chord) return;
      const id = window.OMP_KEYMAP.lookup(chord);
      if (!id) return;
      const handler = handlersRef.current?.[id];
      if (!handler) return;
      if (window.OMP_KEYMAP.isTypingTarget(e.target) &&
          !window.OMP_KEYMAP.allowedInInput(chord)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

Object.assign(window, { useKeymap, useKeymapDispatch });
