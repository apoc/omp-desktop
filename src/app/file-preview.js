/* ═════════════════════════════════════════════════════════════════════
   app/file-preview.js — pure helpers for the file preview (issue #39):
   which file and lines a read card or an agent link points at, whether a
   path lies in the tab's project, and the highlighted text cut into lines.
   design/chat/file-preview.jsx owns the DOM side; the bytes come from
   src-tauri/src/project_file.rs (`OMP_BRIDGE.readProjectFile`).
   A range is `{ from, to }` (1-based, inclusive; `to === from` for one
   line or an open-ended start).
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  const { isSchemeLikeFilePath } = window.OMP_MARKDOWN; // app/marked-setup.js
  const { normPath } = window.OMP_PROJECT_NAV;          // app/project-nav.js
  // `artifact://12`, `https://…`: omp's read takes internal and web URLs too.
  const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
  // Any scheme (`mailto:`, `javascript:`); a drive path or a bare
  // `main.rs:12` matches too, and isSchemeLikeFilePath lets those through.
  const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  // Once backslashes are slashes.
  const ABSOLUTE = /^(?:\/|[a-z]:\/)/i;
  // Past this the highlighter would stall the webview: shown plain.
  const HIGHLIGHT_MAX_CHARS = 256 * 1024;
  // Rows the preview builds, and characters per row: the git browser's
  // caps (git_browser/file.rs MAX_LINES, MAX_LINE_CHARS), which bound the
  // DOM for a file of short lines and the layout of a minified one.
  const MAX_LINES = 20000;
  const MAX_LINE_CHARS = 500;

  /** The file and lines of a read card's target: omp's read takes the path
   *  with inline selectors — `:50`, `:50-80`, `:50+30`, `:-60` (last lines),
   *  `:5-16,960-973` (the first range counts), `:raw`, `:img`,
   *  `:conflicts`, and a `?question` after an image. `null` for a URL or an
   *  empty target. */
  function readTarget(target) {
    let path = String(target ?? "").trim();
    if (!path || URL_SCHEME.test(path)) return null;
    const q = path.indexOf("?");
    if (q > 0 && /\.[a-z0-9]+$/i.test(path.slice(0, q))) path = path.slice(0, q);
    let range = null;
    for (;;) {
      const mode = path.match(/:(?:raw|img|conflicts)$/i);
      if (mode && mode.index > 0) { path = path.slice(0, mode.index); continue; }
      const lines = path.match(/:(\d+)(?:-(\d+)|\+(\d+))?(?:,\d+(?:[-+]\d+)?)*$/);
      if (lines && lines.index > 0 && !range) {
        const from = Number(lines[1]);
        const to = lines[2] ? Number(lines[2]) : lines[3] ? from + Number(lines[3]) - 1 : from;
        range = { from, to };
        path = path.slice(0, lines.index);
        continue;
      }
      const tail = path.match(/:-\d+$/);
      if (tail && tail.index > 0) { path = path.slice(0, tail.index); continue; }
      break;
    }
    return path ? { path, range } : null;
  }

  /** The file and lines an agent's markdown link points at: a scheme-less
   *  href (marked keeps it as written), with an optional `#L12` / `#L12-L20`
   *  anchor or a `:12` / `:12-20` / `:12:5` (line:column) suffix. `null` for
   *  a URL, an in-page anchor or a protocol-relative link. */
  function linkTarget(href) {
    let s = String(href ?? "").trim();
    if (!s || s.startsWith("#") || s.startsWith("//")) return null;
    try { s = decodeURI(s); } catch { return null; }
    if (ANY_SCHEME.test(s) && !isSchemeLikeFilePath(s)) return null;
    let range = null;
    const hash = s.indexOf("#");
    if (hash >= 0) {
      const m = s.slice(hash + 1).match(/^L(\d+)(?:-L?(\d+))?$/i);
      if (m) range = { from: Number(m[1]), to: Number(m[2] ?? m[1]) };
      s = s.slice(0, hash);
    }
    const q = s.indexOf("?");
    if (q >= 0) s = s.slice(0, q);
    const m = s.match(/:(\d+)(?:(-|:)(\d+))?$/);
    if (m && m.index > 0) {
      const from = Number(m[1]);
      if (!range) range = { from, to: m[2] === "-" ? Number(m[3]) : from };
      s = s.slice(0, m.index);
    }
    return s ? { path: s, range } : null;
  }

  /** Whether `path` can be previewed in the project at `root`: a relative
   *  path without `..` or `~`, or an absolute one below `root` (compared as
   *  project-nav's normPath does: either slash, Windows paths without case). */
  function inProject(path, root) {
    const p = String(path ?? "").replace(/\\/g, "/");
    if (!p || p.startsWith("~")) return false;
    if (!ABSOLUTE.test(p)) return !p.split("/").includes("..");
    if (!root) return false;
    // A root of `/` keeps its slash in normPath; drop it for the prefix.
    return normPath(p).startsWith(`${normPath(root).replace(/\/$/, "")}/`);
  }

  /** A primary click on a file link in the agent's markdown (`.md-content
   *  a`) that lies in the project at `root`: `{ target, git, files }`, else
   *  null. `git` (Ctrl/⌘ held) means the git browser instead of the
   *  preview, `files` (Alt held) the files panel. */
  function linkClick(e, root) {
    if (!root || e.defaultPrevented || e.button !== 0) return null;
    const a = typeof e.target?.closest === "function" ? e.target.closest(".md-content a[href]") : null;
    const target = a && linkTarget(a.getAttribute("href"));
    if (!target || !inProject(target.path, root)) return null;
    const git = Boolean(e.ctrlKey || e.metaKey);
    return { target, git, files: !git && Boolean(e.altKey) };
  }

  // Languages by extension where the extension is not itself an hljs alias.
  const EXT_LANG = { mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", jsonc: "json", svg: "xml" };
  const NAME_LANG = { dockerfile: "dockerfile", makefile: "makefile", cmakelists: "cmake" };

  /** The highlight.js language for a file, or null to show it plain.
   *  `has(name)` is `hljs.getLanguage`, passed in to keep this pure. */
  function language(path, has) {
    const name = String(path ?? "").split(/[/\\]/).pop().toLowerCase();
    const stem = name.replace(/\.txt$/, "");
    const dot = name.lastIndexOf(".");
    const candidate = NAME_LANG[stem] ?? (dot > 0 ? (EXT_LANG[name.slice(dot + 1)] ?? name.slice(dot + 1)) : null);
    return candidate && has(candidate) ? candidate : null;
  }

  /** Highlighted HTML (hljs output: `<span class="…">`, `</span>`, escaped
   *  text) cut into one HTML string per line, every line closing the spans
   *  still open at its end and the next reopening them — a block comment
   *  spans lines. */
  function splitHighlighted(html) {
    const lines = [];
    const open = [];
    let line = "";
    let last = 0;
    for (const m of String(html).matchAll(/<span[^>]*>|<\/span>|\n/g)) {
      line += html.slice(last, m.index);
      last = m.index + m[0].length;
      if (m[0] === "\n") {
        lines.push(line + "</span>".repeat(open.length));
        line = open.join("");
      } else if (m[0] === "</span>") {
        open.pop();
        line += m[0];
      } else {
        open.push(m[0]);
        line += m[0];
      }
    }
    lines.push(line + html.slice(last));
    return lines;
  }

  /** `text` cut to MAX_LINES lines of at most MAX_LINE_CHARS characters
   *  (a final newline ends the last line, it does not start another), and
   *  whether anything was cut. */
  function clipLines(text) {
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    const all = body.split("\n");
    let truncated = all.length > MAX_LINES;
    const kept = (truncated ? all.slice(0, MAX_LINES) : all).map((l) => {
      if (l.length <= MAX_LINE_CHARS) return l;
      truncated = true;
      return l.slice(0, MAX_LINE_CHARS);
    });
    return { text: truncated ? kept.join("\n") : body, truncated, total: all.length };
  }

  const ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

  /** One HTML string per line of `body` (already clipped, no final
   *  newline): highlighted by `hljs` when the file's language is known and
   *  the text is at most HIGHLIGHT_MAX_CHARS, escaped text otherwise. The
   *  file preview's and the files panel's rows. */
  function highlightLines(path, body, hljs) {
    const lang = hljs && body.length <= HIGHLIGHT_MAX_CHARS ? language(path, (n) => !!hljs.getLanguage(n)) : null;
    if (lang) {
      try { return splitHighlighted(hljs.highlight(body, { language: lang, ignoreIllegals: true }).value); }
      catch (_) { /* plain below */ }
    }
    return body.replace(/[&<>]/g, (c) => ENTITY[c]).split("\n");
  }

  /** Whether line `n` is inside `range`. */
  function inRange(n, range) {
    return !!range && n >= range.from && n <= range.to;
  }

  window.OMP_FILE_PREVIEW = {
    readTarget, linkTarget, linkClick, inProject, language, splitHighlighted, clipLines, highlightLines, inRange,
    HIGHLIGHT_MAX_CHARS, MAX_LINES, MAX_LINE_CHARS,
  };
})();
