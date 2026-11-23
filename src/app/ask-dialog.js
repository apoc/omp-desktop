/* ═════════════════════════════════════════════════════════════════════
   app/ask-dialog.js — omp's ask dialog. Pure functions only; live.js
   keeps the request on its ask message, design/chat/ask-dialog.jsx
   renders it and holds the picks not sent yet. It also holds `selectRows`,
   the rows of a `select` bubble (desktop chat/ask-bubble.jsx, and the
   phone, which is served this file as /ask-dialog.js: window-only).

   Once `set_ask_dialog` is enabled, every question of one ask tool call
   arrives as a single `extension_ui_request` with `method: "ask"`, and
   the reply is one `extension_ui_response` carrying `answers`. omp checks
   that reply and fails the ask tool on any mismatch instead of guessing
   (rpc-mode.ts `parseAskDialogResponse`):
     - one answer per question, in request order, `id` equal to the
       question's;
     - `selectedOptions` holds exact option labels, none twice;
     - a pick-one question (`multi` absent or false) carries at most one
       option, and never both an option and `customInput`;
     - `customInput` is trimmed, and ignored when empty.
   A pick-any question may be answered with nothing picked. A lone pick-one
   question answered with nothing counts as a cancel and stops the turn,
   so the dialog never sends one.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  function nonBlank(value) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  /** The questions of an `ask` request, or null when they do not have the
   *  shape omp documents — live.js then cancels the request, so omp never
   *  waits on a dialog nothing can answer. `recommended` is kept only when
   *  it indexes an option. */
  function parseQuestions(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const questions = [];
    for (const q of raw) {
      if (!q || typeof q.id !== "string" || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
      const options = [];
      for (const o of q.options) {
        if (!o || typeof o.label !== "string") return null;
        options.push({ label: o.label, description: nonBlank(o.description), preview: nonBlank(o.preview) });
      }
      const rec = q.recommended;
      questions.push({
        id: q.id,
        question: q.question,
        header: nonBlank(q.header)?.trim() ?? null,
        options,
        multi: q.multi === true,
        recommended: Number.isInteger(rec) && rec >= 0 && rec < options.length ? rec : null,
      });
    }
    return questions;
  }

  /** Nothing answered yet: per question, the picked option indexes
   *  (ascending) and the typed text. */
  function emptyDraft(questions) {
    return questions.map(() => ({ picks: [], text: "" }));
  }

  function replaceAt(draft, index, entry) {
    return draft.map((e, i) => (i === index ? entry : e));
  }

  /** A click on option `oi` of question `qi`. Pick-one: the option replaces
   *  the earlier pick and any typed text, since omp takes one or the other.
   *  Pick-any: toggles it. */
  function pick(draft, questions, qi, oi) {
    const entry = draft[qi];
    if (!questions[qi].multi) return replaceAt(draft, qi, { picks: [oi], text: "" });
    const picks = entry.picks.includes(oi)
      ? entry.picks.filter(i => i !== oi)
      : [...entry.picks, oi].sort((a, b) => a - b);
    return replaceAt(draft, qi, { ...entry, picks });
  }

  /** Typed text for question `qi`. On a pick-one question, text that is not
   *  blank replaces the picked option. */
  function type(draft, questions, qi, text) {
    const picks = !questions[qi].multi && text.trim() ? [] : draft[qi].picks;
    return replaceAt(draft, qi, { picks, text });
  }

  /** A pick-one question with neither a pick nor typed text. */
  function unanswered(q, entry) {
    return !q.multi && entry.picks.length === 0 && !entry.text.trim();
  }

  /** How many questions are `unanswered`. */
  function missing(questions, draft) {
    return questions.filter((q, i) => unanswered(q, draft[i])).length;
  }

  /** A lone pick-one question with options answers on click; everything
   *  else waits for Submit. */
  function answersOnClick(questions) {
    return questions.length === 1 && !questions[0].multi && questions[0].options.length > 0;
  }

  /** The `answers` of the reply to omp. */
  function answers(questions, draft) {
    return questions.map((q, i) => {
      const e = draft[i];
      const custom = e.text.trim();
      const picks = q.multi ? e.picks : custom ? [] : e.picks.slice(0, 1);
      const selectedOptions = picks.map(oi => q.options[oi].label);
      return custom ? { id: q.id, selectedOptions, customInput: custom } : { id: q.id, selectedOptions };
    });
  }

  /** omp's ask timeout (ms) as "45 s", "2 min" or "1 min 30 s"; null when
   *  there is none. */
  function timeoutLabel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const min = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${min} min ${rest} s` : `${min} min`;
  }

  /** What omp does once its ask timeout (ms) runs out, or null when there
   *  is none: it picks the recommended options when every question has one,
   *  and otherwise answers on its own. */
  function timeoutNote(questions, ms) {
    const after = timeoutLabel(ms);
    if (!after) return null;
    if (!questions.every(q => q.recommended !== null)) return `omp answers for you after ${after}`;
    return `omp picks the recommended option${questions.length > 1 ? "s" : ""} after ${after}`;
  }

  /** `text` split into plain runs and `code` runs (a backtick pair). Option
   *  labels and descriptions render as text, not markdown: they sit inside
   *  the option's button. An unpaired backtick stays literal. */
  function codeRuns(text) {
    const runs = [];
    const re = /`([^`\n]+)`/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) runs.push({ code: false, text: text.slice(last, m.index) });
      runs.push({ code: true, text: m[1] });
      last = re.lastIndex;
    }
    if (last < text.length) runs.push({ code: false, text: text.slice(last) });
    return runs;
  }

  function answerParts(entry) {
    const parts = Array.isArray(entry?.selectedOptions)
      ? entry.selectedOptions.map(label => nonBlank(label)?.trim()).filter(Boolean)
      : [];
    if (nonBlank(entry?.customInput)) parts.push(entry.customInput.trim());
    return parts;
  }

  /** The settled desktop bubble's one-line summary. Cancellation (including
   *  omp closing a timed-out dialog) keeps the existing status wording; an
   *  answered multi-question dialog exposes its non-empty answer count for
   *  translated plurals (or the lone answer when only one question was filled). */
  function collapsedSummary(msg) {
    if (!msg?.answered && !msg?.cancelled) return null;
    const source = nonBlank(msg.title) ?? nonBlank(msg.message) ?? msg.questions?.[0]?.question ?? "";
    const prompt = String(source).trimStart().split(/\r?\n/, 1)[0].trim();
    if (msg.cancelled) {
      return { answer: null, answerCount: null, status: msg.closedByOmp ? "closed by omp" : "cancelled", prompt, negative: true };
    }

    let answer = nonBlank(msg.answer);
    let answerCount = null;
    if (msg.method === "ask") {
      const answered = (Array.isArray(msg.answers) ? msg.answers : [])
        .map(answerParts)
        .filter(parts => parts.length > 0);
      if (answered.length > 1) {
        answer = null;
        answerCount = answered.length;
      } else {
        answer = answered.length === 1 ? answered[0].join(", ") : null;
      }
    }
    const isChoice = !msg.method || msg.method === "select" || msg.method === "confirm";
    const status = answer === null && answerCount === null ? "nothing picked" : null;
    return {
      answer,
      answerCount,
      status,
      prompt,
      negative: status !== null || (isChoice && answer?.trim().toLowerCase() === "deny"),
    };
  }

  /** The rows of a `select` request (a tool approval, an extension picker, or
   *  one choice field of an ask form), from omp's optional `selectionMarker`
   *  ("radio" | "checkbox"), `checkedIndices` and `markableCount` (the marker
   *  covers the first `markableCount` rows; later ones are actions such as
   *  "Done selecting"). omp's fields arrive raw and are validated here;
   *  anything malformed reads as absent. With no marker every row is a radio
   *  and `markableCount` is ignored. Per row: its `mark` ("radio" | "box" |
   *  null) and `role` ("radio" | "checkbox" | null), whether it is `checked`
   *  (filled mark) and whether it is the answer the bubble was `picked` with.
   *  Also served to the phone: touches `window` only. */
  function selectRows(msg) {
    const options = Array.isArray(msg?.options) ? msg.options : [];
    const marker = msg?.selectionMarker === "checkbox" || msg?.selectionMarker === "radio" ? msg.selectionMarker : null;
    const count = msg?.markableCount;
    const markable = marker && Number.isInteger(count) && count >= 0 ? Math.min(count, options.length) : options.length;
    const checkedIndices = Array.isArray(msg?.checkedIndices) ? msg.checkedIndices : [];
    const rows = options.map((opt, index) => {
      const label = typeof opt === "string" ? opt : String(opt?.label ?? "");
      const picked = msg.answered === true && msg.answer === label;
      if (index >= markable) return { label, mark: null, role: null, checked: false, picked };
      if (marker === "checkbox") return { label, mark: "box", role: "checkbox", checked: checkedIndices.includes(index), picked };
      return { label, mark: "radio", role: "radio", checked: picked, picked };
    });
    return { group: marker === "checkbox" ? "group" : "radiogroup", rows };
  }

  window.OMP_ASK_DIALOG = {
    parseQuestions, emptyDraft, pick, type, unanswered, missing, answersOnClick, answers, timeoutLabel, timeoutNote,
    codeRuns, collapsedSummary, selectRows,
  };
})();
