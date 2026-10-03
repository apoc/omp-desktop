/* ═════════════════════════════════════════════════════════════════════
   app/message-queue.js — the steer / follow-up queue strip above the
   composer. Pure functions only; live.js keeps the state, and
   design/queue-strip.jsx renders it.

   omp owns the queue. `queue_update` frames and `get_state.queuedMessages`
   carry a full snapshot of queue-chip texts per queue — the first text
   part of each pending user message (templates expanded, a `/skill:` call
   as typed), or "[Image]" for an image-only one. Steering includes
   messages the model already took for the running response, until the
   transcript records them. The desktop renders that snapshot and never
   edits it locally: a ✕ / ↑ / ✎ only takes effect when omp answers
   `removed` / `promoted` and sends the next snapshot.

   The only local state is a "sending" row per steer / follow-up that omp
   has not acknowledged yet. omp acknowledges a message once it has been
   admitted to the queue, which can take seconds when an attached image
   is prepared first.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  const KINDS = ["steering", "followUp"];
  const IMAGE_CHIP = "[Image]";
  const EMPTY_QUEUE = Object.freeze({ steering: Object.freeze([]), followUp: Object.freeze([]) });

  function texts(list) {
    return Array.isArray(list) ? list.filter(t => typeof t === "string") : [];
  }

  function sameList(a, b) {
    return a.length === b.length && a.every((t, i) => t === b[i]);
  }

  /** The queue from a `queue_update` frame or `get_state.queuedMessages`.
   *  Returns `prev` itself when nothing changed (get_state repeats the
   *  queue after every turn), and the shared `EMPTY_QUEUE` when empty. */
  function fromSnapshot(raw, prev = EMPTY_QUEUE) {
    const steering = texts(raw?.steering);
    const followUp = texts(raw?.followUp);
    if (sameList(steering, prev.steering) && sameList(followUp, prev.followUp)) return prev;
    if (steering.length === 0 && followUp.length === 0) return EMPTY_QUEUE;
    return { steering, followUp };
  }

  /** The "sending" row for a steer or follow-up just handed to omp. `chip`
   *  is the queue text omp will most likely list it under; `baseline` how
   *  many entries with that text it must not take for its own: those
   *  already queued, plus earlier sends of the same text still waiting for
   *  omp. The row hides once omp lists one more (see `rows`). A template or
   *  an input hook that rewrites the text only means both rows show until
   *  omp's acknowledgement. */
  function sendingEntry(id, kind, text, imageCount, queue, sending) {
    const chip = text || (imageCount > 0 ? IMAGE_CHIP : "");
    const inFlight = sending.filter(s => s.kind === kind && s.chip === chip).length;
    const queued = queue[kind].filter(t => t === chip).length;
    return { id, kind, chip, baseline: queued + inFlight };
  }

  /** Strip rows, steering first (omp delivers it first), each queue in
   *  omp's order with its unacknowledged sends after it. Keys count
   *  occurrences, so duplicate texts stay distinct rows. `editable`: ✎
   *  could only put the "[Image]" placeholder text back. */
  function rows(queue, sending) {
    const out = [];
    for (const kind of KINDS) {
      const seen = new Map();
      for (const text of queue[kind]) {
        const n = seen.get(text) ?? 0;
        seen.set(text, n + 1);
        out.push({ key: `${kind}\u0000${n}\u0000${text}`, kind, text, sending: false, editable: text !== IMAGE_CHIP });
      }
      for (const s of sending) {
        if (s.kind !== kind || (seen.get(s.chip) ?? 0) > s.baseline) continue;
        out.push({ key: `sending\u0000${s.id}`, kind, text: s.chip, sending: true, editable: false });
      }
    }
    return out;
  }

  /** Draft text after ✎ put a queued message back: the queued text first,
   *  then whatever was already typed — omp's own dequeue order. */
  function restoredDraft(queued, current) {
    return [queued, current].filter(t => t.trim()).join("\n\n");
  }

  /** Transcript note for a steer or follow-up omp refused. The message is
   *  gone from the composer, so the note carries it in a code block (which
   *  has a copy button) that its own text cannot close
   *  (app/marked-setup.js `fenceCode`). */
  function failureNote(kind, error, text) {
    const what = kind === "steering" ? "Steer" : "Follow-up";
    const head = `**${what} not sent:** ${error}`;
    return text ? `${head}\n\n${window.OMP_MARKDOWN.fenceCode(text)}` : head;
  }

  window.OMP_QUEUE = { EMPTY_QUEUE, IMAGE_CHIP, fromSnapshot, sendingEntry, rows, restoredDraft, failureNote };
})();
