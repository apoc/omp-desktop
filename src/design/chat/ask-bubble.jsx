/* chat/ask-bubble.jsx — interactive ask-tool bubble.
   Rendered for every extension_ui_request method the desktop shell has UI
   for: select (options + free text), confirm (yes/no), input (single
   line), editor (multi-line). Stays interactive until the user answers
   or the request is cancelled (by the runtime, or locally via Cancel). */

const { Icon: _AskIcon } = window;

// Label used by omp for the multi-select terminator — show it distinctly.
const DONE_LABEL_PREFIX = "Done selecting";

// Tool-approval prompts are a specific select shape omp emits before
// running an exec-tier tool: options exactly ["Approve","Deny"], title
// "Allow tool: <name>". Mirrors the Rust-side match in
// src-tauri/src/approval.rs::approval_tool_name — kept in sync manually
// since this is a display-only echo of that fingerprint, not a second
// enforcement point (the Rust side is what actually auto-answers).
// isApprovalPrompt/approvalToolName proven with an eval-kernel cell
// (10/10 cases: exact-shape match, tool-name extraction incl. dotted
// names, wrong option count/labels/order, unrelated select prompt,
// prefix-in-middle false positive, missing/non-string title).
const APPROVAL_TITLE_PREFIX = "Allow tool: ";

function isApprovalPrompt(msg) {
  return (
    typeof msg.title === "string" &&
    msg.title.startsWith(APPROVAL_TITLE_PREFIX) &&
    msg.options.length === 2 &&
    msg.options[0] === "Approve" &&
    msg.options[1] === "Deny"
  );
}

function approvalToolName(msg) {
  return msg.title.slice(APPROVAL_TITLE_PREFIX.length);
}

function isDoneOption(opt) {
  return opt.includes(DONE_LABEL_PREFIX);
}

function AskBubble({ msg, idx, highlighted, onAnswer, onConfirm, onCancelAsk, onGrant }) {
  const [custom, setCustom] = React.useState("");
  const [draft, setDraft] = React.useState(msg.method === "editor" ? (msg.prefill ?? "") : "");
  const done = msg.answered || msg.cancelled;
  const method = msg.method ?? "select";
  const isApproval = method === "select" && isApprovalPrompt(msg);
  const tool = isApproval ? approvalToolName(msg) : null;

  const submit = (value) => {
    if (done) return;
    onAnswer(msg.id, value);
  };

  // Grant a standing rule for `tool`, then answer this prompt as approved
  // — remembering for next time shouldn't require a second click on
  // "Approve" for the request that's already in front of the user.
  const grant = (scope) => {
    if (done || !tool) return;
    onGrant?.(tool, scope);
    submit("Approve");
  };

  const confirm = (value) => {
    if (done) return;
    onConfirm(msg.id, value);
  };

  const decline = () => {
    if (done) return;
    onCancelAsk(msg.id);
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && custom.trim()) {
      e.preventDefault();
      submit(custom.trim());
    }
  };

  let body;
  if (method === "confirm") {
    const confirmedYes = msg.answered && msg.answer === "Confirm";
    const confirmedNo  = msg.answered && msg.answer === "Deny";
    body = (
      <>
        <div className="ask-question">{msg.title}</div>
        {msg.message && <div className="ask-confirm-message selectable">{msg.message}</div>}
        <div className="ask-options">
          <button
            className={`ask-opt${confirmedYes ? " selected" : ""}${done && !confirmedYes ? " dimmed" : ""}`}
            disabled={done}
            onClick={() => confirm(true)}
          >
            {confirmedYes && <_AskIcon name="check" size={10} color="var(--accent)" />}
            Confirm
          </button>
          <button
            className={`ask-opt${confirmedNo ? " selected" : ""}${done && !confirmedNo ? " dimmed" : ""}`}
            disabled={done}
            onClick={() => confirm(false)}
          >
            Deny
          </button>
        </div>
      </>
    );
  } else if (method === "editor") {
    body = (
      <>
        <div className="ask-question">{msg.title}</div>
        <textarea
          className="ask-editor-textarea selectable"
          value={done ? (msg.answer ?? "") : draft}
          disabled={done}
          onChange={e => setDraft(e.target.value)}
          rows={6}
        />
        {!done && (
          <div className="ask-editor-actions">
            <button className="ask-submit" onClick={() => submit(draft)}>Submit</button>
            <button className="ask-opt" onClick={decline}>Cancel</button>
          </div>
        )}
      </>
    );
  } else if (method === "input") {
    body = (
      <>
        <div className="ask-question">{msg.title}</div>
        <div className="ask-other">
          <input
            className="ask-other-input"
            type="text"
            placeholder={msg.placeholder}
            value={done ? (msg.answer ?? "") : draft}
            disabled={done}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(draft); }
            }}
          />
          {!done && (
            <>
              <button className="ask-submit" onClick={() => submit(draft)}>Submit</button>
              <button className="ask-opt" onClick={decline}>Cancel</button>
            </>
          )}
        </div>
      </>
    );
  } else {
    // select (default — also covers any legacy message without a `method`)
    body = (
      <>
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

        {isApproval && !done && (
          <div className="ask-approval-rules">
            <button className="ask-opt ask-remember" onClick={() => grant("session")}>
              <_AskIcon name="clock" size={10} />
              Allow for this session
            </button>
            <button className="ask-opt ask-remember" onClick={() => grant("project")}>
              <_AskIcon name="folder" size={10} />
              Always allow in this project
            </button>
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
      </>
    );
  }

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
        {body}
      </div>
    </div>
  );
}

Object.assign(window, { AskBubble });
