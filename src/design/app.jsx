/* ═════════════════════════════════════════════════════════════════════
   app.jsx — root App, tweak system, layout orchestration.
   ═════════════════════════════════════════════════════════════════════ */

const {
  Icon, ChatView, Composer, CommandBridge, WindowChrome, TabBar,
  StatusBar, AmbientRail, PlanKanban, useTweaks,
  TweaksPanel, TweakSection, TweakRadio, TweakSelect, TweakToggle, TweakColor,
} = window;

// EDITMODE block — tweak defaults
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "aurora",
  "density": "compact",
  "layout": "rail",
  "accent": "#8AF0C8",
  "monoChat": false,
  "scanlines": true,
  "showRadar": true
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const data = window.OMP_DATA;

  const [activeTabId, setActiveTabId] = React.useState("p1");
  const [bridgeOpen, setBridgeOpen] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  const [planPhase, setPlanPhase] = React.useState("review"); // review | running | done
  const [planMode, setPlanMode] = React.useState(false);
  const [thinkingLevel, setThinkingLevel] = React.useState("auto");
  const [model, setModel] = React.useState(data.models.find((m) => m.current));
  const [messages, setMessages] = React.useState(data.messages);
  const [streaming, setStreaming] = React.useState(true);

  // Apply theme + density to root
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("theme-aurora", "theme-phosphor", "theme-daylight");
    root.classList.add(`theme-${t.theme}`);
    root.classList.remove("density-cozy", "density-compact", "density-dense");
    root.classList.add(`density-${t.density}`);
    if (t.accent) root.style.setProperty("--accent", t.accent);
  }, [t.theme, t.density, t.accent]);

  // Stop the streaming finisher after ~5s for the demo
  React.useEffect(() => {
    const id = setTimeout(() => {
      setStreaming(false);
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.streaming ? { ...m, streaming: false, blocks: [
          { type: "text", text: "Cleaning up the now-redundant pending list and routing the finalize event straight to the active map. Keeping the public selector signature so existing callers don't notice — just less state, fewer races, no new API surface." },
        ] } : m
      ));
      setMessages((prev) => prev.map((m, i) =>
        m.kind === "tool" && m.status === "running" ? { ...m, status: "ok", duration: 134 } : m
      ));
    }, 5400);
    return () => clearTimeout(id);
  }, []);

  // ⌘K global
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); setBridgeOpen((v) => !v);
      }
      if (e.key === "Escape") setBridgeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const project = data.projects.find((p) => p.id === activeTabId);
  const todoCounts = data.kanban.reduce(
    (acc, c) => {
      acc.total += c.tasks.length;
      acc.done += c.tasks.filter((t) => t.status === "done").length;
      return acc;
    },
    { total: 0, done: 0 }
  );

  const handleSend = (text) => {
    setMessages((prev) => [...prev, { kind: "user", time: timeNow(), text }]);
    // fake reply
    setTimeout(() => {
      setStreaming(true);
      setMessages((prev) => [
        ...prev,
        {
          kind: "assistant", time: timeNow(), streaming: true,
          blocks: [{ type: "text", text: "On it. Tracing the call sites first" }],
        },
      ]);
    }, 250);
    setTimeout(() => {
      setStreaming(false);
      setMessages((prev) => prev.map((m, i) => i === prev.length - 1 && m.streaming
        ? { ...m, streaming: false, blocks: [{ type: "text", text: "On it. Tracing the call sites first — back in a tick with a diff to scrub through." }] }
        : m
      ));
    }, 2400);
  };

  const handleAbort = () => setStreaming(false);

  const handleCommand = (c) => {
    if (c.name === "plan") { setPlanMode(true); setPlanPhase("review"); setPlanOpen(true); }
    else if (c.name === "todo") setPlanOpen(true);
    else if (c.name === "model") {} // handled separately by bridge
    else if (c.name === "thinking") cycleThinking();
  };

  const cycleThinking = () => setThinkingLevel((x) =>
    x === "none" ? "auto" : x === "auto" ? "extended" : "none"
  );

  const showRail = t.layout !== "focus";
  const showSplit = t.layout === "split";

  return (
    <>
      <div className="app-backdrop" />
      <div className="app">
        <div className={`window scanlines ${showSplit ? "is-split" : ""}`}>
          <WindowChrome project={project} peer={data.peer}
            onCmd={() => setBridgeOpen(true)} />
          <TabBar projects={data.projects} activeId={activeTabId}
            onSelect={setActiveTabId} peer={data.peer} onNew={() => {}} />

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
                ctx={data.ctx}
                model={model}
                thinking={thinkingLevel}
                todoDone={todoCounts.done}
                todoTotal={todoCounts.total}
                onTodo={() => setPlanOpen(true)}
                onModel={() => setBridgeOpen(true)}
              />
            </main>

            {showSplit && (
              <SplitPeer peer={data.peer} />
            )}

            {showRail && (
              <AmbientRail
                ctx={data.ctx}
                activity={data.activity}
                peer={data.peer}
                messages={messages}
                microcopy={data.microcopy}
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
        onPickModel={(m) => setModel(m)}
      />

      {planOpen && (
        <PlanKanban
          kanban={data.kanban}
          planMeta={data.planMeta}
          mode={planPhase}
          onMode={setPlanPhase}
          onApprove={() => { setPlanMode(false); }}
          onClose={() => setPlanOpen(false)}
        />
      )}

      <TweaksPanel title="Tweaks" noDeckControls>
        <TweakSection label="Look">
          <TweakRadio
            label="theme"
            value={t.theme}
            options={[
              { label: "aurora",   value: "aurora" },
              { label: "phosphor", value: "phosphor" },
              { label: "daylight", value: "daylight" },
            ]}
            onChange={(v) => {
              setTweak({ theme: v, accent:
                v === "aurora"   ? "#8AF0C8" :
                v === "phosphor" ? "#C4FF3F" : "#1F8A5B"
              });
            }}
          />
          <TweakRadio
            label="density"
            value={t.density}
            options={[
              { label: "cozy", value: "cozy" },
              { label: "compact", value: "compact" },
              { label: "dense", value: "dense" },
            ]}
            onChange={(v) => setTweak("density", v)}
          />
          <TweakColor
            label="accent"
            value={t.accent}
            options={["#8AF0C8", "#6EE7FF", "#FF7AC6", "#FFC56E", "#B59BFF", "#C4FF3F"]}
            onChange={(v) => setTweak("accent", v)}
          />
          <TweakToggle label="mono chat font" value={t.monoChat}
            onChange={(v) => setTweak("monoChat", v)} />
        </TweakSection>
        <TweakSection label="Layout">
          <TweakRadio
            label="layout"
            value={t.layout}
            options={[
              { label: "rail", value: "rail" },
              { label: "split", value: "split" },
              { label: "focus", value: "focus" },
            ]}
            onChange={(v) => setTweak("layout", v)}
          />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

// ── Split peer pane: a second session, condensed ─────────────────────
function SplitPeer({ peer }) {
  return (
    <div className="split">
      <div className="split-head">
        <span className="dot live" style={{ background: "var(--cyan)" }} />
        <span className="mono" style={{ color: "var(--cyan)" }}>{peer.project}</span>
        <span style={{ color: "var(--fg-3)" }}>· {peer.title}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost"><Icon name="arrow" size={11} /> focus</button>
      </div>
      <div className="split-body">
        <div className="split-stream">
          <div className="split-row mono">
            <span className="chip" style={{ color: "var(--cyan)", borderColor: "color-mix(in oklab, var(--cyan) 30%, var(--line))" }}>read</span>
            <span style={{ color: "var(--fg-3)" }}>packages/tokens/source.ts</span>
            <span className="chip muted" style={{ marginLeft: "auto" }}>72ms</span>
          </div>
          <div className="split-row mono">
            <span className="chip" style={{ color: "var(--accent)", borderColor: "color-mix(in oklab, var(--accent) 30%, var(--line))" }}>edit</span>
            <span style={{ color: "var(--fg-3)" }}>packages/tokens/build.ts</span>
            <span className="chip muted mono" style={{ marginLeft: "auto" }}>+22 −4</span>
          </div>
          <div className="split-row mono">
            <span className="chip" style={{ color: "var(--accent)", borderColor: "color-mix(in oklab, var(--accent) 30%, var(--line))" }}>edit</span>
            <span style={{ color: "var(--fg-3)" }}>packages/tokens/css.ts</span>
            <span className="shimmer-text" style={{ marginLeft: "auto" }}>writing patch…</span>
          </div>
          <div className="split-row split-thought">
            <span className="mono" style={{ color: "var(--fg-4)" }}>// </span>
            <span style={{ color: "var(--fg-3)", fontStyle: "italic" }}>
              hoisting the design tokens into CSS variables so themes flip without a rebuild
            </span>
          </div>
        </div>
        <div className="split-foot mono">
          <span className="dot live" />
          <span style={{ color: "var(--fg-3)" }}>tokens-rebuilder</span>
          <span style={{ color: "var(--fg-4)" }}>· {peer.tps}t/s · todo {peer.todo.done}/{peer.todo.total}</span>
        </div>
      </div>
    </div>
  );
}

function timeNow() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join(":");
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
