// The streaming assistant message, rebuilt from omp's `messageUpdates:
// "delta"` frames (every omp process runs with that filter, set by Rust at
// spawn): a `message_update` carries only its increment, so the content so
// far is kept by `live.js` in `streamAcc`, off the bubble the transcript and
// the phone carry. The same projection runs in Rust (`agent/inflight.rs`) for
// a tab whose replay came back `dropped`: `accFor` starts the message from
// that copy. See docs/architecture/turn-status.md.
(function () {
  /** The `field` ("text" | "thinking") block at `index`, created empty when
   *  its start event was lost. */
  function blockAt(blocks, index, field) {
    if (!blocks[index]) blocks[index] = { type: field, [field]: "" };
    return blocks[index];
  }

  /**
   * Apply one delta `assistantMessageEvent` to `blocks` (the message's content
   * so far, changed in place). Returns `true` when what the bubble shows —
   * text or thinking — may have changed, so a tool call's streamed arguments
   * (shown by its card, from `tool_execution_*`) never cost a render.
   */
  function applyEvent(blocks, ev) {
    const i = ev?.contentIndex;
    switch (ev?.type) {
      case "start":
        // A restarted message: the frame carries it whole.
        blocks.length = 0;
        for (const b of seed(ev.message)) blocks.push(b);
        return true;
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
        if (!Number.isInteger(i)) return false;
        blocks[i] = { ...ev.block };
        return ev.type !== "toolcall_start";
      case "text_delta":
      case "thinking_delta": {
        if (!Number.isInteger(i) || typeof ev.delta !== "string") return false;
        const field = ev.type === "text_delta" ? "text" : "thinking";
        const block = blockAt(blocks, i, field);
        block[field] = (block[field] ?? "") + ev.delta;
        return true;
      }
      case "text_end":
      case "thinking_end": {
        if (!Number.isInteger(i)) return false;
        const field = ev.type === "text_end" ? "text" : "thinking";
        // `content` is the final text; `block` adds only what it cannot (a signature).
        Object.assign(blockAt(blocks, i, field), ev.block, typeof ev.content === "string" ? { [field]: ev.content } : {});
        return true;
      }
      case "toolcall_end":
        if (Number.isInteger(i) && ev.toolCall) blocks[i] = ev.toolCall;
        return false;
      case "image_end":
        if (Number.isInteger(i) && ev.content) blocks[i] = ev.content;
        return false;
      default:
        // toolcall_delta, done, error: nothing the bubble shows.
        return false;
    }
  }

  /** Blocks to stream into, starting from `message`'s content (copied, so
   *  applying events never changes the message they came from). */
  function seed(message) {
    return Array.isArray(message?.content) ? message.content.map(b => (b && typeof b === "object" ? { ...b } : b)) : [];
  }

  /** What the bubble shows of `blocks`: the last non-blank thinking (and the
   *  `lead` it gives), and the non-empty text blocks (one empty text block
   *  while there is none yet). */
  function view(blocks) {
    let thought = null;
    const text = [];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === "thinking" && block.thinking?.trim()) thought = block.thinking;
      else if (block.type === "text" && block.text) text.push({ type: "text", text: block.text });
    }
    return { thought, lead: thought ? "thinking" : null, blocks: text.length > 0 ? text : [{ type: "text", text: "" }] };
  }

  /**
   * The accumulator a frame of omp message `mid` (journal `seq`) streams
   * into, given the current one (`acc`: `{ mid, blocks, seed }`, or null) and
   * the backend's copy a dropped replay loaded (`snap`: `{ messageId, seq,
   * message }`, or null). Returns `{ acc, changed, skip }`:
   * - another message than `acc`'s starts afresh, from `snap` when it is that
   *   message's copy (after lost frames a bubble left streaming shows the
   *   next message);
   * - a copy `acc` was not seeded from (a later dropped replay, a tab left
   *   mid-message) replaces its blocks: it holds everything up to its `seq`;
   * - `skip`: the frame is at or below the copy's `seq`, already in it.
   * `seed` is the copy object itself, not a flag, so every new dropped replay
   * reseeds — also a tab restored with an older seed.
   */
  function accFor(acc, mid, snap, seq) {
    const copy = snap && snap.messageId === mid ? snap : null;
    let next = acc;
    if (!acc || acc.mid !== mid || (copy && acc.seed !== copy)) {
      next = { mid, blocks: copy ? seed(copy.message) : [], seed: copy };
    }
    return { acc: next, changed: next !== acc, skip: !!copy && seq <= copy.seq };
  }

  window.OMP_STREAM_DELTA = { applyEvent, seed, view, accFor };
})();
