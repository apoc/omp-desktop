// Turn status: pure helpers behind a tab's run state and the outcome of its
// turns, fed by omp's `prompt_result` / `session_settled` frames, the
// `agent_end` yield flags and `get_state.hasPendingAsyncWork` (all omp ≥
// 18.3.1). live.js owns the state; this file only decides.
//
// Exposes `window.OMP_TURN_STATUS`; IIFE per the project rule for plain
// <script> tags. Regression: test-turn-status.mjs.
(function () {
  /** A tab's run state, the strongest condition first:
   *  - `failed`: the omp process exited with a reason; outranks a stale ask
   *    left open by a process that died mid-turn.
   *  - `waiting-user`: an unanswered ask. Asks arrive mid-turn while
   *    `isStreaming` is still true, so this must outrank `running`.
   *  - `running`: a turn is streaming.
   *  - `background`: the agent yielded, but omp reports background work (an
   *    async bash, task or eval job) whose result will wake it again.
   *  - `idle`. */
  function runStateOf({ isStreaming, exitReason, messages, asyncPending }) {
    if (exitReason) return "failed";
    if (messages.some(m => m.kind === "ask" && !m.answered && !m.cancelled)) return "waiting-user";
    if (isStreaming) return "running";
    if (asyncPending) return "background";
    return "idle";
  }

  /** Whether an `agent_end` is the agent yielding its turn. `yielded: false`
   *  ends are the agent's own continuations (a retry, compaction, a
   *  stop-time reminder); frames without the field count when terminal —
   *  the rule omp's RpcPromptResults applies before writing `prompt_result`. */
  function isYield(ev) {
    return !!ev && ev.type === "agent_end" && (ev.yielded ?? ev.isTerminal !== false);
  }

  // omp appends these lines to a 400/413 error for its own request dumps
  // (`appendRawHttpRequestDumpFor400`) and strips them before relaying the
  // error over RPC (`stripRawHttpRequestDiagnostics`); a persisted message
  // still carries them.
  const DUMP_LINE_PREFIXES = ["raw-http-request=", "raw-http-request-save-failed="];

  /** `text` without omp's trailing request-dump lines. */
  function stripDiagnostics(text) {
    const lines = text.split("\n");
    let end = lines.length;
    while (end > 0 && DUMP_LINE_PREFIXES.some(p => lines[end - 1].startsWith(p))) end--;
    return end === lines.length ? text : lines.slice(0, end).join("\n");
  }

  /** The provider's own words from an error text. Most providers wrap them
   *  in a JSON body behind the status (`401 {"type":"error","error":{"type":
   *  "authentication_error","message":"invalid x-api-key"}}` →
   *  `authentication_error: invalid x-api-key`); anything else yields its
   *  first non-empty line. */
  function providerHeadline(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const err = JSON.parse(text.slice(start, end + 1))?.error;
        if (err && typeof err.message === "string" && err.message.trim()) {
          const kind = typeof err.type === "string" && err.type.trim() ? `${err.type.trim()}: ` : "";
          return kind + err.message.trim();
        }
      } catch { /* not a JSON body */ }
    }
    return text.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  }

  const _text = v => (typeof v === "string" && v.trim() ? v.trim() : null);

  // omp's own text for a failed message without one (rpc-prompt-results.ts).
  const UNKNOWN_FAILURE = "Provider request failed";

  function _failure({ raw, httpStatus, provider, model, retryable }) {
    return { raw, headline: providerHeadline(raw) || raw, httpStatus, provider, model, retryable };
  }

  /** The failure an assistant message records (`stopReason: "error"`), or
   *  null for any other message. `retryable` is unknown here: omp sends its
   *  classification only in the live `prompt_result`. */
  function failureOf(message) {
    if (!message || message.role !== "assistant" || message.stopReason !== "error") return null;
    const raw = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? stripDiagnostics(message.errorMessage).trim()
      : UNKNOWN_FAILURE;
    return _failure({
      raw,
      httpStatus: Number.isInteger(message.errorStatus) ? message.errorStatus : null,
      provider: _text(message.provider),
      model: _text(message.model),
      retryable: null,
    });
  }

  // omp's hidden follow-up when an extension's `session_stop` hook blocks
  // the stop (agent-session.ts `#emitSessionStopEvent`): the agent goes on
  // in the same run (`agent_end` with `yielded: false`).
  const CONTINUES_RUN = "session-stop-continuation";

  /** The failures a get_messages transcript shows: index → failure for each
   *  failed assistant message that ended its run — no other assistant
   *  message follows it before the next prompt (`user`) or another `custom`
   *  message (a job wake-up, a skill call, a hidden follow-up). omp keeps
   *  some failed attempts it then continued from (a preserved tool turn, a
   *  stream-stall continuation, an extension's `session_stop` hook pushing
   *  a hidden `session-stop-continuation` — the one custom message that
   *  continues the same run), and marks recovered or superseded retries
   *  with `retryRecovery`; none of them failed the turn. */
  function finalFailures(messages) {
    const out = new Map();
    let assistantAfter = false;
    for (let i = (Array.isArray(messages) ? messages.length : 0) - 1; i >= 0; i--) {
      const m = messages[i];
      const role = m?.role;
      if (role === "user" || (role === "custom" && m.customType !== CONTINUES_RUN)) {
        assistantAfter = false;
      } else if (role === "assistant") {
        const failure = assistantAfter || m.retryRecovery ? null : failureOf(m);
        if (failure) out.set(i, failure);
        assistantAfter = true;
      }
    }
    return out;
  }

  /** `failure` (or null) updated from a `prompt_result` error — `{message,
   *  provider?, model?, httpStatus?, retryable}`, omp's cleaned text and its
   *  verdict on whether the failure is transient. */
  function withPromptError(failure, error) {
    if (!error || typeof error !== "object") return failure;
    const raw = _text(error.message) ?? failure?.raw ?? UNKNOWN_FAILURE;
    return _failure({
      raw,
      httpStatus: Number.isInteger(error.httpStatus) ? error.httpStatus : failure?.httpStatus ?? null,
      provider: _text(error.provider) ?? failure?.provider ?? null,
      model: _text(error.model) ?? failure?.model ?? null,
      retryable: typeof error.retryable === "boolean" ? error.retryable : failure?.retryable ?? null,
    });
  }

  /** The background jobs an `async-result` custom message delivers —
   *  `[{jobId, type, label, durationMs}]`, the message that wakes the agent
   *  after it yielded — or null for any other message. */
  function finishedJobsOf(message) {
    if (!message || message.role !== "custom" || message.customType !== "async-result") return null;
    if (message.display === false) return null;
    const jobs = Array.isArray(message.details?.jobs) ? message.details.jobs : [];
    const out = jobs.flatMap(j => {
      const jobId = _text(j?.jobId);
      return jobId ? [{
        jobId,
        type: _text(j.type),
        label: _text(j.label),
        durationMs: Number.isFinite(j.durationMs) && j.durationMs >= 0 ? j.durationMs : null,
      }] : [];
    });
    return out.length > 0 ? out : null;
  }

  window.OMP_TURN_STATUS = Object.freeze({
    runStateOf, isYield, stripDiagnostics, providerHeadline, failureOf, finalFailures,
    withPromptError, finishedJobsOf,
  });
})();
