/* ═════════════════════════════════════════════════════════════════════
   chrome.jsx — window chrome, tabs, status bar, ambient peripherals
   - WindowChrome (traffic lights, title)
   - TabBar
   - StatusBar
   - Ambient rail: TokenGauge, ActivityRadar, subagents card, Minimap
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TokenGauge, ActivityRadar, Sparkline, TOOL_META, ProfileMenu, DEFAULT_PROFILE_ID, SubagentRailCard } = window;

// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` — same
// guard and rationale as composer.jsx's copy (kept local rather than a
// third file to import from; see composer.jsx's doc comment for why the
// registry-not-loaded fallback can't move into keymap.js itself).
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}

// ── Platform detection ────────────────────────────────────────────────
const IS_WIN = typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win"));

// ── Window chrome ─────────────────────────────────────────────────────
function WindowChrome({
  project, onCmd,
  profiles, activeProfileId, startupProfileId,
  onSelectProfile, onCreateProfile, onRenameProfile, onDeleteProfile, onSetStartupProfile,
}) {
  return (
    <div className="chrome" data-tauri-drag-region>
      {/* macOS traffic lights — left side, hidden on Windows */}
      {!IS_WIN && (
        <div className="chrome-lights">
          <span className="light red" />
          <span className="light amber" />
          <span className="light green" />
        </div>
      )}

      <div className="chrome-title">
        <span className="mono" style={{ color: "var(--fg-3)" }}>OMP</span>
        <span className="mono" style={{ color: "var(--fg-5)" }}>·</span>
        <span style={{ color: "var(--fg-2)" }}>{project.name}</span>
        {project.branch && (
          <span className="chip muted" style={{ marginLeft: 6 }}>
            <Icon name="branch" size={9} color="var(--fg-3)" />
            <span className="mono" style={{ color: "var(--fg-3)" }}>{project.branch}</span>
          </span>
        )}
      </div>

      {/* Per-tab omp profile — the selector acts on the active tab only. */}
      <ProfileMenu
        profiles={profiles}
        activeId={activeProfileId}
        startupId={startupProfileId}
        onSelect={onSelectProfile}
        onCreate={onCreateProfile}
        onRename={onRenameProfile}
        onDelete={onDeleteProfile}
        onSetStartup={onSetStartupProfile}
      />

      <div className="chrome-right">
        <button className="btn ghost outlined" onClick={onCmd}>
          <Icon name="command" size={11} /> bridge{" "}
          <span className="kbd">{hintFor("desktop.commands.open", IS_WIN ? "^K" : "⌘K")}</span>
        </button>

        {/* Windows controls — right side, hidden on macOS/Linux */}
        {IS_WIN && (
          <div className="win-controls">
            <button className="win-ctrl win-min"   title="Minimize">&#8211;</button>
            <button className="win-ctrl win-max"   title="Maximize / Restore">&#9633;</button>
            <button className="win-ctrl win-close" title="Close">&#10005;</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Project tabs ─────────────────────────────────────────────────────
function TabBar({ projects, activeId, onSelect, onClose, onNew, onHistory, profiles = [], appVersion, updateVersion, onUpdate, onCheckUpdate }) {
  // Tabs can run under different profiles, so a tab whose profile is not the
  // built-in one is labelled with it — otherwise two tabs on the same folder
  // in different profiles look identical. Falls back to the raw id until the
  // profile list has loaded.
  const profileLabel = id =>
    id === DEFAULT_PROFILE_ID ? null : (profiles.find(p => p.id === id)?.name ?? id);
  return (
    <div className="tabs">
      {projects.map((p) => {
        const active = p.id === activeId;
        const profile = profileLabel(p.profile);
        return (
          <div key={p.id}
            className={`tab ${active ? "active" : ""}`}
            // Middle-click closes, as in browsers (#24). WebKit before
            // Safari 18.2 / WebKitGTK 2.46 has no `auxclick` and reports it as
            // a `click` with button 1, hence the check here too; newer engines
            // never send `click` for button 1, so this can't double-fire.
            // Swallowing the middle-button mousedown stops Windows autoscroll
            // and Linux primary-selection paste from firing on the tab.
            onClick={e => (e.button === 1 ? onClose?.(p.id) : onSelect(p.id))}
            onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose?.(p.id); } }}>
            <span className="tab-bar-mark" style={{ background: active ? p.color : "transparent" }} />
            <Icon name="folder" size={11} color={active ? p.color : "var(--fg-4)"} />
            {p.runState && p.runState !== "idle" && (
              <span
                className={`tab-run-dot ${p.runState}`}
                title={
                  p.runState === "waiting-user" ? "waiting for you"
                    : p.runState === "failed"    ? "agent process exited"
                    : "running"
                }
              />
            )}
            <span className="tab-name" title={p.name}>{p.name}</span>
            {profile && (
              <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
            )}
            <button className="tab-close" onClick={e => { e.stopPropagation(); onClose?.(p.id); }}><Icon name="close" size={9} /></button>
          </div>
        );
      })}
      <button className="tab-add" title="open project" onClick={onNew}>
        <Icon name="plus" size={11} />
      </button>
      <button className="tab-add" title={`conversation history (${hintFor("desktop.history.open", "Ctrl+H")})`} onClick={onHistory}>
        <Icon name="clock" size={11} />
      </button>
      <div style={{ flex: 1 }} />
      <div className="tabs-right mono">
        {updateVersion && (
          <button className="btn outlined update-pill" onClick={onUpdate} title={`OMP Desktop v${updateVersion} is available`}>
            <Icon name="arrowUp" size={9} />v{updateVersion}
          </button>
        )}
        <button className="btn ghost app-version" onClick={onCheckUpdate} title="check for updates">
          {appVersion ? `v${appVersion}` : "—"}
        </button>
      </div>
    </div>
  );
}

