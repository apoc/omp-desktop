/* app/use-widgets.jsx — rail widget plugins (docs/widgets.md). Rust owns
   config, approval, triggers and scheduling (src-tauri/src/widgets/); this
   hook only reports what the user sees (`widgetsSetView`), mirrors the
   backend's snapshot and `widgets://` events, and turns them into card
   props. Run bookkeeping is pure in app/widgets.js. */

const { OMP_WIDGETS: _UW } = window;
const _UW_GLOBAL_KEY = "__global__";
const _UW_NO_IDS = [];
const _UW_EMPTY_CONFIG = { plugins: [], errors: [], fatal: null, configPath: null };

// One dock bounce (macOS; the OS decides elsewhere): the shared helper in
// app/attention.js, so a new ask elsewhere bounces exactly the same way.
function _uwRequestAttention() {
  window.OMP_ATTENTION?.requestAttention?.(window);
}

function _uwVisible() {
  return document.visibilityState === "visible";
}

/** `activeSessionId` must be the tab the app renders (`activeProject.id`,
 *  "" when none) — never a closed tab's id. `railVisible`: the rail is on
 *  screen (layout not focus, conversation tree closed); hidden = nothing runs.
 *  `setTweak` stores the acknowledged attention key (per plugin id and, for a
 *  tab plugin, per `activeProjectPath`). */
