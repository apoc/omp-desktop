/* ═════════════════════════════════════════════════════════════════════
   app-live.jsx — live-wired root. Replaces design/app.jsx.

   Session model: each tab owns one omp process. OMP_BRIDGE manages
   session lifecycle; the tab list and active session come from the
   bridge (snap.sessions / snap.activeSessionId). Switching tabs calls
   bridge.activateSession() which resets ALL per-session state and
   re-fetches from omp — so the right panel (sparkline, activity radar,
   minimap, kanban, context gauge) always reflects the active session.

   Constants and the cross-cutting effects (bridge subscription, theme)
   live in app/constants.js and app/use-bridge-snapshot.jsx respectively.
   Keyboard shortcuts are resolved by app/use-keymap.jsx (useKeymap loads
   the backend payload and resolves it; useKeymapDispatch installs the
   single window keydown listener) and handled by the handler map built
   below. This file owns only the App component itself: state
   declarations, handlers, and the render tree.
   ═════════════════════════════════════════════════════════════════════ */

const {
  Icon, ChatView, Composer, CommandBridge, WindowChrome, TabBar,
  StatusBar, AmbientRail, PlanKanban, HistoryModal, ChangesPanel, ApprovalRulesPanel, useTweaks,
  TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor, TweakSlider,
  TWEAK_DEFAULTS, NULL_MODEL, EMPTY_PROJECT, NULL_PEER, DEFAULT_PROFILE_ID,
  INTENT_FRAMING, APPROVAL_PROMPT,
  useBridgeSnapshot, useThemeEffect, timeNow,
  useKeymap, useKeymapDispatch, ShortcutsModal,
} = window;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const data          = window.OMP_DATA;
  const bridge        = window.OMP_BRIDGE;

  // ── UI state ──────────────────────────────────────────────────────────────
  const [bridgeOpen,  setBridgeOpen]  = React.useState(false);
  const [bridgeView,  setBridgeView]  = React.useState("commands");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [changesOpen, setChangesOpen] = React.useState(false);
  const [rulesOpen,   setRulesOpen]   = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [planOpen,    setPlanOpen]    = React.useState(false);
  const [planMode,    setPlanMode]    = React.useState(false);
  const planStartedRef = React.useRef(false); // true after first send in plan mode
  const [planAnnotations, setPlanAnnotations] = React.useState({});
  const handleAnnotate = React.useCallback((idx, value) => setPlanAnnotations(prev => {
    const next = { ...prev };
    if (value === null) delete next[idx]; else next[idx] = value;
    return next;
  }), []);

  // Cross-component highlight: hovering a minimap cell lights up the
  // matching chat bubble; clicking scrolls to it.
  const [hoveredMsgIdx, setHoveredMsgIdx] = React.useState(null);
  const handleMinimapClick = (idx) => {
    const el = document.querySelector(`[data-msg-idx="${idx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // ── Live data (all per-session — driven by OMP_BRIDGE.onUpdate) ───────────
  const [messages,      setMessages]      = React.useState([]);
  const [streaming,     setStreaming]     = React.useState(false);
  const [model,         setModelState]    = React.useState(NULL_MODEL);
  const [thinkingLevel, setThinkingLevel] = React.useState(null);
  const [ctx,           setCtx]           = React.useState(data.ctx);
  const [kanban,        setKanban]        = React.useState([]);
  const [planMeta,      setPlanMeta]      = React.useState(data.planMeta);
  const [models,        setModels]        = React.useState([]);
  const [activity,      setActivity]      = React.useState([]);
  const [sparkline,     setSparkline]     = React.useState(Array(30).fill(0));
  const [loginProviders, setLoginProviders] = React.useState(null);

  // ── Tab list — driven by bridge session registry ──────────────────────────
  // Each entry: { id, name, path, color, branch }
  const [sessions,        setSessions]        = React.useState([]);
  const [activeSessionId, setActiveSessionId] = React.useState("");

  // ── Profiles — every selectable omp profile ({id, name}) ─────────────────
  // The profile itself is per tab (see sessions[].profile); this is just the
  // catalogue the selector renders.
  const [profiles,        setProfiles]        = React.useState([]);
  // Which profile is ticked as the default for new tabs / the next launch.
  // App-wide and persisted, unlike a tab's own profile.
  const [startupProfileId, setStartupProfileId] = React.useState(DEFAULT_PROFILE_ID);

  // ── Cross-cutting effects ─────────────────────────────────────────────────
  useBridgeSnapshot(bridge, {
    setMessages, setStreaming, setCtx, setKanban, setPlanMeta,
    setModels, setActivity, setSparkline,
    setModelState, setThinkingLevel,
    setSessions, setActiveSessionId, setProfiles, setStartupProfileId,
  });
  useThemeEffect(t);

  // Fetch OAuth providers whenever the login view opens (ensures fresh auth status)
  React.useEffect(() => {
    if (!bridgeOpen || bridgeView !== "login") return;
    setLoginProviders(null);
    bridge?.getLoginProviders()
      .then(data => setLoginProviders(data?.providers ?? []))
      .catch(() => setLoginProviders([]));
  }, [bridgeOpen, bridgeView]);

  const openBridge = view => { setBridgeView(view); setBridgeOpen(true); };

  // ── Derived values ────────────────────────────────────────────────────────
  const activeProject = sessions.find(s => s.id === activeSessionId) ?? sessions[0] ?? EMPTY_PROJECT;
  const todoCounts    = kanban.reduce(
    (acc, col) => {
      acc.total += col.tasks.length;
      acc.done  += col.tasks.filter(tk => tk.status === "done").length;
      return acc;
    },
    { total: 0, done: 0 }
  );

  // ── Keymap ────────────────────────────────────────────────────────────────
  // Placed after activeProject so useKeymap can pass the active tab's profile.
  const keymap = useKeymap(bridge, activeProject?.profile);

  // Handler map read through a ref so the dispatch effect never re-subscribes.
  const handlersRef = React.useRef({});
  useKeymapDispatch(handlersRef);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSend = (text, images) => {
    const hasAnnotations = Object.keys(planAnnotations).length > 0;
    if (!text.trim() && !hasAnnotations && !(images && images.length > 0)) return;
    let msg = text.trim();
    if (planMode) {
      if (hasAnnotations) {
        // Feedback with block comments — always takes priority over intent framing
        const lineComments = Object.entries(planAnnotations)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, { raw, comment }]) => {
            const quoted = raw.split('\n').map(l => `> ${l}`).join('\n');
            return `${quoted}\n→ ${comment.trim()}`;
          }).join('\n\n');
        const parts = ['Line comments:\n' + lineComments, text.trim()].filter(Boolean);
        msg = parts.join('\n\n');
        setPlanAnnotations({});
        planStartedRef.current = true; // annotations imply plan is already in progress
      } else if (!planStartedRef.current) {
        // First clean send — wrap in intent framing. trimEnd() matters for an
        // image-only send (empty text): INTENT_FRAMING's template ends in a
        // literal "\n\n" that .trim() on the intent argument never touches,
        // and the server's message_start echo arrives already .trim()med
        // (live.js) — an untrimmed local echo would fail that dedup compare
        // and double-render the bubble.
        planStartedRef.current = true;
        msg = INTENT_FRAMING(text.trim()).trimEnd();
      }
    }
    if (streaming) {
      bridge?.steer(msg, images);
    } else if (bridge?.isConnected) {
      bridge.send(msg, images);
    } else {
      setMessages(prev => [...prev, { kind: "user", time: timeNow(), text: msg, images }]);
    }
  };

  const handleAbort      = () => { bridge?.abort(); setStreaming(false); };
  const handlePickModel  = m  => { setModelState(m); bridge?.setModel(m); };
  const handleAskAnswer  = React.useCallback((id, value) => { bridge?.answerAsk(id, value); }, [bridge]); // bridge = window.OMP_BRIDGE, assigned once before React renders — stable ref
  const handleConfirmAsk = React.useCallback((id, confirmed) => { bridge?.answerConfirm(id, confirmed); }, [bridge]);
  const handleCancelAsk  = React.useCallback((id) => { bridge?.cancelAsk(id); }, [bridge]);
  const handleGrantApproval = React.useCallback((tool, scope) => { bridge?.grantApprovalRule(tool, scope); }, [bridge]);
  const handlePickLogin = async (provider) => {
    if (!bridge) return;
    try {
      // OMP_BRIDGE.login resolves when OAuth completes (≤300 s).
      // live.js handles extension_ui_request.open_url via open_url_external (system browser).
      // For already-authenticated providers omp refreshes the token silently (no browser).
      // Use bridge.addAssistantMessage — writes into state.messages so the message
      // survives any subsequent notify() call (e.g. model registry refresh after login).
      await bridge.login(provider.id);
      bridge.addAssistantMessage(`Logged in to **${provider.name}**.`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      bridge.addAssistantMessage(`**Login failed (${provider.name}):** ${msg}`);
    }
  };
  const cycleThinking    = () => bridge?.cycleThinking();

  // Extracted so both the global keymap handler and the composer prop share
  // the same implementation (plan §7: "extract into a togglePlanMode callback").
  const togglePlanMode = () => {
    const next = !planMode;
    setPlanMode(next);
    if (!next) planStartedRef.current = false;
  };

  // Composer-scoped follow-up: the composer owns the draft text.
  const handleFollowUp = (text, images) => { bridge?.followUp(text, images); };

  const handleCommand = c => {
    if      (c.name === "plan")      { setPlanMode(true); planStartedRef.current = false; }
    else if (c.name === "todo")      { setPlanOpen(true); }
    else if (c.name === "compact")   { bridge?.compact(); }
    else if (c.name === "export")    { bridge?.exportHtml(); }
    else if (c.name === "thinking")  { cycleThinking(); }
    else if (c.name === "model")     { openBridge("models"); }
    else if (c.name === "login")     { openBridge("login"); }
    else if (c.name === "new")       { bridge?.newSession(); }
    else if (c.name === "history")   { setHistoryOpen(true); }
    else if (c.name === "shortcuts") { setShortcutsOpen(true); }
  };

  const handleResumeSession = async (session) => {
    if (!bridge || !session) return;
    try {
      await bridge.resumeSession(session);
    } catch (err) {
      // Same dangling-profile rejection as openSession (see handleNewProject
      // below) — the bridge already rolled back its ghost tab registration.
      console.error("[app] failed to resume session:", err);
    }
  };

  const handleApprovePlan = () => {
    setPlanAnnotations({});
    bridge?.followUp(APPROVAL_PROMPT);
    setPlanMode(false);
    planStartedRef.current = false;
    setPlanOpen(true);
  };

  // Tab select — switches the active session; bridge resets all per-session state
  // and re-fetches from the new session's omp → notify() pushes fresh data.
  const handleSelectTab = id => {
    if (id === activeSessionId) return;
    bridge?.activateSession(id);
    // setActiveSessionId is driven by snap.activeSessionId from onUpdate
  };

  // Open project → new session → new tab with its own omp process
  const handleNewProject = async () => {
    if (!bridge) return;
    const path = await bridge.pickFolder();
    if (!path) return;
    try {
      await bridge.openSession(path);
      // Tab list and activeSessionId are updated via onUpdate from the bridge
    } catch (err) {
      // openSession rejects when the inherited/ticked profile no longer
      // exists (deleted by another window, or a hand-edited profiles.json)
      // and the backend refuses to spawn under it — the bridge already
      // rolled back the ghost tab registration, so there's nothing left to
      // undo here; just keep the rejection from going unhandled.
      console.error("[app] failed to open project:", err);
    }
  };

  // Close tab → kills that session's omp process; bridge updates tab list
  const handleCloseTab = id => { bridge?.closeSession(id); };

  // ── Global keymap handler map ─────────────────────────────────────────────
  // Written into handlersRef every render so the dispatch hook always reads
  // the latest closures without re-subscribing to the window listener.
  // Placed after handleNewProject/handleCloseTab so every entry can be a
  // direct function reference (matching cycleThinking/togglePlanMode above)
  // instead of a `() => handleNewProject()` wrapper that only exists to
  // dodge a TDZ that a closure never actually hits.
  handlersRef.current = {
    "app.interrupt":           () => {
      // Only abort when no overlay is open (overlays handle Escape themselves).
      if (bridgeOpen || historyOpen || changesOpen || rulesOpen || planOpen || shortcutsOpen) return;
      if (streaming) handleAbort();
    },
    "app.thinking.cycle":      cycleThinking,
    "app.model.cycleForward":  () => bridge?.cycleModel(),
    "app.model.cycleBackward": () => {
      if (models.length < 2) return;
      const idx = models.findIndex(m => m.id === model.id && m.provider === model.provider);
      // No-op when the current model isn't in the list (plan §7).
      if (idx < 0) return;
      handlePickModel(models[(idx - 1 + models.length) % models.length]);
    },
    "app.model.select":        () => openBridge("models"),
    "app.plan.toggle":         togglePlanMode,
    "app.session.new":         () => bridge?.newSession(),
    "app.session.resume":      () => setHistoryOpen(v => !v),
    "desktop.commands.open":   () => { setBridgeView("commands"); setBridgeOpen(v => !v); },
    "desktop.history.open":    () => setHistoryOpen(v => !v),
    "desktop.shortcuts.open":  () => setShortcutsOpen(v => !v),
    "desktop.tab.new":         handleNewProject,
    "desktop.tab.close":       () => { if (activeProject.id) handleCloseTab(activeProject.id); },
    // Indexed on `activeProject.id`, not `activeSessionId` — same rationale
    // as `handleSelectProfile` below: `activeProject` falls back to
    // `sessions[0]` when the snapshot's `activeSessionId` is stale or empty,
    // so `findIndex` can never return -1 here while `sessions.length >= 2`.
    // Indexing on `activeSessionId` directly would reintroduce that -1.
    "desktop.tab.next":        () => {
      if (sessions.length < 2) return;
      const idx = sessions.findIndex(s => s.id === activeProject.id);
      bridge?.activateSession(sessions[(idx + 1) % sessions.length].id);
    },
    "desktop.tab.prev":        () => {
      if (sessions.length < 2) return;
      const idx = sessions.findIndex(s => s.id === activeProject.id);
      bridge?.activateSession(sessions[(idx - 1 + sessions.length) % sessions.length].id);
    },
    "desktop.panel.todo":      () => setPlanOpen(v => !v),
    "desktop.panel.changes":   () => setChangesOpen(v => !v),
    "desktop.panel.rules":     () => setRulesOpen(v => !v),
    "desktop.session.compact": () => bridge?.compact(),
    "desktop.session.export":  () => bridge?.exportHtml(),
  };

  // Profile switch applies to the active tab only: its omp process is
  // respawned under the new profile (a live process can't be moved to a
  // different auth/session tree), so the tab comes back as a fresh session.
  //
  // Dispatched on `activeProject.id` - the tab the menu is *rendering* - not
  // on `activeSessionId`. The two diverge because `use-bridge-snapshot`
  // only assigns `activeSessionId` when the snapshot's value is truthy, so a
  // `null` from the bridge leaves the closed id in React state; and right
  // after a tab click `activeSessionId` still names the previous tab, which
  // would respawn a different tab than the one shown (and on that
  // `wasActive === false` path a failure would surface no note at all).
  const handleSelectProfile = React.useCallback(id => {
    // EMPTY_PROJECT.id is "" when no tab is open — switchSessionProfile
    // would look it up in the session registry, find nothing, and resolve
    // {ok: false, error: "unknown tab"}, a reason that doesn't match what's
    // actually true (there's no tab, not a bad id). Short-circuit instead.
    if (!activeProject.id) return Promise.resolve({ ok: false, error: "no tab open" });
    return bridge?.switchSessionProfile(activeProject.id, id);
  }, [bridge, activeProject.id]);
  const handleCreateProfile = React.useCallback(name => bridge?.createProfile(name), [bridge]);
  const handleRenameProfile = React.useCallback((id, name) => bridge?.renameProfile(id, name), [bridge]);
  // Returns {ok, error}: the bridge refuses to delete a profile any open tab
  // still runs under, and the menu renders that reason inline.
  const handleDeleteProfile = React.useCallback(id => bridge?.deleteProfile(id), [bridge]);

  // Returns {ok, error}; the backend re-validates the id under its lock, so
  // the menu renders a refusal inline rather than assuming success.
  const handleSetStartupProfile = React.useCallback(id => bridge?.setStartupProfile(id), [bridge]);

  const showRail  = t.layout !== "focus";
  const showSplit = t.layout === "split" && data.peer !== null;
  const safePeer  = data.peer ?? NULL_PEER;
  const liveCtx   = ctx ?? data.ctx;

  return (
    <>
      <div className="app-backdrop" />
      <div className="app">
        <div className={`window scanlines ${showSplit ? "is-split" : ""}`}>
          {/* activeProfileId falls back to the ticked startup profile when no
              tab is open: `activeProject` is then EMPTY_PROJECT, whose
              `profile` is the built-in id, but the bridge spawns the next tab
              into the ticked one (nothing to inherit from) — so showing the
              built-in would tick a profile that is not where the next tab
              actually goes. */}
          <WindowChrome
            project={activeProject}
            peer={safePeer}
            onCmd={() => setBridgeOpen(true)}
            profiles={profiles}
            activeProfileId={activeProject.id ? activeProject.profile : startupProfileId}
            startupProfileId={startupProfileId}
            onSelectProfile={handleSelectProfile}
            onCreateProfile={handleCreateProfile}
            onRenameProfile={handleRenameProfile}
            onDeleteProfile={handleDeleteProfile}
            onSetStartupProfile={handleSetStartupProfile}
          />
          <TabBar
            profiles={profiles}
            projects={sessions}
            activeId={activeSessionId}
            onSelect={handleSelectTab}
            peer={safePeer}
            onNew={handleNewProject}
            onClose={handleCloseTab}
            onHistory={() => setHistoryOpen(true)}
          />

          <div className={`stage ${showRail ? "with-rail" : ""}`}>
            <main className="session">
              <ChatView messages={messages}
                planMode={planMode}
                annotations={planAnnotations}
                onAnnotate={handleAnnotate}
                onAskAnswer={handleAskAnswer}
                onConfirmAsk={handleConfirmAsk}
                onCancelAsk={handleCancelAsk}
                onGrantApproval={handleGrantApproval}
                hoveredMsgIdx={hoveredMsgIdx}
                hasProjectPath={!!activeProject?.path}
              />
              <Composer
                onSend={handleSend}
                planMode={planMode}
                onTogglePlan={togglePlanMode}
                onOpenCmd={() => openBridge("commands")}
                onOpenModel={() => openBridge("models")}
                currentModel={model}
                thinking={thinkingLevel}
                onCycleThinking={cycleThinking}
                isStreaming={streaming}
                onAbort={handleAbort}
                onApprove={handleApprovePlan}
                annotationCount={Object.keys(planAnnotations).length}
                microcopy={data.microcopy}
                onPick={handleCommand}
                onFollowUp={handleFollowUp}
              />
              <StatusBar
                ctx={liveCtx}
                model={model}
                thinking={thinkingLevel}
                todoDone={todoCounts.done}
                todoTotal={todoCounts.total}
                onTodo={() => setPlanOpen(true)}
                onModel={() => openBridge("models")}
                onChanges={() => setChangesOpen(true)}
                onRules={() => setRulesOpen(true)}
                onTweaks={() => window.postMessage({ type: '__activate_edit_mode' }, '*')}
                autosave={t.autosave ?? true}
                onAutosave={v => setTweak("autosave", v)}
              />
            </main>

            {showSplit && data.peer && <SplitPeer peer={data.peer} />}

            {showRail && (
              <AmbientRail
                ctx={liveCtx}
                activity={activity}
                peer={safePeer}
                messages={messages}
                microcopy={data.microcopy}
                sparklineValues={sparkline}
                onClose={() => setTweak("layout", "focus")}
                hoveredMsgIdx={hoveredMsgIdx}
                onMinimapHover={setHoveredMsgIdx}
                onMinimapClick={handleMinimapClick}
              />
            )}
          </div>
        </div>
      </div>

      <CommandBridge
        open={bridgeOpen}
        initialView={bridgeView}
        onClose={() => setBridgeOpen(false)}
        onPick={handleCommand}
        onPickModel={handlePickModel}
        onPickLogin={handlePickLogin}
        loginProviders={loginProviders}
        currentModelId={model.id}
      />

      {planOpen && (
        <PlanKanban
          kanban={kanban}
          planMeta={planMeta}
          onClose={() => setPlanOpen(false)}
          onAbort={handleAbort}
        />
      )}

      {historyOpen && (
        <HistoryModal
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onResume={handleResumeSession}
          activeCwd={activeProject?.path}
        />
      )}

      {changesOpen && (
        <ChangesPanel onClose={() => setChangesOpen(false)} />
      )}

      {rulesOpen && (
        <ApprovalRulesPanel onClose={() => setRulesOpen(false)} />
      )}

      {shortcutsOpen && (
        <ShortcutsModal
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          keymap={keymap}
        />
      )}

      <TweaksPanel title="Tweaks" noDeckControls>
        <TweakSection label="Look">
          <TweakRadio label="theme" value={t.theme}
            options={[
              { label: "aurora",   value: "aurora"   },
              { label: "phosphor", value: "phosphor" },
              { label: "daylight", value: "daylight" },
            ]}
            onChange={v => setTweak({ theme: v, accent:
              v === "aurora"   ? "#8AF0C8" :
              v === "phosphor" ? "#C4FF3F" : "#1F8A5B"
            })}
          />
          <TweakRadio label="density" value={t.density}
            options={[
              { label: "cozy",    value: "cozy"    },
              { label: "compact", value: "compact" },
              { label: "dense",   value: "dense"   },
            ]}
            onChange={v => setTweak("density", v)}
          />
          <TweakColor label="accent" value={t.accent}
            options={["#8AF0C8", "#6EE7FF", "#FF7AC6", "#FFC56E", "#B59BFF", "#C4FF3F"]}
            onChange={v => setTweak("accent", v)}
          />
          <TweakToggle label="mono chat font" value={t.monoChat}
            onChange={v => setTweak("monoChat", v)} />
          <TweakSlider label="font size" value={t.fontSize ?? 100}
            min={75} max={150} step={5} unit="%"
            onChange={v => setTweak("fontSize", v)} />
        </TweakSection>
        <TweakSection label="Layout">
          <TweakRadio label="layout" value={t.layout}
            options={[
              { label: "rail",  value: "rail"  },
              { label: "split", value: "split" },
              { label: "focus", value: "focus" },
            ]}
            onChange={v => setTweak("layout", v)}
          />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}


ReactDOM.createRoot(document.getElementById("root")).render(<App />);
