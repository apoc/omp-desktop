/* Observed context events render as text, never trusted markup or links. */
const { Icon: _CR_Icon } = window;
const _CR_COLORS = {
  skill: "var(--lilac)",
  instruction: "var(--cyan)",
  harness: "var(--amber)",
};

const ContextRow = React.memo(function ContextRow({ msg, idx, highlighted }) {
  const kind = ["skill", "instruction", "harness"].includes(msg.contextKind)
    ? msg.contextKind
    : "context";
  const color = _CR_COLORS[kind] || "var(--fg-3)";
  const detail =
    msg.text &&
    (msg.text.length > 240 ? `${msg.text.slice(0, 240)}…` : msg.text);
  return (
    <div
      className={`row tool fade-up${highlighted ? " mm-hot" : ""}`}
      data-msg-idx={idx}
    >
      <div className="ass-rail">
        <div className="tool-glyph" style={{ borderColor: color, color }}>
          <_CR_Icon name="context" size={11} color={color} />
        </div>
        <div className="ass-thread" />
      </div>
      <div className={`tool-card ok context-row ${kind}`}>
        <div className="context-row-head">
          <span className="context-row-kind" style={{ color }}>
            {kind}
          </span>
          <span className="context-row-agent">
            {msg.agentLabel || msg.agentId || "agent"}
          </span>
        </div>
        <div className="context-row-title">{msg.title}</div>
        {msg.sourcePath && (
          <div className="context-row-source mono">{msg.sourcePath}</div>
        )}
        {detail && <div className="context-row-detail">{detail}</div>}
        {kind === "instruction" && msg.text && (
          <details className="context-row-inspection">
            <summary>Inspect instructions</summary>
            <pre tabIndex={0}>{msg.text}</pre>
          </details>
        )}
      </div>
    </div>
  );
});

Object.assign(window, { ContextRow });
