/* chat/tool-card.jsx — Linear/Raycast-style card for one tool call,
   plus ScrubbableDiff (shown for `edit` tools with a parsed diff). */

const { Icon: _TC_Icon, TOOL_META: _TC_TOOL_META, EvalCell: _TC_EvalCell } = window;

function ScrubbableDiff({ msg }) {
  const total = msg.diff.length;
  const [pos, setPos]     = React.useState(total);
  const [hover, setHover] = React.useState(null);
  const trackRef          = React.useRef(null);

  // Auto-play: lines land in sequence on first mount
  React.useEffect(() => {
    let i = 0;
    setPos(0);
    const id = setInterval(() => {
      i += 1;
      setPos(i);
      if (i >= total) clearInterval(id);
    }, 70);
    return () => clearInterval(id);
  }, [total]);

  const visiblePos = hover != null ? hover : pos;

  const onScrub = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    setHover(Math.max(1, Math.round((x / r.width) * total)));
  };

  return (
    <div className="diff-wrap">
      <div className="diff-head mono">
        <span style={{ color: "var(--fg-3)" }}>{msg.target}</span>
        <span className="diff-counts">
          <span style={{ color: "var(--diff-add-fg)" }}>+{msg.adds}</span>
          <span style={{ color: "var(--diff-rm-fg)" }}>−{msg.rems}</span>
        </span>
      </div>
      <div className="diff-body mono">
        {msg.diff.slice(0, visiblePos).map((l, i) => (
          <div key={i} className={`diff-line k-${l.kind} fade-up`}>
            <span className="diff-gutter">{l.line}</span>
            <span className="diff-mark">{l.kind === "add" ? "+" : l.kind === "rem" ? "−" : " "}</span>
            <span className="diff-code">{l.text}</span>
          </div>
        ))}
        {visiblePos < total && Array.from({ length: total - visiblePos }, (_, i) => (
          <div key={`g-${i}`} className="diff-line ghost">
            <span className="diff-gutter">·</span><span className="diff-mark"> </span>
            <span className="diff-code">━━━━━━━━━━━━━━━━━━━━━━━━━━━━</span>
          </div>
        ))}
      </div>
      <div className="diff-track-wrap">
        <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>scrub</span>
        <div className="diff-track" ref={trackRef}
          onMouseMove={onScrub} onMouseLeave={() => setHover(null)}>
          <div className="diff-track-base" />
          {msg.diff.map((l, i) => (
            <div key={i}
              className={`diff-tick k-${l.kind}`}
              style={{ left: `${(i / total) * 100}%`, width: `${100 / total}%` }} />
          ))}
          <div className="diff-track-cursor"
            style={{ left: `${(visiblePos / total) * 100}%` }} />
        </div>
        <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
          {visiblePos}/{total}
        </span>
      </div>
    </div>
  );
}

// ── Subagent progress panel (task / quick_task) ─────────────────────
const _TA_CLR = {
  pending:   "var(--fg-5)",
  running:   "var(--accent)",
  completed: "var(--fg-3)",
  failed:    "var(--rose)",
  aborted:   "var(--amber)",
};

