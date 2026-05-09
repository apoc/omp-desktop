/* ═════════════════════════════════════════════════════════════════════
   app-live.jsx — live-wired root. Replaces design/app.jsx.

   Session model: each tab owns one omp process. OMP_BRIDGE manages
   session lifecycle; the tab list and active session come from the
   bridge (snap.sessions / snap.activeSessionId). Switching tabs calls
   bridge.activateSession() which resets ALL per-session state and
   re-fetches from omp — so the right panel (sparkline, activity radar,
   minimap, kanban, context gauge) always reflects the active session.
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

const NULL_MODEL   = { id: "", name: "–", provider: "", note: "", latency: 0, current: false };
const EMPTY_PROJECT = { id: "", name: "OMP Desktop", path: "", color: "var(--accent)", branch: "" };
const NULL_PEER    = { project: "—", title: "no peer session", activity: "edit · idle", tps: 0, todo: { done: 0, total: 1 } };

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const data          = window.OMP_DATA;
  const bridge        = window.OMP_BRIDGE;

  // ── UI state ──────────────────────────────────────────────────────────────
  const [bridgeOpen, setBridgeOpen] = React.useState(false);
  const [bridgeView, setBridgeView] = React.useState("commands");
  const [planOpen,   setPlanOpen]   = React.useState(false);
  const [planMode,   setPlanMode]   = React.useState(false);
  const planStartedRef = React.useRef(false); // true after first send in plan mode
  const [planAnnotations, setPlanAnnotations] = React.useState({});
  const handleAnnotate = (idx, value) => setPlanAnnotations(prev => {
    const next = { ...prev };
    if (value === null) delete next[idx]; else next[idx] = value;
    return next;
  });

  // ── Live data (all per-session — driven by OMP_BRIDGE.onUpdate) ───────────
  const [messages,      setMessages]      = React.useState([]);
  const [streaming,     setStreaming]      = React.useState(false);
  const [model,         setModelState]    = React.useState(NULL_MODEL);
  const [thinkingLevel, setThinkingLevel] = React.useState("auto");
  const [ctx,           setCtx]           = React.useState(data.ctx);
  const [kanban,        setKanban]        = React.useState([]);
  const [planMeta,      setPlanMeta]      = React.useState(data.planMeta);
  const [models,        setModels]        = React.useState([]);
  const [activity,      setActivity]      = React.useState([]);
  const [sparkline,     setSparkline]     = React.useState(Array(30).fill(0));

  // ── Tab list — driven by bridge session registry ───────────────────────────
  // Each entry: { id, name, path, color, branch }
  const [sessions,        setSessions]       = React.useState([]);
  const [activeSessionId, setActiveSessionId] = React.useState("");


  // ── Subscribe to bridge ───────────────────────────────────────────────────
  React.useEffect(() => {
    if (!bridge) return;
    const unsub = bridge.onUpdate(snap => {
      // Per-session state — ALL reset when switching tabs, then re-populated
      setMessages(snap.messages);
      setStreaming(snap.isStreaming);
      setCtx(snap.ctx);
      setKanban(snap.kanban);
      setPlanMeta(snap.planMeta);
      setModels(snap.models);
      setActivity(snap.activity);
      setSparkline(snap.sparkline);
      if (snap.model)         setModelState(snap.model);
      else                    setModelState(NULL_MODEL);
      if (snap.thinkingLevel) setThinkingLevel(snap.thinkingLevel);

      // Tab list — updated whenever a session is opened / closed / renamed
      setSessions(snap.sessions ?? []);
      if (snap.activeSessionId) setActiveSessionId(snap.activeSessionId);

      // kanban updated — PlanKanban derives running/done internally
    });
    return unsub;
  }, [bridge]);

  // ── Theme / density ────────────────────────────────────────────────────────
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-aurora", "theme-phosphor", "theme-daylight");
    root.classList.add(`theme-${t.theme}`);
    root.classList.remove("density-cozy", "density-compact", "density-dense");
    root.classList.add(`density-${t.density}`);
    if (t.monoChat) root.classList.add("mono-chat");
    else            root.classList.remove("mono-chat");
    if (t.accent) root.style.setProperty("--accent", t.accent);
  }, [t.theme, t.density, t.accent, t.monoChat]);

  // ── ⌘K shortcut ──────────────────────────────────────────────────────────
  const openBridge = view => { setBridgeView(view); setBridgeOpen(true); };

  React.useEffect(() => {
    const onKey = e => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setBridgeOpen(v => { if (!v) setBridgeView("commands"); return !v; }); }
      if (e.key === "Escape") setBridgeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


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

  // ── Handlers ──────────────────────────────────────────────────────────────
  const intentFraming = intent =>
    `Please draft a plan for the following task. Write it in Markdown with clear sections: overview, approach, key steps, and risks. Do not start implementing yet — draft only for my review.\n\n---\n\n${intent.trim()}`;

  const APPROVAL_PROMPT = "Plan approved. Please proceed to execute it. Use your todo_write tool to track tasks as you go.";

  const handleSend = text => {
    const hasAnnotations = Object.keys(planAnnotations).length > 0;
    if (!text.trim() && !hasAnnotations) return;
    let msg = text.trim();
    if (planMode) {
      if (hasAnnotations) {
        // Feedback with block comments — always takes priority over intent framing
        const lineComments = Object.entries(planAnnotations)
          .sort(([a],[b]) => Number(a)-Number(b))
          .map(([,{raw,comment}]) => {
            const quoted = raw.split('\n').map(l => `> ${l}`).join('\n');
            return `${quoted}\n→ ${comment.trim()}`;
          }).join('\n\n');
        const parts = ['Line comments:\n' + lineComments, text.trim()].filter(Boolean);
        msg = parts.join('\n\n');
        setPlanAnnotations({});
        planStartedRef.current = true; // annotations imply plan is already in progress
      } else if (!planStartedRef.current) {
        // First clean send — wrap in intent framing
        planStartedRef.current = true;
        msg = intentFraming(text.trim());
      }
    }
    if (bridge?.isConnected) bridge.send(msg);
    else setMessages(prev => [...prev, { kind: "user", time: _timeNow(), text: msg }]);
  };

  const handleAbort = () => { bridge?.abort(); setStreaming(false); };

  const handlePickModel = m => { setModelState(m); bridge?.setModel(m); };

  const handleCommand = c => {
    if      (c.name === "plan")     { setPlanMode(true); planStartedRef.current = false; }
    else if (c.name === "todo")     { setPlanOpen(true); }
    else if (c.name === "compact")  { bridge?.compact(); }
    else if (c.name === "export")   { bridge?.exportHtml(); }
    else if (c.name === "thinking") { cycleThinking(); }
    else if (c.name === "model")    { bridge?.cycleModel(); }
  };

  const cycleThinking = () => {
    const next = thinkingLevel === "none" ? "auto" : thinkingLevel === "auto" ? "extended" : "none";
    setThinkingLevel(next);
    bridge?.setThinking(next);
  };

  const handleApprovePlan = () => {
    setPlanAnnotations({});
    bridge?.followUp(APPROVAL_PROMPT);
    setPlanMode(false);
    planStartedRef.current = false;
    setPlanOpen(true);
  };

  // Tab select — switches the active session; bridge resets all per-session state
  // and re-fetches from the new session's omp → notify() pushes fresh data
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
    await bridge.openSession(path);
    // Tab list and activeSessionId are updated via onUpdate from the bridge
  };

  // Close tab → kills that session's omp process; bridge updates tab list
  const handleCloseTab = id => {
    bridge?.closeSession(id);
  };

  const showRail  = t.layout !== "focus";
  const showSplit = t.layout === "split" && data.peer !== null;
  const safePeer  = data.peer ?? NULL_PEER;
  const liveCtx   = ctx ?? data.ctx;

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
            projects={sessions}
            activeId={activeSessionId}
            onSelect={handleSelectTab}
            peer={safePeer}
            onNew={handleNewProject}
            onClose={handleCloseTab}
          />

          <div className={`stage ${showRail ? "with-rail" : ""}`}>
            <main className="session">
              <ChatView messages={messages}
                planMode={planMode}
                annotations={planAnnotations}
                onAnnotate={handleAnnotate}
              />
              <Composer
                onSend={handleSend}
                planMode={planMode}
                onTogglePlan={() => {
                  const next = !planMode;
                  setPlanMode(next);
                  if (!next) planStartedRef.current = false;
                }}
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
              />
              <StatusBar
                ctx={liveCtx}
                model={model}
                thinking={thinkingLevel}
                todoDone={todoCounts.done}
                todoTotal={todoCounts.total}
                onTodo={() => setPlanOpen(true)}
                onModel={() => openBridge("models")}
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

function _timeNow() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
