/* ═════════════════════════════════════════════════════════════════════
   app/file-comments.js — pure helpers of the files panel
   (docs/architecture/file-comments.md): the per-tab marks (explain or
   comment on lines of a project file), the composer chip label, the text
   the marks add to the outgoing message, the stale check, and the views of
   the git browser's tree the panel shows (the tab folder's subtree, only
   the commented files, @-mention search hits).

   A mark is `{ id, n, path, from, to, kind, text, selection, lines }`:
   `path` is relative to the tab's folder ("/"-separated, Rust's
   `FilePreview.path`), `from`/`to` 1-based inclusive, `kind` "explain" or
   "comment" (`text` only for a comment), `selection` the selected text when
   the mark was made on a text selection (null for picked lines), `lines`
   the marked lines as they were (the stale check), `n` its number in the
   tab (assigned by the chip store).

   The per-tab store is OMP_BROWSER's chip store (`EMPTY`, `chipsOf`,
   `addChip`, `removeChips`, `restoreChips`: same numbering rule), read at
   call time. Exposes `window.OMP_FILE_COMMENTS`; IIFE per AGENTS.md
   (tests/test-file-comments.mjs).
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Characters of a selection quoted in the message and the chip.
  const SELECTION_MAX = 120;
  const CHIP_SELECTION_MAX = 28;
  const CHIP_TEXT_MAX = 40;

  const HEADER = "File comments (paths relative to the project folder, line numbers 1-based; read the lines before answering):";
  const EXPLAIN = "Explain this code.";

  const browser = () => window.OMP_BROWSER;
  const NO_MARKS = Object.freeze([]);

  // ── Store ──────────────────────────────────────────────────────────────

  const marksOf = (s, sid) => browser().chipsOf(s, sid);
  const addMark = (s, sid, mark) => browser().addChip(s, sid, mark);
  const removeMarks = (s, sid, ids) => browser().removeChips(s, sid, ids);
  const restoreMarks = (s, sid, list) => browser().restoreChips(s, sid, list);

  /** Mark `id` of tab `sid` with `patch` merged in; `s` itself when the tab
   *  has no such mark. */
  function updateMark(s, sid, id, patch) {
    return window.OMP_SESSION_UI.updateEntry(s, sid, NO_MARKS, (list) => {
      const i = list.findIndex((m) => m.id === id);
      if (i < 0) return list;
      const next = list.slice();
      next[i] = { ...list[i], ...patch };
      return next;
    });
  }

  // ── Text ───────────────────────────────────────────────────────────────

  const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  /** `path:from` or `path:from-to`: omp's read selector form. */
  const location = (m) => (m.to > m.from ? `${m.path}:${m.from}-${m.to}` : `${m.path}:${m.from}`);

  /** A selection as one line, at most SELECTION_MAX characters. */
  const selectionText = (s) => cut(oneLine(s), SELECTION_MAX);

  /** `s` as markdown inline code: a backtick fence longer than any run
   *  inside, padded when `s` starts or ends with a backtick. */
  function inlineCode(s) {
    const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
    const fence = "`".repeat(longest + 1);
    const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
    return `${fence}${pad}${s}${pad}${fence}`;
  }

  /** One mark's block. The path and the comment have their commands
   *  neutralised (OMP_BROWSER.neutralise: a comment must not turn a send
   *  into a skill call); the selection is file content, so its `@` is
   *  escaped too (neutralisePage), or omp would read `@decorator` as a file
   *  mention. The comment keeps the user's own `@file` mentions. */
  function markText(m) {
    const { neutralise, neutralisePage } = browser();
    const where = neutralise(location(m));
    const head = m.selection
      ? `#${m.n} ${where}, the text ${inlineCode(neutralisePage(selectionText(m.selection)))}`
      : `#${m.n} ${where}`;
    const body = m.kind === "explain" ? EXPLAIN : `Comment: ${neutralise(m.text ?? "")}`;
    return `${head}\n${body}`;
  }

  /** The typed text with every mark's block appended (in number order),
   *  under HEADER; `text` unchanged without marks. */
  function mergeIntoMessage(text, marks) {
    if (!marks.length) return text;
    const blocks = [...marks].sort((a, b) => a.n - b.n).map(markText).join("\n\n");
    const base = text.trim();
    const all = `${HEADER}\n\n${blocks}`;
    return base ? `${base}\n\n${all}` : all;
  }

  /** The composer chip: `#1 live.js:12-14 — explain` or
   *  `#2 live.js:9 "isCmd…" — "rename this…"`. `explainWord` is the
   *  caller's translation of "explain". */
  function chipLabel(m, explainWord) {
    const name = m.path.split("/").pop();
    const where = location({ ...m, path: name });
    const sel = m.selection ? ` "${cut(oneLine(m.selection), CHIP_SELECTION_MAX)}"` : "";
    const what = m.kind === "explain" ? explainWord : `"${cut(oneLine(m.text), CHIP_TEXT_MAX)}"`;
    return `#${m.n} ${where}${sel} — ${what}`;
  }

  // ── Stale check ──────────────────────────────────────────────────────

  /** Whether the marked lines differ from what they were when marked:
   *  `lines` is the file now, one string per line. */
  function isStale(m, lines) {
    if (m.to > lines.length) return true;
    for (let i = 0; i < m.lines.length; i++) if (lines[m.from - 1 + i] !== m.lines[i]) return true;
    return false;
  }

  // ── Counts ───────────────────────────────────────────────────────────

  /** `{ explain, comment, files, byPath }`: marks per kind, distinct files
   *  and a Map path → number of marks. */
  function counts(marks) {
    const byPath = new Map();
    let explain = 0;
    for (const m of marks) {
      byPath.set(m.path, (byPath.get(m.path) ?? 0) + 1);
      if (m.kind === "explain") explain++;
    }
    return { explain, comment: marks.length - explain, files: byPath.size, byPath };
  }

  // ── Paths and trees ──────────────────────────────────────────────────

  const ABSOLUTE = /^(?:\/|[a-z]:\/)/i;

  /** `path` relative to `folder` ("/"-separated, `./` dropped), or null
   *  when it is absolute outside it. A relative path is taken as already
   *  relative to the folder (omp's tool paths are). */
  function relativeTo(folder, path) {
    const p = String(path ?? "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    if (!p) return null;
    if (!ABSOLUTE.test(p)) return p;
    const { normPath } = window.OMP_PROJECT_NAV;
    const base = normPath(folder ?? "");
    if (!base) return null;
    const prefix = base === "/" ? "/" : `${base}/`;
    return normPath(p).startsWith(prefix) ? p.slice(prefix.length) : null;
  }

  const rebased = (node, prefix) => ({
    ...node,
    path: node.path.slice(prefix.length),
    children: node.children.map((c) => rebased(c, prefix)),
  });

  /** The git browser's tree (paths relative to the work tree) cut to the
   *  tab's folder, given as Rust's `StatusView.folder` (the folder relative
   *  to the work tree, "/"-separated, "" for the work tree itself), with
   *  paths relative to the folder: what `project_file_read` and the agent
   *  take. The whole tree for "", an empty root when the folder holds no
   *  tracked or untracked file, null when Rust could not place the folder.
   *  A folder name matches exactly, else — with `foldCase`, on a file
   *  system that ignores case (Windows, macOS) — without case: the folder's
   *  case on disk may differ from the index's there. */
  function folderTree(root, folder, foldCase = false) {
    if (!root || folder == null) return null;
    if (folder === "") return root;
    let node = root;
    for (const part of folder.split("/")) {
      const dirs = node.children.filter((c) => c.dir);
      node = dirs.find((c) => c.name === part)
        ?? (foldCase ? dirs.find((c) => c.name.toLowerCase() === part.toLowerCase()) : undefined);
      if (!node) return { name: "", path: "", dir: true, status: null, changed: 0, children: [] };
    }
    return { ...rebased(node, `${node.path}/`), name: "", path: "" };
  }

  /** `root` pruned to the files in `paths` (a Set) and the directories
   *  holding them; null when none is in the tree. */
  function onlyFiles(root, paths) {
    if (!root) return null;
    const walk = (node) => {
      const children = [];
      for (const c of node.children) {
        if (!c.dir) { if (paths.has(c.path)) children.push(c); continue; }
        const kept = walk(c);
        if (kept) children.push(kept);
      }
      return children.length ? { ...node, children } : null;
    };
    return walk(root) ?? { ...root, children: [] };
  }

  /** A root holding the @-mention search's file hits (`list_project_files`
   *  `FileHit[]`) flat, named by their whole path, for a folder that is not
   *  a git repository. Directories are left out. */
  function searchRoot(hits) {
    const children = (hits ?? []).filter((h) => !h.isDir)
      .map((h) => ({ name: h.path, path: h.path, dir: false, status: null, changed: 0, children: [] }));
    return { name: "", path: "", dir: true, status: null, changed: 0, children };
  }

  window.OMP_FILE_COMMENTS = {
    SELECTION_MAX, HEADER, EXPLAIN,
    marksOf, addMark, updateMark, removeMarks, restoreMarks,
    location, selectionText, inlineCode, markText, mergeIntoMessage, chipLabel,
    isStale, counts, relativeTo, folderTree, onlyFiles, searchRoot,
  };
})();
