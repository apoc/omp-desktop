// mentions.js — pure helpers for the composer's `@`-mention file-path
// autocomplete. No DOM/Tauri access: `composer.jsx` drives the textarea,
// `live.js` drives the IPC call, this file only answers "what's the
// current mention token?" and "what does accepting it produce?".
//
// Wrapped in an IIFE so the top-level `const` declarations don't leak into
// the document's top-level lexical scope (same reason as app/constants.js).

(function () {
  // Find the `@` token, if any, that `caret` sits inside of.
  //
  // A token starts at an `@` that is either at the very beginning of the
  // text or preceded by whitespace/`(` — this is what keeps `a@b` (an
  // email-shaped fragment) from ever triggering the menu, since the `@`
  // there is preceded by an ordinary word character.
  //
  // Only the prefix between the `@` and the caret is returned as `query`
  // — text after the caret is left alone, matching how most editors'
  // word completion behaves when the caret is repositioned mid-token.
  //
  // Returns `null` when the caret isn't inside a mention token.
  function parseMentionQuery(text, caret) {
    if (typeof text !== "string" || typeof caret !== "number") return null;
    if (caret < 0 || caret > text.length) return null;

    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") break;
      if (/\s/.test(ch)) return null; // whitespace before any '@' — no token here
      i--;
    }
    if (i < 0) return null; // no '@' found on this line

    const atIndex = i;
    const before = atIndex > 0 ? text[atIndex - 1] : null;
    const validPrecursor = before === null || /\s/.test(before) || before === "(";
    if (!validPrecursor) return null;

    const query = text.slice(atIndex + 1, caret);
    if (query.includes("@")) return null; // stray second '@' — not a single token

    return { start: atIndex, end: caret, query };
  }

  // Replace the `[range.start, range.end)` span of `text` with
  // `insertText`, returning the new text and the caret position right
  // after the inserted span. The caller decides `insertText`'s shape
  // (trailing space for a file pick, trailing `/` to keep drilling into
  // a directory) — this stays a plain splice.
  function applyMention(text, range, insertText) {
    const { start, end } = range;
    const newText = text.slice(0, start) + insertText + text.slice(end);
    return { text: newText, caret: start + insertText.length };
  }

  Object.assign(window, {
    OMP_MENTIONS: { parseMentionQuery, applyMention },
  });
})();
