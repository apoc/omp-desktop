# Rail widgets

A widget is a small program, in any language, that the desktop starts as a separate process. It prints one JSON document to stdout, and the desktop renders it as a card in the ambient rail using a fixed set of block types. You register commands in your own `widgets.json`. A plugin runs only after you approve it in the rail, and it never runs code inside the app.

Internals (scheduler, IPC, invariants) are in [`architecture/widgets.md`](architecture/widgets.md).

## Five-minute start

1. Copy the example scripts to `~/.omp-desktop/widgets/`:

   ```bash
   mkdir -p ~/.omp-desktop/widgets
   cp examples/widgets/*.sh examples/widgets/*.py examples/widgets/*.mjs ~/.omp-desktop/widgets/
   chmod +x ~/.omp-desktop/widgets/*
   ```

2. Copy `examples/widgets/widgets.example.json` to `<app config>/widgets.json`. The path is shown under Settings → Rail, in the `Plugin config` row:

   | OS | `<app config>` |
   |---|---|
   | macOS | `~/Library/Application Support/dev.ohMyPi.desktop/` |
   | Linux | `~/.config/dev.ohMyPi.desktop/` (`$XDG_CONFIG_HOME` if set) |
   | Windows | `%APPDATA%\dev.ohMyPi.desktop\` |

   A minimal file with one plugin looks like this:

   ```json
   { "version": 1, "plugins": [
     { "id": "hello", "title": "Hello", "command": ["python3", "-I", "~/.omp-desktop/widgets/hello.py"] }
   ] }
   ```

3. Click "Reload widgets" in the same Settings row. An approval card for "Hello" appears in the rail. It lists the exact command. Check it, then click **Approve**.
4. The card runs and shows the context it was given. From now on it refreshes on its own (see [When a plugin runs](#when-a-plugin-runs)).

A ten-line shell script works the same way:

```bash
#!/usr/bin/env bash
python3 -I - "$OMP_WIDGET_PROJECT" "$OMP_WIDGET_BRANCH" <<'PY'
import json, sys
project, branch = sys.argv[1], sys.argv[2]
print(json.dumps({"version": 1, "status": "ok", "blocks": [
    {"type": "kv", "rows": [{"k": "project", "v": project}, {"k": "branch", "v": branch}]}]}))
