/* chat/form-dialog.jsx — the ask tool's HTML form (extension_ui_request
   method "form", omp 19.1+). Renders only the parsed model in
   app/html-form.js; no part of omp's HTML string reaches the DOM. Picture
   blocks show alt text, never the source URL. */

const { Icon: _FD_Icon } = window;
const _FD = window.OMP_HTML_FORM;

// Drafts not sent yet, per request id: the chat view remounts on a tab switch.
const _FD_drafts = new Map();
const _FD_DRAFTS_MAX = 16;

function _FD_saveDraft(id, draft) {
  _FD_drafts.delete(id);
  _FD_drafts.set(id, draft);
  if (_FD_drafts.size > _FD_DRAFTS_MAX) _FD_drafts.delete(_FD_drafts.keys().next().value);
}

function _FD_Check() {
  return <_FD_Icon name="check" size={10} strokeWidth={2.2} dotColor="transparent" aria-hidden="true" />;
}

function _FD_Block({ block, fieldIndex, form, draft, errors, update, idPrefix }) {
  switch (block.kind) {
    case "text":
      return <div className={`form-context${block.heading ? " form-heading" : ""}`}>{block.text}</div>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return <List className="form-list">{block.items.map((item, i) => <li key={i}>{item}</li>)}</List>;
    }
    case "pre":
      return <pre className="form-pre selectable">{block.text}</pre>;
    case "table":
      return (
        <div className="form-table-wrap">
          <table className="form-table"><tbody>
            {block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}
          </tbody></table>
        </div>
      );
    case "image":
      return <div className="form-image-alt">{OMP_TR("Image: {alt}", { alt: block.alt })}</div>;
    case "field": {
      const index = fieldIndex.get(block.field);
      return <_FD_Field field={block.field} index={index} form={form} draft={draft} error={errors[index]} update={update} idPrefix={idPrefix} />;
    }
    default:
      return null;
  }
}

