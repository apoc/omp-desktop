/* ═════════════════════════════════════════════════════════════════════
   app-live.jsx — live-wired root. Replaces design/app.jsx.
   Changes from the prototype:
     - Demo streaming-finisher timeout REMOVED
     - Demo fake-reply handleSend REMOVED
     - OMP_BRIDGE.onUpdate() drives all React state
     - handleSend / handleAbort wired to OMP_BRIDGE
     - Model switching wired to OMP_BRIDGE.setModel()
     - kanban, planMeta, ctx, sparkline come from live data
     - peer session hidden when peer is null (not in single-agent RPC)
   Visual components (ChatView, Composer, AmbientRail, …) unchanged.
   ═════════════════════════════════════════════════════════════════════ */

const {
  Icon, ChatView, Composer, CommandBridge, WindowChrome, TabBar,
  StatusBar, AmbientRail, PlanKanban, useTweaks,
  TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor,
} = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "aurora",
  "density": "compact",
  "layout": "rail",
  "accent": "#8AF0C8",
  "monoChat": false,
  "scanlines": true,
  "showRadar": true
}/*EDITMODE-END*/;

// Placeholder model: StatusBar reads model.name without a null guard.
// Use "–" so the status bar slot shows something neutral, not "connecting…"
// alongside the hardcoded "connected" dot (which would look contradictory).
const NULL_MODEL = { id: "", name: "–", provider: "", note: "", latency: 0, current: false };

// Fallback project for WindowChrome when no session is open yet.
// Never shown as a tab — only used so WindowChrome never receives undefined.
const EMPTY_PROJECT = { id: "", name: "OMP Desktop", path: "", color: "var(--accent)", branch: "" };

// Placeholder peer for PeerSession — peer.activity must be a non-null string.
const NULL_PEER = {
  project: "—", title: "no peer session",
  activity: "edit · idle", tps: 0, todo: { done: 0, total: 1 },
};

