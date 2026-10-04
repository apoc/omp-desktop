/* chat/ask-dialog.jsx — omp's ask dialog: every question of one ask tool
   call in one card. Pick-one questions are radio rows, pick-any ones
   checkbox rows, and each question has a free-text box. A lone pick-one
   question answers on click; anything else sends on Submit, once every
   pick-one question has an option or typed text. Settled, the card
   collapses to what was sent. Answer rules and the reply's shape live in
   app/ask-dialog.js; AskBubble renders this for `method: "ask"`. */

const { MarkdownContent: _AD_Markdown, Icon: _AD_Icon } = window;
const _AD = window.OMP_ASK_DIALOG;

// Picks not sent yet, per request id. The chat view remounts on a tab
// switch, and an open dialog must come back the way it was left. A settled
// dialog drops its entry; one abandoned with its tab or process never
// settles, so the oldest entries go past a small cap.
const _AD_drafts = new Map();
const _AD_DRAFTS_MAX = 32;

function _AD_saveDraft(id, draft) {
  _AD_drafts.delete(id);
  _AD_drafts.set(id, draft);
  if (_AD_drafts.size > _AD_DRAFTS_MAX) _AD_drafts.delete(_AD_drafts.keys().next().value);
}

function _AD_Check() {
  return <_AD_Icon name="check" size={10} strokeWidth={2.2} dotColor="transparent" aria-hidden="true" />;
}

// Option labels and descriptions: plain text with `code` spans.
function _AD_Text({ text }) {
  return _AD.codeRuns(text).map((run, i) =>
    run.code ? <code key={i}>{run.text}</code> : <React.Fragment key={i}>{run.text}</React.Fragment>
  );
}

function AskQuestion({ q, qi, total, entry, onPick, onType, onEnter }) {
  const needsAnswer = total > 1 && _AD.unanswered(q, entry);
  const placeholder = q.options.length === 0 ? "Type your answer…"
    : q.multi ? "Add your own…" : "Or type your own answer…";
  return (
    <section className="ask-q">
      {(total > 1 || q.header) && (
        <div className="ask-q-head">
          {total > 1 && <span className="mono">{qi + 1}/{total}</span>}
          {q.header && <span className="chip warn">{q.header}</span>}
          <span className={`ask-q-kind${needsAnswer ? " todo" : ""}`}>
            {q.multi ? "pick any" : needsAnswer ? "needs an answer" : "pick one"}
          </span>
        </div>
      )}
      <div className="ask-question"><_AD_Markdown text={q.question} /></div>
      {q.options.length > 0 && (
        <div className="ask-rows" role={q.multi ? "group" : "radiogroup"} aria-label={q.header ?? `Question ${qi + 1}`}>
          {q.options.map((o, oi) => {
            const on = entry.picks.includes(oi);
            return (
              <div key={oi} className={`ask-row${on ? " selected" : ""}`}>
                <button type="button" className="ask-row-btn" role={q.multi ? "checkbox" : "radio"}
                  aria-checked={on} onClick={() => onPick(qi, oi)}>
                  <span className={`ask-mark ${q.multi ? "box" : "radio"}`}>{q.multi && on && <_AD_Check />}</span>
                  <span className="ask-row-text">
                    <span className="ask-row-label">
                      <span><_AD_Text text={o.label} /></span>
                      {q.recommended === oi && <span className="chip warn">recommended</span>}
                    </span>
                    {o.description && <span className="ask-row-desc"><_AD_Text text={o.description} /></span>}
                  </span>
                </button>
                {o.preview && <div className="ask-row-preview"><_AD_Markdown text={o.preview} /></div>}
              </div>
            );
          })}
        </div>
      )}
      <div className="ask-other">
        <input className="ask-other-input" type="text" placeholder={placeholder} value={entry.text}
          onChange={e => onType(qi, e.target.value)}
          onKeyDown={e => { if (isSubmitEnter(e)) { e.preventDefault(); onEnter(); } }} />
      </div>
    </section>
  );
}

// The settled card: what was sent per question, or "not answered" when the
// dialog was cancelled or closed by omp.
function AskSummary({ questions, answers }) {
  return (
    <div className={`ask-dialog done${answers ? "" : " closed"}`}>
      {questions.map((q, qi) => {
        const a = answers?.[qi];
        const picked = a?.selectedOptions ?? [];
        return (
          <div key={qi} className="ask-sum-row">
            <div className="ask-sum-q" title={q.question}>
              {q.header && <span className="chip warn">{q.header}</span>}
              <span className="ask-sum-q-text"><_AD_Text text={q.question.replace(/\s+/g, " ").trim()} /></span>
            </div>
            {!a && <div className="ask-sum-a none">not answered</div>}
            {a && picked.length === 0 && !a.customInput && <div className="ask-sum-a none">nothing picked</div>}
            {picked.map((label, i) => (
              <div key={i} className="ask-sum-a"><_AD_Check /><span><_AD_Text text={label} /></span></div>
            ))}
            {a?.customInput && (
              <div className="ask-sum-a"><_AD_Check /><span>{a.customInput}</span><span className="typed">typed</span></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AskDialog({ msg, onSubmit, onCancel }) {
  const questions = msg.questions;
  const done = msg.answered || msg.cancelled;
  const [draft, setDraft] = React.useState(() => _AD_drafts.get(msg.id) ?? _AD.emptyDraft(questions));
  React.useEffect(() => { if (done) _AD_drafts.delete(msg.id); }, [done, msg.id]);
  if (done) return <AskSummary questions={questions} answers={msg.answers} />;

  const update = (next) => { _AD_saveDraft(msg.id, next); setDraft(next); };
  const onClick = _AD.answersOnClick(questions);
  // A click sends a lone pick-one question at once, so its draft only ever
  // holds typed text: nothing missing means something was typed.
  const missing = _AD.missing(questions, draft);
  const canSend = missing === 0;
  const send = (d) => onSubmit(_AD.answers(questions, d));

  const pick = (qi, oi) => {
    const next = _AD.pick(draft, questions, qi, oi);
    if (onClick) send(next); else update(next);
  };
  const progress = onClick
    ? (canSend ? "Enter sends your answer" : "Click an option to answer")
    : missing > 0
      ? `${missing} question${missing === 1 ? "" : "s"} still need${missing === 1 ? "s" : ""} an answer`
      : "Ready to send";

  // Bare Shift+Tab is a window shortcut (thinking level) even inside text
  // fields; here it has to move focus back through the dialog instead.
  // Other chords with Tab (Ctrl+Shift+Tab: previous tab) pass through.
  const keepShiftTab = (e) => {
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) e.stopPropagation();
  };

  return (
    <div className="ask-dialog" onKeyDown={keepShiftTab}>
      {questions.map((q, qi) => (
        <AskQuestion key={qi} q={q} qi={qi} total={questions.length} entry={draft[qi]}
          onPick={pick}
          onType={(i, text) => update(_AD.type(draft, questions, i, text))}
          onEnter={() => { if (canSend) send(draft); }} />
      ))}
      <div className="ask-dialog-foot">
        <span className={`ask-progress${!onClick && missing > 0 ? " incomplete" : ""}`}>{progress}</span>
        <span className="ask-foot-spacer" />
        <button type="button" className="ask-opt" onClick={onCancel}>Cancel</button>
        {(!onClick || canSend) && (
          <button type="button" className="ask-submit" disabled={!canSend} onClick={() => send(draft)}>
            {questions.length > 1 ? "Submit answers" : "Submit"}
          </button>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { AskDialog });
