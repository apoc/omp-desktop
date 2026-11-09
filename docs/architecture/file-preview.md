# File preview (issue #39)

A read-only look at one project file: a read card's target or a file link in the agent's markdown. Text is highlighted with the read lines tinted. Images show whole. Sites are out of scope: http(s) links keep their routing (localhost to the browser panel, the rest to the system browser through `navigation_guard.rs`).

## Entry points

|Where|What opens|
|---|---|
|read card path (`chat/tool-card.jsx` `_TC_ReadBody`)|preview, with the range from omp's inline selector|
|read card thumbnails|the image lightbox (`chat/image-lightbox.jsx`) on the result's image blocks; no file read|
|write card path, edit card paths (`DiffPaths`)|the git browser (unchanged for edit; write joined it)|
|scheme-less link in agent markdown|preview; Ctrl/⌘-click: the git browser; Alt-click: the files panel (`file-comments.md`)|
|preview "Open in git browser"|the git browser on Rust's project-relative path|
|preview "Comment in files panel" (text files)|the files panel on that file, the preview's range picked|

`app-live.jsx` holds `preview = { key, target }`. `key` is the tab the preview was opened in, and the modal renders only while that tab is active. A new path refetches; a new range on the same path only scrolls. The markdown containers' delegated click (`MarkdownLinkContext`, `ui/markdown.jsx`) is `handleChatLinkClick`: `linkClick(e, root)` claims a primary click on a project file link (the preview, with Ctrl/⌘ the git browser, with Alt the files panel), and anything else goes on to the browser panel's `onChatClick`. Without that handler a relative link navigates the webview, and `navigation_guard.rs` blocks it silently.

## Targets (`app/file-preview.js`)

A range is `{ from, to }`, 1-based and inclusive; one line and an open-ended start (`:50`) both have `to === from`.

- `readTarget(target)`: omp's read takes one `path` string with inline selectors: `:50`, `:50-80`, `:50+30`, `:-60`, a comma list (the first range counts), `:raw`, `:img`, `:conflicts`, and `?question` after an image. URLs (`artifact://`, `https://`) are not previewable. A Windows drive keeps its colon.
- `linkTarget(href)`: a link that marked kept as written (relative, or an absolute path). It understands `#L12`, `#L12-L20`, `:12`, `:12-20` and `:12:5` (line:column), and the href is percent-decoded. Any scheme, `#anchor` or `//host` returns null. `new URL` reads a Windows drive (`C:/x.rs`) and a bare `main.rs:12` as schemes, so `app/marked-setup.js`'s `link` renderer keeps exactly those two shapes as anchors (a slash after the drive letter; `.ext:N` on a bare name). The predicate is `OMP_MARKDOWN.isSchemeLikeFilePath`, defined with the renderer and reused by `linkTarget`. An unclaimed click on one is blocked by `navigation_guard.rs` like any non-web scheme.
- `inProject(path, root)`: the UI gate. The path must be relative with no `..` or `~`, or absolute below the tab's folder, compared as `OMP_PROJECT_NAV.normPath` does (either slash; drive and UNC paths without case). A tab without a folder previews nothing. Rust enforces the boundary again; this check only decides whether the path renders as a button.

## Rust (`project_file.rs`, `project_file_read`)

- The webview sends `sessionId` and `path`. The folder comes from `TerminalManager::folder`, which is the folder `start_session` registered for the tab. A tab without a folder is refused.
- `git_browser::project_relative` handles traversal, `.git` and symlinked parent directories as written, and absolute paths inside the folder. After that, the file itself is canonicalised and checked again: a symlink whose target is outside the folder, or a resolved path through `.git` (a symlink into it, a symlinked directory pointing at it, a Windows 8.3 alias such as `GIT~1`), comes back as the `Outside` kind; a symlink pointing elsewhere inside is followed. These are plain fs reads: no git and no filter drivers.
- Result `FilePreview { path, size, kind, text?, data?, mimeType? }`. `kind` is `Text | Image | Binary | TooLarge | Missing | Outside`, and like the git browser's `FileView` these are states, not errors. A path `project_relative` refuses as written (traversal, `.git`, a symlinked parent out of the folder; the UI gate keeps most of these from ever being sent), a directory, or an I/O failure is an `Err(String)`, shown with its text.
- Image by extension (`png jpg jpeg gif webp bmp ico avif svg`). It is returned base64 with its MIME type and shown as a `data:` URL, which CSP `img-src` already allows. An SVG in an `<img>` runs no script.
- Size limits: text 1 MiB (`MAX_TEXT_BYTES`), images 8 MiB (`MAX_IMAGE_BYTES`). The read is `take(cap + 1)`, so a file that grows after `metadata` cannot overrun the limit.
- Binary means a NUL byte in the first 8 KiB (`git_browser::is_binary`, the git browser's own test). Text that is not valid UTF-8 is decoded lossily.

## Rendering (`chat/file-preview.jsx`)

- `clipLines` cuts the text to the git browser's caps (`MAX_LINES` 20 000, `MAX_LINE_CHARS` 500) before anything is highlighted or rendered, and the header shows a `truncated` chip. The line-count chip keeps the file's full count.
- `highlightLines` (`app/file-preview.js`, shared with the files panel) runs hljs on files up to `HIGHLIGHT_MAX_CHARS` (256 KiB) when `language()` finds a registered language. Larger files, or files in an unknown language, show as escaped plain text. `splitHighlighted` cuts hljs output into lines, closing open spans at the end of each line and reopening them on the next, so a block comment keeps its colour across lines.
- The code sits on a fixed dark surface in every theme, like chat code blocks: the hljs theme's colours are dark-theme colours.
- A range of several lines is tinted (`is-read`); a single line or an open-ended start (`:50`) is marked as the target (`is-target`). The rows are a memoised component, so a re-render of the head (the copy button's flash) does not rebuild them. On load the view scrolls so the range starts four lines from the top.
- The modal follows the lightbox: it renders in a portal on `<body>`, `useModalLayer` (`chat/image-lightbox.jsx`) makes `#root` `inert` and returns focus to the opener on close, and Esc is handled in the capture phase with `preventDefault` (the global keymap skips handled events). The scrim closes it only for a press that began on the scrim, so a drag-select out of the code does not.
- The `Outside` kind shows the "Outside the project" state and no "Open in git browser"; an `Err` shows its text.

## Card data (`adapter.js`)

- read: `images`, the result's `{type:"image"}` blocks, at most 4. omp sends them only when the model takes image input. A failed or text-only read has none. The card shows them with `ImageThumbs` (`chat/image-lightbox.jsx`), the user bubble's thumbnail strip.
- write: `targets: [args.path]` at start. On finish, `bytes` is parsed from omp's `Successfully wrote N bytes to …`.

Tool cards come only from live `tool_execution_*` frames; the get_messages merge keeps them in place, so these fields need no rebuild path.
