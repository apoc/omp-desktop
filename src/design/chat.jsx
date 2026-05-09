/* ═════════════════════════════════════════════════════════════════════
   chat.jsx — the chat surface
   ChatView · UserBubble · AssistantBubble · ToolCard (Linear/Raycast feel)
   · ScrubbableDiff (timeline-like)
   · streaming token shimmer, caret blink
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TOOL_META, MarkdownContent, AnnotablePlan } = window;

// ── User bubble — right-aligned, cool ─────────────────────────────────
function UserBubble({ msg }) {
  return (
    <div className="row user fade-up">
      <div className="user-bubble selectable">
        <div className="user-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>{msg.time}</span>
          <span className="chip muted">you</span>
        </div>
        <div className="user-text">{msg.text}</div>
      </div>
    </div>
  );
}

// ── Assistant block (text + plan + thoughts) ─────────────────────────
function AssistantBubble({ msg, annotable, annotations, onAnnotate }) {
  return (
    <div className="row assistant fade-up">
      <div className="ass-rail">
        <div className="ass-glyph"><Icon name="sparkle" size={11} color="var(--accent)" /></div>
        <div className="ass-thread" />
      </div>
      <div className="ass-body">
        <div className="ass-meta">
          <span className="mono" style={{ color: "var(--accent)" }}>{msg.model ?? "–"}</span>
          <span className="chip muted">{msg.time}</span>
          {msg.lead === "thinking" && (
            <span className="chip" style={{ color: "var(--lilac)", borderColor: "color-mix(in oklab, var(--lilac) 30%, var(--line))" }}>
              <Icon name="thinking" size={10} />
              thinking
            </span>
          )}
        </div>
        {msg.thought && (
          <div className="thought selectable">
            <span className="mono" style={{ color: "var(--fg-4)" }}>// </span>
            <span style={{ color: "var(--fg-3)", fontStyle: "italic" }}>{msg.thought}</span>
          </div>
        )}
        {msg.blocks?.map((b, i) => {
          if (b.type === "text") {
            // Last message in plan mode: render annotatable blocks (not streaming)
            if (annotable && !msg.streaming) {
              return (
                <AnnotablePlan key={i} text={b.text}
                  annotations={annotations}
                  onAnnotate={onAnnotate} />
              );
            }
            return (
              <MarkdownContent key={i} text={b.text}
                streaming={msg.streaming && i === msg.blocks.length - 1} />
            );
          }
          if (b.type === "plan") {
            return <InlinePlan key={i} plan={b} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

// ── Inline mini-plan (the assistant's first plan reply) ──────────────
function InlinePlan({ plan }) {
  return (
    <div className="inline-plan slide-in">
      <div className="inline-plan-head">
        <Icon name="plan" size={12} color="var(--accent)" />
        <span style={{ color: "var(--fg-2)", fontWeight: 600 }}>{plan.title}</span>
        <span className="chip muted">{plan.phases.reduce((n, p) => n + p.tasks.length, 0)} tasks</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 22 }}>open kanban →</button>
      </div>
      <div className="inline-plan-body">
        {plan.phases.map((ph) => (
          <div key={ph.id} className="inline-phase">
            <div className="inline-phase-head">
              <span className="mono" style={{ color: "var(--fg-3)" }}>{ph.label.toUpperCase()}</span>
              <span className="hr" />
            </div>
            {ph.tasks.map((t) => (
              <div key={t.id} className={`inline-task status-${t.status}`}>
                <span className="task-mark">
                  {t.status === "done" && <Icon name="check" size={10} />}
                  {t.status === "in_progress" && <span className="pulse-dot" />}
                  {t.status === "pending" && <span className="mono" style={{ color: "var(--fg-4)" }}>○</span>}
                </span>
                <span className="task-text selectable">{t.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tool card (Linear / Raycast feeling) ─────────────────────────────
function ToolCard({ msg }) {
  const meta = TOOL_META[msg.tool] || { color: "var(--fg-3)", icon: "circle", label: msg.tool };
  const running = msg.status === "running";
  return (
    <div className={`row tool fade-up`}>
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: meta.color, color: meta.color }}>
          <Icon name={meta.icon} size={11} color={meta.color} />
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
          ) : (
            <span className="chip muted">
              <span className="mono">{msg.duration}ms</span>
            </span>
          )}
          <span className="chip muted mono">{msg.time}</span>
        </div>

        {msg.tool === "search" && msg.preview && (
          <div className="tool-search">
            {msg.preview.map((p, i) => (
              <div key={i} className={`search-row ${p.hot ? "hot" : ""}`}>
                <Icon name="file" size={11} color={p.hot ? "var(--accent)" : "var(--fg-3)"} />
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
      </div>
    </div>
  );
}

// ── Scrubbable diff — the headliner. Hover the bar to peek at lines. ──
function ScrubbableDiff({ msg }) {
  const total = msg.diff.length;
  const [pos, setPos] = React.useState(total); // play state, drives revealed lines
  const [hover, setHover] = React.useState(null);
  const trackRef = React.useRef(null);

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

// ── ChatView: wires everything ───────────────────────────────────────
function ChatView({ messages, planMode, annotations, onAnnotate }) {
  const scrollRef    = React.useRef(null);
  const atBottomRef  = React.useRef(true);   // assume start at bottom
  const prevCountRef = React.useRef(0);

  // Track whether user is near the bottom
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Auto-scroll on every messages change
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const count = messages.length;
    const newMsg = count > prevCountRef.current;
    prevCountRef.current = count;
    // Always scroll when a new message block is added (user sent, agent started, tool card appeared)
    // During streaming (same count, content grows) only scroll if already at bottom
    if (newMsg || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Only the last completed assistant message is annotatable in plan mode
  let lastAsstIdx = -1;
  if (planMode) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "assistant" && !messages[i].streaming) { lastAsstIdx = i; break; }
    }
  }

  return (
    <div className="chat-scroll selectable" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-pad">
        {messages.map((m, i) => {
          if (m.kind === "user") return <UserBubble key={i} msg={m} />;
          if (m.kind === "tool") return <ToolCard    key={i} msg={m} />;
          return <AssistantBubble key={i} msg={m}
            annotable={i === lastAsstIdx}
            annotations={annotations}
            onAnnotate={onAnnotate} />;
        })}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

Object.assign(window, { ChatView, UserBubble, AssistantBubble, ToolCard, ScrubbableDiff });