// ── Status bar (footer): connection, model, tokens, todos, extension ─
function StatusBar({ ctx, model, thinking, todoDone, todoTotal, onTodo, onModel, onTweaks, onChanges, onRules, onStats, autosave, onAutosave }) {
  const thinkLabel = { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "max" }[thinking] ?? "—";
  return (
    <div className="status">
      <span className="status-cell"><span className="dot live" /> connected</span>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onModel} style={{ height: 20, padding: "0 6px" }}>
        <span style={{ color: "var(--accent)" }}>{model.name}</span>
        <Icon name="chev" size={9} color="var(--fg-4)" />
      </button>
      <span className="status-sep">·</span>
      <span className="status-cell"><Icon name="thinking" size={10} color="var(--lilac)" /> {thinkLabel}</span>
      <span className="status-sep">·</span>
      <span className="status-cell mono">
        <span style={{ color: "var(--fg-3)" }}>{ctx.label}</span>
        <span className="status-bar-tube">
          <span className="status-bar-fill" style={{ width: `${ctx.pct}%` }} />
        </span>
        <span style={{ color: "var(--fg-4)" }}>{(+ctx.pct).toFixed(1)}%</span>
      </span>
      <span className="status-sep">·</span>
      <span className="status-cell mono"><span style={{ color: "var(--fg-3)" }}>cost</span> {ctx.cost}</span>
      <span className="status-sep">·</span>
      <span className="status-cell mono"><span style={{ color: "var(--fg-3)" }}>{ctx.tokensPerSec}</span> t/s</span>
      <div style={{ flex: 1 }} />
      <button className="status-cell btn ghost" onClick={onTodo} style={{ height: 20, padding: "0 6px" }}>
        <Icon name="plan" size={11} color="var(--accent)" />
        <span style={{ color: "var(--accent)" }}>todo {todoDone}/{todoTotal}</span>
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={() => onAutosave?.(!autosave)}
        style={{ height: 20, padding: "0 6px" }} title="toggle autosave">
        <span className="mono" style={{ color: autosave ? "var(--fg-3)" : "var(--fg-5)" }}>
          autosave {autosave ? "on" : "off"}
        </span>
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onChanges} title="changes (git status/diff)" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="diff2" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onRules} title="approval rules" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="check" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onStats} title="usage statistics" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="cost" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onTweaks} title="tweaks" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="cog" size={11} color="var(--fg-3)" />
      </button>
    </div>
  );
}

