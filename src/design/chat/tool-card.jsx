/* chat/tool-card.jsx — Linear/Raycast-style card for one tool call,
   plus ScrubbableDiff (shown for `edit` tools with a parsed diff). */

const { Icon: _TC_Icon, TOOL_META: _TC_TOOL_META, EvalCell: _TC_EvalCell, CopyButton: _TC_Copy, CopyHost: _TC_CopyHost, CollapseToggle: _TC_Collapse, ImageThumbs: _TC_Thumbs } = window;
const { bashPreview: _TC_bashPreview } = window.OMP_COLLAPSE;
const { readTarget: _TC_readTarget, inProject: _TC_inProject } = window.OMP_FILE_PREVIEW;
const { formatBytes: _TC_size } = window.OMP_UPDATER;

// One open-in-git-browser button per file an edit (or a write) touched; a card whose
// paths are not known yet (a running edit in a mode the start frame does
// not name files for) shows none.
function DiffPaths({ msg, onOpenFile }) {
  const paths = msg.targets.filter(Boolean);
  return (
    <span className="diff-paths">
      {paths.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && ", "}
          <button type="button" className="diff-path" onClick={() => onOpenFile?.(p)} title="open in the git browser">{p}</button>
        </React.Fragment>
      ))}
    </span>
  );
}

// A read card's target and summary, the path opening the file preview
// (issue #39) when it is a project file; plus the images omp returned for
// it, opening the image viewer.
function _TC_ReadBody({ msg, projectRoot, onPreviewFile }) {
  const target = _TC_readTarget(msg.target);
  // A tab without a folder has no project to read from (Rust refuses it).
  const previewable = !!(onPreviewFile && projectRoot && target && _TC_inProject(target.path, projectRoot));
  return (
    <React.Fragment>
      <div className="tool-foot mono">
        <span style={{ color: "var(--fg-3)" }}>↳</span>
        {previewable ? (
          <button type="button" className="diff-path" onClick={() => onPreviewFile(target)} title="Preview the file">{msg.target}</button>
        ) : (
          <span className="fp-path-outside" title={target ? "Outside the project: no preview" : undefined}>{msg.target}</span>
        )}
        {msg.summary && <span style={{ color: "var(--fg-4)" }}>· {msg.summary}</span>}
      </div>
      <_TC_Thumbs images={msg.images} className="tool-images" alt="image the agent read" />
    </React.Fragment>
  );
}

