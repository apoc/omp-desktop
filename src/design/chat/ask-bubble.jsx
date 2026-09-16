/* chat/ask-bubble.jsx — interactive ask-tool bubble.
   Rendered for every extension_ui_request method the desktop shell has UI
   for: select (options + free text), confirm (yes/no), input (single
   line), editor (multi-line). Stays interactive until the user answers
   or the request is cancelled (by the runtime, or locally via Cancel). */

const { Icon: _AskIcon } = window;

// Label used by omp for the multi-select terminator — show it distinctly.
const DONE_LABEL_PREFIX = "Done selecting";

// Tool-approval prompts are a specific select shape omp emits before
// running an exec-tier tool: options exactly ["Approve","Deny"], and a
// title whose *first line* is "Allow tool: <name>". The title is
// multi-line: omp appends an optional "Origin:"/"Reason:" line plus
// whatever the tool's formatApprovalDetails() returns (path, command,
// content preview — elided at 2000 chars), all joined with "\n". Only
// the first line identifies the tool; treating the whole title as the
// name matched nothing (see approval.rs::is_valid_tool_name) so every
// grant was silently rejected, and rendered the payload as one collapsed
// wall of text.
//
// Mirrors the Rust-side match in src-tauri/src/approval.rs
// (approval_tool_name + is_valid_tool_name) — kept in sync manually since
// this is a display-only echo of that fingerprint, not a second
// enforcement point (the Rust side is what actually auto-answers). The
// name grammar is enforced here too, so the "remember this" buttons only
// appear when the grant the Rust side receives will actually be accepted
// — but an unparseable name only withholds those buttons, it never
// demotes the card back to a generic select (the head/details split and
// its height cap must apply to every "Allow tool:" prompt, and a binary
// approval must never regain a free-text answer box).
// approvalInfo proven with an eval-kernel cell (24/24 cases: the real
// captured 4-line 1159-char `write` title, single-line titles, CRLF vs a
// lone trailing `\r` (Rust-parity), tool-name extraction incl.
// dotted/mcp names, 64-char boundary, over-long/path-like/empty names
// (card without grant), wrong option count/labels/order, unrelated
// select prompt, prefix-in-middle and leading-newline false positives,
// non-string title, missing options).
const APPROVAL_TITLE_PREFIX = "Allow tool: ";
const APPROVAL_TOOL_NAME = /^[A-Za-z0-9][\w.:-]{0,63}$/;

// Split a prompt title into its first line and the (possibly empty)
// remainder. Mirrors Rust `str::lines()`: only the `\r` of a CRLF ending
// is dropped, a lone trailing `\r` stays in the line (and then fails
// APPROVAL_TOOL_NAME, exactly as is_valid_tool_name rejects it there).
function splitTitle(title) {
  const nl = title.indexOf("\n");
  if (nl === -1) return [title, ""];
  return [title.slice(0, nl).replace(/\r$/, ""), title.slice(nl + 1).replace(/\r/g, "")];
}

// `{ tool, head, details }` for an "Allow tool:" prompt, else null. `tool`
// is null when the name fails the Rust-side grammar: the card still
// renders as an approval (split head, capped details, no free-text box)
// but offers no grant, since that grant would be rejected anyway.
function approvalInfo(msg) {
  if (typeof msg.title !== "string" || !Array.isArray(msg.options)) return null;
  if (msg.options.length !== 2 || msg.options[0] !== "Approve" || msg.options[1] !== "Deny") {
    return null;
  }
  const [head, details] = splitTitle(msg.title);
  if (!head.startsWith(APPROVAL_TITLE_PREFIX)) return null;
  const tool = head.slice(APPROVAL_TITLE_PREFIX.length);
  return { tool: APPROVAL_TOOL_NAME.test(tool) ? tool : null, head, details };
}

function isDoneOption(opt) {
  return opt.includes(DONE_LABEL_PREFIX);
}

function AskBubble({ msg, idx, highlighted, onAnswer, onConfirm, onCancelAsk, onGrant, hasProjectPath }) {
  const [custom, setCustom] = React.useState("");
  const [draft, setDraft] = React.useState(msg.method === "editor" ? (msg.prefill ?? "") : "");
  const done = msg.answered || msg.cancelled;
  const method = msg.method ?? "select";
  const approval = method === "select" ? approvalInfo(msg) : null;
  const isApproval = approval !== null;
  const tool = approval?.tool ?? null;

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
    if (isSubmitEnter(e) && custom.trim()) {
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
              if (isSubmitEnter(e) && draft.trim()) { e.preventDefault(); submit(draft); }
            }}
          />
          {!done && (
            <>
              {draft.trim() && <button className="ask-submit" onClick={() => submit(draft)}>Submit</button>}
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
        <div className="ask-question">{approval ? approval.head : msg.title}</div>

        {/* Detail lines omp appends to the title (origin/reason, path,
            command, content preview). Capped + scrollable in CSS so a
            2000-char payload can never push Approve/Deny out of reach. */}
        {approval?.details && (
          <div className="ask-approval-details mono selectable">{approval.details}</div>
        )}

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

        {tool && !done && (
          <div className="ask-approval-rules">
            <button className="ask-opt ask-remember" onClick={() => grant("session")}>
              <_AskIcon name="clock" size={10} />
              Allow for this session
            </button>
            {hasProjectPath && (
              <button className="ask-opt ask-remember" onClick={() => grant("project")}>
                <_AskIcon name="folder" size={10} />
                Always allow in this project
              </button>
            )}
          </div>
        )}

        {/* Free-text input — skips the "Other (type your own)" round-trip:
            typing here sends the text directly as the select response value. */}
        {!isApproval && (
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
        )}
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
