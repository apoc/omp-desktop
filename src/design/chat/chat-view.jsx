/* chat/chat-view.jsx — top-level chat surface. Sticks to the bottom while
   the user is already there; a manual scroll up unpins the view and shows
   a "Jump to latest" button instead of forcing the viewport back on every
   streamed update (issue #20). See app/scroll-pin.js for the pin state
   machine. Also routes each message to the right bubble component; the
   minimap-hover cross-highlight (mm-hot) flows through here via the
   `hoveredMsgIdx` prop. */

const { UserBubble: _CV_UserBubble, ToolCard: _CV_ToolCard, AssistantBubble: _CV_AssistantBubble, AskBubble: _CV_AskBubble, Icon: _CV_Icon } = window;
const { nextPinned: _CV_nextPinned, shouldRepin: _CV_shouldRepin } = window.OMP_SCROLL_PIN;

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
  // Shared with the status bar / usage-stats panel (adapter.js). Gate on
  // the *source* value being non-null, not the formatted string —
  // `formatTokens(null)` returns the truthy "—" placeholder, which would
  // render an empty "— before" chip instead of hiding it.
  const tok      = window.formatTokens(msg.tokensBefore);
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
          {!pending && !error && msg.tokensBefore != null && (
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

function ChatView({ messages, planMode, annotations, onAnnotate, hoveredMsgIdx, onAskAnswer, onConfirmAsk, onCancelAsk, onGrantApproval, hasProjectPath }) {
  const scrollRef   = React.useRef(null);
  const pinnedRef   = React.useRef(true);   // assume start pinned to bottom
  const prevTopRef  = React.useRef(0);
  const lastIdRef   = React.useRef(null);
  // Mirrors pinnedRef into render so the "Jump to latest" button can show —
  // scroll position itself must not force a re-render on every wheel tick.
  const [showJump, setShowJump] = React.useState(false);

  const setPinned = (val) => {
    pinnedRef.current = val;
    setShowJump(!val);
  };

  // Re-syncs prevTopRef after every programmatic scroll, or the next
  // nextPinned call would misread it as a user scroll-up.
  const stickToBottom = (el) => {
    el.scrollTop = el.scrollHeight;
    prevTopRef.current = el.scrollTop;
  };

  // Only a real user scroll — up and away from the bottom — unpins.
  // Scrolling back down near the bottom re-pins. See app/scroll-pin.js.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = _CV_nextPinned(pinnedRef.current, prevTopRef.current, el);
    prevTopRef.current = el.scrollTop;
    if (pinned !== pinnedRef.current) setPinned(pinned);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom(el);
    setPinned(true);
  };

  // Auto-scroll only while pinned. A new message block (tool card, new
  // assistant turn, …) during a run must NOT itself force a jump — that
  // was issue #20: every streamed update snapped the view to the bottom
  // even while the user was reading history. Sending a new prompt
  // explicitly re-pins, and so does the transcript being reset to empty
  // (/new, a profile switch respawning the tab, or the tab itself being
  // torn down) — none of those change `activeSessionId`, so the `key`
  // remount on tab switch (app-live.jsx) doesn't reach them, and a leftover
  // unpinned state would otherwise strand the button over an empty chat.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!pinnedRef.current && _CV_shouldRepin(lastIdRef.current, messages)) setPinned(true);
    lastIdRef.current = messages[messages.length - 1]?._id ?? null;
    if (pinnedRef.current) stickToBottom(el);
  }, [messages]);

  // Only the last completed assistant message is annotatable in plan mode
  let lastAsstIdx = -1;
  if (planMode) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "assistant" && !messages[i].streaming) { lastAsstIdx = i; break; }
    }
  }

  return (
    <div className="chat-wrap">
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
            if (m.kind === "ask")     return <_CV_AskBubble_M     key={m._id ?? i} idx={i} highlighted={hl} msg={m} onAnswer={onAskAnswer} onConfirm={onConfirmAsk} onCancelAsk={onCancelAsk} onGrant={onGrantApproval} hasProjectPath={hasProjectPath} />;
            return <_CV_AssistantBubble_M key={m._id ?? i} idx={i} highlighted={hl} msg={m}
              annotable={i === lastAsstIdx}
              annotations={annotations}
              onAnnotate={onAnnotate} />;
          })}
          <div style={{ height: 24 }} />
        </div>
      </div>
      {showJump && (
        <button type="button" className="chat-jump-latest" onClick={jumpToLatest}>
          <_CV_Icon name="chev" size={12} />
          Jump to latest
        </button>
      )}
    </div>
  );
}

Object.assign(window, { ChatView });