function ScrubbableDiff({ msg, onOpenFile }) {
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
        <DiffPaths msg={msg} onOpenFile={onOpenFile} />
        <span className="diff-counts">
          <span style={{ color: "var(--diff-add-fg)" }}>+{msg.adds}</span>
          <span style={{ color: "var(--diff-rm-fg)" }}>−{msg.rems}</span>
        </span>
        <_TC_Copy className="diff-copy" label="Copy diff" text={msg.diffText} />
      </div>
      <div className="diff-body mono">
        <div className="diff-lines">
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

// Each subagent row manages its own open/scroll state. `onInspect` opens
// the agent in the subagent manager (keyed by the AgentProgress id).
function TaskAgentRow({ sa, onInspect }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const bodyRef   = React.useRef(null);
  const isRunning = sa.status === "running";
  const lines     = sa._stream?.length ? sa._stream
    : sa.output ? sa.output.split("\n") : [];
  const hasBody   = lines.length > 0;
  const clr       = _TA_CLR[sa.status] ?? "var(--fg-4)";
  const hint      = isRunning ? sa.lastIntent
    : (sa.status === "failed" || sa.status === "aborted") ? (sa.error ?? sa.status)
    : sa.task;

  // Auto-scroll the body div while the subagent is still running.
  React.useEffect(() => {
    if (isOpen && isRunning && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines.length, isOpen, isRunning]);

  return (
    <div className={`ta-row ta-${sa.status}`}>
      <div className="ta-top">
        <button className="ta-hd" onClick={() => hasBody && setIsOpen(o => !o)}
          style={{ cursor: hasBody ? "pointer" : "default" }}>
          <span className="dot" style={{
            background: clr, flexShrink: 0,
            ...(isRunning ? { animation: "pulseDot 1.4s ease-in-out infinite" } : {}),
          }} />
          <span className="ta-agent">{sa.agent}</span>
          {hint && <span className="ta-hint">· {hint}</span>}
          <div style={{ flex: 1 }} />
          {sa.toolCount  > 0 && <span className="chip muted mono ta-chip">{sa.toolCount}×</span>}
          {sa.tokens     > 0 && <span className="chip muted mono ta-chip">{sa.tokens >= 1000 ? `${(sa.tokens/1000).toFixed(1)}k` : sa.tokens}t</span>}
          {sa.durationMs > 0 && <span className="chip muted mono ta-chip">{sa.durationMs >= 1000 ? `${(sa.durationMs/1000).toFixed(1)}s` : `${sa.durationMs}ms`}</span>}
          {hasBody && <_TC_Icon name={isOpen ? "chev" : "chevR"} size={10} color="var(--fg-4)" />}
        </button>
        {onInspect && sa.id && (
          <button className="btn icon ghost ta-inspect" title="inspect in subagent manager" onClick={() => onInspect(sa.id)}>
            <_TC_Icon name="focus" size={11} />
          </button>
        )}
      </div>
      {isOpen && hasBody && (
        <div className="ta-body selectable" ref={bodyRef}>
          {lines.map((l, i) => <div key={i} className="ta-stream-line">{l || "\u00a0"}</div>)}
        </div>
      )}
    </div>
  );
}

function TaskPanel({ subagents, onInspect }) {
  return (
    <div className="task-panel">
      {subagents.map(sa => <TaskAgentRow key={sa.index} sa={sa} onInspect={onInspect} />)}
    </div>
  );
}

// `collapsed`: true/false when the body has a toggle, undefined when it is
// too short to collapse (app/chat-collapse.js). Collapsed, the body keeps a
// few lines in view: bash its last ones, everything else its first.
function ToolCard({ msg, idx, highlighted, onInspectSubagent, onOpenFile, onPreviewFile, projectRoot, collapsed, onToggleCollapse }) {
  const meta    = _TC_TOOL_META[msg.tool] || { color: "var(--fg-3)", icon: "circle", label: msg.tool };
  const running = msg.status === "running";
  const bashLines = collapsed && msg.output ? _TC_bashPreview(msg.output) : msg.output;
  return (
    <div className={`row tool fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: meta.color, color: meta.color }}>
          <_TC_Icon name={meta.icon} size={11} color={meta.color} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className={`tool-card ${running ? "running" : "ok"}`}>
        <div className="tool-card-head">
          <span className="tool-tag" style={{ color: meta.color, background: `color-mix(in oklab, ${meta.color} 14%, transparent)`, borderColor: `color-mix(in oklab, ${meta.color} 30%, var(--line))` }}>
            {meta.label}
          </span>
          <span className="tool-title selectable">{msg.title}</span>
          <div className="tool-card-spacer" />
          {running ? (
            <span className="chip accent" style={{ animation: "pulseDot 1.4s infinite" }}>
              <span className="dot live" /> running
            </span>
          ) : msg.duration != null && (
            <span className="chip muted">
              <span className="mono">{msg.duration}ms</span>
            </span>
          )}
          <span className="chip muted mono">{msg.time}</span>
          {collapsed !== undefined && (
            <_TC_Collapse collapsed={collapsed} onToggle={() => onToggleCollapse(msg._id, collapsed)} />
          )}
        </div>

        <div className={collapsed ? `collapse-clip${msg.tool === "bash" ? " from-end" : ""}` : undefined}>
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

          {msg.tool === "read" && <_TC_ReadBody msg={msg} projectRoot={projectRoot} onPreviewFile={onPreviewFile} />}

          {msg.tool === "write" && msg.targets?.length > 0 && (
            <div className="tool-foot mono">
              <span style={{ color: "var(--fg-3)" }}>↳</span>
              <DiffPaths msg={msg} onOpenFile={onOpenFile} />
              {msg.bytes != null && <span style={{ color: "var(--fg-4)" }}>· {_TC_size(msg.bytes)}</span>}
            </div>
          )}

          {msg.tool === "edit" && msg.diff && <ScrubbableDiff msg={msg} onOpenFile={onOpenFile} />}
          {msg.tool === "edit" && !msg.diff && (
            <div className="tool-foot mono">
              <span style={{ color: "var(--fg-3)" }}>↳</span>
              <DiffPaths msg={msg} onOpenFile={onOpenFile} />
              <span style={{ color: "var(--diff-add-fg)", marginLeft: 8 }} className="mono">+{msg.adds || 0}</span>
              <span style={{ color: "var(--diff-rm-fg)", marginLeft: 4 }} className="mono">−{msg.rems || 0}</span>
              {running && <span className="shimmer-text" style={{ marginLeft: "auto" }}>writing patch…</span>}
            </div>
          )}

          {msg.tool === "bash" && bashLines && (
            // Copies the whole output, not just the lines shown.
            <_TC_CopyHost label="Copy output" text={msg.outputText}>
              <pre className="tool-bash mono selectable">
                {bashLines.map((l, i) => (
                  <div key={i} style={{ color: `var(--${l.color})` }}>{l.line}</div>
                ))}
              </pre>
            </_TC_CopyHost>
          )}

          {msg.tool === "eval" && msg.cells && (
            <div className="tool-eval">
              {msg.cells.map((cell, i) => <_TC_EvalCell key={i} cell={cell} />)}
            </div>
          )}
          {msg.tool === "task" && msg.subagents?.length > 0 && (
            <TaskPanel subagents={msg.subagents} onInspect={onInspectSubagent} />
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ToolCard, ScrubbableDiff });
