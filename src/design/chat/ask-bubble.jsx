/* chat/ask-bubble.jsx — interactive ask bubble.
   Rendered for every extension_ui_request method the desktop shell has UI
   for: select (pick one option: tool approvals, extension pickers), ask
   (omp's ask dialog, chat/ask-dialog.jsx), confirm (yes/no), input (single
   line), editor (multi-line). Stays interactive until the user answers
   or the request is cancelled (by the runtime, or locally via Cancel). */

const { Icon: _AskIcon, AskDialog: _AskDialog, OMP_ASK_DIALOG: _AskDialogRules } = window;
// Tool-approval prompts ("Allow tool: <name>" + detail lines): the
// head/details split and the grant-eligible tool name. See app/approval.js.
const { approvalInfo: _AskApprovalInfo } = window.OMP_APPROVAL;

function AskBubble({ msg, idx, highlighted, onAnswer, onAnswerDialog, onConfirm, onCancelAsk, onGrant, hasProjectPath }) {
  const [draft, setDraft] = React.useState(msg.method === "editor" ? (msg.prefill ?? "") : "");
  const done = msg.answered || msg.cancelled;
  const method = msg.method ?? "select";
  const approval = method === "select" ? _AskApprovalInfo(msg) : null;
  const tool = approval?.tool ?? null;
  // omp's ask dialog while it waits: question count and omp's timeout.
  const dialogOpen = method === "ask" && !done;
  const timeoutNote = dialogOpen ? _AskDialogRules.timeoutNote(msg.questions, msg.timeout) : null;

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

  let body;
  if (method === "ask") {
    body = (
      <_AskDialog
        msg={msg}
        onSubmit={answers => onAnswerDialog(msg.id, answers)}
        onCancel={decline}
      />
    );
  } else if (method === "confirm") {
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
              return (
                <button
                  key={i}
                  className={`ask-opt${isSelected ? " selected" : ""}${isDimmed ? " dimmed" : ""}`}
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
          {dialogOpen && msg.questions.length > 1 && (
            <span className="chip muted">{msg.questions.length} questions</span>
          )}
          {timeoutNote && <span className="chip warn">{timeoutNote}</span>}
          {msg.answered && (
            <span className="chip" style={{ color: "var(--accent)", borderColor: "color-mix(in oklab, var(--accent) 30%, var(--line))" }}>
              answered
            </span>
          )}
          {msg.cancelled && (
            <span className="chip" style={{ color: "var(--fg-4)", borderColor: "var(--line-bright)" }}>
              {msg.closedByOmp ? "closed by omp" : "cancelled"}
            </span>
          )}
        </div>
        {body}
      </div>
    </div>
  );
}

Object.assign(window, { AskBubble });
