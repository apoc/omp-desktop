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

// `submitKey` ("enter" | "ctrl+enter", the tweak) is the editor textarea's
// send chord (constants.js isSubmitKey); the single-line input keeps Enter.
function AskBubble({ msg, idx, highlighted, onAnswer, onAnswerDialog, onConfirm, onCancelAsk, onGrant, hasProjectPath, submitKey = "enter" }) {
  window.OMP_I18N.useLocale();
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

  // Approve this prompt and remember the tool for next time — that
  // shouldn't require a second click on "Approve" for the request that's
  // already in front of the user. One bridge call does both: the grant names
  // this prompt, not the tool (Rust reads the tool and the project from what
  // the prompt's own process asked, and only while it is unanswered). The
  // bridge settles the bubble at once; Rust answers the prompt first and
  // saves the rule only once the answer was written, and a refusal (nothing
  // sent) reopens the bubble.
  const grant = (scope) => {
    if (done || !tool) return;
    onGrant?.(msg, scope);
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
            {OMP_TR("Confirm")}
          </button>
          <button
            className={`ask-opt${confirmedNo ? " selected" : ""}${done && !confirmedNo ? " dimmed" : ""}`}
            disabled={done}
            onClick={() => confirm(false)}
          >
            {OMP_TR("Deny")}
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
          onKeyDown={e => {
            if (!done && isSubmitKey(e, submitKey)) { e.preventDefault(); submit(draft); }
          }}
          rows={6}
        />
        {!done && (
          <div className="ask-editor-actions">
            <button className="ask-submit" onClick={() => submit(draft)}>{OMP_TR("Submit")}</button>
            <button className="ask-opt" onClick={decline}>{OMP_TR("Cancel")}</button>
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
              {draft.trim() && <button className="ask-submit" onClick={() => submit(draft)}>{OMP_TR("Submit")}</button>}
              <button className="ask-opt" onClick={decline}>{OMP_TR("Cancel")}</button>
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
              {OMP_TR("Allow for this session")}
            </button>
            {hasProjectPath && (
              <button className="ask-opt ask-remember" onClick={() => grant("project")}>
                <_AskIcon name="folder" size={10} />
                {OMP_TR("Always allow in this project")}
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
          <span className="mono" style={{ color: "var(--amber)" }}>{OMP_TR("Ask")}</span>
          <span className="chip muted">{msg.time}</span>
          {dialogOpen && msg.questions.length > 1 && (
            <span className="chip muted">{msg.questions.length} {OMP_TR("questions")}</span>
          )}
          {timeoutNote && <span className="chip warn">{timeoutNote}</span>}
          {msg.answered && (
            <span className="chip" style={{ color: "var(--accent)", borderColor: "color-mix(in oklab, var(--accent) 30%, var(--line))" }}>
              {OMP_TR("answered")}
            </span>
          )}
          {msg.cancelled && (
            <span className="chip" style={{ color: "var(--fg-4)", borderColor: "var(--line-bright)" }}>
              {msg.closedByOmp ? OMP_TR("closed by omp") : OMP_TR("cancelled")}
            </span>
          )}
        </div>
        {body}
      </div>
    </div>
  );
}

Object.assign(window, { AskBubble });
