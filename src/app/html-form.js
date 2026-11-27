/* ═════════════════════════════════════════════════════════════════════
   app/html-form.js — omp's ask-tool HTML form: drafts, the reply `data`
   and its validation (`window.OMP_HTML_FORM`). The parser is
   app/html-form-parse.js (a port of omp's own); `parse` here delegates to
   it at call time, so the phone page loads only this file.
   design/chat/form-dialog.jsx renders the model on the desktop and
   remote/transcript.js on the phone.

   Mirrors omp's tools/html-form/data.ts. The reply is
   `{data: {<control name>: value}}` (rpc-mode.ts
   parseFormDialogResponse): one string for a radio/single select, an array
   for a checkbox group or multi-select, a number for number/range, and a
   free-text value for a group's automatic Other. Unknown names, wrong
   shapes and disabled options make omp fail the ask tool, so this module
   builds only that shape and validates untrusted phone input with it.

   Every user-facing error is `{text, vars}`: an English source string with
   `{name}` placeholders. The desktop shows `OMP_TR(text, vars)`;
   `errorText` fills it in English (phone page, console).
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  function message(text, vars) {
    return vars ? { text, vars } : { text };
  }

  /** An error object (or plain source string) with its placeholders filled,
   *  untranslated. */
  function errorText(error) {
    const text = String(typeof error === "string" ? error : error?.text ?? "");
    const vars = typeof error === "object" ? error?.vars : undefined;
    return text.replace(/\{(\w+)\}/g, (whole, key) => vars && Object.hasOwn(vars, key) ? String(vars[key]) : whole);
  }

  function parse(html) {
    const parser = window.OMP_HTML_FORM_PARSE;
    return parser ? parser.parse(html) : { error: message("This page cannot read forms.") };
  }

  function isArrayChoice(field) {
    return field.multi && field.options.length > 1;
  }

  function choiceValue(field, checked, other) {
    const typed = field.other ? other?.trim() : undefined;
    const values = field.options.flatMap((option, index) => checked.has(index) && !option.disabled ? [option.value] : []);
    if (isArrayChoice(field)) return typed ? [...values, typed] : values;
    return typed || values[0];
  }

  function textValue(field, text) {
    if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
    return text;
  }

  /** One field's value from its own draft entry. */
  function entryValue(field, entry) {
    return field.kind === "text"
      ? textValue(field, typeof entry === "string" ? entry : field.value)
      : choiceValue(field, new Set(entry?.picks ?? []), entry?.other);
  }

  function emptyDraft(form) {
    return form.fields.map(field => field.kind === "text"
      ? field.value
      : {
        picks: field.options.flatMap((option, index) => option.checked && !option.disabled ? [index] : []),
        other: "",
      });
  }

  function pick(draft, form, index, optionIndex) {
    const field = form.fields[index];
    if (field.kind !== "choice" || field.options[optionIndex]?.disabled) return draft;
    const entry = draft[index];
    const picks = field.multi
      ? entry.picks.includes(optionIndex)
        ? entry.picks.filter(pickIndex => pickIndex !== optionIndex)
        : [...entry.picks, optionIndex].sort((a, b) => a - b)
      : [optionIndex];
    return draft.map((value, i) => i === index ? { ...entry, picks, other: field.multi ? entry.other : "" } : value);
  }

  function setOther(draft, form, index, text) {
    const field = form.fields[index];
    if (field.kind !== "choice" || !field.other) return draft;
    return draft.map((value, i) => i === index
      ? { ...value, other: text, picks: field.multi ? value.picks : text.trim() ? [] : value.picks }
      : value);
  }

  function setText(draft, form, index, text) {
    if (form.fields[index]?.kind !== "text") return draft;
    return draft.map((value, i) => i === index ? text : value);
  }

  /** Clear a choice field's draft entry, used when a single-choice select
   *  goes back to its "Choose…" placeholder. */
  function clearPick(draft, form, index) {
    if (form.fields[index]?.kind !== "choice") return draft;
    return draft.map((value, i) => i === index ? { picks: [], other: "" } : value);
  }

  function buildData(form, draft, { hidden = true } = {}) {
    const data = Object.create(null);
    if (hidden) for (const [name, value] of form.hidden) data[name] = value;
    for (const [index, field] of form.fields.entries()) {
      if (!field.name) continue;
      const value = entryValue(field, draft[index]);
      if (value !== undefined) data[field.name] = value;
    }
    return data;
  }

  function defaultData(form) {
    return buildData(form, emptyDraft(form));
  }

  // Phone answers omit hidden inputs to stay inside the action size limit;
  // the desktop adds the authoritative parsed defaults before handing off.
  function withHiddenDefaults(form, data) {
    const merged = Object.assign(Object.create(null), data);
    const visible = new Set(form.fields.map(field => field.name));
    for (const [name, value] of form.hidden) if (!visible.has(name)) merged[name] = value;
    return merged;
  }

  function setInputValue(input, field, value) {
    // Range inputs clamp when value is assigned; constraints must already be
    // present so the displayed and submitted numbers are identical.
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    input.value = value;
    return input.value;
  }

  /** The `<input type>` both renderers draw a single-line text field with:
   *  its own type when the browser keeps the field's default unchanged under
   *  it, else "text". omp sends an untouched field's value as written, but a
   *  range input shows its midpoint for `value=""`, a colour input
   *  `#000000`, a date input nothing for an unreadable date — the shown and
   *  the sent answer would differ. `makeInput` creates a detached
   *  `<input>` to try the value on; without one the answer is "text". */
  function inputType(field, makeInput) {
    const type = field.type || "text";
    if (type === "text" || typeof makeInput !== "function") return "text";
    const input = makeInput();
    input.type = type;
    if (input.type !== type) return "text";
    return setInputValue(input, field, field.value) === field.value ? type : "text";
  }

  /** omp 19.1's `fieldError` (data.ts) as `{text, vars}`: required, numeric
   *  min/max, min/max length, email and url. `pattern` is a hint only: a
   *  model-written regex never runs in the webview. */
  function fieldError(field, value) {
    if (field.kind === "choice") {
      const empty = value === undefined || (Array.isArray(value) && value.length === 0);
      if (!field.required || !empty) return undefined;
      return message(isArrayChoice(field) ? "Select at least one" : "Required");
    }
    const text = value === undefined ? "" : String(value);
    if (text.trim() === "") return field.required ? message("Required") : undefined;
    if (field.type === "number" || field.type === "range") {
      const number = Number(text);
      if (!Number.isFinite(number)) return message("Enter a number");
      if (field.min !== undefined && number < field.min) return message("Must be at least {min}", { min: field.min });
      if (field.max !== undefined && number > field.max) return message("Must be at most {max}", { max: field.max });
    }
    if (field.minLength !== undefined && text.length < field.minLength) return message("Needs at least {n} characters", { n: field.minLength });
    if (field.maxLength !== undefined && text.length > field.maxLength) return message("At most {n} characters", { n: field.maxLength });
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return message("Enter an email address");
    if (field.type === "url") {
      try {
        new URL(text);
      } catch {
        return message("Enter a full URL");
      }
    }
    return undefined;
  }

  // ── omp's reading of a submitted answer (rpc-mode.ts) ───────────────────
  /** Why omp refuses an answer: `kind` picks the wording, `field` the name. */
  class AnswerRefusal extends Error {
    constructor(kind, field) {
      super(kind);
      this.kind = kind;
      this.field = field;
    }
  }

  // Shown beside the field in a draft (the field is known there).
  const DRAFT_TEXT = {
    disabled: "That answer is a disabled option",
    unexpected: "That answer is already picked",
  };
  // `answerError`'s wording, naming the field.
  const ANSWER_TEXT = {
    record: "The answer is not a set of form fields.",
    unknown: "The form has no field named “{field}”.",
    list: "“{field}” needs a list of answers.",
    single: "“{field}” takes one answer, not a list.",
    disabled: "“{field}” carries a disabled option.",
    unexpected: "“{field}” carries an unexpected answer.",
    text: "“{field}” needs text.",
    rule: "Fix the field “{field}” before sending.",
  };

  function refusalMessage(refusal) {
    const kind = refusal instanceof AnswerRefusal ? refusal.kind : "unexpected";
    return message(ANSWER_TEXT[kind] ?? ANSWER_TEXT.unexpected, kind === "record" ? undefined : { field: refusal?.field ?? "" });
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function parseChoice(field, value) {
    if (value === undefined) return choiceValue(field, new Set());
    const array = isArrayChoice(field);
    const shape = array ? "list" : "single";
    if (array !== Array.isArray(value)) throw new AnswerRefusal(shape, field.name);
    const entries = array ? value : [value];
    const checked = new Set();
    let other;
    for (const entry of entries) {
      if (typeof entry !== "string") throw new AnswerRefusal(shape, field.name);
      const enabled = field.options.findIndex(option => !option.disabled && option.value === entry);
      const index = enabled >= 0 ? enabled : field.options.findIndex(option => option.value === entry);
      if (index >= 0 && field.options[index].disabled) throw new AnswerRefusal("disabled", field.name);
      if (index >= 0 && !checked.has(index)) checked.add(index);
      else if (index < 0 && field.other && other === undefined) other = entry;
      else throw new AnswerRefusal("unexpected", field.name);
    }
    return choiceValue(field, checked, other);
  }

  function parseText(field, value) {
    if (value === undefined) return textValue(field, "");
    const numeric = field.type === "number" || field.type === "range";
    if (typeof value === "string" || (numeric && typeof value === "number" && Number.isFinite(value)))
      return textValue(field, String(value));
    throw new AnswerRefusal("text", field.name);
  }

  function parseChoiceOrHidden(field, value, hiddenValue) {
    if (hiddenValue === undefined) return parseChoice(field, value);
    const echo = Array.isArray(value) ? value.indexOf(hiddenValue) : value === hiddenValue ? 0 : -1;
    if (echo < 0) return parseChoice(field, value);
    const withoutEcho = Array.isArray(value) ? value.toSpliced(echo, 1) : undefined;
    if (Array.isArray(value) && !field.options.some(option => option.value === hiddenValue))
      return parseChoice(field, withoutEcho);
    try {
      return parseChoice(field, value);
    } catch {
      return parseChoice(field, withoutEcho);
    }
  }

  /** Every named field's value as omp parses `data`; throws an
   *  AnswerRefusal. One entry answers every field of its name, a field of
   *  another shape declines it, at least one field must carry the entry, and
   *  an undeclared name is refused. */
  function readAnswer(form, data) {
    if (!isRecord(data)) throw new AnswerRefusal("record");
    const named = form.fields.filter(field => field.name);
    const names = new Set([...named.map(field => field.name), ...form.hidden.map(([name]) => name)]);
    for (const name of Object.keys(data)) if (!names.has(name)) throw new AnswerRefusal("unknown", name);
    const hidden = new Map(form.hidden);
    const groups = new Map();
    for (const field of named) {
      if (!groups.has(field.name)) groups.set(field.name, []);
      groups.get(field.name).push(field);
    }
    const fields = [];
    for (const [name, group] of groups) {
      const entry = Object.hasOwn(data, name) ? data[name] : undefined;
      const hiddenValue = hidden.get(name);
      let mismatch;
      const values = group.map(field => {
        try {
          const value = field.kind === "choice" ? parseChoiceOrHidden(field, entry, hiddenValue) : parseText(field, entry);
          return { field, name, value, carried: true };
        } catch (error) {
          if (group.length === 1) throw error;
          mismatch ??= error;
          return { field, name, value: field.kind === "choice" ? parseChoice(field, undefined) : parseText(field, undefined), carried: false };
        }
      });
      if (!values.some(value => value.carried)) throw mismatch;
      fields.push(...values);
    }
    return fields;
  }

  /** Why omp would reject `data` by shape (`{text, vars}`), or null:
   *  unknown names, wrong shapes, disabled options and duplicate entries. */
  function dataError(form, data) {
    try {
      readAnswer(form, data);
      return null;
    } catch (error) {
      return refusalMessage(error);
    }
  }

  /** Why `data` must not be sent (`{text, vars}`), or null: the shape rules,
   *  then omp 19.1's `fieldError` on every field's value as omp parses it —
   *  applied on every omp version (19.2+ no longer checks them, so the
   *  check only ever refuses what an older omp would reject). */
  function answerError(form, data) {
    let fields;
    try {
      fields = readAnswer(form, data);
    } catch (error) {
      return refusalMessage(error);
    }
    for (const { field, name, value } of fields) {
      if (fieldError(field, value)) return message(ANSWER_TEXT.rule, { field: name });
    }
    return null;
  }

  function validateData(form, data) {
    return dataError(form, data) === null;
  }

  function sameValue(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      const sorted = list => [...list].map(String).sort();
      return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
    }
    return a === b;
  }

  /** Errors to show beside each field (`{index: {text, vars}}`); Submit
   *  stays disabled while any exist. Each field is checked on its own
   *  answer (omp's per-field reading, then `fieldError`), then against the
   *  value omp would read for it from the whole answer: a field whose answer
   *  another field of the same name replaces is flagged. Whatever
   *  `answerError` still refuses lands on the first named field. */
  function draftErrors(form, draft) {
    const errors = {};
    const data = buildData(form, draft);
    let parsed = null;
    try {
      parsed = new Map(readAnswer(form, data).map(entry => [entry.field, entry.value]));
    } catch {
      parsed = null;
    }
    form.fields.forEach((field, index) => {
      if (!field.name) return;
      const own = entryValue(field, draft[index]);
      let error;
      try {
        if (field.kind === "choice") parseChoice(field, own);
      } catch (refusal) {
        error = message(DRAFT_TEXT[refusal?.kind] ?? DRAFT_TEXT.unexpected);
      }
      error ??= fieldError(field, own);
      if (!error && parsed?.has(field) && !sameValue(parsed.get(field), own))
        error = message("Another field named “{name}” replaces this answer", { name: field.name });
      if (error) errors[index] = error;
    });
    if (Object.keys(errors).length === 0) {
      const refusal = answerError(form, data);
      const first = form.fields.findIndex(field => field.name);
      if (refusal && first >= 0) errors[first] = refusal;
    }
    return errors;
  }

  function summary(form, data) {
    const hiddenNames = new Set(form.hidden.map(([name]) => name));
    const parts = [];
    for (const field of form.fields) {
      if (!field.name || hiddenNames.has(field.name) || !Object.hasOwn(data ?? {}, field.name)) continue;
      const value = data[field.name];
      const values = Array.isArray(value) ? value : [value];
      const shown = values.flatMap(entry => {
        if (entry === undefined || entry === null || String(entry).trim() === "") return [];
        if (field.kind !== "choice") return [String(entry)];
        return [field.options.find(option => option.value === String(entry))?.label ?? String(entry)];
      });
      if (shown.length) parts.push(shown.join(", "));
    }
    return parts.length > 1
      ? { answer: null, count: parts.length }
      : { answer: parts[0] ?? null, count: null };
  }

  function summaryPrompt(form) {
    for (const section of form.sections) {
      if (section.title) return section.title;
      const text = section.blocks.find(block => block.kind === "text" || block.kind === "pre");
      if (text) return (text.text ?? "").trim().split(/\r?\n/, 1)[0];
      const field = section.blocks.find(block => block.kind === "field")?.field;
      if (field) return field.label || field.name.replace(/[_-]+/g, " ");
    }
    return "";
  }

  /** The reply for a form this shell refuses to show (no `form` from
   *  `parse`): omp's response has no non-cancelling variant but `data`, and
   *  it fails the ask call on an unknown field name, quoting that name in the
   *  tool error the model reads. So the refusal sentence is the one key,
   *  value null. A cancellation would end the turn (omp reads it as the
   *  user's Esc). The sentence is English for the model, never translated.
   *  The password refusal is recognised by the parser's own text. */
  function refusalData(error) {
    const reason = errorText(error) || "The form could not be read.";
    const sentence = reason === window.OMP_HTML_FORM_PARSE?.PASSWORD_REFUSAL
      ? "OMP Desktop does not show ask forms that mention a password. Do not ask for a password in the chat or in a form; if one is needed, tell the user to enter it in a terminal. Ask anything else in plain text."
      : `OMP Desktop could not show this ask form: ${reason} Do not send this form again; ask the user in plain text instead.`;
    return { [sentence]: null };
  }

  window.OMP_HTML_FORM = {
    parse, emptyDraft, pick, setOther, setText, clearPick, buildData, defaultData, withHiddenDefaults, setInputValue,
    inputType, fieldError, draftErrors, dataError, answerError, validateData, summary, summaryPrompt, errorText, refusalData,
    isArrayChoice, choiceValue, textValue,
  };
})();