PY
```

## Where cards appear

Widget cards sit in the ambient rail. By default, plugin cards follow the built-in context, radar, subagents, Agent context and Changes cards, followed by the active tab's omp extension cards and the minimap. Plugin cards follow `widgets.json` order; an approval and its eventual result share one position. Error cards about `widgets.json` stay at the top.

Use the header's **Ambient controls** gear to hide/show individual cards and drag them into your preferred order, or use the move-up/down buttons. **Settings → Rail → Card order** offers the same ordering controls. Order is saved across tabs and restarts; hidden cards keep their place, and cards absent from one project regain their saved position when they return.

**Approval cards** appear for every enabled plugin not yet approved, or changed since approval, regardless of `match`, so you can approve a plugin before opening a matching project. Hidden approval cards stay hidden. **Result cards** appear for approved plugins whose `match` fits the active project and remote, initially idle until their first run. **omp extension cards** show the active tab's status lines and widgets, marked `extension`.

A disabled plugin (`"enabled": false`) gets no card.

Ambient controls and **Settings → Rail** share one toggle per enabled plugin, stored as `widget:plugin:<id>` so it survives restarts (older `widget:<id>` toggles are not carried over). **A hidden plugin starts no new runs**; an already-running invocation finishes normally. The same applies while the whole rail is hidden (focus layout, conversation tree or browser open). Showing a plugin never grants approval. The rail header and its controls stay reachable even when every card is hidden.

## Config reference

`<app config>/widgets.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "git",
      "title": "Git",
      "command": ["bash", "~/.omp-desktop/widgets/git.sh"],
      "match": { "path": "~/GIT/work", "remote": "gitlab.example.com" },
      "triggers": ["activate", "turn_end", "branch"],
      "timeoutMs": 10000,
      "intervalMs": 60000,
      "enabled": true,
      "scope": "tab",
      "insert": { "target": "new-tab", "project": "~/GIT/work/inbox" }
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Must be `1`. Anything else rejects the whole file: one error card, no plugin runs. |
| `id` | yes | `[a-z0-9-]{1,32}`, unique. Also names the plugin's Settings toggle (`widget:plugin:<id>`) and its approval. |
| `title` | no | Shown in the card head. Defaults to `id`. |
| `command` | yes | An argv array. Element 0 is either a bare program name (looked up on `PATH`) or an absolute path. A relative path such as `./x` or `bin/x` is rejected, because the working directory is the untrusted project. There is no shell. A leading `~/` in any element is expanded to your home directory (`$HOME`, or `%USERPROFILE%` on Windows); `~user` and a bare `~` are left as they are. If there is no home directory, the entry is reported as an error. |
| `match` | no | Every key is optional, and every key you give must match. `path` matches when the project path starts with this prefix, on a directory boundary (`~/` is expanded). `remote` matches when the default remote's fetch URL contains this substring. Without `match`, the plugin applies to every project. Typical use: work widgets under `~/GIT/work`, personal ones under `~/GIT/private`. |
| `triggers` | no | Any of `activate`, `turn_end` and `branch`. All three are the default; `[]` means the plugin runs only from its refresh button (and `intervalMs`). The refresh button (`manual`) always works, so listing `manual` is allowed but changes nothing. `interval` is not accepted here: set `intervalMs` instead. |
| `timeoutMs` | no | Default 10000, clamped to 1000..60000. |
| `intervalMs` | no | Periodic refresh. Absent or `0` means none. Clamped to 15000..3600000 (15 s to 1 h). |
| `enabled` | no | Default `true`. A disabled plugin is never offered for approval and never runs, and it has no Settings toggle. |
| `scope` | no | `"tab"` (default) or `"global"`; anything else rejects the entry. A `tab` plugin keeps one result per tab. A `global` plugin keeps one result for the whole app, computed with the active tab's context. |
| `insert` | no | Where a click on an item's `+` button puts its text: `{ "target": "draft" \| "new-tab", "project": "<path>" }`. `draft` (default) appends to the active tab's draft. `new-tab` opens new-conversation setup for `project`; after you confirm its branch/worktree choice, the text is put into that new tab's draft. Cancelling setup discards that insertion without changing another tab's draft. `project` is required: an absolute path, or `~/…`, naming an existing directory when config loads (canonicalised). A click never submits a prompt. See [Insert target](#insert-target). |

How the file is read:

- It is read at startup and when you click "reload widgets", never in between. Edits to `widgets.json` take effect only on reload.
- At most 32 entries are read. Any beyond that are ignored, with one error card.
- A malformed entry (bad `id`, duplicate `id`, empty or relative `command`, unknown `scope`) is skipped with an error card naming it. The other plugins still run.
- An unknown key (a typo such as `"intervallMs"`), an unknown trigger name, or `"interval"` in `triggers` adds an error card naming the key or value. The entry itself stays valid.
- A bad `insert` (not an object, unknown `target`, `new-tab` without `project`, a relative or missing `project`, a path that is not a directory, a `~/` project without a home directory) adds an error card naming the problem. So does `project` combined with `target: "draft"` or no `target`, because `project` is only used with `new-tab`. The plugin still runs and inserts into the draft. An unknown key inside `insert` (`insert.send`) is reported like any other unknown key.
- A missing `widgets.json` means no plugins and no error.
- If the desktop cannot determine its config directory, the plugins row says so and nothing runs.

### Insert target

```json
{ "id": "mrs", "command": ["bash", "~/.omp-desktop/widgets/mrs.sh"],
  "insert": { "target": "new-tab", "project": "~/GIT/work/inbox" } }
```

With `new-tab`, clicking `+` on a list item or `text` block opens new-conversation setup for `project`, even when that folder already has an open tab. Confirming the branch/worktree choice launches a new tab, moves focus to it and puts the insert text into its prompt box; cancelling inserts nothing. The text is never sent. Holding ⌥ (Alt) while clicking instead appends to the active tab's draft. The `url` button still opens the item's URL; only insertion follows this target. A launch failure remains visible in setup and inserts nothing until a launch succeeds.

The target comes **only** from `widgets.json`. Plugin output is untrusted and cannot choose or change it: an `insert` key in the output is ignored like any other unknown field, so a plugin cannot open tabs in folders you did not configure.

## Approval

A plugin never runs until you approve it. Approving pins the plugin's **fingerprint**: a SHA-256 hash over

- every `command` element (after `~/` expansion), and
- the contents of every element that is an absolute path to a regular file, such as the script in `["bash", "~/.omp-desktop/widgets/git.sh"]`. A file larger than 8 MiB contributes its size and modification time instead.

The rail shows an approval card for each enabled plugin whose fingerprint is not approved, regardless of `match`. The card lists the command, one argument per line, each in double quotes with line breaks, control characters and invisible or direction-changing Unicode characters escaped (`\n`, `\u202e`), so what you read is exactly what will run. If the plugin was approved before under a different fingerprint, the card says that it changed since you approved it.

Before **every** run, the desktop recomputes the fingerprint. If anything changed (the command in `widgets.json` after a reload, or the script file on disk), nothing is started. The card shows `plugin changed since it was approved — approve it again`, and the approval card comes back.

The run executes exactly what that check read. Each file the fingerprint hashes is run from a verified copy in a private folder (`widget-runs/store/<fingerprint>/` in the app's cache directory), not from its original path. The first run after an approval copies each file while hashing it and keeps the copies only if they hash to the approved fingerprint. Later runs reuse those copies, but never on trust: while the originals are hashed again, each copy is compared with its original byte for byte, and the folder must hold nothing but the copies. A copy that differs or is missing, or anything else found in the folder, makes the desktop build it again. A script replaced between the check and the start therefore cannot run under the old approval. If the copies cannot be stored, the run uses its fresh ones once and deletes them afterwards. Copies of fingerprints that are no longer approved are deleted at the next start of the app.

A copy keeps its file name, so an interpreter that goes by the extension (`.mjs`, `.ps1`) behaves the same, and on macOS and Linux a file executable by you stays executable by you. Its path stays the same from run to run, so tools that cache per script path (uv's environments for scripts with inline metadata) keep their cache. It sits in another folder, though: anything named by absolute path that loads files next to itself does not find them. That covers a widget script doing `$(dirname "$0")/lib.sh` or a relative `import`, and also launcher scripts such as npm's `npx.cmd` shim or a symlinked `/usr/local/bin/npx`. Keep a widget in one file, and start launchers by their bare name (looked up on `PATH`, not copied). Not copied, and started from their own path:

- the program itself (`command[0]`) when it is a native executable for your system, which loads its libraries from its own folder: on Windows a path ending in `.exe`, elsewhere an ELF or Mach-O binary. Anything else named first is copied, including a `.bat`/`.cmd` and, on Windows, a program named without `.exe`. So is any file passed as an argument, even a native one, such as the `.dll` in `["dotnet", "…/app.dll"]`;
- a file larger than 8 MiB;
- a path that is not a regular file when the run starts, such as a folder (`uv run --directory …`) or a missing file.

If the app's cache directory cannot be determined, or a script cannot be read or copied, the run fails with that error instead of falling back to the original file.

Approvals are stored in `<app config>/widget-approvals.json`, as `{ "version": 1, "approved": { "<id>": "<fingerprint>" } }`. To revoke one, delete its entry (keep the JSON valid), or the file, and click "reload widgets". Approving writes only that plugin's entry into the file as it is on disk, so a revocation you have not reloaded yet stays revoked. If the file exists but is not valid JSON or has another `version`, no plugin is approved, and approving is refused until you fix or delete it.

## When a plugin runs

| Trigger | When |
|---|---|
| `activate` | A tab becomes active, or a plugin becomes runnable for the active tab: you approve it, show its card, show the rail, or reload a config that adds or matches it. Only the plugins that *became* runnable run, so approving or showing one card does not re-run the others. |
| `turn_end` | omp finished a turn (`agent_end`) in that tab. |
| `branch` | The tab's `.git/HEAD` changed to another branch. The first branch seen for a tab is only recorded. |
| `manual` | You clicked the card's refresh button. |
| `interval` | Every `intervalMs` (not a `triggers` value). |

Scheduling happens in the desktop's Rust backend. The rules:

- **Active tab.** A `turn_end` or `branch` event in the active tab runs every runnable plugin that lists it.
- **Background tabs.** A `turn_end` or `branch` event in a tab you are not looking at is remembered per tab plugin. When you switch to that tab, each such plugin runs once: with `activate` if it lists `activate`, otherwise with the remembered trigger. Global plugins ignore events from background tabs.
- **Global plugins on `activate`** run only when they have no result yet, or when the last result is older than `intervalMs`. Without `intervalMs`, they run on every `activate`, as a tab plugin does.
- **Interval.**
  - Tab plugins: the timer belongs to the active tab and restarts on a tab switch.
  - Global plugins: the timer keeps running across tab switches.
  - A tick runs the plugin only while the window and the rail are visible and the plugin is runnable.
  - When the window or the rail becomes visible again, every interval plugin whose last run is older than its interval (or that never ran) runs once. A run still in flight counts as fresh.
  - A config reload that changes a plugin's `intervalMs`, `match`, `scope`, `enabled` state or approval restarts its timer.
- **Runnable** means all of these hold:
  - the plugin is enabled and approved;
  - its card toggle is on;
  - the rail is visible;
  - the tab has a session, and its project and remote satisfy `match`.

  For a global plugin, `match` is checked against the active tab.
- **One run at a time per card.**
  - A card means a (tab, plugin) pair for tab plugins, and one shared slot for global ones.
  - A trigger that arrives while a run is in flight is coalesced into at most one follow-up run. An `interval` never replaces a queued non-interval trigger.
  - Before the follow-up starts, it is checked again: it must still be runnable. An interval follow-up also needs the window visible and, for a tab plugin, its tab still active.
- **At most 4 plugins run at once across the whole app.** Further runs wait in a first-in, first-out queue. A waiting card shows as running.
- **Closing a tab** kills and waits for plugins running with that tab's context, including a global plugin using its folder, before allowing another conversation to switch that checkout. Tab-scoped results are dropped; global result slots remain shared. Quitting the app, or relaunching it after an update, kills every running plugin.

## Input: session information

Environment variables (always set, possibly empty):

| Variable | Value |
|---|---|
| `OMP_WIDGET_VERSION` | `1` |
| `OMP_WIDGET_PROJECT` | absolute project path of the tab the run is for |
| `OMP_WIDGET_BRANCH` | current branch, or empty (detached HEAD, or not a repo) |
| `OMP_WIDGET_REMOTE` | fetch URL of the default remote, or empty. A password in the URL's userinfo is removed (`https://x-access-token:…@host/…` becomes `https://x-access-token@host/…`) |
| `OMP_WIDGET_SESSION` | desktop session id of that tab |
| `OMP_WIDGET_TRIGGER` | `activate` \| `turn_end` \| `branch` \| `manual` \| `interval` |

The same values are written to stdin as one JSON object, and then stdin is closed. Plugins may ignore stdin.

```json
{"version":1,"project":"/Users/me/GIT/app","branch":"main","remote":"git@host:me/app.git","session":"s1","trigger":"manual"}
```

`branch`, `remote`, `session` and `trigger` are each limited to 2048 bytes (cut on a character boundary), in both the environment and stdin. `project` is passed as it is.

Other process details:

- **Working directory:** the project path. If the tab has no project, it is your home directory.
- **Environment:** plugins run with your environment, so `glab`, `gh` and `git` logins work. They get the app's extended `PATH`, with empty and relative entries removed.

No other session data is available. In particular, plugins cannot see the transcript or the model, and they cannot send prompts.

## Output schema v1

stdout must be UTF-8 and contain one JSON document:

```json
{
  "version": 1,
  "status": "ok",
  "blocks": [
    { "type": "status",   "label": "pipeline", "value": "passed", "tone": "ok" },
    { "type": "number",   "label": "unpushed", "value": 3, "unit": "commits" },
    { "type": "progress", "label": "review",   "value": 2, "max": 5 },
    { "type": "text",     "text": "Branch is 3 ahead of origin/main." },
    { "type": "kv",       "rows": [ { "k": "branch", "v": "feat/x" } ] },
    { "type": "list",     "items": [
        { "label": "!42 Login fix", "detail": "2 approvals", "tone": "ok",
          "url": "https://…/-/merge_requests/42", "insert": "MR !42: Login fix https://…",
          "time": "2026-10-13T09:30:00Z" }
    ] },
    { "type": "link",     "label": "Open pipeline", "url": "https://…" }
  ]
}
```

Top level:

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Must be the number `1`. Another number gives the error card "plugin reports version N, this desktop supports 1"; a non-number gives "plugin reports an invalid version, …". |
| `status` | no | `ok` \| `warn` \| `error` \| `info` \| `neutral` (default `neutral`). Tints the dot in the card head. |
| `blocks` | yes | An array of at most 32 blocks. |
| `attention` | no | A string of at most 200 chars that asks for notice: see [Attention](#attention). Missing, empty or not a string means no attention. |

Blocks:

| `type` | Fields |
|---|---|
| `status` | `label`, `value`, `tone`. Needs a label or a value. |
| `number` | `label`, `value` (a number, or a decimal number string), `unit` (optional) |
| `progress` | `label`, `value`, `max` (numbers or decimal number strings) |
| `text` | `text`, `insert` (optional, ≤ 2000 chars; adds a + button that inserts the text into the composer) |
| `kv` | `title` (optional), `rows`: `[{ "k", "v" }]` |
| `list` | `title` (optional; shown with the item count), `limit` (optional, 1–50: only the first `limit` items show, plus a "+N more" button), `items`: `[{ "label", "detail", "tone", "url", "insert", "time" }]`. Only `label` is required. |
| `link` | `label`, `url` |

Field rules:

- **Scalars.** `label`, `value`, `detail`, `k` and `v` accept a string, a finite number or a boolean, coerced to a string. `null`, objects and arrays are dropped.
- **Numeric strings** must be decimal (`"3"`, `"-1.5"`). A blank string, hex (`"0x10"`) and similar are rejected.
- **Unknown block `type`.** The block is skipped, the rest renders, and the card shows a small "1 unsupported block" note. Unknown fields are ignored.
- **`tone`** (on `status` and list items) is one of `ok`, `warn`, `error`, `info` or `neutral`.
- **`url`.** Only `http:`/`https:` URLs of at most 2000 chars with no control characters are opened, in the system browser.
  - A `link` block with any other URL is rendered as plain text (its label, or the URL string), without a button.
  - A list item with any other URL keeps its row, but the URL is dropped: no open action, and a click inserts the label.
- **`insert`.** Clicking an item appends text to the composer draft, separated by a space. It never replaces the draft and never discards a draft that starts with `/`. Without `insert`, the click inserts `label` plus the `url` if there is one. Limited to 2000 chars.
- **`time`** (list items) is either an ISO 8601 date-time with an explicit zone (`2026-10-13T09:30:00Z`, `…T09:30+02:00`; seconds and fractions optional) or epoch seconds (a number). Anything else (`"March 7"`, a time without a zone, an impossible date such as `2026-02-30`) is dropped.
  - It is shown right of the label as a compact relative time: `now` under a minute, then `5m`, `3h`, `2d`, or `in 12m` for future times. Beyond 30 days it shows a `YYYY-MM-DD` UTC date. The labels update every minute.
  - The tooltip shows the ISO timestamp.
- **A `list`** scrolls inside a 220 px area, so a long list never makes the card taller than the rail.
- **Strings** are rendered as text, never as HTML or markdown.
- **Lengths.** `label`, `value`, `detail`, `k`, `v`, `title` and `attention` are cut to 200 chars; `text` to 2000. A list keeps at most 50 items and a `kv` block at most 50 rows. These caps are enforced by the frontend parser (`src/app/widgets.js`).

### Conventions

- **List items are the clickable rows.** Use them for MRs, CI jobs, branches, or any other row the user can act on.
- **Empty state.** Use a `text` block ("No open MRs.", "Pipeline never run.") rather than an empty `list` or `kv`.
- **One card per plugin.** Each config entry produces one card, with up to 32 blocks.

### Attention

A plugin that needs the user to look at its card sets `"attention": "<key>"`. The key says *what* needs notice, so it must change when the situation does and stay the same while it does not. A good key is a hash of the sorted set of problems (for example the sorted failing job names), not a timestamp or a counter.

- **State.** A card is in attention while its current key is non-empty and differs from the key you last acknowledged. A rerun that prints the same key changes nothing.
- **Look.** The card border and the dot before the title pulse (about 1.5 s) in the card's status colour: red for `error`, amber for `warn`, otherwise the accent. With reduced motion (`prefers-reduced-motion: reduce`) the border is static and thicker and the dot is static. While the plugin reruns, the pulse keeps the status colour of the widget still shown.
- **Acknowledge.** A click anywhere on the card acknowledges the key; a click on a list item still inserts or opens as usual. For keyboard and screen reader users the card head has a small "Acknowledge" button while the card is in attention (the card is also announced as "needs attention"); it does nothing else. The acknowledged key is stored in the tweak store and survives restarts: for a global plugin per plugin id (`widgetAck:<id>`), for a tab plugin per plugin id and project path (`widgetAck:<id>:<hash of the path>`, not per tab, because tab ids change every launch). Two tabs of the same project share the ack; a tab of another project never touches it, so a project with no key does not reset the ack of a project that has one.
- **Clear.** When a successful run has no key (or an empty one), the attention ends and the stored key is dropped, so the same key alerts again if it comes back. A failed or running run changes nothing.
- **Dock.** When a card *enters* attention (a new, unacknowledged key) while the window is visible but not focused, the desktop requests the user's attention once with the informational type (a single dock bounce on macOS). A rerun with the same key does not bounce again. The widget scheduler pauses while the window is hidden or minimized, so no new key arrives then and nothing bounces: the bounce only fires for a visible window without focus. Where the OS or the window API does not support it, nothing happens.

```json
{ "version": 1, "status": "warn", "attention": "9f2c41aa", "blocks": [ … ] }
```

Here `9f2c41aa` is a short hash of `["build", "lint"]`, the sorted names of the failing jobs.

## Errors

| Failure | Card shows |
|---|---|
| Not approved, or changed since approval | approval card; a run attempt after a change shows `plugin changed since it was approved — approve it again` |
| Exit ≠ 0 | `exit <status>: ` + the last 300 chars of stderr (of stdout if stderr is empty) |
| Timeout | `timed out after N ms` |
| stdout over 256 KiB | `stdout exceeds 256 KiB` |
| stdout not UTF-8 | `stdout is not UTF-8` |
| stdout not JSON | `stdout is not JSON: <first 120 chars>` |
| Wrong output `version` / no `blocks` array | `plugin reports version N, this desktop supports 1` / `output has no "blocks" array` |
| Cannot start (program, interpreter or working directory missing) | `could not start <argv0>: <OS error>` |
| Bad `widgets.json` (version, not JSON) | one error card titled `widgets.json`; no plugin runs |
| Malformed entry, unknown key or trigger | an error card naming the entry and the problem |

The backend masks credentials in all plugin text that becomes an error message (exit tails, the non-JSON preview), before it reaches the window: `Bearer …`, `token=…`, `password: …`, `ghp_…`/`sk-…`-style tokens and URL userinfo become `[REDACTED]`. Other diagnostics are shown as printed.

A card keeps its previous successful result visible, dimmed, while a new run is in flight. An error replaces it with the error card, which keeps a "last ok HH:MM" note. If a card fails to render, only that card shows an error; the conversation and the other cards keep working.

## Trust and permission model

**What runs.** Only commands from your own `widgets.json`.

- A project cannot define commands.
- The window never sends a command line to the backend. It sends only plugin ids and view state (active tab, rail and window visibility, hidden cards), and the backend looks the command up itself.
- There is no shell: `command` is an argv array. Write `["sh", "-c", "…"]` yourself if you want one.
- Plugin output is rendered as text only. The frontend's content security policy is unchanged, and no plugin code runs in the webview.

**With which rights.** A plugin runs as you, with your full environment and permissions. It can read your files and your tokens, and use the network.

**When.** Once approved, a plugin runs **automatically, without asking again**, in every project its `match` allows, on every trigger it lists:

- on tab activation, turn end and branch change,
- on every interval,
- for a background tab, on your next switch to it.

**Not covered by omp's approval.** The desktop starts omp in the tool approval mode chosen under approvals (`write` by default; `docs/architecture/approval-mode.md`), so in `write` the agent's shell commands ask first. Widget plugins are not agent tool calls and do not go through that prompt in any mode, `yolo` included. Your one-time widget approval is the only gate.

**What approval protects against.** Changes made outside the desktop UI. Examples:

- an agent with write access, or a script you ran, edits a plugin's `command` in `widgets.json` (after the next reload);
- someone edits an approved script file.

Neither runs until you approve the new fingerprint in the rail. This matters because an agent working in a project can write files outside it, including `~/.omp-desktop/widgets/` and the app config directory, unless your setup prevents it.

**What approval does not protect against:**

- **The rest of the entry.** The fingerprint pins only `command` and the files it names. Edits to `match`, `triggers`, `intervalMs`, `timeoutMs`, `scope`, `insert`, `title` and `enabled` take effect on the next reload without a new approval. So whoever can edit `widgets.json` can, for example, widen an approved plugin's `match.path` to `/` so that it runs in every project, untrusted clones included, or turn an approved plugin you disabled back on. Approve only commands you are willing to run in any project.
- **Files the fingerprint does not cover.**
  - A program resolved via `PATH` (`bash`, `python3`, `node`) is hashed by name only.
  - So is anything the script loads by itself: modules, sourced files, config files, or packages fetched by `uv`/`npx`.
  - A file larger than 8 MiB is covered only by its size and modification time, and runs from its own path.
  - A native program named as `command[0]` by absolute path is checked before each run but started from its own path, where it also loads its libraries; scripts and arguments run from the verified copies.

  Keep a widget self-contained in one script file, and use absolute paths to native interpreters if you want them pinned.
- **The approvals file and the script copies.** `widget-approvals.json` is an ordinary user file, like `approval-rules/`, and so are the verified copies under `widget-runs/` in the app's cache directory. Anything that can write arbitrary files as you can edit them, and it could just as well edit `~/.bashrc`. Approval does not defend against that level of access: something that changes a copy, or puts a file beside it, in the moment between the check and the plugin's start would run its own code.
- **The webview.** Approving goes through the desktop window (`widgets_approve`), as answering tool approvals does. A compromised webview could approve a plugin, but it can already send prompts and answer tool approvals, so this adds no new power.
- **Hostile project contents.** The working directory is the project, which you should treat as untrusted: a cloned repo can contain any file. Make sure nothing from it is imported or executed:
  - **Python:** run with `python3 -I`. It ignores the working directory, the `PYTHON*` variables and the user site-packages. `python3 -c` and `python3 -` otherwise put the working directory on `sys.path`, so a repo's `json.py` would run. With `-I`, neither the working directory nor the script's directory is put on the path.
  - **Node** loads project code only if your script `require`s/`import`s a relative path.
  - **`uv`** runs the interpreter of a `.venv` it finds in the working directory or any of its parents, even with `--no-project`, and otherwise reads `pyproject.toml`, `uv.toml` and `.python-version` there. Pass `--directory <your widgets dir>` so uv never looks at the project, plus `--no-project --no-config`.
  - **`npx`/`npm`** read the project's `.npmrc` and `node_modules`. Start them with another working directory.
  - **Arguments:** give script arguments as absolute paths too.

**Limits that hold even for a broken plugin:**

- the timeout (default 10 s, at most 60 s) and the 256 KiB stdout cap both kill the plugin's whole process group (on Windows its Job Object);
- at most 4 plugins run at once;
- closing a tab, quitting, or relaunching after an update kills its plugins;
- stderr is never shown, except as the error tail of a failed run, and that tail has credentials masked.

## Where to keep your widgets

Put them in `~/.omp-desktop/widgets/`, one executable per widget, and reference them as `~/.omp-desktop/widgets/<name>` in `widgets.json`.

- Keep them out of project repos: the project is untrusted, and widgets run with your permissions.
- `chmod +x` each script and give it a shebang, or start it through an interpreter, e.g. `["python3", "-I", "~/.omp-desktop/widgets/x.py"]`.

### Windows

- **Paths.** Write paths in `widgets.json` with forward slashes, or escape backslashes (`"C:\\Tools\\x.exe"`). `~/` expands to `%USERPROFILE%`.
- **`bash`.** A bare `bash` may resolve to the WSL launcher (`C:\Windows\System32\bash.exe`), which runs the script inside Linux. Start shell widgets with Git for Windows' bash by absolute path instead, e.g. `["C:/Program Files/Git/bin/bash.exe", "~/.omp-desktop/widgets/git.sh"]`.
- **`python3`** may be the Microsoft Store stub, which opens the Store instead of running. Use `["py", "-3", "-I", "…"]` or an absolute `python.exe` path.
- **No console window.** Plugins start without one, and a timeout kills the whole process tree.

## Examples

`examples/widgets/` contains:

- `widgets.example.json`: wires all four examples with `~/.omp-desktop/widgets/…` paths. `git` and `hello` are enabled; `node` and `mcp` are disabled until you set them to `true`.
- `git.sh`: branch (or `detached @ <sha>`), upstream, changed files, ahead/behind, and the unpushed commits; with no upstream, the recent commits instead. Click `+` on a commit to insert `<sha> <subject>`. Needs `bash`, `git` ≥ 2.26 and `python3` (for JSON escaping). It runs git with `GIT_OPTIONAL_LOCKS=0`, so it never takes `.git/index.lock` from under the agent's own `git add`/`commit`. It never runs a program the project's own git config (`.git/config`, the files it includes, `config.worktree`) names: no `core.fsmonitor`, every filter driver that config defines or overrides is emptied for the run (filters only your global or system config defines, such as git-lfs, keep working), commit signatures are not verified, and a partial clone does not fetch (`GIT_NO_LAZY_FETCH`, git ≥ 2.44), so one missing objects the widget needs shows an error instead. A submodule counts as changed only when it has a different commit checked out, since checking its files would use the submodule's own filters.
- `hello.py`: Python 3, standard library only. Echoes the context as key/value rows; the remote is shown without its password, because the desktop already removed it.
- `hello.mjs`: the same in Node ≥ 18.
- `mcp-tool.py`: calls one MCP tool over stdio and shows its text result. Started with `uv run --directory ~/.omp-desktop/widgets --no-project --no-config --with mcp`, and it starts the MCP server (`npx`) in your home directory, so nothing from the project is used.

## MCP

The desktop knows nothing about MCP. A plugin that wants to use an MCP tool is itself the MCP client: it starts the server, calls the tool, and prints the result as widget JSON. `mcp-tool.py` shows the pattern.

## omp extension widgets

omp extensions show their own UI through `ctx.ui.setStatus(key, text)` and `ctx.ui.setWidget(key, lines)`, which omp forwards to the desktop in `--mode rpc-ui`. The desktop draws them in the rail, after the plugin cards:

- **Status lines**: one `status` card for all of the tab's status lines, a row per key (`plan-mode  📋 2/4`). omp's own `/review` and `/annotate` report their progress this way.
- **Widgets**: one card per widget key, titled with the key, its lines in monospace. Up to 50 lines of up to 500 characters each are shown; a longer widget says how many lines are left out.

Both cards carry an `extension` chip and the accent border. They have no refresh button: the extension pushes every update, and `setStatus(key, undefined)` / `setWidget(key, undefined)` removes the row or card. Terminal styling is stripped (colours from `ctx.ui.theme.fg`, OSC 8 hyperlinks keep their text), and everything is shown as text. A widget an extension builds as a component (a factory instead of a `string[]`) never reaches the desktop: omp only forwards line arrays.

**Per tab.** Each tab shows what its own omp process published, including what a background tab published while you were elsewhere. A tab's statuses and widgets stay through `/new`, branch and fork, as in omp's terminal UI (extensions that care refresh them on `session_switch`, and on `session_branch` for a branch), and go away when its omp process ends or is restarted (profile switch).

**Hiding.** Ambient controls and Settings → Rail list `extension: status lines` and `extension: <key>` for what the active tab has published, stored as `widget:ext-status` and `widget:ext:<key>` next to the plugins' `widget:plugin:<id>`. A hidden card's updates are still kept, so it comes back current. These cards can be reordered like built-in and plugin cards.

**Trust.** The code runs inside omp, with the trust you already give an installed omp extension; the desktop runs none of it and needs no approval. It only displays the text.

**Example.** Save as `~/.omp/agent/extensions/rail-demo.ts` (for a profile: `~/.omp/profiles/<profile>/agent/extensions/`, for one project: `<project>/.omp/extensions/`) and open a new tab:

```ts
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let turns = 0;
  const show = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("rail-demo", `${turns} turn${turns === 1 ? "" : "s"}`);
    ctx.ui.setWidget("rail-demo", [`cwd   ${ctx.cwd}`, `turns ${turns}`]);
  };
  pi.on("session_start", async (_event, ctx) => show(ctx));
  pi.on("turn_end", async (_event, ctx) => { turns++; show(ctx); });
}
```

**Not the same as rail widgets.** A rail widget plugin (the rest of this page) is a program you list in `widgets.json` and approve, run by the desktop for every matching tab. An extension widget belongs to one omp session and comes from the extensions loaded into it. Internals: [`architecture/extension-widgets.md`](architecture/extension-widgets.md).
