// Reconcile the saved active branch and model context with a tab's live
// transcript. Bubbles match omp message timestamps, tools match call ids;
// neither may be paired by display position. Desktop-only notes and rows,
// and messages omp dropped from its context, stay where the user saw them.
//
// Exposes `window.OMP_TRANSCRIPT`; IIFE per the project rule for plain
// <script> tags. Regression: test-transcript-merge.mjs.
(function () {
  /** An omp message's `timestamp`, or null: what a live entry and its
   *  get_messages copy both store as `ts`. Every producer goes through this
   *  so the two sides cannot disagree on a key. */
  function tsOf(msg) {
    return Number.isFinite(msg?.timestamp) ? msg.timestamp : null;
  }

  // get_messages is the model's current context, not the saved conversation:
  // compaction and provider filtering can remove tools and earlier turns.
  // Follow the raw snapshot's active ancestry; never include abandoned branches.
  function messagesFromEntries(data) {
    if (!Array.isArray(data?.entries) || !(data.leafId === null || typeof data.leafId === "string")) return null;
    const records = new Map();
    for (const entry of data.entries) {
      if (!entry || typeof entry.id !== "string" || records.has(entry.id)) return null;
      records.set(entry.id, entry);
    }
    const seen = new Set(), messages = [];
    for (let id = data.leafId; id != null;) {
      const entry = records.get(id);
      if (!entry || seen.has(id) || !(entry.parentId === null || typeof entry.parentId === "string")) return null;
      seen.add(id);
      if (entry.type === "message") messages.push(entry.message);
      id = entry.parentId;
    }
    return messages.reverse();
  }

  /** Bubbles identify omp messages by timestamp; tool cards identify the
   *  persisted call/result pair by call id. Desktop-only notes and rows
   *  have neither key and stay in place. */
  function messageKey(m) {
    if (m?.kind === "tool" && m._toolCallId) return `tool:${m._toolCallId}`;
    if (m?.kind !== "user" && m?.kind !== "assistant") return null;
    return Number.isFinite(m.ts) ? `${m.kind}:${m.ts}` : null;
  }

  // `copy` with what only the live bubble knows: its identity, `_id` (the
  // React key, and what per-entry UI state such as app/chat-collapse.js's
  // toggles is keyed by), omp's `retryable` verdict (sent only in the live
  // `prompt_result`, never persisted) and its part in omp's automatic
  // retries (app/turn-status.js) — the `retries` chip of the reply they
  // ended on, with the failure a stopped attempt took from its
  // retry row (the persisted copy of an aborted message carries none), or,
  // for an attempt omp retried but kept in its context (a failed tool-call
  // turn), staying `retried` / `superseded` with its failure still pending.
  function _withLiveFields(copy, live) {
    // Preserve completed live timing/streamed details. A later model-context
    // result without its call must not erase arguments recovered from raw entries.
    if (live.kind === "tool" && live.status !== "running" &&
        (!live._historySource || (live._historySource === "call" && copy._historySource === "result"))) return live;
    let out = live._id == null ? copy : { ...copy, _id: live._id };
    const verdict = live.failure?.retryable;
    if (typeof verdict === "boolean" && copy.failure && copy.failure.retryable !== verdict) {
      out = { ...out, failure: { ...copy.failure, retryable: verdict } };
    }
    if (live.retries) {
      out = { ...out, retries: live.retries };
      if (!out.failure && live.failure && live.retries.outcome === "stopped") out = { ...out, failure: live.failure };
    } else if (live.retried) {
      const { failure, ...rest } = out;
      out = { ...rest, retried: true, ...(live.superseded ? { superseded: true } : {}), ...(failure ? { pendingFailure: failure } : {}) };
    }
    return out;
  }

  // A user bubble `send` showed before omp's echo tied it to a message: the
  // prompt is still on its way, so whatever omp already has comes before it.
  const _inFlight = m => m.kind === "user" && !Number.isFinite(m.ts);

  /** The tab's transcript after a get_messages. A live entry whose message
   *  get_messages returned is replaced by that copy (the ground truth),
   *  keeping what only the live bubble knows (`_withLiveFields`); every
   *  other live entry stays where it is. Persisted entries the live
   *  transcript never showed — frames lost while the tab was in the
   *  background, or the history of a tab that had none yet — go in at their
   *  place in omp's order: before the first live entry whose copy comes
   *  later, or before a later live entry of omp's that was dropped from the
   *  context (it keeps its `ts`), and leftovers before a trailing prompt
   *  still in flight. omp's order, not `ts`: a steer or follow-up carries
   *  the time it was sent but joins the context when it is delivered,
   *  after replies stamped later. With `trimmed` (`_trimMessages` cut the
   *  live transcript's head), entries before the first message both sides
   *  share stay out.
   *  A streaming entry has a copy only if its message ended while its frames
   *  were lost (omp adds a message to the context at `message_end`): that
   *  copy takes its place. Any other streaming entry is left out — the
   *  caller re-appends its streaming bubble. */
  function mergeTranscript(live, persisted, { trimmed = false } = {}) {
    // Include provisional cards when locating a previously trimmed head,
    // even if richer raw calls replace them below.
    const liveKeys = trimmed ? new Set(live.map(messageKey)) : null;
    let first = Infinity;
    // A provider can return results alone in completion order. Replace those
    // provisional cards when raw calls restore invocation order and arguments.
    const recoveredCalls = new Set(persisted.filter(m => m._historySource === "call").map(messageKey));
    live = live.filter(m => m._historySource !== "result" || !recoveredCalls.has(messageKey(m)));
    const slots = new Map(); // key → indices into `persisted`, in omp's order
    persisted.forEach((p, i) => {
      const key = messageKey(p);
      if (!key) return;
      if (liveKeys?.has(key) && i < first) first = i;
      const queue = slots.get(key);
      if (queue) queue.push(i);
      else slots.set(key, [i]);
    });
    const copyOf = live.map(m => slots.get(messageKey(m))?.shift() ?? -1);
    const claimed = new Set(copyOf);
    // Indices into `persisted`, in order, that no live entry stands for.
    const missed = [];
    persisted.forEach((p, i) => {
      if (!claimed.has(i) && !(trimmed && i < first)) missed.push(i);
    });
    // For each live position, the copy index of the next matched entry.
    const nextCopy = new Array(live.length);
    for (let j = live.length - 1, upcoming = Infinity; j >= 0; j--) {
      nextCopy[j] = upcoming;
      if (copyOf[j] !== -1) upcoming = copyOf[j];
    }
    // Where a trailing run of prompts in flight starts.
    let tail = live.length;
    while (tail > 0 && _inFlight(live[tail - 1])) tail--;

    const merged = [];
    let next = 0;
    // Missed entries before index `below` and older than `olderThan`.
    const flush = (below, olderThan = Infinity) => {
      while (next < missed.length && missed[next] < below && !(persisted[missed[next]].ts >= olderThan)) {
        merged.push(persisted[missed[next++]]);
      }
    };
    for (let j = 0; j < tail; j++) {
      const m = live[j];
      const i = copyOf[j];
      if (i === -1) {
        if (m.streaming) continue;
        if (Number.isFinite(m.ts)) flush(nextCopy[j], m.ts);
        merged.push(m);
        continue;
      }
      flush(i);
      merged.push(_withLiveFields(persisted[i], m));
    }
    flush(Infinity);
    // The prompts in flight have no copy and are never streaming.
    merged.push(...live.slice(tail));
    return merged;
  }

  window.OMP_TRANSCRIPT = Object.freeze({ tsOf, messagesFromEntries, mergeTranscript });
})();
