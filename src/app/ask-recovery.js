/* Restore ask-tool questions, not dead extension callbacks. Replies become
   ordinary user prompts; no tool, approval or model call runs on recovery. */
(function () {
  const EXIT_ERROR = "Previous OMP process exited before completing the turn.";
  const EXIT_RESULT =
    "Previous OMP process exited before this tool returned; its outcome is unknown.";

  function interruptedResult(message) {
    return (
      message.isError === true &&
      message.content?.length === 1 &&
      message.content[0]?.type === "text" &&
      message.content[0].text === EXIT_RESULT
    );
  }

  // Only the current unanswered batch. A later user message, completed turn,
  // explicit abort or ordinary error supersedes it. The caller supplies only
  // the active branch, so abandoned branches never enter this scan.
  function pending(messages) {
    if (!Array.isArray(messages)) return [];
    const results = new Map();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      if (message.role === "toolResult") {
        if (!results.has(message.toolCallId))
          results.set(message.toolCallId, message);
      } else if (
        message.role === "user" ||
        (message.role === "custom" && message.attribution === "user")
      ) {
        return [];
      } else if (message.role === "assistant") {
        if (
          message.stopReason === "aborted" &&
          message.errorMessage === EXIT_ERROR
        )
          continue;
        if (message.stopReason !== "toolUse" && message.stopReason !== "stop")
          return [];
        return (Array.isArray(message.content) ? message.content : []).flatMap(
          (call) => {
            if (
              call.type !== "toolCall" ||
              call.name !== "ask" ||
              typeof call.id !== "string" ||
              !call.id
            )
              return [];
            const result = results.get(call.id);
            if (result && !interruptedResult(result)) return [];
            const questions = window.OMP_ASK_DIALOG.parseQuestions(
              call.arguments?.questions,
            );
            return questions ? [{ callId: call.id, questions }] : [];
          },
        );
      }
    }
    return [];
  }

  function dismissalKey(file) {
    return `omp-desktop:ask-dismissed:${JSON.stringify(file)}`;
  }

  function readDismissals(file) {
    const saved = JSON.parse(
      window.localStorage?.getItem(dismissalKey(file)) ?? "[]",
    );
    if (!Array.isArray(saved) || saved.some((id) => typeof id !== "string"))
      throw new Error("Invalid saved question cancellations.");
    return saved;
  }

  // Unlike the visual tree's permissive index, recovery refuses broken
  // ancestry: guessing a root could reopen an abandoned question.
  function fromEntries(data, file) {
    if (!Array.isArray(data?.entries) || typeof data.leafId !== "string")
      return null;
    const byId = new Map();
    for (const entry of data.entries) {
      if (!entry || typeof entry.id !== "string" || byId.has(entry.id))
        return null;
      byId.set(entry.id, entry);
    }
    const seen = new Set(),
      messages = [];
    for (let id = data.leafId; id != null;) {
      const entry = byId.get(id);
      if (!entry || seen.has(id)) return null;
      seen.add(id);
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "custom_message" && entry.attribution === "user")
        messages.push({ role: "user" });
      id = entry.parentId;
    }
    return restore(messages.reverse(), file);
  }

  function restore(messages, file) {
    let dismissed;
    try {
      dismissed = new Set(readDismissals(file));
    } catch {
      dismissed = new Set();
    } // Storage failure must never hide a question.
    const calls = pending(messages).filter((q) => !dismissed.has(q.callId));
    if (!calls.length) return null;
    const callIds = calls.map((q) => q.callId);
    return {
      id: `restored-ask:${JSON.stringify(callIds)}`,
      questions: calls.flatMap((call, i) =>
        call.questions.map((q) => ({ ...q, id: `${i}:${q.id}` })),
      ),
      recovery: { file, callIds },
    };
  }

  function dismiss(file, callIds) {
    const storage = window.localStorage;
    if (!storage)
      throw new Error("Question cancellation storage is unavailable.");
    const ids = new Set([...readDismissals(file), ...callIds]);
    storage.setItem(dismissalKey(file), JSON.stringify([...ids]));
  }

  function reply(questions, answers) {
    if (!Array.isArray(answers) || answers.length !== questions.length)
      return null;
    const pairs = [];
    for (const [i, q] of questions.entries()) {
      const a = answers[i];
      if (
        !a ||
        a.id !== q.id ||
        !Array.isArray(a.selectedOptions) ||
        a.selectedOptions.some(
          (label) => !q.options.some((o) => o.label === label),
        ) ||
        new Set(a.selectedOptions).size !== a.selectedOptions.length ||
        (a.customInput !== undefined && typeof a.customInput !== "string")
      )
        return null;
      const text = a.customInput?.trim() || null;
      if (
        !q.multi &&
        (a.selectedOptions.length > 1 ||
          (a.selectedOptions.length && text) ||
          (!a.selectedOptions.length && !text))
      )
        return null;
      pairs.push({
        question: q.question,
        selectedOptions: a.selectedOptions,
        ...(text ? { customInput: text } : {}),
      });
    }
    // These are answers, not slash/skill commands or harness tags. Escaping
    // slashes also keeps /skill: tokens in quoted question text inert in omp.
    const data = JSON.stringify(pairs, null, 2).replace(
      /[\/<>]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return `My answers to the questions left pending before OMP Desktop restarted are below as JSON data. Continue from these answers without repeating completed work.\n\n${data}`;
  }

  window.OMP_ASK_RECOVERY = { fromEntries, dismiss, reply };
})();