// ── Minimap of the session: dense grid, one cell per message ─────────
// Hue encodes role/tool color (same palette as the chat). For assistant
// messages, opacity is log-scaled by tokens used so expensive turns pop
// against cheap ones. Click scrolls the chat to that message; hover
// highlights it via shared hoveredIdx state.
function SessionMinimap({ messages, hoveredIdx, onHover, onClick }) {
  // Log-scaled max across assistant messages so heatmap variance is
  // visible even when one compaction turn dwarfs the rest.
  const maxTokens = React.useMemo(() => {
    let max = 0;
    for (const m of messages) {
      if (m.kind === "assistant" && m.tokens && m.tokens > max) max = m.tokens;
    }
    return max;
  }, [messages]);
  const logMax = Math.log10(maxTokens + 1) || 1;

  return (
    <div className="minimap">
      <div className="minimap-head">
        <Icon name="minimap" size={11} color="var(--fg-3)" />
        <span className="mono" style={{ color: "var(--fg-3)" }}>session</span>
        <span className="mono" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>{messages.length}</span>
      </div>
      <div className="minimap-grid">
        {messages.map((m, i) => {
          let hue = "var(--fg-5)";
          if      (m.kind === "user")      hue = "var(--fg-3)";
          else if (m.kind === "assistant") hue = "var(--accent)";
          else if (m.kind === "ask")       hue = "var(--amber)";
          else if (m.kind === "tool")      hue = TOOL_META[m.tool]?.color || "var(--fg-4)";

          // Brightness: assistant cells modulate by log(tokens), others flat.
          let opacity = 0.7;
          if (m.kind === "assistant" && m.tokens && maxTokens > 0) {
            const t = Math.log10(m.tokens + 1) / logMax;
            opacity = 0.4 + 0.6 * Math.max(0, Math.min(1, t));
          }

          // Per-kind tooltip — tools don't carry their own tokens (the
          // LLM cost lives on the assistant message that invoked them),
          // so they get tool-specific info instead of a token chip.
          let title;
          if (m.kind === "assistant") {
            const tok  = m.tokens ? `${m.tokens.toLocaleString()} tok` : "—";
            const inOut = (m.tokensIn != null || m.tokensOut != null)
              ? ` (${(m.tokensIn ?? 0).toLocaleString()} in · ${(m.tokensOut ?? 0).toLocaleString()} out)`
              : "";
            title = `assistant · ${tok}${inOut}${m.time ? " · " + m.time : ""}`;
          } else if (m.kind === "tool") {
            const dur = m.duration ? ` · ${(m.duration / 1000).toFixed(1)}s` : "";
            const status = m.status === "running" ? " · running" : (m.status === "ok" ? "" : ` · ${m.status}`);
            title = `${m.tool ?? "tool"}${m.title ? " " + m.title : ""}${dur}${status}`;
          } else if (m.kind === "user") {
            const preview = m.text ? ` · ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}` : "";
            title = `you${preview}`;
          } else {
            title = m.kind;
          }
          const cls = `minimap-cell ${m.kind} ${m.streaming ? "live" : ""} ${hoveredIdx === i ? "hot" : ""}`.trim();

          return (
            <div key={m._id ?? i}
              className={cls}
              style={{ background: hue, opacity }}
              title={title}
              onMouseEnter={() => onHover?.(i)}
              onMouseLeave={() => onHover?.(null)}
              onClick={() => onClick?.(i)} />
          );
        })}
      </div>
      <div className="minimap-legend">
        <span className="minimap-legend-item"><i style={{ background: "var(--fg-3)" }} />you</span>
        <span className="minimap-legend-item"><i style={{ background: "var(--accent)" }} />assistant</span>
        <span className="minimap-legend-item"><i style={{ background: "var(--amber)" }} />ask</span>
        <span className="minimap-legend-item"><i style={{ background: "var(--fg-4)" }} />tool</span>
      </div>
    </div>
  );
}

// ── Right rail: ambient peripherals stacked ──────────────────────────
function AmbientRail({
  ctx, activity, messages, microcopy, onClose, sparklineValues, hoveredMsgIdx, onMinimapHover, onMinimapClick,
  subagents, subagentPaneOpen, onOpenSubagent, onToggleSubagentPane,
}) {
  // Use live tps samples. Before the first turn, sparklineValues is all zeros
  // which renders as a flat baseline — honest, not fake random data.
  const sparkVals = (sparklineValues && sparklineValues.length > 0)
    ? sparklineValues
    : Array(30).fill(0);
  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="mono" style={{ color: "var(--fg-3)" }}>ambient</span>
        <button className="btn icon ghost" onClick={onClose} title="hide rail">
          <Icon name="close" size={10} />
        </button>
      </div>

      <div className="rail-card glass">
        <TokenGauge used={ctx.used} total={ctx.total} pct={ctx.pct}
          label={ctx.label} sub={`cost ${ctx.cost} · ${ctx.tokensPerSec} t/s`} />
        <div className="rail-spark">
          <Sparkline values={sparkVals} width={210} height={28} />
          <div className="rail-spark-foot mono">
            <span style={{ color: "var(--fg-4)" }}>throughput</span>
            <span style={{ color: "var(--accent)" }}>{ctx.tokensPerSec} t/s</span>
          </div>
        </div>
      </div>

      <div className="rail-card glass">
        <div className="rail-card-head">
          <Icon name="radar" size={11} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>agent radar</span>
          <span className="chip muted mono" style={{ marginLeft: "auto" }}>last 60s</span>
        </div>
        <ActivityRadar activity={activity} tps={ctx.tokensPerSec} />
        <div className="legend">
          {Object.entries(TOOL_META).filter(([k]) => ["read","search","edit","bash"].includes(k)).map(([k, m]) => (
            <span key={k} className="legend-item">
              <span style={{ background: m.color }} /> {m.label}
            </span>
          ))}
        </div>
      </div>

      <SubagentRailCard agents={subagents} paneOpen={subagentPaneOpen}
        onOpen={onOpenSubagent} onTogglePane={onToggleSubagentPane} />

      <div className="rail-card glass" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 120 }}>
        <div className="rail-card-head">
          <Icon name="minimap" size={11} color="var(--fg-3)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>minimap</span>
        </div>
        <SessionMinimap messages={messages} hoveredIdx={hoveredMsgIdx} onHover={onMinimapHover} onClick={onMinimapClick} />
      </div>
    </aside>
  );
}

Object.assign(window, { WindowChrome, TabBar, StatusBar, AmbientRail, SessionMinimap });
