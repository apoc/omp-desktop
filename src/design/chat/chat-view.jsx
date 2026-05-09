/* chat/chat-view.jsx — top-level chat surface. Handles auto-scroll to
   bottom when new messages land, and routes each message to the right
   bubble component. The minimap-hover cross-highlight (mm-hot) flows
   through here via the `hoveredMsgIdx` prop. */

const { UserBubble: _CV_UserBubble, ToolCard: _CV_ToolCard, AssistantBubble: _CV_AssistantBubble } = window;

function ChatView({ messages, planMode, annotations, onAnnotate, hoveredMsgIdx }) {
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
        {messages.map((m, i) => {
          const hl = hoveredMsgIdx === i;
          if (m.kind === "user") return <_CV_UserBubble key={i} idx={i} highlighted={hl} msg={m} />;
          if (m.kind === "tool") return <_CV_ToolCard    key={i} idx={i} highlighted={hl} msg={m} />;
          return <_CV_AssistantBubble key={i} idx={i} highlighted={hl} msg={m}
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