function TaskPanel({ subagents }) {
  const [open, setOpen] = React.useState(new Set());
  const toggle = i => setOpen(prev => {
    const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n;
  });
  return (
    <div className="task-panel">
      {subagents.map(sa => {
        const isOpen    = open.has(sa.index);
        const clr       = _TA_CLR[sa.status] ?? "var(--fg-4)";
        const isRunning = sa.status === "running";
        const bodyText  = sa.output || (sa.recentOutput ?? []).join("\n");
        const hasBody   = !!bodyText;
        // Header secondary: show live intent while running, error text on failure,
        // else truncated task description.
        const hint = isRunning ? sa.lastIntent
          : (sa.status === "failed" || sa.status === "aborted") ? (sa.error ?? sa.status)
          : sa.task;
        return (
          <div key={sa.index} className={`ta-row ta-${sa.status}`}>
            <button className="ta-hd" onClick={() => hasBody && toggle(sa.index)}
              style={{ cursor: hasBody ? "pointer" : "default" }}>
              <span className="dot" style={{
                background: clr, flexShrink: 0,
                ...(isRunning ? { animation: "pulseDot 1.4s ease-in-out infinite" } : {}),
              }} />
              <span className="ta-agent">{sa.agent}</span>
              {hint && <span className="ta-hint">· {hint}</span>}
              <div style={{ flex: 1 }} />
              {sa.toolCount > 0  && <span className="chip muted mono ta-chip">{sa.toolCount}×</span>}
              {sa.tokens    > 0  && <span className="chip muted mono ta-chip">{sa.tokens >= 1000 ? `${(sa.tokens/1000).toFixed(1)}k` : sa.tokens}t</span>}
              {sa.durationMs > 0 && <span className="chip muted mono ta-chip">{sa.durationMs >= 1000 ? `${(sa.durationMs/1000).toFixed(1)}s` : `${sa.durationMs}ms`}</span>}
              {hasBody && <_TC_Icon name={isOpen ? "chev" : "chevR"} size={10} color="var(--fg-4)" />}
            </button>
            {isOpen && bodyText && <pre className="ta-body selectable">{bodyText}</pre>}
          </div>
        );
      })}
    </div>
  );
}
// ── Live stream log for task / quick_task ───────────────────────────
function TaskStream({ subagents, running }) {
  const streamRef = React.useRef(null);
  const totalLines = (subagents ?? []).reduce((n, sa) => n + (sa._stream?.length ?? 0), 0);

  // Auto-scroll the stream div (not the chat) while the task is running.
  React.useEffect(() => {
    if (running && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [totalLines, running]);

  const hasAny = (subagents ?? []).some(sa => sa._stream?.length || sa.output);
  return (
    <div className="ta-stream selectable" ref={streamRef}>
      {!hasAny && <span className="ta-stream-empty">waiting for output…</span>}
      {(subagents ?? []).map(sa => {
        const lines = sa._stream?.length ? sa._stream
          : sa.output ? sa.output.split("\n") : [];
        if (!lines.length) return null;
        const clr = _TA_CLR[sa.status] ?? "var(--fg-4)";
        return (
          <div key={sa.index} className="ta-stream-block">
            <div className="ta-stream-hd">
              <span className="dot" style={{ background: clr, flexShrink: 0 }} />
              <span className="ta-agent">{sa.agent}</span>
              {sa.status === "running" && sa.lastIntent &&
                <span className="ta-hint">· {sa.lastIntent}</span>}
            </div>
            {lines.map((l, i) => (
              <div key={i} className="ta-stream-line">{l || "\u00a0"}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
}


function ToolCard({ msg, idx, highlighted }) {
  const meta    = _TC_TOOL_META[msg.tool] || { color: "var(--fg-3)", icon: "circle", label: msg.tool };
  const running = msg.status === "running";
  const isTask  = msg.tool === "task";
  const [streamOpen, setStreamOpen] = React.useState(false);
  return (
    <div className={`row tool fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: meta.color, color: meta.color }}>
          <_TC_Icon name={meta.icon} size={11} color={meta.color} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className={`tool-card ${running ? "running" : "ok"}`}>
        <div
          className={`tool-card-head${isTask ? " task-head" : ""}`}
          onClick={isTask ? () => setStreamOpen(o => !o) : undefined}
        >
          <span className="tool-tag" style={{ color: meta.color, background: `color-mix(in oklab, ${meta.color} 14%, transparent)`, borderColor: `color-mix(in oklab, ${meta.color} 30%, var(--line))` }}>
            {meta.label}
          </span>
          <span className="tool-title selectable">{msg.title}</span>
          <div className="tool-card-spacer" />
          {running ? (
            <span className="chip accent" style={{ animation: "pulseDot 1.4s infinite" }}>
              <span className="dot live" /> running
            </span>
          ) : (
            <span className="chip muted">
              <span className="mono">{msg.duration}ms</span>
            </span>
          )}
          <span className="chip muted mono">{msg.time}</span>
          {isTask && <_TC_Icon name={streamOpen ? "chev" : "chevR"} size={10} color="var(--fg-4)" style={{ marginLeft: 4 }} />}
        </div>

        {msg.tool === "search" && msg.preview && (
          <div className="tool-search">
            {msg.preview.map((p, i) => (
              <div key={i} className={`search-row ${p.hot ? "hot" : ""}`}>
                <_TC_Icon name="file" size={11} color={p.hot ? "var(--accent)" : "var(--fg-3)"} />
                <span className="mono" style={{ color: p.hot ? "var(--fg)" : "var(--fg-2)" }}>{p.file}</span>
                <span className="mono" style={{ color: "var(--fg-4)", marginLeft: "auto" }}>{p.hits} hits</span>
              </div>
            ))}
          </div>
        )}

        {msg.tool === "read" && (
          <div className="tool-foot mono">
            <span style={{ color: "var(--fg-3)" }}>↳</span>
            <span style={{ color: "var(--fg-2)" }}>{msg.target}</span>
            <span style={{ color: "var(--fg-4)" }}>· {msg.summary}</span>
          </div>
        )}

        {msg.tool === "edit" && msg.diff && <ScrubbableDiff msg={msg} />}
        {msg.tool === "edit" && !msg.diff && (
          <div className="tool-foot mono">
            <span style={{ color: "var(--fg-3)" }}>↳</span>
            <span style={{ color: "var(--fg-2)" }}>{msg.target}</span>
            <span style={{ color: "var(--diff-add-fg)", marginLeft: 8 }} className="mono">+{msg.adds || 0}</span>
            <span style={{ color: "var(--diff-rm-fg)", marginLeft: 4 }} className="mono">−{msg.rems || 0}</span>
            {running && <span className="shimmer-text" style={{ marginLeft: "auto" }}>writing patch…</span>}
          </div>
        )}

        {msg.tool === "bash" && msg.output && (
          <pre className="tool-bash mono selectable">
            {msg.output.map((l, i) => (
              <div key={i} style={{ color: `var(--${l.color})` }}>{l.line}</div>
            ))}
          </pre>
        )}

        {msg.tool === "eval" && msg.cells && (
          <div className="tool-eval">
            {msg.cells.map((cell, i) => <_TC_EvalCell key={i} cell={cell} />)}
          </div>
        )}
        {isTask && msg.subagents?.length > 0 && streamOpen && (
          <TaskStream subagents={msg.subagents} running={running} />
        )}
        {isTask && msg.subagents?.length > 0 && !streamOpen && (
          <TaskPanel subagents={msg.subagents} />
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ToolCard, ScrubbableDiff });
