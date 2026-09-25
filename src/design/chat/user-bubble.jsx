/* chat/user-bubble.jsx — user-side bubble, right-aligned. */
const { toDataUrl } = window.OMP_IMAGES;
const { ImageLightbox: _UB_ImageLightbox } = window;

function UserBubble({ msg, idx, highlighted }) {
  // Index of the attached image shown enlarged, or null (issue #25).
  const [openIdx, setOpenIdx] = React.useState(null);
  const thumbsRef = React.useRef([]);
  const srcs = React.useMemo(() => (msg.images ?? []).map(toDataUrl), [msg.images]);
  const thumbFor = React.useCallback((i) => thumbsRef.current[i] ?? null, []);
  const closeViewer = React.useCallback(() => setOpenIdx(null), []);

  return (
    <div className={`row user fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="user-bubble selectable">
        <div className="user-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>{msg.time}</span>
          <span className="chip muted">you</span>
        </div>
        {srcs.length > 0 && (
          <div className="user-images">
            {srcs.map((src, i) => (
              <button
                key={i}
                className="user-image-btn"
                title="View image"
                onClick={() => setOpenIdx(i)}
              >
                {/* Hidden, not removed, while it is the one enlarged: the
                    viewer flies out of and back into its rect. */}
                <img
                  ref={(el) => { thumbsRef.current[i] = el; }}
                  className={`user-image${openIdx === i ? " is-lifted" : ""}`}
                  src={src}
                  alt="attached image"
                />
              </button>
            ))}
          </div>
        )}
        {msg.text && <div className="user-text">{msg.text}</div>}
      </div>
      {openIdx != null && openIdx < srcs.length && (
        <_UB_ImageLightbox
          images={srcs}
          index={openIdx}
          onIndex={setOpenIdx}
          onClose={closeViewer}
          thumbFor={thumbFor}
        />
      )}
    </div>
  );
}

Object.assign(window, { UserBubble });
