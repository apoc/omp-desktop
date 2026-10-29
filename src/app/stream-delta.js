// The streaming assistant message, rebuilt from omp's `messageUpdates:
// "delta"` frames (every omp process runs with that filter, set by Rust at
// spawn): a `message_update` carries only its increment, so the content so
// far lives here, on the streaming bubble (`live.js` `_acc`). The same
// projection runs in Rust (`agent/inflight.rs`) for a tab whose replay came
// back `dropped`: `seed` starts a bubble from that copy.
// See docs/architecture/turn-status.md.
(function () {
  /** A block at `index`, created empty when a start event was lost. */
  function blockAt(blocks, index, type, field) {
    if (!blocks[index]) blocks[index] = { type, [field]: "" };
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
        if (!Number.isInteger(i)) return false;
        blocks[i] = { ...ev.block };
        return true;
      case "toolcall_start":
        if (Number.isInteger(i)) blocks[i] = { ...ev.block };
        return false;
      case "text_delta":
      case "thinking_delta": {
        if (!Number.isInteger(i) || typeof ev.delta !== "string") return false;
        const field = ev.type === "text_delta" ? "text" : "thinking";
        const block = blockAt(blocks, i, ev.type === "text_delta" ? "text" : "thinking", field);
        block[field] = (block[field] ?? "") + ev.delta;
        return true;
      }
      case "text_end":
      case "thinking_end": {
        if (!Number.isInteger(i)) return false;
        const field = ev.type === "text_end" ? "text" : "thinking";
        const block = blockAt(blocks, i, field, field);
        // `content` is the final text; `block` adds only what it cannot (a signature).
        Object.assign(block, ev.block, typeof ev.content === "string" ? { [field]: ev.content } : {});
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

  /** What the bubble shows of `blocks`: the last non-blank thinking, and the
   *  non-empty text blocks (one empty text block while there is none yet). */
  function view(blocks) {
    let thought = null;
    const text = [];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === "thinking" && block.thinking?.trim()) thought = block.thinking;
      else if (block.type === "text" && block.text) text.push({ type: "text", text: block.text });
    }
    return { thought, blocks: text.length > 0 ? text : [{ type: "text", text: "" }] };
  }

  window.OMP_STREAM_DELTA = { applyEvent, seed, view };
})();
