# Files panel (file comments)

A panel in the side column (beside the chat, where the rail, the conversation tree and the browser go) for pointing the agent at code: open project files, mark lines or a text selection for **explain** or write a **comment** on them, in one file or several, and send the batch with the next message. One panel per tab; nothing is persisted.

## Layout and entry points

- Toolbar button (`file` icon) and `desktop.files.toggle` ("Toggle files panel", default `Ctrl+Shift+M`, `Shift+Cmd+M` on macOS, rebindable, `fromGuest`). Open, the toolbar shows a full-view toggle beside it (`.stage.files-full` hides every other stage column, as the browser's full view does; leaving the panel leaves full view).
- File preview header: "Comment in files panel" (text files only) closes the preview and opens the panel on that file, the preview's range picked.
- Alt-click on a project file link in an agent reply (`OMP_FILE_PREVIEW.linkClick` → `files`; Ctrl/⌘ still wins for the git browser).
- A composer chip click opens the panel on that mark's file and lines.

The panel is `side === "files"` in `app-live.jsx`'s per-tab side map, a resizable pane (`OMP_LAYOUT_WIDTHS.PANES.files`, tweak `filesWidth`, Settings → Layout → Column widths) like the conversation tree. Left: the git browser's files pane (`GitFileTree`, unchanged apart from four optional props), hideable per tab from the file bar. Right: the file bar (tree toggle, path, line count, truncated chip, reload, open in the git browser, copy path), the code, and a footer with the tab's counts, "clear all" and "send now".

## Files and the tree (`app/use-file-comments.jsx`)

- Tree: `git_browser_status` (the git browser's command, gix), fetched while the panel is open and again on the tab's branch change, a finished edit/write tool card (`OMP_GIT_BROWSER.finishedEdits`) and the reload button. Its paths are relative to the work tree; `StatusView.folder` (Rust, `git_browser/status.rs`: the folder the status was asked for, both paths canonicalised, relative to the work dir, `""` for the work dir itself) places the tab's folder in it, and `OMP_FILE_COMMENTS.folderTree` cuts the tree there with paths relative to the folder — what `project_file_read` and the agent (whose cwd is the tab folder) take. A folder name matches exactly, else, on Windows and macOS (file systems that ignore case, where the case on disk can differ from the index's), without case. A folder Rust could not place (`folder: None`) shows an error instead of the tree, never work-tree paths read as folder-relative.
- Toggles: "N changed" (the git browser's changed-only), "N commented" (only files with marks, their folders open; `onlyFiles`).
- Not a git repository (status fails and the tab has no `repoRoot` from the HEAD watcher): the filter box becomes a search over the @-mention file walk (`list_project_files`, fuzzy, 50 hits, `searchRoot`), listed flat. A folder that becomes a repository later (`git init`) gets its tree on the next refetch.
- File: `project_file_read` (the preview's command: tab folder from the terminal registry, symlink and `.git` refusal, 1 MiB text cap). Text is clipped and highlighted exactly as in the preview (`OMP_FILE_PREVIEW.clipLines`, `highlightLines`: hljs up to `HIGHLIGHT_MAX_CHARS`, 256 KiB; larger or unknown-language files show plain). Non-text kinds show the preview's states (`FILE_STATES`, `FileState`); an image cannot be marked.

## Marks (`app/file-comments.js`, `design/files/file-code.jsx`)

A mark is `{ id, n, path, from, to, kind, text, selection, lines }`: `path` folder-relative, `from`/`to` 1-based inclusive, `kind` `"explain"` or `"comment"` (`text` only for a comment), `selection` the selected text when made from a text selection, `lines` the marked lines as they were.

- Picking: press, drag or shift-click on the line numbers (or the marker column), or select text in the code (a selection ending at the very start of a row ends on the row before; cards, the form, the popup and the mark numbers are never part of it). Shift-click extends from the line first pressed (or the first line of a target or selection pick). A pick takes the focus into the code (`.fc-lines`, `tabIndex -1`) and shows a popup (above it, or below when there is no room in the scrolled view) with **explain** (adds the mark at once, no text) and **comment** (opens the plan-comment form under the picked lines; its one "comment" button or ⌘/Ctrl+↵ saves; Esc in it cancels). A press outside the code's scroller drops a pick, and so does an Esc while the focus is in the panel or nowhere; that Esc and the form's are prevented, so they never reach the keymap's interrupt, and an Esc ending an IME composition is left to the IME. An open target (preview, chat link, chip) is scrolled to and picked once, then dropped from the view, so a remount does not repeat it.
- A mark tints its lines (explain cyan, comment lilac), numbers its first line and shows a card under its last one: explain cards have remove, comment cards edit and remove.
- Stale: a mark whose `lines` no longer match the file (`isStale`; a line added above, a changed line, a shorter file) shows "changed since" — the agent reads the file as it is at send time, so the user can re-pick.
- Store: per tab, `OMP_BROWSER`'s chip store (same numbering: one past the highest, restarting at 1 once the tab's marks are gone; a handed-back batch is numbered after newer ones). A closed tab drops its marks and view.

## Sending (`app-live.jsx` `takeChips`)

Marks are composer chips (`BrowserChips` with the marks' icon, label and title; `chipLabel`: `#1 live.js:12-14 — explain`, `#2 live.js:9 "isCmd…" — "rename…"`) and go out with the next submit — send, steer, follow-up, a goal's first prompt — after the browser annotations, taken when sent (marks added meanwhile stay); a command takes none. A failed goal start hands them back to their tab. A draft of marks alone can be sent (as browser chips can), and "send now" sends them with no typed text (disabled in goal mode, whose send needs an objective).

`mergeIntoMessage` appends:

```
File comments (paths relative to the project folder, line numbers 1-based; read the lines before answering):

#1 src/live.js:3845-3848
Explain this code.

#2 src/live.js:3852, the text `isCommandInvocation(state.commands, text)`
Comment: Hoist into a helper shared with followUp.
```

- No code is quoted: the location is omp's read-selector form, and the agent reads the lines itself.
- A selection adds its text on one line, cut at 120 characters, as inline code with a fence longer than any backtick run in it, neutralised as browser page data (`OMP_BROWSER.neutralisePage`: `/skill\:`, a line-leading `\/`, every `\@`, since omp reads any `@path` — a decorator — as a file mention).
- The path and the comment are neutralised as a browser comment (`neutralise`: commands only; the comment keeps the user's own `@file` mentions). Whether a message runs a command is decided on the typed draft alone (`OMP_SLASH.routeSubmit`), so marks never turn a send into one.

## Things easy to break

- Tree paths and mark paths are tab-folder-relative only through `folderTree`; reading a work-tree-relative path relative to the tab folder opens the wrong file in a monorepo tab.
- `GitFileTree`'s extra props are optional: the git browser passes none and must look unchanged.
- `desktop.files.toggle` is in both `KEYMAP_ACTIONS` (`app/keymap.js`) and Rust `ACTION_IDS` (`keybindings/mod.rs`).
- `FileCode` is exported memoised and every prop it gets is a stable reference (the app re-renders on every streamed frame, a file has up to 20 000 rows); its rows are `_FC_Row` memo components, so a mark or pick change re-renders only the rows whose class or badge changed. A new inline prop there rebuilds the whole file per frame.
- `app-live.jsx` keys `FilesPanel` by tab: two tabs on one folder must not share a code view's pick or half-written form.
- Full view hides every stage child but the panel and the Settings host (`.st-host`), as the browser's does.
