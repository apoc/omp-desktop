/* chat/ask-bubble.jsx — interactive ask bubble.
   Rendered for every extension_ui_request method the desktop shell has UI
   for: select (one option per click: tool approvals, extension pickers,
   ask-form choice fields), ask (omp's ask dialog, chat/ask-dialog.jsx),
   confirm (yes/no), input (single line), editor (multi-line). Stays
   interactive until the user answers
   or the request is cancelled (by the runtime, or locally via Cancel). */

const { Icon: _AskIcon, AskDialog: _AskDialog, FormDialog: _AskFormDialog, OMP_ASK_DIALOG: _AskDialogRules } = window;
// Tool-approval prompts ("Allow tool: <name>" + detail lines): the
// head/details split and the grant-eligible tool name. See app/approval.js.
const { approvalInfo: _AskApprovalInfo } = window.OMP_APPROVAL;

// `submitKey` ("enter" | "ctrl+enter", the tweak) is the editor textarea's
// send chord (constants.js isSubmitKey); the single-line input keeps Enter.
function AskBubble({ msg, idx, highlighted, onAnswer, onAnswerDialog, onAnswerForm, onConfirm, onCancelAsk, onGrant, hasProjectPath, submitKey = "enter" }) {
  window.OMP_I18N.useLocale();
  const [draft, setDraft] = React.useState(msg.method === "editor" ? (msg.prefill ?? "") : "");
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();
  const done = msg.answered || msg.cancelled;
  const summary = done ? _AskDialogRules.collapsedSummary(msg) : null;
  React.useEffect(() => { setExpanded(false); }, [done]);
  const method = msg.method ?? "select";
  const approval = method === "select" ? _AskApprovalInfo(msg) : null;
  const tool = approval?.tool ?? null;
  // omp's ask dialog while it waits: question count and omp's timeout.
  const dialogOpen = method === "ask" && !done;
  const formOpen = method === "form" && !done;
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
  } else if (method === "form") {
    body = (
      <_AskFormDialog
        msg={msg}
        onSubmit={data => onAnswerForm(msg.id, data)}
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
    // select (default — also covers any legacy message without a `method`):
    // rows shaped by OMP_ASK_DIALOG.selectRows (radio marks, or omp's
    // checkbox state with unmarked action rows past `markableCount`),
    // styled like the ask dialog's rows; a click answers at once with the
    // row's label. Tool approvals render the same way.
    body = (
      <>
        <div className={`ask-dialog${done ? " done" : ""}`}>
          <section className="ask-q ask-select">
            <div className="ask-question ask-select-question" id={`ask-q-${msg.id}`}>{approval ? approval.head : msg.title}</div>

            {/* Detail lines omp appends to the title (origin/reason, path,
                command, content preview). Capped + scrollable in CSS so a
                2000-char payload can never push Approve/Deny out of reach. */}
            {approval?.details && (
              <div className="ask-approval-details mono selectable">{approval.details}</div>
            )}

            {msg.options.length > 0 && (() => {
              const { group, rows } = _AskDialogRules.selectRows(msg);
              return (
                <div className="ask-rows" role={group} aria-labelledby={`ask-q-${msg.id}`}>
                  {rows.map((row, i) => {
                    const isDimmed = done && !row.picked;
                    return (
                      <div key={i} className={`ask-row${row.checked ? " checked" : ""}${row.picked ? " selected" : ""}${isDimmed ? " dimmed" : ""}`}>
                        <button type="button" className="ask-row-btn" role={row.role ?? undefined}
                          aria-checked={row.role ? row.checked : undefined}
                          disabled={done} onClick={() => submit(row.label)}>
                          {row.mark && (
                            <span className={`ask-mark ${row.mark}`}>
                              {row.mark === "box" && row.checked && <_AskIcon name="check" size={10} strokeWidth={2.2} dotColor="transparent" aria-hidden="true" />}
                            </span>
                          )}
                          <span className="ask-row-text"><span className="ask-row-label"><span>{row.label}</span></span></span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </section>
        </div>

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

  const summaryAnswer = summary
    ? (summary.answerCount !== null
      ? window.OMP_I18N.plural(summary.answerCount, "{n} answer", "{n} answers")
      : summary.answer
        ? (method === "confirm" ? OMP_TR(summary.answer) : summary.answer)
        : OMP_TR(summary.status))
    : "";
  const summaryIcon = !summary?.negative ? "check" : summary.status === "nothing picked" ? "minus" : "close";

  return (
    <div className={`row ask fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="ass-rail">
        <div className="ass-glyph ask-glyph">
          <_AskIcon name="circle" size={11} color="var(--amber)" />
        </div>
        <div className="ass-thread" />
      </div>
      <div className="ass-body">
        {summary && (
          <button
            type="button"
            className={`ask-collapsed${expanded ? " expanded" : ""}${summary.negative ? " negative" : ""}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            title={expanded ? OMP_TR("Collapse prompt") : OMP_TR("Expand prompt")}
            onClick={() => setExpanded(value => !value)}
          >
            <_AskIcon name={summaryIcon} size={12} strokeWidth={2.2} dotColor="transparent" aria-hidden="true" />
            <span className="ask-collapsed-answer" title={summaryAnswer || undefined}>{summaryAnswer}</span>
            <span className="ask-collapsed-prompt" title={summary.prompt || undefined}>{summary.prompt}</span>
            <span className="chip muted">{msg.time}</span>
            <_AskIcon name={expanded ? "chev" : "chevR"} size={10} color="var(--fg-4)" dotColor="transparent" aria-hidden="true" />
          </button>
        )}
        {!summary && (
          <div className="ass-meta">
            <span className="mono" style={{ color: "var(--amber)" }}>{method === "form" ? OMP_TR("form") : OMP_TR("Ask")}</span>
            <span className="chip muted">{msg.time}</span>
            {dialogOpen && msg.questions.length > 1 && (
              <span className="chip muted">{msg.questions.length} {OMP_TR("questions")}</span>
            )}
            {formOpen && msg.form && (
              <span className="chip muted">{msg.form.fields.filter(field => field.name).length} {OMP_TR("fields")}</span>
            )}
            {timeoutNote && <span className="chip warn">{timeoutNote}</span>}
          </div>
        )}
        <div id={detailsId} hidden={summary ? !expanded : undefined}>{body}</div>
      </div>
    </div>
  );
}

Object.assign(window, { AskBubble });
