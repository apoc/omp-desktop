/* chat/user-bubble.jsx — user-side bubble, right-aligned. */

function UserBubble({ msg, idx, highlighted }) {
  return (
    <div className={`row user fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
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

Object.assign(window, { UserBubble });
