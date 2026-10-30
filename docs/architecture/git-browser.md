# Git browser

A full-window overlay (`.gitb-scrim` / `.gitb`) over the active tab's project, with three panes:

- **files** — the project tree with git status marks, a "N changed" toggle that limits the tree to changed files, and a name filter;
- **file** — the whole selected file with its change inline: removed lines in place, added lines highlighted, old and new line numbers, ↑↓ between hunks, stage / discard, copy diff;
- **history** — the commit graph of every ref (`--all`, topological), with lanes, a synthetic working-tree row on top and HEAD / branch / remote / tag badges.

It opens from the toolbar's git button, from `desktop.panel.changes` (label "Git browser", default `Ctrl+Shift+G`, `Shift+Cmd+G` on macOS; rebindable) and from the file paths in an edit tool card (one button per file, `onOpenFile(path)`, which opens it on that file). Esc, the close button or a click on the scrim closes it.

All git work is in Rust (`src-tauri/src/git_browser/`, gix): listing, the status merge, tree folding, the full-file line diff, the log, refs, ahead/behind, the lane layout and the files of a commit. The webview keeps only view state — expanded dirs, selection, filter, mode — and renders what Rust returns (`src/app/git-browser.js`, `src/app/use-git-browser.jsx`, `src/design/git/`).

## Diff base

The working tree is shown against **HEAD**: staged and unstaged changes in one view, no separate index column. **stage** is `workspace_accept` (`git add`), **discard** is `workspace_reject` (`git checkout`); both are `workspace.rs`, unchanged, and both refresh the browser when they return.

## Rust (`src-tauri/src/git_browser/`)

