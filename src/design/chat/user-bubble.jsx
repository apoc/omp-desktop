/* chat/user-bubble.jsx — user-side bubble, right-aligned. */
const { toDataUrl } = window.OMP_IMAGES;

function UserBubble({ msg, idx, highlighted }) {
  return (
    <div className={`row user fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="user-bubble selectable">
        <div className="user-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>{msg.time}</span>
          <span className="chip muted">you</span>
        </div>
        {msg.images?.length > 0 && (
          <div className="user-images">
            {msg.images.map((img, i) => (
              <img key={i} className="user-image" src={toDataUrl(img)} alt="attached image" />
            ))}
          </div>
        )}
        {msg.text && <div className="user-text">{msg.text}</div>}
      </div>
    </div>
  );
}

Object.assign(window, { UserBubble });
