/* chat/chat-view.jsx — top-level chat surface. Handles auto-scroll to
   bottom when new messages land, and routes each message to the right
   bubble component. The minimap-hover cross-highlight (mm-hot) flows
   through here via the `hoveredMsgIdx` prop. */

const { UserBubble: _CV_UserBubble, ToolCard: _CV_ToolCard, AssistantBubble: _CV_AssistantBubble, AskBubble: _CV_AskBubble, Icon: _CV_Icon } = window;

// ── Per-bubble memo wrappers ────────────────────────────────────────────────
// Primary streaming-perf win: only the live tail (new object ref per
// message_update) re-renders; stable messages bail out automatically.
// Created once at module load — React.memo returns a stable component type.
const _CV_UserBubble_M      = React.memo(_CV_UserBubble);
const _CV_ToolCard_M        = React.memo(_CV_ToolCard);
const _CV_AssistantBubble_M = React.memo(_CV_AssistantBubble);
const _CV_AskBubble_M       = React.memo(_CV_AskBubble);

const CompactRow = React.memo(function CompactRow({ msg }) {
  const [open, setOpen] = React.useState(false);
  const pending  = msg.status === "pending";
  const error    = msg.status === "error";
  const COLOR    = error ? "var(--rose)" : "var(--lilac)";
  const fmtTok   = n => n == null ? null
    : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000     ? `${(n / 1_000).toFixed(1)}k`
    : String(n);
  const tok      = fmtTok(msg.tokensBefore);
  const hasBody  = !!msg.summary && !pending && !error;

  return (
    <div className="row tool fade-up">
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: COLOR, color: COLOR }}>
          <_CV_Icon name={error ? "warn" : "context"} size={11} color={COLOR} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className={`tool-card ${pending ? "running" : "ok"}`}
        style={error ? { borderColor: "color-mix(in oklab, var(--rose) 35%, var(--line-bright))" } : {}}>
        <div className="tool-card-head"
          style={{ cursor: hasBody ? "pointer" : "default" }}
          onClick={() => hasBody && setOpen(o => !o)}>
          <span className="tool-tag" style={{
            color: COLOR,
            background: `color-mix(in oklab, ${COLOR} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${COLOR} 30%, var(--line))`,
          }}>compact</span>
          <span className="tool-title">
            {pending ? "compacting context\u2026"
              : error   ? "compaction failed"
              : (msg.shortSummary || "context compacted")}
          </span>
          <div className="tool-card-spacer" />
          {pending && (
            <span className="chip accent" style={{ animation: "pulseDot 1.4s infinite" }}>
              <span className="dot live" />{" "}running
            </span>
          )}
          {!pending && !error && tok && (
            <span className="chip muted mono">{tok} before</span>
          )}
          {error && <span className="chip" style={{ color: "var(--rose)" }}>failed</span>}
          {hasBody && <_CV_Icon name={open ? "chev" : "chevR"} size={10} color="var(--fg-4)" />}
        </div>
        {open && hasBody && (
          <div className="compact-body selectable">
            {msg.summary}
          </div>
        )}
      </div>
    </div>
  );
});

function ChatView({ messages, planMode, annotations, onAnnotate, hoveredMsgIdx, onAskAnswer }) {
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
    // Always scroll when a new message block is added (user sent, agent
    // started, tool card appeared). During streaming (same count, content
    // grows) only scroll if already at bottom.
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
        {/* Note: after a trim, idx shifts for all surviving messages, causing a full
           re-render of memo'd bubbles in that notify cycle (bounded at MINIMAP_MAX -
           MINIMAP_COLS = 156). Streaming re-renders are unaffected. Driving annotable
           and scroll-targeting off _id instead of idx would make trim zero-cost for
           history, but requires a larger refactor. */}
        {messages.map((m, i) => {
          const hl = hoveredMsgIdx === i;
          if (m.kind === "user")    return <_CV_UserBubble_M    key={m._id ?? i} idx={i} highlighted={hl} msg={m} />;
          if (m.kind === "compact") return <CompactRow          key={m._id ?? i} msg={m} />;
          if (m.kind === "tool")    return <_CV_ToolCard_M      key={m._id ?? i} idx={i} highlighted={hl} msg={m} />;
          if (m.kind === "ask")     return <_CV_AskBubble_M     key={m._id ?? i} idx={i} highlighted={hl} msg={m} onAnswer={onAskAnswer} />;
          return <_CV_AssistantBubble_M key={m._id ?? i} idx={i} highlighted={hl} msg={m}
            annotable={i === lastAsstIdx}
            annotations={annotations}
            onAnnotate={onAnnotate} />;
        })}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

Object.assign(window, { ChatView });
