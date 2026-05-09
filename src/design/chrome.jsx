/* ═════════════════════════════════════════════════════════════════════
   chrome.jsx — window chrome, tabs, status bar, ambient peripherals
   - WindowChrome (traffic lights, title)
   - TabBar
   - StatusBar
   - Ambient rail: TokenGauge, ActivityRadar, Minimap, Peer session
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TokenGauge, ActivityRadar, Sparkline, TOOL_META } = window;

// ── Platform detection ────────────────────────────────────────────────
const IS_WIN = typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win"));

// ── Window chrome ─────────────────────────────────────────────────────
function WindowChrome({ project, peer, onCmd }) {
  return (
    <div className="chrome">
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

      <div className="chrome-right">
        <button className="btn ghost outlined" onClick={onCmd}>
          <Icon name="command" size={11} /> bridge{" "}
          <span className="kbd">{IS_WIN ? "^K" : "⌘K"}</span>
        </button>

        {/* Windows controls — right side, hidden on macOS/Linux */}
        {IS_WIN && (
          <div className="win-controls">
            <button className="win-ctrl win-min" title="Minimize">&#8211;</button>
            <button className="win-ctrl win-max" title="Maximize / Restore">&#9633;</button>
            <button className="win-ctrl win-close" title="Close">&#10005;</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Project tabs ─────────────────────────────────────────────────────
function TabBar({ projects, activeId, onSelect, onClose, peer, onNew }) {
  return (
    <div className="tabs">
      {projects.map((p) => {
        const active = p.id === activeId;
        return (
          <div key={p.id}
            className={`tab ${active ? "active" : ""}`}
            onClick={() => onSelect(p.id)}>
            <span className="tab-bar-mark" style={{ background: active ? p.color : "transparent" }} />
            <Icon name="folder" size={11} color={active ? p.color : "var(--fg-4)"} />
            <span className="tab-name">{p.name}</span>
            {p.id === peer?.projectId && (
              <span className="chip accent" style={{ padding: "1px 6px" }}>split</span>
            )}
            <button className="tab-close" onClick={e => { e.stopPropagation(); onClose?.(p.id); }}><Icon name="close" size={9} /></button>
          </div>
        );
      })}
      <button className="tab-add" title="open project" onClick={onNew}>
        <Icon name="plus" size={11} />
      </button>
      <div style={{ flex: 1 }} />
      <div className="tabs-right mono">
        <span style={{ color: "var(--fg-4)" }}>v0.4.7-aurora</span>
      </div>
    </div>
  );
}

// ── Status bar (footer): connection, model, tokens, todos, extension ─
function StatusBar({ ctx, model, thinking, todoDone, todoTotal, onTodo, onModel }) {
  return (
    <div className="status">
      <span className="status-cell"><span className="dot live" /> connected</span>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onModel} style={{ height: 20, padding: "0 6px" }}>
        <span style={{ color: "var(--accent)" }}>{model.name}</span>
        <Icon name="chev" size={9} color="var(--fg-4)" />
      </button>
      <span className="status-sep">·</span>
      <span className="status-cell"><Icon name="thinking" size={10} color="var(--lilac)" /> {thinking}</span>
      <span className="status-sep">·</span>
      <span className="status-cell mono">
        <span style={{ color: "var(--fg-3)" }}>{ctx.label}</span>
        <span className="status-bar-tube">
          <span className="status-bar-fill" style={{ width: `${ctx.pct}%` }} />
        </span>
        <span style={{ color: "var(--fg-4)" }}>{ctx.pct}%</span>
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
      <span className="status-cell mono" style={{ color: "var(--fg-4)" }}>autosave on · 2s ago</span>
    </div>
  );
}

// ── Minimap of the session: little colored rectangles, one per msg ───
function SessionMinimap({ messages }) {
  return (
    <div className="minimap">
      <div className="minimap-head">
        <Icon name="minimap" size={11} color="var(--fg-3)" />
        <span className="mono" style={{ color: "var(--fg-3)" }}>session</span>
        <span className="mono" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>{messages.length}</span>
      </div>
      <div className="minimap-body">
        {messages.map((m, i) => {
          let color = "var(--fg-5)";
          let height = 8;
          if (m.kind === "user") { color = "var(--fg-3)"; height = 14; }
          else if (m.kind === "assistant") { color = "var(--accent)"; height = 12; }
          else if (m.kind === "tool") {
            color = TOOL_META[m.tool]?.color || "var(--fg-4)";
            height = m.tool === "edit" ? 18 : 10;
          }
          return (
            <div key={i}
              className={`minimap-row ${m.streaming ? "live" : ""}`}
              style={{ background: color, height, opacity: m.streaming ? 1 : 0.85 }}
              title={m.title || m.kind} />
          );
        })}
      </div>
    </div>
  );
}

// ── Peer session widget — shows the OTHER agent, when split is on ────
function PeerSession({ peer }) {
  const meta = TOOL_META[peer.activity?.split(" · ")[0]] || TOOL_META.edit;
  return (
    <div className="peer">
      <div className="peer-head">
        <span className="dot live" style={{ background: "var(--cyan)", boxShadow: "0 0 0 0 var(--cyan)" }} />
        <span className="mono" style={{ color: "var(--cyan)" }}>{peer.project}</span>
        <span className="mono" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>{peer.tps}t/s</span>
      </div>
      <div className="peer-title selectable">{peer.title}</div>
      <div className="peer-row">
        <span className="chip accent" style={{ borderColor: `color-mix(in oklab, ${meta.color} 40%, var(--line))`, color: meta.color, background: `color-mix(in oklab, ${meta.color} 12%, transparent)` }}>
          <Icon name={meta.icon} size={9} color={meta.color} />
          {peer.activity}
        </span>
      </div>
      <div className="peer-row mono" style={{ color: "var(--fg-3)" }}>
        todo {peer.todo.done}/{peer.todo.total}
        <span className="status-bar-tube" style={{ marginLeft: 6, flex: 1 }}>
          <span className="status-bar-fill" style={{ width: `${(peer.todo.done / peer.todo.total) * 100}%`, background: "var(--cyan)" }} />
        </span>
        <button className="btn ghost" style={{ marginLeft: 6, height: 18, padding: "0 6px", fontSize: "var(--d-text-xs)" }}>focus →</button>
      </div>
    </div>
  );
}

// ── Right rail: ambient peripherals stacked ──────────────────────────
function AmbientRail({ ctx, activity, peer, messages, microcopy, onClose, sparklineValues }) {
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

      <div className="rail-card glass">
        <div className="rail-card-head">
          <Icon name="split" size={11} color="var(--cyan)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>peer session</span>
          <span className="chip" style={{ marginLeft: "auto", color: "var(--cyan)", borderColor: "color-mix(in oklab, var(--cyan) 30%, var(--line))" }}>split</span>
        </div>
        <PeerSession peer={peer} />
      </div>

      <div className="rail-card glass" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 120 }}>
        <div className="rail-card-head">
          <Icon name="minimap" size={11} color="var(--fg-3)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>minimap</span>
        </div>
        <SessionMinimap messages={messages} />
      </div>
    </aside>
  );
}

Object.assign(window, { WindowChrome, TabBar, StatusBar, AmbientRail, SessionMinimap, PeerSession });
