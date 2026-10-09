// Tool approvals: pure helpers shared by the approval prompt the human
// answers (design/chat/ask-bubble.jsx) and the row for one a rule answered
// (design/chat/approval-row.jsx, #42).
//
// A tool-approval prompt is a specific `select` omp emits before running an
// exec-tier tool: options exactly ["Approve","Deny"], and a title whose
// *first line* is "Allow tool: <name>". The title is multi-line: omp appends
// an optional "Origin:"/"Reason:" line plus whatever the tool's
// formatApprovalDetails() returns (path, command, content preview — elided
// at 2000 chars), all joined with "\n" (omp tools/approval.ts
// `formatApprovalPrompt`).
//
// Mirrors the Rust-side match in src-tauri/src/approval.rs
// (approval_tool_name + is_valid_tool_name), kept in sync by hand: this is a
// display-only echo of that fingerprint, not a second enforcement point (the
// Rust side is what actually auto-answers). The name grammar is enforced
// here too, so the "remember this" buttons only appear when the grant the
// Rust side receives will be accepted — but an unparseable name only
// withholds those buttons, it never demotes the card back to a generic
// select (the head/details split and its height cap apply to every
// "Allow tool:" prompt).
//
// A prompt a rule covers never reaches the frontend: reader.rs answers it
// on omp's stdin and forwards `{type: "desktop_auto_approval", tool,
// details}` instead, `details` being the title after its first line (null
// when there is none, `\r`s kept). `autoApprovalRow` turns that into a
// transcript row.
//
// Exposes `window.OMP_APPROVAL`; IIFE per the project rule for plain
// <script> tags. Regression: test-approval.mjs.
(function () {
  const TITLE_PREFIX = "Allow tool: ";
  const TOOL_NAME = /^[A-Za-z0-9][\w.:-]{0,63}$/;
  // Detail lines that say where a call comes from, not what it does: the
  // row's one-line summary skips them when the tool gave a detail of its own.
  const CONTEXT_LINE = /^(Origin|Reason): /;
  // A summary longer than this may be cut off by the row's ellipsis, so the
  // row offers its full details even when they are this one line.
  const SUMMARY_MAX = 100;

  /** A prompt title split into its first line and the (possibly empty)
   *  rest. Mirrors Rust `str::lines()` for the first line: only the `\r` of
   *  a CRLF ending is dropped, a lone trailing `\r` stays in the line (and
   *  then fails TOOL_NAME, as is_valid_tool_name rejects it there). The rest
   *  loses every `\r`. */
  function splitTitle(title) {
    const nl = title.indexOf("\n");
    if (nl === -1) return [title, ""];
    return [title.slice(0, nl).replace(/\r$/, ""), title.slice(nl + 1).replace(/\r/g, "")];
  }

  /** `{ tool, head, details }` for an "Allow tool:" prompt, else null.
   *  `tool` is null when the name fails the Rust-side grammar: the card
   *  still renders as an approval (split head, capped details) but offers no
   *  grant, since that grant would be rejected anyway. */
  function approvalInfo(msg) {
    if (typeof msg.title !== "string" || !Array.isArray(msg.options)) return null;
    if (msg.options.length !== 2 || msg.options[0] !== "Approve" || msg.options[1] !== "Deny") {
      return null;
    }
    const [head, details] = splitTitle(msg.title);
    if (!head.startsWith(TITLE_PREFIX)) return null;
    const tool = head.slice(TITLE_PREFIX.length);
    return { tool: TOOL_NAME.test(tool) ? tool : null, head, details };
  }

  /** Transcript row for reader.rs' `desktop_auto_approval` frame. Made by
   *  the desktop, so it carries no `ts` (the get_messages merge keeps it in
   *  place). `details` is "" when the prompt had none. */
  function autoApprovalRow(ev, time) {
    return {
      kind: "approval",
      tool: typeof ev?.tool === "string" ? ev.tool : "",
      details: typeof ev?.details === "string" ? ev.details.replace(/\r/g, "") : "",
      time,
    };
  }

  /** What an approval row shows: `summary`, the first detail line that says
   *  what the call does (an Origin:/Reason: line only when nothing else is
   *  there), and whether there is more to unfold (`expandable`): another
   *  non-empty line, or a summary long enough to be cut off. */
  function rowView(msg) {
    const lines = (msg.details || "").split("\n").map(l => l.trimEnd()).filter(l => l.trim());
    const summary = lines.find(l => !CONTEXT_LINE.test(l)) ?? lines[0] ?? "";
    return { summary, expandable: lines.length > 1 || summary.length > SUMMARY_MAX };
  }

  window.OMP_APPROVAL = { approvalInfo, autoApprovalRow, rowView };
})();