| File | Responsibility |
|---|---|
| `mod.rs` | the `pub fn` entry points the five `#[tauri::command]` wrappers in `lib.rs` call, the shared types (`TreeNode`, `StatusKind`), repo opening (`workspace::discover`, shared with stage/discard, minus the repository's own filter drivers — see [Filter drivers](#filter-drivers)), path relativising, `MAX_FILES`, the test fixture |
| `status.rs` | `StatusView` / `RepoInfo`, the per-path status merge, folding the paths into a `TreeNode` tree |
| `file.rs` | `FileView` / `Line` / `LineKind` / `FileKind`, the full-file inline line diff (worktree vs HEAD, commit vs first parent), binary sniff, the per-file caps |
| `log.rs` | `LogView` / `LogRow` / `Ref`, the topological walk over HEAD and every ref, ref badges, ahead/behind vs upstream, `MAX_COMMITS` |
| `graph.rs` | the lane layout, `MAX_LANES` |
| `commit.rs` | `CommitView`, the tree-to-tree diff vs the first parent, folded into the tree of touched files |

Every command takes `path` (the tab's project folder, as the `workspace_*` commands do), runs under `tauri::async_runtime::spawn_blocking` and returns `Result<T, String>`; the error string reaches the overlay as is (e.g. "not a git repository"). The repo is found with `gix::discover(path)` (`mod.rs` `open`); the **work dir**, not `path`, is the root of every relative path. Relative paths from the webview go through `workspace::validate_relative_path`; a path inside a stored commit tree gets only its textual checks (no `..`, no `.git` component, not absolute), since resolving it against today's disk could follow a directory that has since become a symlink. Structs are `#[serde(rename_all = "camelCase")]`; enums serialise as bare strings.

### Filter drivers

Reading a work-tree file through git's filter pipeline — status hashing a file whose stat data changed, the file view's worktree side — runs the command of any `filter.<name>.clean`/`process` driver the file's attributes select. gix trusts a repository's own config as soon as the user owns it, and a downloaded or extracted repository is owned by the user, so its `.git/config` could make a mere preview run a command. `open` therefore removes, in memory, every `filter` section whose source is the repository (`.git/config`, `config.worktree`, and files they include). Drivers from the user's, the system's and the environment's config stay (`git lfs install` writes the global one): those commands are the user's own choice, as they are for `git status`. The built-in conversions (`core.autocrlf`, `eol`/`text`, `ident`, `working-tree-encoding`) run no command and are unaffected. A repository driver that is gone leaves its paths unconverted: an LFS setup made with `git lfs install --local` shows the worktree content against the pointer blob.

Submodules are opened by gix from their own config, which `open` never sees, so status does not descend into them: a submodule is `Modified` when it has a different commit checked out (gix `Submodule::Given { ignore: Dirty }`), never for edits inside its work tree.

The drivers that stay, and the `git` gix runs once to find its installation config, are children of the app: every command holds the spawn gate (`spawn_gate::shared`, the guard `open` returns) for as long as it reads, so none starts while a Chromium launch has its CDP pipe ends in reach of a child (`docs/architecture/browser.md`). A Chromium launch waits for the reads in flight; other spawns do not wait behind it.

Stage and discard (`workspace_accept`/`workspace_reject`) run the `git` binary, which applies the repository's drivers like any `git add` / `git checkout`; they run only on the user's explicit action.

### Commands and payloads

```
git_browser_status(path) -> StatusView
  StatusView { repo: RepoInfo, tree: TreeNode, changed: u32, truncated: bool }
  RepoInfo   { name /* work dir basename */, branch: Option<String> /* short; None = detached */,
               head: Option<String> /* full sha; None = unborn */, ahead: Option<u32>, behind: Option<u32> /* None = no upstream */ }
  TreeNode   { name, path /* project-relative, "/"-separated, "" for the root */, dir: bool,
               status: Option<StatusKind>, changed: u32 /* changed files below a dir; 0 for files */,
               children: Vec<TreeNode> /* dirs first, then files, each alphabetical; empty for files */ }
  StatusKind = "Modified" | "Added" | "Deleted" | "Renamed" | "Untracked"   (git_browser::StatusKind)

git_browser_file(path, relPath) -> FileView
  FileView { path /* normalised, project-relative */, kind: "Text" | "Binary" | "Missing" | "TooLarge",
             status: Option<StatusKind>, adds: u32, rems: u32, lines: Vec<Line>, truncated: bool }
  Line     { kind: "ctx" | "add" | "rem", old: Option<u32>, new: Option<u32>, text /* no trailing newline, lossy UTF-8 */ }

git_browser_log(path) -> LogView
  LogView { rows: Vec<LogRow>, width: u32 /* lanes */, truncated: bool }
  LogRow  { id /* full sha; "@" for the working-tree row */, short /* 7 chars; "" for "@" */, parents: Vec<String>,
            subject /* first line; "" for "@" */, author, at: i64 /* unix secs; 0 for "@" */,
            refs: Vec<Ref>, lane: u32, edges: Vec<Edge> }
  Ref     { name, kind: "head" | "branch" | "remote" | "tag" }
  Edge    { from: u32, to: u32 }   // lane in this row → lane in the next row

git_browser_commit(path, sha) -> CommitView
  CommitView { id, short, subject, body /* rest of the message */, author, email, at: i64, parents: Vec<String>,
               tree: TreeNode /* only the files the commit touched */, files: u32, truncated: bool }

git_browser_commit_file(path, sha, relPath) -> FileView
```

The webview sends a project path, a file path and a sha — never git arguments.

### Files and the status merge

The file list is the index entries (tracked files; a file deleted in the worktree is still in the index and is listed as `Deleted`) plus the untracked files from gix status (`UntrackedFiles::Files`, excludes honoured, so ignored files never appear). Status is HEAD vs worktree, merged per path from both layers (HEAD → index, index → worktree):

| Per path | `status` |
|---|---|
| untracked | `Untracked` |
| added in the index (not in HEAD), even if also modified in the worktree | `Added` |
| deleted in the index or the worktree, not re-added | `Deleted` |
| rewrite / rename in either layer | `Renamed`, on the **new** path |
| any other change in either layer, conflicts included | `Modified` |
| unchanged | `None` |

Rename detection between HEAD and the index follows the repo's config (`status.renames` / `diff.renames`, on unless the user turned it off); between the index and the work tree there is none, as in `git status`, so an unstaged `mv` shows the old path as `Deleted` and the new one as `Untracked`. A detected rename shows only on its new path; the old path is not in the tree.

`changed` on the root and on each dir counts the changed files below it. More than `MAX_FILES` (20 000) files: the tree stops there and `truncated` is `true`.

### Inline diff (`file.rs`)

- `git_browser_file`: worktree bytes vs the HEAD blob at `relPath` (at the rename source for a `Renamed` file). The worktree side first goes through git's filter pipeline (`repo.filter_pipeline` → `convert_to_git`: `core.autocrlf`, `eol`/`text` attributes, ident), so a file checked out with CRLF from an LF blob is unchanged, as status says; `core.safecrlf` is overridden to `false` for that read, since a view must show a file whose endings would not round-trip (as `git diff` does, with a warning) rather than refuse it. Untracked, or added with no HEAD blob: every line `add`. Deleted (no worktree file): every line `rem`. Unchanged tracked file: every line `ctx`. Neither side exists: `kind: "Missing"`.
- `git_browser_commit_file`: the blob in the commit vs the blob in its first parent (the empty tree for a root commit; the rename source for a `Renamed` file). `status` comes from the commit's tree diff; a file the commit did not touch has `status: None` and every line `ctx`.
- Lines are diffed with `gix::diff::blob` (`InternedInput`, `Algorithm::Histogram`, slider heuristics). The view walks the hunks in order and emits `ctx` runs between them; inside a hunk the `rem` lines come before the `add` lines. `old` is set on `ctx`/`rem`, `new` on `ctx`/`add`.
- A NUL byte in the first `BINARY_SNIFF_BYTES` (8 KiB) of either side: `kind: "Binary"`, no lines.
- A side larger than `MAX_SIDE_BYTES` (2 MiB): `kind: "TooLarge"`, no lines, `truncated: false` — the view is absent, not partial (cutting one side would mislabel the other side's tail as added or removed). A worktree file over 4 MiB on disk is `TooLarge` without being read: line-ending conversion at most halves it, so it cannot come out under 2 MiB (a clean filter that shrinks more, such as LFS, is treated the same); a blob over the cap is caught from its object header and never inflated. Caps that set `truncated: true`: `MAX_LINES` (20 000) output lines (later lines dropped), `MAX_LINE_CHARS` (500) per line, counted in chars (decoded from at most 4 × 500 bytes, so a megabyte-long minified line costs no more than a long one).
- `relPath` may also be absolute: an edit card's path is whatever omp reported, made absolute by the frontend against the tab's folder when it is relative (omp's paths are tab-relative, tree rows are repo-relative, and Rust cannot tell the two apart). Inside the work dir it is made relative; outside it is an `Err`. Where the card's paths come from (`adapter.js`): a finished edit takes `details.path` (one file, absolute) or `details.perFileResults[].path` (several) — omp's `aggregateDetails` fills them for every edit mode; a running one, and a failed one (its details carry no path), keep what the start frame named, which depends on omp's `edit.mode`: the `path` argument (`replace`, `patch`) or the file headers of the `input` script — `[path#TAG]` (`hashline`, the default), `*** Add|Update|Delete File: path` (`apply_patch`), `*** Edit File: path` (`sloppy`; a trailing ` all` flag is dropped, a bare `all` or an empty header continues the previous file and names none, a JSON-quoted path is unquoted). A card with no known path shows no button.

### Log and refs (`log.rs`)

- Tips are HEAD and every ref; the walk is `gix::traverse::commit::topo` with `Sorting::DateOrder` and the repo's commit-graph when one is enabled (without it the in-degree pass walks all history before the first row), newest first, at most `MAX_COMMITS` (500) commits (`truncated` past that).
- The first row is the synthetic working-tree row `{ id: "@", parents: [head] }`, omitted when HEAD is unborn. It is laid out like a commit whose only parent is HEAD.
- `Ref.kind`: `head` is the branch HEAD points at (name = branch name), or name `HEAD` when detached; `remote` names keep their remote prefix (`origin/main`); `tag` names drop `refs/tags/`. A symbolic ref (`refs/remotes/origin/HEAD`) gets no badge and is not a tip: peeling it would rename it to its target and badge that branch twice. Refs that are neither branches nor tags (a stash) are walked, as `git log --all` does, but carry no badge.
- `RepoInfo.ahead` / `behind` are `head ^upstream` and `upstream ^head` (`rev_walk(..).with_hidden(..)`, what git counts; no merge base, which would be one of several in a criss-cross history); no upstream, a detached HEAD, or an upstream ref that was never fetched → `None`; a broken ref store is an error.

### Lane layout (`graph.rs`)

`active: Vec<Option<Id>>` maps a lane to the commit the line in that lane is waiting for. For each row, newest first:

1. `lane` = the lane already waiting for this commit, else the first free slot, else a new one (never capped: only emitted values are). No other lane can be waiting for the same commit: an id enters a lane only after a lookup found it absent, so a merged-in line is drawn by the child's own `lane → k` edge (step 2) and needs no re-targeting.
2. No parents: `lane` is freed. Otherwise, if the first parent is already waited for in another lane `k`, `lane` is freed and the edge is `lane → k`; else `active[lane]` = first parent and the edge is `lane → lane`.
3. Each further parent: its lane `k` if one waits for it, else the first free slot (now waiting for it, and claimed in this row); edge `lane → k`.
4. Every other waiting lane — not the commit's own, not one claimed in this row — gets a pass-through edge `j → j`.
5. Trailing free slots are trimmed; `width` = max(`width`, `lane + 1`, `active.len()`), clamped to `MAX_LANES`.

`Edge { from, to }` therefore always runs from a lane in this row to a lane in the next one; the frontend draws each row's node at `lane` and its edges down to the next row, nothing else. The bookkeeping (`active`) is exact for any number of lanes; only the emitted `lane`/`from`/`to` and `width` are clamped to `MAX_LANES` (12), so further lanes draw on the last one without ever ending another lane's line at the wrong node.

### Commits (`commit.rs`)

`git_browser_commit` diffs the commit's tree against its first parent's (the empty tree for a root commit) with `repo.diff_tree_to_tree` and folds the changes into a `TreeNode` of the touched files only, statuses `Added` / `Modified` / `Deleted` / `Renamed` (new path). `files` is the number of touched files; the `MAX_FILES` cap and `truncated` apply as for status.

### Why gix, and where `git` still runs

Reads go through gix (0.87, default features: `status`, `blob-diff`, `revision`, `dirwalk`, `index`, `attributes`, `excludes`): no process per refresh, no output parsing, no dependence on the user's `git` version, PATH or config aliases. The `git` binary still runs for **`workspace::accept` / `reject` only** (`git add` / `git checkout`): gix has no mature index add or worktree restore. `workspace::git` runs it by absolute path, the first `git` (`git.exe`) in the absolute folders of the child PATH (`child_path::child_path_dirs` + `locate_program`), with those folders as its PATH; never a bare `git`, which an empty or relative PATH entry would resolve inside the project. No `git` there is the command's `Err`.

## Frontend

### Bridge (`live.js`)

`gitBrowserStatus()`, `gitBrowserFile(relPath)`, `gitBrowserLog()`, `gitBrowserCommit(sha)`, `gitBrowserCommitFile(sha, relPath)` invoke the commands with `{ path, relPath, sha }`, `path` being `_activeProjectPath()`. Each resolves `{ ok: true, value }` or `{ ok: false, error }` (the Rust error string), and `null` when the tab has no project folder: errors are passed on, not swallowed into a fallback, so the overlay can show them. `workspaceAccept` / `workspaceReject` are the stage / discard calls.

### Pure helpers (`app/git-browser.js`, `window.OMP_GIT_BROWSER`, `test-git-browser.mjs`)

- `flatten(root, expanded, changedOnly)` → `[{ node, depth }]`, the visible rows of the tree;
- `changedDirs(root)` → the set of dir paths with `changed > 0` (the tree opens with them expanded);
- `ancestorDirs(path)` → the dirs to expand to reveal a path (an edit card's file);
- `filterFiles(root, query, changedOnly)` → the flat list of matching files while the name filter is set;
- `hunkStarts(lines)` → the line indices the ↑↓ buttons jump between;
- `splitPath(path)` → `[dir, name]`;
- `relativeTime(atSecs, nowSecs)` → `now`, `5m`, `2h`, `3d`, `2w`, `4mo`, `1y`;
- `diffText(lines)` → the changed lines prefixed `+` / `-`, for the copy button (plain text, no markdown fence);
- `firstFile(root, changedOnly)` → the first file in display order, selected on open when there is no `initialPath`;
- `discardDeletes(status)` → whether discard removes the file outright (`Untracked`, `Added`, `Renamed`: no HEAD blob to restore) — the discard confirmation rule;
- `finishedEdits(messages)` → the count of finished edit/write tool cards, the refresh trigger below.

### Hook (`app/use-git-browser.jsx`, `window.useGitBrowser`)

Mounted with the overlay as `useGitBrowser({ bridge, initialPath, branch, edits })` (`edits` = `finishedEdits(messages)`, counted by `app-live.jsx`). Returns `status`, `log`, `commitSha`, `commit`, `tree` and `truncated` (the status tree in worktree mode, the commit's in commit mode), `file`, `error`, `commitError`, `fileError`, `selected`, `expanded`, `changedOnly`, `filter` and the actions `select`, `toggleDir`, `setChangedOnly`, `setFilter`, `browse(sha | "@")`, `refresh`, `stage`, `discard`.

- **Mode** is `commitSha`: `null` for the working tree, else the browsed commit. No loading flags: a pane with no value and no error is loading. On open it fetches status and log, then the selected file (`initialPath`, else `firstFile`); a selection fetches `gitBrowserFile` in worktree mode and `gitBrowserCommitFile(sha, …)` in commit mode.
- **Refresh**: status and the open working-tree file refetch when the active tab's `branch` changes (the bridge snapshot's `sessions[i].branch`, driven by `git://branch/{id}`), when an edit/write tool card finishes while the overlay is open (`edits` grows), after stage / discard, and on the refresh button; the log on a branch change and the refresh button only. A commit and its files are never refetched (a commit cannot change). A project change remounts the overlay (its `key`).
- `error` is a status or log failure; the overlay shows it in its body instead of the panes. `commitError` and `fileError` are shown inside the pane they belong to.

### Components (`design/git/`)

`file-tree.jsx` (`GitFileTree`), `file-view.jsx` (`GitFileView`), `history.jsx` (`GitHistory`; `tag` icon for tag refs) and `git-browser.jsx` (`GitBrowser`), loaded in that order. `GitBrowser({ bridge, onClose, initialPath, branch, edits })` (memoised: App re-renders on every streamed frame) is the mount contract: `app-live.jsx` mounts it keyed on the active tab's project path (a tab switch to another project remounts it with fresh view state) from `gitOpen = { path, project }`, passing `initialPath` only while the tab is still on that project, plus the branch and the finished-edit count for the hook's refresh triggers. The dialog takes focus on mount (so keystrokes no longer reach the composer underneath) and gives it back on close; it closes on Escape unless the key was already handled or the focus sits in a modal stacked above it (everything above renders in a `.bridge-scrim`: the command bridge, the approvals/stats/update panels) — focus anywhere else does not stop it, because the composer refocuses its textarea under the scrim when a turn ends. The scrim closes only on a click that both starts and ends on it, so a drag-select ending outside the panel stays harmless. The head shows the project name, the branch chip (the short sha on a detached HEAD) plus a `no commits` chip while HEAD is unborn (the branch chip still shows: `head_name()` is set on an unborn branch), ahead/behind and the changed-file count (no line totals: `StatusView` carries none). The file body is `selectable` (the app body is `user-select: none`); line numbers are not. The components take their data from the hook and hold no git logic.

## Browsing a commit

A click on a commit row calls `browse(sha)`: the files pane shows the commit's touched files (`CommitView.tree`), the file pane shows a file as of that commit with the commit's change against its first parent inline, read-only (no stage / discard). A click on the working-tree row (`browse("@")`) returns to worktree mode. The history pane stays as it is in both modes.

## Things easy to break

- Payload field names are camelCase on the wire (`relPath`, `truncated`, `changed`, …) and the hook reads them by name. A renamed Rust field or a missing `rename_all` breaks the overlay silently; change both sides together.
- The `"@"` row: `id: "@"`, `short: ""`, `subject: ""`, `at: 0`, `parents: [head]`, absent when HEAD is unborn. The history pane selects worktree mode on it; code that treats every row as a commit (sha lookups, `relativeTime(0)`) must skip it.
- The caps: 500 commits (`MAX_COMMITS`), 20 000 files (`MAX_FILES`) and 20 000 lines (`MAX_LINES`), 2 MiB per side (`MAX_SIDE_BYTES`, → `TooLarge`), 500 chars per line (`MAX_LINE_CHARS`), 12 lanes (`MAX_LANES`). They keep a large repo or file from freezing the webview; raise them only with a measurement.
- A rename is shown on its **new** path only, in both the worktree tree and a commit's tree; the old path is not a row. The file view diffs it against the rename **source**'s blob (`git_browser_file`: the HEAD blob at the source path of the HEAD → index rename; `git_browser_commit_file`: the source location from the tree diff), so a pure rename is all `ctx` and a rename plus edit shows only the edit. A copy (copy-detected rewrite) counts as `Added` and diffs against an empty side.
- `truncated` is always shown when set (tree, file and history each carry it): a capped view must not look complete.
- Reads stay in gix; adding a `git` subprocess to `git_browser/` reintroduces the PATH and output-parsing problems the cutover removed. Only `workspace::accept` / `reject` run `git`.