function App() {
  const [t, setTweak]             = useTweaks(TWEAK_DEFAULTS);
  const data                       = window.OMP_DATA;
  const bridge                     = window.OMP_BRIDGE;

  // ── UI state ──────────────────────────────────────────────────────────────
  const [activeTabId, setActiveTabId] = React.useState("");
  const [bridgeOpen,  setBridgeOpen]  = React.useState(false);
  const [planOpen,    setPlanOpen]    = React.useState(false);
  const [planPhase,   setPlanPhase]   = React.useState("review");
  const [planMode,    setPlanMode]    = React.useState(false);

  // ── Live data state (driven by OMP_BRIDGE) ────────────────────────────────
  const [messages,      setMessages]      = React.useState(data.messages);
  const [streaming,     setStreaming]      = React.useState(false);
  const [model,         setModelState]    = React.useState(NULL_MODEL);
  const [thinkingLevel, setThinkingLevel] = React.useState("auto");
  const [ctx,           setCtx]           = React.useState(data.ctx);
  const [kanban,        setKanban]        = React.useState(data.kanban);
  const [planMeta,      setPlanMeta]      = React.useState(data.planMeta);
  const [models,        setModels]        = React.useState(data.models);
  const [activity,      setActivity]      = React.useState(data.activity);
  const [sparkline,     setSparkline]     = React.useState(Array(30).fill(0));
  const [projects,      setProjects]      = React.useState(data.projects);

  // ── Subscribe to live bridge updates ─────────────────────────────────────
  React.useEffect(() => {
    if (!bridge) return;
    const unsub = bridge.onUpdate(snap => {
      setMessages(snap.messages);
      setStreaming(snap.isStreaming);
      if (snap.model)         setModelState(snap.model);
      if (snap.thinkingLevel) setThinkingLevel(snap.thinkingLevel);
      setCtx(snap.ctx);
      setKanban(snap.kanban);
      setPlanMeta(snap.planMeta);
      setModels(snap.models);
      setActivity(snap.activity);
      setSparkline(snap.sparkline);
      setProjects(snap.projects);
      // Auto-select the first project tab when the agent sends initial state
      if (snap.firstProjectId) {
        setActiveTabId(id => id === "" ? snap.firstProjectId : id);
      }

      // Auto-open kanban when todo_write creates the first phase
      if (snap.kanban.length > 0 && planMode) {
        const phase = window.derivePlanPhase?.(
          snap.kanban.map(c => ({ tasks: c.tasks.map(t => ({ status:
            t.status === "done" ? "completed" : t.status })) }))
        ) ?? "review";
        setPlanPhase(phase);
      }
    });
    return unsub;
  }, [bridge]);

  // ── Theme / density sync to <html> ────────────────────────────────────────
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-aurora", "theme-phosphor", "theme-daylight");
    root.classList.add(`theme-${t.theme}`);
    root.classList.remove("density-cozy", "density-compact", "density-dense");
    root.classList.add(`density-${t.density}`);
    if (t.monoChat) root.classList.add("mono-chat");
    else root.classList.remove("mono-chat");
    if (t.accent) root.style.setProperty("--accent", t.accent);
  }, [t.theme, t.density, t.accent, t.monoChat]);

  // ── ⌘K global shortcut ───────────────────────────────────────────────────
  React.useEffect(() => {
    const onKey = e => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setBridgeOpen(v => !v); }
      if (e.key === "Escape") setBridgeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────
  const activeProject = projects.find(p => p.id === activeTabId) ?? projects[0] ?? EMPTY_PROJECT;
  const todoCounts = kanban.reduce(
    (acc, col) => {
      acc.total += col.tasks.length;
      acc.done  += col.tasks.filter(t => t.status === "done").length;
      return acc;
    },
    { total: 0, done: 0 }
  );

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSend = text => {
    if (!text.trim()) return;
    if (bridge?.isConnected) {
      bridge.send(text);
    } else {
      // Demo mode: show user message only, no fake reply
      setMessages(prev => [...prev, { kind: "user", time: _timeNow(), text }]);
    }
  };

  const handleAbort = () => {
    bridge?.abort();
    setStreaming(false);
  };

  const handlePickModel = m => {
    setModelState(m);
    bridge?.setModel(m);
  };

  const handleCommand = c => {
    if (c.name === "plan") {
      setPlanMode(true); setPlanPhase("review"); setPlanOpen(true);
    } else if (c.name === "todo") {
      setPlanOpen(true);
    } else if (c.name === "compact") {
      bridge?.compact();
    } else if (c.name === "export") {
      bridge?.exportHtml();
    } else if (c.name === "thinking") {
      cycleThinking();
    } else if (c.name === "model") {
      bridge?.cycleModel();
    }
  };

  const cycleThinking = () => {
    const next = thinkingLevel === "none" ? "auto" : thinkingLevel === "auto" ? "extended" : "none";
    setThinkingLevel(next);
    bridge?.setThinking(next);
  };

  const handleApprovePlan = () => {
    setPlanMode(false);
    // In oh-my-pi, approving means sending a follow-up; the agent typically
    // proceeds automatically after writing the plan, so this is a no-op here.
  };

  const handleNewProject = async () => {
    const path = await bridge?.openProject();
    if (!path) return;
    const name = path.replace(/\\/g, '/').split('/').pop() || path;
    const newProject = {
      id: `p${Date.now()}`,
      name,
      path,
      color: 'var(--lilac)',
      branch: 'main',
    };
    setProjects(prev => [...prev, newProject]);
    setActiveTabId(newProject.id);
  };

  const handleCloseTab = id => {
    // Kill the agent process owned by this tab before removing it.
    bridge?.stopAgent();
    setProjects(prev => {
      const next = prev.filter(p => p.id !== id);
      if (id === activeTabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id);
      }
      return next;
    });
  };

  const showRail  = t.layout !== "focus";
  const showSplit = t.layout === "split" && data.peer !== null;
  // Never pass null peer — PeerSession reads peer.activity unconditionally
  const safePeer  = data.peer ?? NULL_PEER;

  // Merge live ctx into OMP_DATA so StatusBar reads the live version
  const liveCtx = ctx ?? data.ctx;

  return (
    <>
      <div className="app-backdrop" />
      <div className="app">
        <div className={`window scanlines ${showSplit ? "is-split" : ""}`}>
          <WindowChrome
            project={activeProject}
            peer={safePeer}
            onCmd={() => setBridgeOpen(true)}
          />
          <TabBar
            projects={projects}
            activeId={activeTabId}
            onSelect={setActiveTabId}
            peer={safePeer}
            onNew={handleNewProject}
            onClose={handleCloseTab}
          />

          <div className={`stage ${showRail ? "with-rail" : ""}`}>
            <main className="session">
              <ChatView messages={messages} />
              <Composer
                onSend={handleSend}
                planMode={planMode}
                onTogglePlan={() => {
                  const next = !planMode;
                  setPlanMode(next);
                  if (next) { setPlanPhase("review"); setPlanOpen(true); }
                }}
                onOpenCmd={() => setBridgeOpen(true)}
                onOpenModel={() => setBridgeOpen(true)}
                currentModel={model}
                thinking={thinkingLevel}
                onCycleThinking={cycleThinking}
                isStreaming={streaming}
                onAbort={handleAbort}
                microcopy={data.microcopy}
              />
              <StatusBar
                ctx={liveCtx}
                model={model}
                thinking={thinkingLevel}
                todoDone={todoCounts.done}
                todoTotal={todoCounts.total}
                onTodo={() => setPlanOpen(true)}
                onModel={() => setBridgeOpen(true)}
              />
            </main>

            {/* Split peer pane — hidden when no peer (single-agent mode) */}
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
              />
            )}
          </div>
        </div>
      </div>

      <CommandBridge
        open={bridgeOpen}
        onClose={() => setBridgeOpen(false)}
        onPick={handleCommand}
        onPickModel={handlePickModel}
        currentModelId={model.id}
      />

      {planOpen && (
        <PlanKanban
          kanban={kanban}
          planMeta={planMeta}
          mode={planPhase}
          onMode={setPlanPhase}
          onApprove={handleApprovePlan}
          onClose={() => setPlanOpen(false)}
        />
      )}

      <TweaksPanel title="Tweaks" noDeckControls>
        <TweakSection label="Look">
          <TweakRadio
            label="theme"
            value={t.theme}
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
          <TweakRadio
            label="density"
            value={t.density}
            options={[
              { label: "cozy",    value: "cozy"    },
              { label: "compact", value: "compact" },
              { label: "dense",   value: "dense"   },
            ]}
            onChange={v => setTweak("density", v)}
          />
          <TweakColor
            label="accent"
            value={t.accent}
            options={["#8AF0C8", "#6EE7FF", "#FF7AC6", "#FFC56E", "#B59BFF", "#C4FF3F"]}
            onChange={v => setTweak("accent", v)}
          />
          <TweakToggle label="mono chat font" value={t.monoChat}
            onChange={v => setTweak("monoChat", v)} />
        </TweakSection>
        <TweakSection label="Layout">
          <TweakRadio
            label="layout"
            value={t.layout}
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

function _timeNow() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
