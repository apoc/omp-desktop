/* chat/ask-bubble.jsx — interactive ask-tool bubble.
   Rendered when the agent emits an extension_ui_request with method="select".
   Shows the question title, clickable option chips, and a free-text input.
   Stays interactive until the user answers or the agent cancels the request. */

const { Icon: _AskIcon } = window;

// Label used by omp for the multi-select terminator — show it distinctly.
const DONE_LABEL_PREFIX = "Done selecting";

function isDoneOption(opt) {
  return opt.includes(DONE_LABEL_PREFIX);
}

function AskBubble({ msg, idx, highlighted, onAnswer }) {
  const [custom, setCustom] = React.useState("");
  const done = msg.answered || msg.cancelled;

  const submit = (value) => {
    if (done) return;
    onAnswer(msg.id, value);
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && custom.trim()) {
      e.preventDefault();
      submit(custom.trim());
    }
  };

  return (
    <div className={`row ask fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="ass-glyph ask-glyph">
          <_AskIcon name="circle" size={11} color="var(--amber)" />
        </div>
        <div className="ass-thread" />
      </div>
      <div className="ass-body">
        <div className="ass-meta">
          <span className="mono" style={{ color: "var(--amber)" }}>Ask</span>
          <span className="chip muted">{msg.time}</span>
          {msg.answered && (
            <span className="chip" style={{ color: "var(--accent)", borderColor: "color-mix(in oklab, var(--accent) 30%, var(--line))" }}>
              answered
            </span>
          )}
          {msg.cancelled && (
            <span className="chip" style={{ color: "var(--fg-4)", borderColor: "var(--line-bright)" }}>
              cancelled
            </span>
          )}
        </div>

        <div className="ask-question">{msg.title}</div>

        {msg.options.length > 0 && (
          <div className="ask-options">
            {msg.options.map((opt, i) => {
              const isSelected = msg.answered && msg.answer === opt;
              const isDimmed   = done && !isSelected;
              const isDone     = isDoneOption(opt);
              return (
                <button
                  key={i}
                  className={[
                    "ask-opt",
                    isSelected ? "selected" : "",
                    isDimmed   ? "dimmed"   : "",
                    isDone     ? "done-opt" : "",
                  ].filter(Boolean).join(" ")}
                  disabled={done}
                  onClick={() => submit(opt)}
                >
                  {isSelected && <_AskIcon name="check" size={10} color="var(--accent)" />}
                  {opt}
                </button>
              );
            })}
          </div>
        )}

        {/* Free-text input — skips the "Other (type your own)" round-trip:
            typing here sends the text directly as the select response value. */}
        <div className="ask-other">
          <input
            className="ask-other-input"
            type="text"
            placeholder="Or type your own answer…"
            value={custom}
            disabled={done}
            onChange={e => setCustom(e.target.value)}
            onKeyDown={handleKey}
          />
          {!done && custom.trim() && (
            <button className="ask-submit" onClick={() => submit(custom.trim())}>
              Submit
            </button>
          )}
          {/* Show custom answer inline when the user typed rather than clicked */}
          {done && msg.answer && !msg.options.includes(msg.answer) && (
            <span className="ask-custom-echo">{msg.answer}</span>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AskBubble });