function _FD_Field({ field, index, form, draft, error, update, idPrefix }) {
  const entry = draft[index];
  const question = field.label || (field.options?.length === 1 ? field.options[0].label : "") || field.name.replace(/[_-]+/g, " ");
  // Stable, unique ids so every control has an accessible name: text-like
  // controls and the single-choice select point at the question with a native
  // label, choice groups name themselves through aria-labelledby.
  const prefix = idPrefix ? `${idPrefix}-${index}` : `form-field-${index}`;
  const questionId = `${prefix}-q`;
  const controlId = `${prefix}-c`;
  const choice = field.kind === "choice";
  const radioRefs = React.useRef([]);
  const enabledIndices = (field.options ?? []).flatMap((option, oi) => option.disabled ? [] : [oi]);
  // Arrow keys move focus and selection inside a radiogroup, one tab stop per
  // group (roving tabindex) — the WAI-ARIA radio pattern. Checkboxes keep
  // native button activation.
  const onRadioKey = (e, oi) => {
    if (field.multi) return;
    const position = enabledIndices.indexOf(oi);
    if (position < 0) return;
    let next;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = enabledIndices[(position + 1) % enabledIndices.length];
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = enabledIndices[(position - 1 + enabledIndices.length) % enabledIndices.length];
    else if (e.key === "Home") next = enabledIndices[0];
    else if (e.key === "End") next = enabledIndices.at(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
    update(_FD.pick(draft, form, index, next));
    radioRefs.current[next]?.focus();
  };
  const rows = (multi) => (
    <div className="ask-rows" role={multi ? "group" : "radiogroup"} aria-labelledby={questionId}>
      {field.options.map((option, oi) => {
        const on = entry.picks.includes(oi);
        const tabStop = on || (entry.picks.length === 0 && enabledIndices[0] === oi);
        return (
          <div key={oi} className={`ask-row${on ? " selected" : ""}${option.disabled ? " dimmed" : ""}`}>
            <button type="button" className="ask-row-btn" role={multi ? "checkbox" : "radio"}
              aria-checked={on} disabled={option.disabled}
              tabIndex={multi ? undefined : (tabStop ? 0 : -1)}
              ref={el => { if (!multi) radioRefs.current[oi] = el; }}
              onClick={() => update(_FD.pick(draft, form, index, oi))}
              onKeyDown={e => onRadioKey(e, oi)}>
              <span className={`ask-mark ${multi ? "box" : "radio"}`}>{multi && on && <_FD_Check />}</span>
              <span className="ask-row-text"><span className="ask-row-label"><span>{option.label}</span></span></span>
            </button>
          </div>
        );
      })}
    </div>
  );
  let control;
  if (field.kind === "choice" && field.select && !field.multi) {
    control = (
      <select id={controlId} className="ask-other-input form-select selectable" value={entry.picks[0] ?? -1}
        onChange={e => {
          const next = Number(e.target.value);
          update(next >= 0 ? _FD.pick(draft, form, index, next) : _FD.clearPick(draft, form, index));
        }}>
        <option value="-1">{OMP_TR("Choose…")}</option>
        {field.options.map((option, oi) => (
          <option key={oi} value={oi} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    );
  } else if (field.kind === "choice") {
    control = (
      <>
        {rows(field.multi)}
        {field.other && (
          <div className="ask-other form-other">
            <input className="ask-other-input" type="text" value={entry.other}
              aria-label={OMP_TR("Other (type your own)")}
              placeholder={OMP_TR("Other (type your own)")}
              onChange={e => update(_FD.setOther(draft, form, index, e.target.value))} />
          </div>
        )}
      </>
    );
  } else if (field.multiline) {
    control = (
      <textarea id={controlId} className="ask-editor-textarea selectable" value={entry} rows={field.rows || 4}
        placeholder={field.placeholder} maxLength={field.maxLength || undefined}
        onChange={e => update(_FD.setText(draft, form, index, e.target.value))} />
    );
  } else {
    control = (
      <input id={controlId} className="ask-other-input selectable" type={field.type || "text"} value={entry}
        placeholder={field.placeholder} required={field.required}
        min={field.min} max={field.max} step={field.step}
        minLength={field.minLength} maxLength={field.maxLength}
        onChange={e => update(_FD.setText(draft, form, index, e.target.value))} />
    );
  }
  const labelProps = { className: "ask-question form-field-label", id: questionId };
  const hasLabel = !choice || (field.select && !field.multi);
  return (
    <section className="ask-q form-field">
      {hasLabel
        ? <label {...labelProps} htmlFor={controlId}>{question}</label>
        : <div {...labelProps}>{question}</div>}
      {control}
      {field.pattern && <div className="form-context">{OMP_TR("Pattern: {pattern}", { pattern: field.pattern })}</div>}
      {error && <div className="form-error" role="alert">{OMP_TR(error)}</div>}
    </section>
  );
}

function _FD_Summary({ form, data }) {
  const hidden = new Set(form.hidden.map(([name]) => name));
  const fields = form.fields.filter(field => field.name && !hidden.has(field.name));
  return (
    <div className="ask-dialog done form-dialog">
      {fields.map((field, i) => {
        const value = data?.[field.name];
        const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
        const shown = values.map(entry => field.kind === "choice"
          ? field.options.find(option => option.value === String(entry))?.label ?? String(entry)
          : String(entry));
        return (
          <div className="ask-sum-row" key={i}>
            <div className="ask-sum-q" title={field.label || field.name}>
              <span className="ask-sum-q-text">{field.label || field.name.replace(/[_-]+/g, " ")}</span>
            </div>
            {shown.length === 0
              ? <div className="ask-sum-a none">{OMP_TR("nothing picked")}</div>
              : shown.map((text, j) => <div className="ask-sum-a" key={j}><_FD_Check /><span>{text}</span></div>)}
          </div>
        );
      })}
    </div>
  );
}

function FormDialog({ msg, onSubmit, onCancel }) {
  const form = msg.form;
  const done = msg.answered || msg.cancelled;
  const [draft, setDraft] = React.useState(() => form ? (_FD_drafts.get(msg.id) ?? _FD.emptyDraft(form)) : []);
  React.useEffect(() => { if (done) _FD_drafts.delete(msg.id); }, [done, msg.id]);
  if (!form) {
    return (
      <div className="ask-dialog done form-dialog">
        <div className="ask-sum-row">
          <div className="ask-sum-q"><span className="ask-sum-q-text">{OMP_TR("Unsupported form")}</span></div>
          <div className="ask-sum-a none">{msg.formError || OMP_TR("The form could not be read.")}</div>
        </div>
        <div className="ask-dialog-foot">
          <span className="ask-foot-spacer" />
          {!done && <button type="button" className="ask-opt" onClick={onCancel}>{OMP_TR("Retry")}</button>}
        </div>
      </div>
    );
  }
  if (done) return <_FD_Summary form={form} data={msg.data} />;

  const update = next => { _FD_saveDraft(msg.id, next); setDraft(next); };
  const errors = _FD.draftErrors(form, draft);
  const canSend = Object.keys(errors).length === 0;
  const fieldIndex = new Map(form.fields.map((field, index) => [field, index]));
  const timeout = window.OMP_ASK_DIALOG.timeoutLabel(msg.timeout);
  const keepShiftTab = e => {
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) e.stopPropagation();
  };
  return (
    <div className="ask-dialog form-dialog" onKeyDown={keepShiftTab}>
      {form.sections.map((section, si) => (
        <section className={`form-section${section.fieldset ? " fieldset" : ""}`} key={si}>
          {section.title && <div className="form-legend">{section.title}</div>}
          {section.blocks.map((block, bi) => (
            <_FD_Block key={bi} block={block} fieldIndex={fieldIndex} form={form}
              draft={draft} errors={errors} update={update} idPrefix={`form-${msg.id}`} />
          ))}
        </section>
      ))}
      <div className="ask-dialog-foot">
        <span className={`ask-progress${canSend ? "" : " incomplete"}`}>
          {canSend ? OMP_TR("Ready to send") : OMP_TR("Fix the marked fields before sending")}
        </span>
        {timeout && <span className="chip warn">{OMP_TR("omp submits the form's defaults after {time}", { time: timeout })}</span>}
        <span className="ask-foot-spacer" />
        <button type="button" className="ask-opt" onClick={onCancel}>{OMP_TR("Cancel")}</button>
        <button type="button" className="ask-submit" disabled={!canSend}
          onClick={() => onSubmit(_FD.buildData(form, draft))}>{OMP_TR("Submit")}</button>
      </div>
    </div>
  );
}

Object.assign(window, { FormDialog });
