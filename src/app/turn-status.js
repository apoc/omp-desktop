// Turn status: pure helpers behind a tab's run state and the outcome of its
// turns, fed by omp's `prompt_result` / `session_settled` frames, the
// `agent_end` yield flags, `get_state.hasPendingAsyncWork` (all omp ≥
// 18.3.1) and the automatic-retry frames `auto_retry_start` /
// `auto_retry_end`. live.js owns the state; this file only decides.
//
// Exposes `window.OMP_TURN_STATUS`; IIFE per the project rule for plain
// <script> tags. Regression: test-turn-status.mjs.
(function () {
  /** A tab's run state, the strongest condition first:
   *  - `failed`: the omp process exited with a reason; outranks a stale ask
   *    left open by a process that died mid-turn.
   *  - `waiting-user`: an unanswered ask. Asks arrive mid-turn while
   *    `isStreaming` is still true, so this must outrank `running`.
   *  - `retrying`: omp is retrying a failed request (a live retry row); it
   *    covers the wait between attempts, when no turn streams.
   *  - `running`: a turn is streaming.
   *  - `background`: the agent yielded, but omp reports background work (an
   *    async bash, task or eval job) whose result will wake it again.
   *  - `idle`. */
  function runStateOf({ isStreaming, exitReason, messages, asyncPending }) {
    if (exitReason) return "failed";
    // One pass: this runs on every streaming delta of the active tab.
    let retrying = false;
    for (const m of messages) {
      if (m.kind === "ask" && !m.answered && !m.cancelled) return "waiting-user";
      if (m.kind === "retry" && !m.ended) retrying = true;
    }
    if (retrying) return "retrying";
    if (isStreaming) return "running";
    if (asyncPending) return "background";
    return "idle";
  }

  // Run states in which the agent is still at work: mid-turn, retrying a
  // failed request, waiting on the user, or waiting on a background job
  // that will wake it. A `failed` tab has no live process left.
  const BUSY_RUN_STATES = new Set(["running", "retrying", "waiting-user", "background"]);
  const isBusyRunState = runState => BUSY_RUN_STATES.has(runState);

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

  // ── Automatic retries (`auto_retry_start` / `auto_retry_end`) ─────────────
  // omp retries a failed request by itself: it drops the failed attempt from
  // the conversation, waits `delayMs` and sends it again. The run shows one
  // `retry` row while that goes on, at the end of the transcript.

  // `finalError` of a retry cancelled between attempts by `abort_retry` or
  // `abort` (turn-recovery.ts `#endCancelledRetry`).
  const RETRY_CANCELLED = "Retry cancelled";

  const _count = v => (Number.isInteger(v) && v > 0 ? v : null);

  /** An assistant message that did not answer: it failed or was stopped. */
  const failedStop = m => m?.stopReason === "error" || m?.stopReason === "aborted";

  const _hasText = c => typeof c?.text === "string" && c.text.trim().length > 0;
  const _actionable = c => {
    switch (c?.type) {
      case "toolCall": case "image": case "redactedThinking": case "anthropicServerTool": return true;
      case "text": return _hasText(c);
      case "thinking": return typeof c.thinkingSignature === "string" && c.thinkingSignature.trim().length > 0;
      default: return false;
    }
  };

  /** Whether an assistant message answered, by omp's own rule
   *  (`assistantTurnProducedOutput`, session/messages.ts): not failed or
   *  stopped, with actionable content — non-blank text, a tool call, an
   *  image, server-tool or redacted thinking, or signed thinking — and a
   *  `toolUse` stop with a tool call or text. omp keeps retrying after
   *  anything else, such as an empty stop, so that ends no retries. */
  function producedOutput(m) {
    if (m?.role !== "assistant" || failedStop(m) || !Array.isArray(m.content)) return false;
    if (m.stopReason === "toolUse" && !m.content.some(c => c?.type === "toolCall" || (c?.type === "text" && _hasText(c)))) return false;
    return m.content.some(_actionable);
  }

  /** Entries the transcript keeps but does not show: a failed attempt omp
   *  retried that showed nothing (`retryStarted`), and a retry row omp
   *  already ended (`retryEnded`), until the run's yield removes it. */
  const isHidden = m => !!m.superseded || (m.kind === "retry" && !!m.ended);

  /** Index of the run's retry row, or -1. */
  function retryIndex(messages) {
    return messages.findLastIndex(m => m.kind === "retry");
  }

  /** A bubble that shows nothing of its own: no thinking, no non-empty text. */
  const _blank = m => !m.thought && (m.blocks ?? []).every(b => b.type === "text" && !b.text?.trim());

  /** `auto_retry_start`: the request just failed and will be sent again. Its
   *  bubble (the last one holding a `pendingFailure`, or `aborted`: omp also
   *  retries a stream that stalled or dropped without content) is marked
   *  `retried`, and hidden (`superseded`) when it showed nothing — one that
   *  streamed text before failing stays. The retry row moves to the end,
   *  waiting for the next attempt. `now`: when the frame arrived (ms). */
  function retryStarted(messages, ev, now) {
    const out = [...messages];
    let failure = null;
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.kind === "user") break;
      if (m.kind === "assistant" && (m.pendingFailure || m.aborted) && !m.retried) {
        failure = m.pendingFailure;
        out[i] = { ...m, retried: true, ...(_blank(m) ? { superseded: true } : {}) };
        break;
      }
    }
    const ri = retryIndex(out);
    const prev = ri === -1 ? null : out.splice(ri, 1)[0];
    const raw = _text(ev.errorMessage);
    out.push({
      kind: "retry",
      ...(prev?._id ? { _id: prev._id } : {}),
      attempt: _count(ev.attempt) ?? (prev?.attempt ?? 0) + 1,
      // Failures seen, one per frame: omp's own `attempt` restarts after a
      // fallback model takes over and survives an `abort` mid-attempt.
      failed: (prev?.failed ?? 0) + 1,
      maxAttempts: _count(ev.maxAttempts),
      phase: "waiting",
      since: now,
      delayMs: Number.isFinite(ev.delayMs) && ev.delayMs > 0 ? ev.delayMs : 0,
      failure: failure ?? (raw ? _failure({ raw: stripDiagnostics(raw).trim(), httpStatus: null, provider: null, model: null, retryable: null }) : prev?.failure ?? null),
      firstFailedAt: prev?.firstFailedAt ?? now,
      ended: null,
    });
    return out;
  }

  /** A turn starts while the row waits: omp sent the next attempt, which is
   *  in flight until the provider answers. Any other turn leaves `messages`. */
  function retryAttempting(messages, now) {
    const ri = retryIndex(messages);
    if (ri === -1 || messages[ri].phase !== "waiting" || messages[ri].ended) return messages;
    const out = [...messages];
    out[ri] = { ...messages[ri], phase: "attempting", since: now };
    return out;
  }

  /** `auto_retry_end` records how the retries ended, which hides the row and
   *  ends the `retrying` state; the run's final `agent_end` removes it
   *  (`retryFinished`). It comes before that `agent_end` when the retries
   *  were cancelled or gave up. On success the row is already gone: the
   *  answering message finished it, and this frame follows even the run's
   *  `agent_end` (measured on omp 18.6.0). */
  function retryEnded(messages, ev) {
    const ri = retryIndex(messages);
    if (ri === -1) return messages;
    const out = [...messages];
    out[ri] = {
      ...messages[ri],
      ended: { cancelled: ev.finalError === RETRY_CANCELLED },
    };
    return out;
  }

  /** The retries are over: remove the row and record on the reply they
   *  ended on how they went, `retries: {failed, outcome}` — `recovered` (it
   *  answered after `failed` failed attempts), `failed` (omp gave up) or
   *  `stopped` (cancelled). Called with the answering assistant message at
   *  its `message_end` (more turns may follow in the same run), and at the
   *  run's yield through `retryYielded`; `ts` is `last`'s timestamp. A reply
   *  a retry had hidden is shown again (a cancel between attempts ends the
   *  run on the attempt that just failed), and a reply that did not recover
   *  shows its failure now — runs no prompt started get no `prompt_result`
   *  to reveal it — or, for an attempt stopped in flight, which records no
   *  error, the row's. Without `last` the retries did not recover: an
   *  answering message would have finished the row at its `message_end`. */
  function retryFinished(messages, last, ts) {
    const ri = retryIndex(messages);
    if (ri === -1) return messages;
    const row = messages[ri];
    const out = messages.filter((_, i) => i !== ri);
    let fi = ts == null ? -1 : out.findLastIndex(m => m.kind === "assistant" && m.ts === ts);
    // An answer whose bubble is missing (its message_start fell out of the
    // replay journal) must not tag the hidden failed attempt before it.
    if (fi === -1 && last && !failedStop(last)) return out;
    if (fi === -1) {
      for (let i = out.length - 1; i >= 0; i--) {
        // Only a prompt omp accepted (echoed, so it has a `ts`) starts a new
        // run: one it refused while the row waited does not.
        if (out[i].kind === "user" && out[i].ts != null) break;
        // Before the row only the attempt whose failure started it can be the
        // final one (`retried`); an earlier reply that answered never is, even
        // when the failed attempt's own bubble was lost to a replay gap.
        // Desktop notes (no `ts`) are no attempt.
        if (out[i].kind === "assistant" && !out[i].streaming && out[i].ts != null) {
          if (i >= ri || out[i].retried) fi = i;
          break;
        }
      }
    }
    if (fi === -1) return out;
    const fin = out[fi];
    const stop = last?.stopReason ?? (fin.pendingFailure || fin.failure ? "error" : "aborted");
    const outcome = row.ended?.cancelled || stop === "aborted" ? "stopped"
      : stop === "error" ? "failed"
      : "recovered";
    // One failure per `auto_retry_start`; a final failure that started no
    // retry (omp gave up) is one more.
    const failed = row.failed + (outcome === "failed" && !fin.retried ? 1 : 0);
    const { superseded, pendingFailure, ...shown } = fin;
    const failure = outcome === "recovered" ? null
      : fin.failure ?? pendingFailure ?? (outcome === "stopped" ? row.failure : null);
    out[fi] = {
      ...shown,
      retries: { failed, outcome },
      ...(failure ? { failure } : pendingFailure ? { pendingFailure } : {}),
    };
    return out;
  }

  /** The run yielded with its retry row still there. `last` is the run's
   *  last assistant message (`agent_end.messages`), which may leave out the
   *  attempt the run ended on (measured): then it can be an earlier reply
   *  that answered before a later request failed. Only a failed or aborted
   *  `last` names the final attempt; otherwise the run's last bubble is it. */
  function retryYielded(messages, last, ts) {
    const final = failedStop(last);
    return retryFinished(messages, final ? last : null, final ? ts : null);
  }

  /** The row with nothing left to end it (the process died): removed. */
  function retryCleared(messages) {
    const ri = retryIndex(messages);
    return ri === -1 ? messages : messages.filter((_, i) => i !== ri);
  }

  window.OMP_TURN_STATUS = Object.freeze({
    runStateOf, isBusyRunState, isYield, stripDiagnostics, providerHeadline, failureOf, finalFailures,
    withPromptError, finishedJobsOf,
    failedStop, producedOutput, isHidden, retryIndex, retryStarted, retryAttempting, retryEnded, retryFinished, retryYielded, retryCleared,
  });
})();