function useWidgets({ bridge, activeSessionId, activeProjectPath, railVisible, tweaks, setTweak }) {
  const [config, setConfig] = React.useState(_UW_EMPTY_CONFIG);
  // sessionId ("" for none) → plugin ids applicable to it, latest per
  // session, so a late payload for another tab never blanks this one.
  const [applicable, setApplicable] = React.useState({});
  // runKey → RunView, mutated in place by OMP_WIDGETS.mergeRun; `runsVersion`
  // re-renders. parseCache memoises parseOutput per run key and finish.
  const runsRef = React.useRef(new Map());
  const parseCacheRef = React.useRef(new Map());
  const [runsVersion, setRunsVersion] = React.useState(0);
  const [windowVisible, setWindowVisible] = React.useState(_uwVisible);

  const applyActive = React.useCallback((active) => {
    if (!active || !Array.isArray(active.applicable)) return;
    const sid = active.sessionId ?? "";
    setApplicable(m => ({ ...m, [sid]: active.applicable }));
  }, []);

  // `skip`: run keys removed while the snapshot was in flight, which the
  // (older) snapshot must not bring back.
  const applySnapshot = React.useCallback((snap, skip) => {
    if (!snap) return;
    setConfig({ plugins: snap.plugins ?? [], errors: snap.errors ?? [], fatal: snap.fatal ?? null, configPath: snap.configPath ?? null });
    applyActive(snap.active);
    let changed = false;
    for (const run of snap.runs ?? []) {
      if (skip?.has(_UW.runKey(run.key, run.pluginId))) continue;
      if (_UW.mergeRun(runsRef.current, run)) changed = true;
    }
    if (changed) setRunsVersion(v => v + 1);
  }, [applyActive]);

  // Listen first, then fetch: an event landing before the snapshot resolves
  // is applied at once and the snapshot merges around it by (seq, phase).
  React.useEffect(() => {
    if (!bridge) return undefined;
    let live = true;
    let loading = true;
    let unlisten = null;
    const removedWhileLoading = new Set();
    const onEvent = (kind, payload) => {
      if (!live || !payload) return;
      if (kind === "run") {
        if (_UW.mergeRun(runsRef.current, payload)) setRunsVersion(v => v + 1);
      } else if (kind === "removed") {
        const k = _UW.runKey(payload.key, payload.pluginId);
        if (loading) removedWhileLoading.add(k);
        parseCacheRef.current.delete(k);
        if (runsRef.current.delete(k)) setRunsVersion(v => v + 1);
      } else if (kind === "config") {
        applySnapshot(payload);
      } else if (kind === "active") {
        applyActive(payload);
      }
    };
    (async () => {
      const stop = await bridge.onWidgetsEvent(onEvent);
      if (!live) { stop(); return; }
      unlisten = stop;
      const snap = await bridge.widgetsState();
      loading = false;
      if (live) applySnapshot(snap, removedWhileLoading);
    })();
    return () => { live = false; unlisten?.(); };
  }, [bridge, applySnapshot, applyActive]);

  React.useEffect(() => {
    const onChange = () => setWindowVisible(_uwVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Plugins whose Settings toggle is off: they neither run nor render. Taken
  // from the tweak keys, not the config, so a plugin the config lacks right
  // now stays hidden when a reload brings it back (see hiddenPluginIds).
  const hiddenKey = _UW.hiddenPluginIds(tweaks, config.plugins.map(p => p.id)).join("\0");
  const hiddenIds = React.useMemo(() => (hiddenKey ? hiddenKey.split("\0") : _UW_NO_IDS), [hiddenKey]);
  const sessionId = activeSessionId || null;
  // Sent only when a field changes: the deps are the view's own values.
  React.useEffect(() => {
    if (!bridge) return;
    bridge.widgetsSetView({ sessionId, railVisible, windowVisible, hidden: hiddenIds });
  }, [bridge, sessionId, railVisible, windowVisible, hiddenIds]);

  const activeIds = applicable[sessionId ?? ""] ?? _UW_NO_IDS;
  const cards = React.useMemo(() => {
    const byId = new Map(config.plugins.map(p => [p.id, p]));
    const out = [];
    for (const id of activeIds) {
      const p = byId.get(id);
      if (!p || !p.enabled || p.approval !== "approved" || hiddenIds.includes(id)) continue;
      const key = p.scope === "global" ? _UW_GLOBAL_KEY : sessionId;
      if (!key) continue;
      const k = _UW.runKey(key, id);
      const run = runsRef.current.get(k);
      const parsed = _UW.parsedLast(parseCacheRef.current, k, run?.last);
      // A tab plugin's ack follows the project, not the tab (tab ids change
      // every launch); a tab without a path falls back to its own id.
      const ackKey = _UW.ackKey(id, p.scope === "global" ? null : (activeProjectPath || `tab:${sessionId}`));
      out.push({ id, ackKey, title: p.title, insert: p.insert, resetKey: `${k}:${run?.seq ?? 0}`, run: _UW.cardRun(run, parsed) });
    }
    return out;
  }, [config.plugins, activeIds, hiddenIds, sessionId, activeProjectPath, runsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attention (docs/widgets.md#attention): `attentionStep` holds every rule;
  // the effect only remembers `seen`, stores a cleared ack and asks the OS to
  // bounce the dock once per new key.
  const seenRef = React.useRef(new Map());
  const shown = React.useMemo(() => cards.map(c => {
    const step = _UW.attentionStep({
      key: c.run.widget?.attention, ack: tweaks?.[c.ackKey], seen: seenRef.current.get(c.ackKey), hasWidget: !!c.run.widget,
    });
    return { ...c, attention: step.active, step };
  }), [cards, tweaks]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    for (const c of shown) {
      seenRef.current.set(c.ackKey, c.step.seen);
      if (c.step.writeAck) setTweak?.(c.ackKey, null);
      if (c.step.bounce && _uwVisible() && !document.hasFocus()) _uwRequestAttention();
    }
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click on a card or its acknowledge button: store the key it shows as acknowledged.
  const shownRef = React.useRef(shown);
  shownRef.current = shown;
  const acknowledge = React.useCallback((pluginId) => {
    const c = shownRef.current.find(x => x.id === pluginId);
    const key = c?.run.widget?.attention;
    if (key) setTweak?.(c.ackKey, key);
  }, [setTweak]);

  // Approval is per plugin, not per tab: shown whatever the active project.
  const approvals = React.useMemo(() => config.plugins
    .filter(p => p.enabled && p.approval !== "approved" && !hiddenIds.includes(p.id))
    .map(p => ({ id: p.id, title: p.title, command: p.command, changed: p.approval === "changed" })),
  [config.plugins, hiddenIds]);

  const togglePlugins = React.useMemo(() => config.plugins.filter(p => p.enabled), [config.plugins]);

  const refresh = React.useCallback((pluginId) => bridge?.widgetsRefresh(pluginId), [bridge]);
  const reload = React.useCallback(async () => {
    if (bridge) applySnapshot(await bridge.widgetsReload());
  }, [bridge, applySnapshot]);
  // Approves the fingerprint the card was rendered for. A stale card (the
  // command or script changed meanwhile) re-reads the state so the card
  // shows what would now be approved, and rejects so the card re-enables.
  const configRef = React.useRef(config);
  configRef.current = config;
  const approve = React.useCallback(async (pluginId) => {
    if (!bridge) return;
    const fingerprint = configRef.current.plugins.find(p => p.id === pluginId)?.fingerprint;
    if (!fingerprint) return;
    const res = await bridge.widgetsApprove(pluginId, fingerprint);
    if (res.ok) { applySnapshot(res.value); return; }
    applySnapshot(await bridge.widgetsState());
    throw new Error(res.error);
  }, [bridge, applySnapshot]);

  return {
    cards: shown, approvals, configErrors: config.errors, fatal: config.fatal, configPath: config.configPath,
    togglePlugins, refresh, reload, approve, acknowledge,
  };
}

window.useWidgets = useWidgets;
