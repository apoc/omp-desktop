// Phone transcript rendering, open-question cards and scroll pinning.
// Only configured assistant markdown enters innerHTML; all other data is textContent.
// Exposes window.OMP_REMOTE_TRANSCRIPT = { createTranscript({ status, scan, error, onAnswer, onError }) }.
(function () {
  const C = window.OMP_REMOTE_CLIENT;
  const P = window.OMP_SCROLL_PIN;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(label, click) {
    const element = node("button", label);
    element.type = "button";
    element.addEventListener("click", click);
    return element;
  }

  function railRow(tag, cls, glyphClass, symbol, content) {
    const row = node(tag, undefined, cls);
    const rail = node("div", undefined, "ass-rail");
    const glyph = node("div", undefined, glyphClass);
    if (symbol) glyph.append(node("span", symbol));
    rail.append(glyph, node("div", undefined, "ass-thread"));
    row.append(rail, content);
    return row;
  }

  function createTranscript({ status, scan, error, onAnswer, onError }) {
    const transcript = node("section");
    transcript.setAttribute("aria-label", "Transcript");
    const asks = node("section");
    asks.setAttribute("aria-label", "Open questions");
    const jumpLatest = button("↓ Newest", () => { pinned = true; jumpToBottom(); updateJump(); });
    jumpLatest.className = "jump-latest";
    jumpLatest.hidden = true;
    const scrollBox = node("div", undefined, "scroll");
    scrollBox.append(status, scan, error, transcript, asks);
    const stage = node("div", undefined, "stage");
    stage.append(scrollBox, jumpLatest);

    const openTools = new Set();
    const askDrafts = new Map();
    let renderedAsks = null;
    let pinned = true, prevScroll = 0, lastViewTabId = null, lastTailId = null;
    // Ids already on screen for the current tab; only new ones fade in, so a
    // streaming rebuild does not make the whole transcript blink.
    let shownIds = new Set(), freshIds = new Set(), shownTab = null;
    const fade = key => (freshIds.has(key) ? " fade-up" : "");

    function scroller() { return scrollBox; }
    function measure() { const m = scroller(); return { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight }; }
    function jumpToBottom() { const m = scroller(); m.scrollTop = m.scrollHeight - m.clientHeight; }
    function updateJump() { jumpLatest.hidden = pinned; }
    function onScroll() { const m = measure(); pinned = P.nextPinned(pinned, prevScroll, m); prevScroll = m.scrollTop; updateJump(); }
    function afterRender(view, keep) {
      const m = measure();
      const messages = view?.messages || [];
      const tail = messages.at(-1);
      const repin = C.repinFor(P, { tabId: lastViewTabId, lastId: lastTailId }, view);
      lastViewTabId = view?.tabId ?? null;
      lastTailId = tail?.id ?? null;
      const result = P.afterOutput({ pinned, follow: true, repin }, m);
      pinned = result.pinned;
      if (result.stick) jumpToBottom();
      else scroller().scrollTop = keep;
      prevScroll = measure().scrollTop;
      updateJump();
    }
    scrollBox.addEventListener("scroll", onScroll);
    // The box shrinks under the iOS keyboard, a growing draft or a rotation:
    // a pinned reader stays on the newest message (as desktop chat-view).
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => { if (pinned) { jumpToBottom(); prevScroll = measure().scrollTop; } }).observe(scrollBox);
    }

    function renderUser(message) {
      const row = node("div", undefined, `row user${fade(C.messageKey(message))}`);
      const bubble = node("div", undefined, "user-bubble");
      const text = node("div", message.text || "", "user-text selectable");
      bubble.append(text);
      row.append(bubble);
      return row;
    }

    function renderAssistant(message) {
      const body = node("div", undefined, "ass-body");
      const text = node("div", undefined, "ass-text selectable md-content");
      try { text.innerHTML = C.renderMarkdown(message.text || ""); }
      catch (err) { onError(err.message); text.textContent = message.text || ""; }
      body.append(text);
      return railRow("div", `row assistant${fade(C.messageKey(message))}`, "ass-glyph", "✦", body);
    }

    function renderNotice(message) {
      const body = node("div", undefined, "ass-body");
      const text = node("div", message.text || "", "ass-text selectable");
      text.style.color = "var(--fg-3)";
      body.append(text);
      return railRow("div", `row assistant${fade(C.messageKey(message))}`, "ass-glyph", "", body);
    }

    function renderTool(message) {
      const tool = message.tool || {};
      const card = node("details", undefined, "tool-card");
      card.open = openTools.has(message.id);
      card.addEventListener("toggle", () => { if (card.open) openTools.add(message.id); else openTools.delete(message.id); });
      const head = node("summary", undefined, "tool-card-head");
      const tag = node("span", tool.name || "tool", "tool-tag");
      const title = node("span", tool.summary || "", "tool-title");
      const spacer = node("div", undefined, "tool-card-spacer");
      head.append(tag, title, spacer);
      const body = node("div", undefined, "tool-bash mono selectable");
      body.append(node("pre", tool.output || message.text || ""));
      card.append(head, body);
      return railRow("div", `row tool${fade(C.messageKey(message))}`, "tool-glyph", "⚙", card);
    }

    function renderAsk(ask, key) {
      const card = node("div", undefined, "ass-body");
      const row = railRow("article", `row ask${fade(`ask:${ask.id}`)}`, "ass-glyph ask-glyph", "?", card);
      if (ask.kind === "select") {
        card.append(selectControls(ask));
        return row;
      }
      card.append(node("div", ask.title || "Question", "ask-question"));
      if (ask.message) card.append(node("div", ask.message, "ask-confirm-message selectable"));
      if (ask.kind === "dialog") {
        card.append(dialogControls(ask, key));
        return row;
      }
      const controls = C.askControls(ask);
      if (Array.isArray(controls)) {
        const opts = node("div", undefined, "ask-options");
        for (const option of controls) {
          const b = button(option.label, () => onAnswer(ask.id, option.value));
          b.className = "ask-opt";
          opts.append(b);
        }
        card.append(opts);
      } else {
        const wrap = node("div", undefined, "ask-other");
        const input = node(controls.multiline ? "textarea" : "input");
        input.className = controls.multiline ? "ask-editor-textarea selectable" : "ask-other-input";
        input.setAttribute("aria-label", ask.title || "Answer");
        input.value = askDrafts.get(key) ?? ask.value ?? "";
        input.addEventListener("input", () => askDrafts.set(key, input.value));
        wrap.append(input);
        const submit = button(controls.multiline ? "Submit" : "Answer", () => onAnswer(ask.id, input.value));
        submit.className = "ask-submit";
        if (controls.multiline) {
          const cancel = button("Cancel", () => onAnswer(ask.id, null));
          cancel.className = "ask-opt";
          const actions = node("div", undefined, "ask-editor-actions");
          actions.append(submit, cancel);
          wrap.append(actions);
        } else {
          wrap.append(submit);
        }
        card.append(wrap);
      }
      return row;
    }

    // omp's `select` (tool approvals, ask-form choice fields too): rows in a card
    // as on the desktop (design/chat/ask-bubble.jsx), shaped by the shared
    // OMP_ASK_DIALOG.selectRows; a tap answers at once with the option's value
    // (the option label for omp's string options).
    function selectControls(ask) {
      const wrap = node("div", undefined, "ask-dialog");
      const group = node("section", undefined, "ask-q ask-select");
      const title = node("div", ask.title || "Question", "ask-question ask-select-question");
      title.id = `ask-q-${ask.id}`;
      group.append(title);
      if (ask.message) group.append(node("div", ask.message, "ask-confirm-message selectable"));
      const rows = node("div", undefined, "ask-rows");
      const shaped = window.OMP_ASK_DIALOG.selectRows(ask);
      rows.setAttribute("role", shaped.group);
      rows.setAttribute("aria-labelledby", title.id);
      const controls = C.askControls(ask);
      shaped.rows.forEach((spec, i) => {
        const row = node("div", undefined, spec.checked ? "ask-row checked" : "ask-row");
        const btn = node("button");
        btn.type = "button";
        btn.className = "ask-row-btn";
        if (spec.role) {
          btn.setAttribute("role", spec.role);
          btn.setAttribute("aria-checked", String(spec.checked));
        }
        btn.addEventListener("click", () => onAnswer(ask.id, controls[i].value));
        if (spec.mark) btn.append(node("span", "", `ask-mark ${spec.mark}`));
        const text = node("span", undefined, "ask-row-text");
        text.append(node("span", spec.label, "ask-row-label"));
        btn.append(text);
        row.append(btn);
        rows.append(row);
      });
      group.append(rows);
      wrap.append(group);
      return wrap;
    }

    // omp's multi-question ask: answers are [{ id, selectedOptions, customInput? }],
    // one per question in order. A pick-one question takes an option or typed
    // text, never both; a pick-any question may be answered with nothing.
    function dialogControls(ask, key) {
      const questions = ask.questions || [];
      const draft = askDrafts.get(key) ?? questions.map(() => ({ picks: [], text: "" }));
      askDrafts.set(key, draft);
      const wrap = node("div", undefined, "ask-dialog");
      const syncs = [];
      const problem = node("p", "", "error");
      questions.forEach((q, qi) => {
        const group = node("section", undefined, "ask-q");
        const head = node("div", undefined, "ask-q-head");
        if (questions.length > 1) head.append(node("span", `${qi + 1}/${questions.length}`, "mono"));
        if (q.header) head.append(node("span", q.header, "chip warn"));
        const kind = node("span", q.multi ? "pick any" : "pick one", `ask-q-kind${q.multi ? "" : " todo"}`);
        head.append(kind);
        group.append(head, node("div", q.question, "ask-question"));
        const rows = node("div", undefined, "ask-rows");
        const optionRows = [];
        (q.options || []).forEach(option => {
          const row = node("div", undefined, "ask-row");
          const btn = node("button");
          btn.type = "button";
          btn.className = "ask-row-btn";
          btn.setAttribute("role", q.multi ? "checkbox" : "radio");
          btn.addEventListener("click", () => {
            const entry = draft[qi];
            if (q.multi) {
              const picked = new Set(entry.picks);
              if (!picked.delete(option.label)) picked.add(option.label);
              entry.picks = q.options.map(o => o.label).filter(label => picked.has(label));
            } else { entry.picks = [option.label]; entry.text = ""; }
            sync();
          });
          const mark = node("span", "", `ask-mark ${q.multi ? "box" : "radio"}`);
          const text = node("span", option.label, "ask-row-text");
          if (option.description) text.append(node("span", option.description, "ask-row-desc"));
          btn.append(mark, text);
          row.append(btn);
          rows.append(row);
          optionRows.push(row);
        });
        const other = node("div", undefined, "ask-other");
        const input = node("input");
        input.className = "ask-other-input";
        input.setAttribute("aria-label", `Custom answer: ${q.question}`);
        input.placeholder = q.multi ? "Add your own…" : "Or type your own answer…";
        input.addEventListener("input", () => {
          draft[qi].text = input.value;
          if (!q.multi && input.value.trim()) draft[qi].picks = [];
          sync();
        });
        other.append(input);
        group.append(rows, other);
        wrap.append(group);
        function sync() {
          optionRows.forEach((row, i) => {
            const on = draft[qi].picks.includes(q.options[i].label);
            row.classList.toggle("selected", on);
            row.firstElementChild.setAttribute("aria-checked", String(on));
          });
          if (input.value !== draft[qi].text) input.value = draft[qi].text;
        }
        syncs.push(sync);
      });
      syncs.forEach(sync => sync());
      const answer = button("Answer", () => {
        const answers = [];
        for (const [qi, q] of questions.entries()) {
          const custom = draft[qi].text.trim();
          if (!q.multi && !draft[qi].picks.length && !custom) { problem.textContent = "Answer every question."; return; }
          answers.push(custom ? { id: q.id, selectedOptions: draft[qi].picks, customInput: custom } : { id: q.id, selectedOptions: draft[qi].picks });
        }
        problem.textContent = "";
        onAnswer(ask.id, answers);
      });
      answer.className = "ask-submit";
      wrap.append(problem, answer);
      return wrap;
    }

    function renderAsks(view) {
      const nextAsks = JSON.stringify([view.tabId, view.asks || []]);
      if (nextAsks === renderedAsks) return;
      renderedAsks = nextAsks;
      asks.replaceChildren();
      asks.className = "asks";
      const liveDrafts = new Set();
      for (const ask of view.asks || []) {
        const key = `${view.tabId}:${ask.id}`;
        liveDrafts.add(key);
        asks.append(renderAsk(ask, key));
      }
      for (const key of askDrafts.keys()) if (!liveDrafts.has(key)) askDrafts.delete(key);
    }

    function renderView(view) {
      // Rebuilding the transcript can clamp the browser's scroll offset, so a
      // reader who is not pinned gets the same offset back afterwards.
      const keep = scroller().scrollTop;
      transcript.replaceChildren();
      transcript.className = "transcript";
      if (!view) {
        asks.replaceChildren(); asks.className = "asks"; renderedAsks = null;
        transcript.append(node("p", "Select a session to read its live view.", "status"));
        lastViewTabId = null; lastTailId = null; pinned = true; shownIds = new Set(); shownTab = null; updateJump();
        return;
      }
      if (view.tabId !== shownTab) { shownIds = new Set(); shownTab = view.tabId; }
      const seen = C.trackShown(shownIds, view.messages || [], view.asks || []);
      freshIds = seen.fresh; shownIds = seen.shown;
      for (const message of view.messages || []) {
        if (message.role === "thinking") continue;
        if (message.role === "tool") {
          transcript.append(renderTool(message));
        } else if (message.role === "assistant") {
          transcript.append(renderAssistant(message));
        } else if (message.role === "user") {
          transcript.append(renderUser(message));
        } else {
          transcript.append(renderNotice(message));
        }
      }
      renderAsks(view);
      afterRender(view, keep);
    }

    function syncControls(connected) {
      for (const element of asks.querySelectorAll?.("button, input, textarea") || []) element.disabled = !connected;
    }

    return { stage, renderView, syncControls };
  }

  window.OMP_REMOTE_TRANSCRIPT = { createTranscript };
})();
