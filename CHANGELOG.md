# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Messages waiting for the agent are listed above the prompt box: steers (Enter while the agent works) and follow-ups (Ctrl+Q), in the order the agent will get them. Each row can be removed (✕), taken back into the prompt box to edit (✎, text only), or — for a follow-up — sent as a steer right away (↑), which also starts the agent again after you stopped it. A message the agent already took cannot be pulled back; the row then says "already delivered". The list is omp's own queue, so it stays correct across tab switches. A steer or follow-up omp refuses leaves a note with its text.
- Talk to a running subagent, or stop it, from the subagent manager. Open an agent while it works: a message box under its details sends it a message as if you were its user (Enter sends, Shift+Enter starts a new line). The agent reads it at its next step; while the agent is open in the manager, the message then shows up as a `you ›` line in its Output tab. A message the agent refuses stays in the box with a note saying why; so does text you were still typing when the agent finished. The stop button asks once more before it ends the agent; the agent that started it gets an aborted result and carries on.
- Pick the thinking level from a menu (#10): click the thinking pill under the prompt box. It lists the levels the current model supports, each with what it means, and ticks the one in use. Shift+Tab still cycles through the levels.
- When the agent asks you questions, they now arrive together in one card: every question of the ask at once, with each option's description, the recommended option marked, previews where the agent gave them, and a box to type your own answer to each. Questions that take several answers have checkboxes. Nothing is sent until you press Submit, which waits until every pick-one question has an answer; a lone pick-one question still answers on click. Cancel stops the turn, as Esc does. Once sent, the card shrinks to the answers you gave. Before, the questions came one at a time, and every click on a multi-answer question added another prompt to the chat.
- A tab whose agent has finished its reply but still has a background job running (a backgrounded shell command, task or eval) now shows it: a hollow ring in the tab bar and the project sidebar, and a note under the prompt box, until omp reports the work done. The agent picks the job's result up by itself; a row naming the finished job (its command and run time) then appears above the reply it triggered. The update dialog counts such a tab as busy, since restarting would kill the job.
- A conversation tree with the prompt-cache status of every prompt. Open it from the branch button in the right rail or the status bar, or type `/tree` (or `/branch`): it replaces the right rail and lists the conversation as a git-style graph, one row per prompt, oldest at the top, with branches in separate lanes and a divider at each context compaction. Each row says whether asking that prompt again would reuse the provider's prompt cache — cached, expiring in under 10 minutes, partly cached (the part up to an earlier cache anchor, which omp re-marks every 15th prompt, is still cached), or cold — and what asking it again would cost now and after the cache expires; when the provider reports no cache lifetime, the rows show no cache colours or prices. Select a row to **Branch here** (a new conversation without that prompt and everything after it; the prompt goes back into the prompt box), **Fork after the reply** (a new conversation that keeps the prompt and its reply), or, for a prompt that only exists in another conversation of the same family, **Open in new tab**. Branch and fork are disabled while the tab's agent works. A new omp process (a tab opened from the tree, or a tab reopened after a relaunch) writes the conversation to the cache again, because its system prompt differs (with a memory backend, the recalled memories): the tree prices **Open in new tab** that way and shows points cached by an earlier process as cold, tagged "earlier process".
- When a request fails and omp retries it by itself (an overloaded or unreachable provider, say), the conversation now says so: a row with the attempt (such as 3 of 10), the provider's error, a countdown to the next try or how long the current try has been waiting, and a Stop button — between tries it stops retrying and shows the failure, during a try it stops that try as Esc does. Meanwhile the tab bar and the project sidebar show a spinning amber dot, and the update dialog counts the tab as busy. Failed tries no longer leave empty replies behind: the reply says after how many failed attempts it came, or how many there were before omp gave up or you stopped it.

### Changed

- OMP Desktop now requires omp 18.4.11 or newer. A tab started against an older omp does not start; its note names the installed and the required version, and an `omp update` takes effect for the next tab without restarting the app. The list of waiting messages, subagent steering, the question card and the conversation tree's fork (see Added) rely on RPC commands that older omp versions lack.
- A steer or follow-up now appears in the conversation when the agent actually reads it, not when you send it, and no longer pulls the view down if you are reading further up. Until then it is in the list above the prompt box.
- Pick-from-a-list prompts from extensions, such as `/review`'s pickers, no longer have a box for typed text: they only accept one of their own options.

### Fixed

- The chat stays on its latest line when the area below it grows — the list of waiting messages, attached images, or a long draft — instead of hiding the end of the conversation behind it until the next update.
- A tab that fails to start — omp too old or not on `PATH`, or its profile deleted meanwhile — now says why, in the current tab or on the empty workspace, when it was opened with `+`, from a recent project or from the history panel. Before, nothing happened.
- After picking a model whose highest thinking level is lower than the current one, the thinking pill shows the lowered level right away instead of at the next prompt.
- A model without thinking showed `thinking · auto`; it now shows `off`, as omp does. The status bar showed `xhigh` as `max`, and omp's own `max` level as `—`.
- An answer you typed to the agent's question reached the agent as if you had picked an option of that name; it now arrives as your own answer.
- A request the provider rejected — after omp's own retries — left an empty reply, which vanished entirely after a tab switch. The reply now shows the failure: the HTTP status, provider and model, the provider's own message, and its full response behind "provider response". "temporary" marks a failure omp considers transient, such as an overloaded provider, where sending again later may work. A failed request that produced no output is not kept across a restart: omp leaves it out of the conversation it resumes.
- After switching tabs and back, the conversation keeps its order: a reply that followed a tool call could jump above it, and every later entry shifted along with it, the last one sometimes vanishing. Notes the app adds itself (an automatic tool approval, a login result) and messages omp dropped from its own context (an attempt it retried) no longer disappear on a tab switch either.

## [0.5.0] - 2026-10-03

### Added

- Rename a conversation from the tab bar or the project sidebar (#32): double-click a tab or a sidebar row, or use the pencil on a sidebar row or in a grouped tab's dropdown, then type the name and press Enter (Escape cancels). The name is saved with the conversation, so it survives a restart or resume, and from then on the automatic title never overwrites it. It works while the agent is running too, and leaves nothing in the chat. Typing `/rename <title>` still works the same way.
- Copy buttons on agent output (#33). Hover an assistant message, a code block, a bash output, an eval cell's code or output, or an edit's diff, and click the copy icon to put its raw text on the clipboard: a message copies as the markdown the agent wrote, a code block as the exact fence content, and a bash output in full — including lines scrolled out of the card, without omp's wall-time and exit-code notes. The button briefly shows "copied".
- Skills can be picked in the middle of a message (#30), the way omp's own editor does it: typing `/` after other text (`review this change /`) opens a list of skills only, which narrows as you type a name or any part of a hyphenated name (`/rev` finds `skill:code-review`). Picking one inserts `/skill:<name>` at that spot and keeps the rest of your text, which omp passes to the skill as its instructions. Escape closes the list without touching the message. A message that invokes a skill this way also reaches omp as a skill while the agent is still working, and plan mode sends it as typed, like a `/skill:<name>` at the start.
- The model picker lists your recently used models first (#11): up to five, newest first, in a "recently used" group above the full list, which stays unchanged below. The order is omp's own — the same one its terminal model selector uses — so a model you switched to in the terminal, in another tab, or by `/model` counts too. It is kept per profile, includes only models you can pick right now, and follows the filter as you type.
- The app reopens the tabs that were open when it last closed (#17) — after quitting, a restart, or an in-app update. Each tab comes back in its place with its project, profile and conversation, and the tab you were on is active again. A tab that had no conversation yet reopens empty on its folder. A tab whose folder no longer exists, or that fails to start, is not reopened; a note in the chat says which. Folders opened with "Open with OMP Desktop" at launch open after the restored tabs and become the active tab.

### Fixed

- Pasted text stays readable (#31). A sent message keeps its line breaks instead of running them together into one line. A long paste (more than 5 lines or 500 characters) still goes into the prompt box as a `[paste #N +K lines]` placeholder, but a chip above the box now shows it: click the chip to read the pasted text, or "expand" to turn it back into editable text in the prompt. Once a draft is taller than the prompt box, it scrolls instead of hiding the rest.
- After an in-app update on Windows, the relaunched app connects to omp again instead of every tab staying silent until a manual restart (#34). The MSI installer starts the new version with only the machine-wide PATH, so an omp installed for the current user (`%LOCALAPPDATA%\omp`, on the user PATH) was not found. omp is now spawned with the machine and user PATH from the registry appended to whatever PATH the app was started with. The same goes for `git`, so the Changes panel also keeps working with a per-user Git install (winget `--scope user`, scoop).
- The history panel's filter row offers one chip per project that has saved conversations, each with its count, instead of only "All Projects" and the current project (#35). The current project's chip comes first, and stays there with a count of 0 when it has none; the rest follow their most recent conversation. Two folders with the same name show their parent folder (hover a chip for its full path), and a long list of projects scrolls inside the filter row.

## [0.4.2] - 2026-10-02

### Fixed

- The prompt box and plan mode belong to each tab instead of being shared by all of them (#28). Switching projects no longer carries over a half-typed message (which Enter would then send to the other project), its attached images or collapsed pastes, plan mode, or plan comments. Each tab keeps its own until you come back; an image still being prepared when you switch lands in the tab it was pasted into.

## [0.4.1] - 2026-09-30

### Added

- A new conversation's tab is named after its folder at first, then renames itself to the conversation's generated title once the first exchange finishes (omp's RPC mode never auto-titles, so the app asks for one with `/rename` after the first turn); the title is then refreshed after 5 and 10 further turns to keep up with the work, then left alone, and a `/rename` you type yourself (`/rename Title` or `/rename:Title`) always wins. The project sidebar's single-tab card shows that name too. Resumed conversations keep their saved name. `/new` in the same tab drops the old title and earns a rename of its own (#13).

### Fixed

- Release builds stamp every script and stylesheet URL with the app version (`?v=X.Y.Z`), so a webview that cached a previous version's files after an in-app update can no longer serve them: the WebView2 data folder survives the updater, and embedded assets carry no cache validators, which could leave an updated app running a mix of old and new frontend modules until the cache happened to evict.
- The Linux `.AppImage` starts when another user mounts it — `firejail --appimage`, the AppImage catalog's test, root-extracted copies — instead of failing with `AppRun.wrapped: Permission denied`. Tauri CLI before 2.12 shipped that launcher as owner/group-only (`0770`); builds now use Tauri 2.12, and a release fails if any file in the AppImage is limited to its owner.

## [0.4.0] - 2026-09-30

### Added

- Project sidebar (toggle with `Ctrl+B` / `⌘B`, the tab-bar button, or the *project sidebar* tweak): open tabs grouped by project — hover a project to start a new conversation there — plus the recently opened folders of the active tab's profile; click one to open it, hover to drop it from the list (#27).
- Tabs on the same folder and profile collapse into one tab-bar chip with a count; its dropdown switches between them or starts a new conversation in that project — a second tab on the same folder and profile, i.e. a duplicate of that project card (#27, #12).

### Changed

- Opening a recent project, or resuming a conversation from history, focuses its tab when it is already open instead of starting a second copy (#27). `+` / `Ctrl+T` still always opens a new tab.
- A folder picked with `+` / `Ctrl+T` is opened at its real (symlink-resolved) path, the same form "Open with OMP Desktop" and the recent-projects list use, so an open project is always recognised (#27).
- The app no longer opens an empty "OMP Desktop" tab at launch — an agent running in whatever directory the app happened to start in, with no project behind it. With no tab open (at launch, or after closing the last one) the main area shows an animated "digital rain" welcome screen with an OMP-DESKTOP logo (static when the system asks for reduced motion); projects open from the sidebar or the tab bar, and no agent process runs until one does.

## [0.3.3] - 2026-09-25

### Added

- Middle-clicking a project tab closes it, like in a browser (#24).
- Clicking an image attached to a message pops it out into an enlarged viewer; with several images, switch between them with the arrow buttons or ←/→ keys, close with Esc or a click (#25).

### Fixed

- Conversation history is now ordered by when a session was last active (its most recent message), not by when it was created — a session you continue days after starting now correctly sorts to the top (#23).
- Raw HTML in agent replies and plans is shown as text instead of being rendered, so markup like `<img onerror=…>` can no longer run scripts in the app.

### Changed

- Release builds no longer allow inline scripts or inline event handlers (Content Security Policy), as a second line of defence against injected markup.

## [0.3.2] - 2026-09-24

### Fixed

- Markdown links whose scheme is hidden behind HTML character references (e.g. `&#106;avascript:`) now render as plain text instead of clickable links.
- A code block's language tag can no longer inject HTML attributes into the rendered page.

### Changed

- Faster startup in release builds: the interface ships precompiled and uses React's production build, so the first screen appears in about 0.1 s instead of 1.7 s, and the bundled frontend files shrink from 5.4 MB to 1.3 MB. `npm run dev` is unchanged.
- Stricter Content Security Policy: `eval` is no longer allowed (nothing in the app needed it).
- All dependencies updated: React 19.3 (was 18.3), marked 18 (was 12), highlight.js 11.12, Babel 7.29.9, Tauri 2.11.6 and its plugins, `gix` 0.87, `notify` 8, `sha2` 0.11, `windows-sys` 0.61, Tauri CLI 2.11.5. This also clears two `quick-xml` security advisories.

## [0.3.1] - 2026-09-24

### Added

- In-app updates (#19) — the tab bar now shows the running version (it used to show a hardcoded placeholder) and, once a newer release is published, an update pill. The pill, the version label, `/check-updates` and a rebindable **Check for updates** shortcut open a panel with the release notes and **install & restart**, which downloads the signed update, verifies it, closes every tab's omp process and relaunches. It warns first if any tab is mid-turn. Windows, macOS and the Linux AppImage update themselves; `.deb`/`.rpm` and source builds only get the notice and a link to the release page. The app checks 15 s after launch and then every 6 h; background checks never open anything, and **skip this version** hides the notice until a newer version appears. Automatic checks can be turned off in Tweaks → Session. Installs from before this release have to be updated by hand once.

### Changed

- Release builds are now signed for the updater. The release workflow needs the `TAURI_SIGNING_PRIVATE_KEY` secret (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one) and fails early without the key. Once every platform has built, it publishes `latest.json`, using this changelog's section for the version as release notes. It won't publish a feed that is missing a platform, or one whose tag disagrees with the app version. A manual run of the workflow now names its release after the `tag` input; it used to name it after the branch. Releases only build after the full test suite passes (Rust tests on Windows/Linux/macOS plus the JS regression scripts), and CI now runs that same suite; it previously ran only `cargo check`.

## [0.3.0] - 2026-09-24

### Added

- Usage statistics panel (#22) — a status-bar button surfaces cost/token telemetry for the active tab's profile, sourced from `omp stats --json` (requests, error rate, cost, cache rate, tokens in/out, avg throughput/TTFT), broken down by model, by project folder, and by agent type (main/subagent/advisor). Covers a rolling last-24-hours window and the active tab's own profile only — omp's `--json` output has no flag for a wider time range, and resolves against one profile per invocation the same as every other per-tab omp spawn — so switching tabs to a different profile and reopening the panel shows that profile's own last-24h usage, not a merge across profiles.
- Prompt history in the composer (#16) — Arrow Up/Down recall the tab's previously sent prompts (bash/readline-style: only when the caret sits on the first/last line, so multi-line edits still use the arrows normally), and Ctrl+Up/Cmd+Up opens a scrollable picker over the last 100 (configurable in Tweaks → Session) prompts, click or Enter to load one into the composer without sending. History is per-tab and in-memory only — never written to disk — gathered as you send, and backfilled from the transcript whenever a tab is (re)activated or a saved session is resumed, so switching back to an older tab or resuming from history repopulates it instead of starting empty.
- Minimap legend (#21) — the session minimap grid colored each cell by role/tool with no key explaining what the colors meant. A small legend row now sits under the grid, mapping color to meaning: you, assistant, ask, tool.
- Subagent manager — live introspection of the agents a `task` call spawns. A **subagents** card in the right rail shows how many are running, their combined tokens/cost/tool calls, and what each is doing right now (current tool + intent, elapsed time). Opening the manager (the card's button, the Tweaks **split** layout, or the new inspect icon on any agent row of a task card) adds a column with totals, a swimlane timeline of recent activity (the last few tool calls of up to 8 agents active in the past ~2 minutes), live/done/failed filters, and agents grouped by the task call that spawned them — nested agents indented under their parent, and each group can jump the chat to its task card. Clicking an agent opens an inspector: its task and assignment, the tool it is running now, tokens/cost/wall time/requests/model/context, recent tools, recent output plus a live event stream, and its full transcript. Finished agents stay listed for the rest of the session (omp itself forgets them), and a background tab re-syncs on return, marking agents that finished meanwhile as ended. The live event stream is only requested while an agent is being inspected.

### Changed

- Removed the "peer session" rail card, split pane and `split` tab chip — prototype leftovers that never had live data behind them. The Tweaks `split` layout now opens the subagent manager instead.

### Fixed

- The `/` palette and ⌘K bridge never received omp's slash-command list on connect: the backend's command allowlist was missing `get_available_commands`, so the request introduced for #8 was rejected before reaching omp and the list only filled in if omp happened to push an `available_commands_update`. It is now allowlisted, and a Rust test checks every `_send`/`_sendWithResponse` call site in `live.js` against the allowlist (failing on any call site whose command type it cannot read).

## [0.2.2] - 2026-09-23

### Fixed

- Image attachment in the composer — the attach-image icon had no click handler and clipboard paste only ever read plain text, so both silently did nothing (#7). The icon now opens a native file picker; pasting an image (screenshot, copied file, or a bitmap alongside real text from a spreadsheet/rich-text app) now attaches it as a thumbnail and sends it to the agent as an image content block, with the accompanying text preserved. On Linux (WebKitGTK), the synchronous paste event never carried image data at all even after that fix — only `text/*` — so clipboard image paste still silently did nothing there; pasting now falls back to the async Clipboard API when the synchronous path finds no image, which WebKitGTK does populate correctly.
- Clicking a link in agent output (e.g. a GitHub URL) navigated the app's own window in place, with no back control — the only recovery was quitting and losing every tab's session state (#14). The webview now stays on the app for every internal navigation; `http(s)`/`mailto` links are handed to the system's default browser/mail client instead. Everything else is refused: a same-origin file-path link no longer reboots the app in place, and a `javascript:`/`data:` link (which a webview would otherwise execute before any navigation even starts) is rendered as plain text instead of a clickable link.
- Chat force-scrolled to the bottom on every streamed update while the agent worked, with no way to read earlier content mid-run (#20). The transcript now auto-scrolls only while already pinned to the bottom; scrolling up unpins it (per tab) and shows a "Jump to latest" button. A new streamed message no longer forces the view back on its own — scrolling back down to the bottom, sending, steering, queueing a follow-up (which now shows in the transcript immediately rather than once the agent gets to it), clicking the button, or the transcript being reset (`/new`, a profile switch) all re-pin.
- A tab opened from history with a long (often auto-generated) session title could span nearly half the window width and squeeze out every other tab (#15). Tab labels now truncate with an ellipsis at 200px and show the full title on hover.
- The `/` composer palette and ⌘K command bridge only ever listed a static 12-entry desktop command list — omp's real slash commands (`/security`, `/fast`, `/mcp`, …) and every discovered skill (`/skill:<name>`) were invisible, with no way to run them except typing the full name from memory (#8). Both now merge that static list with omp's live `get_available_commands` (fetched on connect, refreshed on `available_commands_update`, scoped per tab/profile). A desktop entry (`/plan`, `/history`, …) still runs its own handler; picking an omp-native entry inserts `/name ` into the composer so you can add arguments and send it as a normal prompt, which omp executes.

## [0.2.1] - 2026-09-19

### Added

- "Open with OMP Desktop" on a folder — Finder, Explorer (right-click a folder or a folder's background) and Linux file managers can hand a directory to the app, which opens it as a project tab. Opening a folder while the app is running adds a tab to the existing window and brings it to the front; opening one while it is closed starts it with that folder's tab instead of the empty launch tab. Opening a folder from the command line (`omp-desktop /path/to/project`) does the same.
- Keyboard shortcuts — every desktop action (tabs, panels, model cycling, session history, plan mode) is now a bindable, rebindable chord; the main ones ship with a default binding out of the box. The Shortcuts screen (`Ctrl+/` or `/shortcuts`) lists all actions with their effective chords, their source layer (omp config / desktop overlay / registry default), and lets you rebind, add a second chord, clear, or reset. Rebinds are stored in `<app config>/keybindings.json`; omp's own `~/.omp/agent/keybindings.yml` is read-only and respected as the base layer. Dispatch honours the focused element: typing characters in the composer is never intercepted, but `Ctrl+`/`Alt+`/`Super+` combos and `Escape`/`Shift+Tab`/Fn keys work from anywhere. The command bridge's own Escape handling (back out of the model/login view, then close) now runs standalone instead of behind a global override, so `Escape` from a drilled-in view returns to the command list before it closes the bridge.

## [0.2.0] - 2026-09-17

### Added

- Per-tab omp profiles — each tab runs its own `omp --profile <id>` (separate auth, sessions, settings, caches); create, rename and delete them from the title-bar selector, and tick one as the default that new tabs and the next launch start in. The built-in `default` profile keeps using `~/.omp/agent`; switching a tab's profile restarts that tab's agent only.
- Approval rules — "Allow for this session" / "Always allow in this project" on approval prompts, plus a panel to review and revoke them. Sessions now start with `--approval-mode write`, so exec-tier tools ask instead of auto-approving.
- Changes panel — `git status`/`git diff` for the active tab's project with per-file accept/reject, bounded so large changesets stay responsive.
- `@`-mention autocomplete for project file paths in the composer.
- Conversation history and resume are scoped to the tab's own profile.
- `confirm` and `editor` prompts render as chat cards (previously auto-cancelled and invisible); `input` no longer uses a blocking browser dialog.
- Per-tab run state in the tab bar: running / waiting-on-you / idle / failed.
- Switching back to a background tab recovers the tool cards, prompts and streaming state that arrived while it was away.
- Credentials (tokens, API keys, auth headers) are redacted from agent output and logs.
- Hardening: only known RPC command types reach the agent, and saved-session identity comes from the session filename.
- `test-rpc.mjs --evidence` writes a redacted golden snapshot of the RPC surface to `docs/agents/evidence/`.

### Fixed

- Closing a tab or quitting now kills the agent's whole process tree — no orphaned subagents or tool-call children.
- Enter that commits an IME candidate no longer sends a half-typed message.
- Bridge button in the title bar sat ~7px above the window controls.
- Ask prompts could be answered twice, or answered after the agent had already cancelled them.
- "Agent process exited" / "Agent failed to start" notices rendered as blank bubbles, hiding why a session died.
- A tab whose agent dies during startup now explains itself instead of going blank. Any death before the agent's first output — a rejected flag, an exec failure, or no model resolving — previously read as a clean, silent exit; the tab now shows omp's own stderr reason, including the exact command to run when it's a missing-credentials profile. Background tabs report it too, when next selected.
- A freshly created profile's tab died silently at startup (no credentials, so omp had nothing to boot) and `/login` plus the provider list had nothing to talk to. `create_profile` now seeds a minimal `models.yml` so the tab boots far enough to run `/login`; the seed is removed once login succeeds.
- Several prompts raised in one turn overwrote each other, wedging the tab with tool cards stuck at "running".
- Approval rules could be silently lost when two windows saved at once: a stale-lock takeover let the previous holder delete the new owner's lock file, admitting a third writer mid-write.
- Lock contention on the rules and profile files surfaced as `File exists (os error 17)` instead of a readable "another window is updating this file; try again".
- A failed session spawn (omp missing from PATH, an exec error) left a dead tab in the tab bar with no agent behind it, and a failure partway through startup could leave a running omp process that nothing could reach or shut down.

### Changed

- Large diffs and long tool-output streams are now bounded in memory (journal capped at 8 MiB per session; `git diff` read through an early-stopping pipe).

## [0.1.3] - 2026-09-13

### Added

- Conversation history panel (`Ctrl+H`/`⌘H`, `/history` command, or the clock icon in the tab bar) — browse, search, and resume past omp sessions persisted under `~/.omp/agent/sessions`. Backend adds `list_saved_sessions` (async, off the Tauri main thread) and a validated `resume` path on `start_session`; `resume` values are checked against the sessions directory before being forwarded to omp's argv, rejecting flag-shaped or out-of-tree paths.

### Fixed

- Tab switch drops all tool cards from chat — `get_messages` returns only text entries; tool/ask/compact cards live exclusively in live event state. Fixed by merging `get_messages` ground-truth text into the existing snapshot (preserving tool cards in-place) instead of replacing `state.messages` wholesale. `activeToolCards` indices are rebuilt after merge so in-flight `tool_execution_update` events continue landing correctly.
- Minimap cell stuck pulsating after tab switch — `streamingBubble` restored from snapshot was never cleared when `get_state` reported `isStreaming: false` (turn completed while away); `_applyRpcState` now retires the bubble and strips `streaming: true` entries from `state.messages` immediately, before `get_messages` arrives.
- Model picker empty / no models listed — `get_available_models` returns ~2 MiB (837 models), overflowing the RPC v1 1 MiB physical-frame cap and failing with `RPC response exceeded the transport limit`, leaving `state.models` empty. The bridge now negotiates protocol v2 (`negotiate_protocol`) in `_initFetch` before the large fetches and reassembles the resulting `rpc_chunk` sequence (base64 byte-segments → strict UTF-8 → JSON) in `handleLine`. Reassembly validates chunkId/index/count/byteLength, rejects interleaved or duplicate frames, and enforces the 64 MiB ceiling.
- Built `.app`/`.dmg` shows an empty model picker (and no working session) when launched from Finder/Dock/DMG, while `tauri dev` works — macOS hands a GUI-launched bundle a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew, so `Command::new("omp")` in `agent/spawn.rs` failed to resolve `/opt/homebrew/bin/omp`; the default session never spawned and `get_available_models` never ran. `spawn_omp` and the `rpc-ui` probe now override the child `PATH`, appending common install dirs (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`, `~/.local/bin`, `~/.cargo/bin`) after the inherited entries (de-duplicated, inherited PATH still wins).

## [0.1.2] - 2026-05-11

### Fixed

- macOS freeze (spinning beach ball + high CPU) when opening a project folder via the + button — `blocking_pick_folder` was called from a command-handler thread, deadlocking against the main RunLoop; switched to callback-based `pick_folder` with an async command and `spawn_blocking` channel bridge

## [0.1.1] - 2026-05-10

### Added

- `/login` command with OAuth provider picker (fetches providers via `get_login_providers` RPC)
- Ask tool rendered as inline chat bubble with `rpc-ui` mode support _(requires [can1357/oh-my-pi#994](https://github.com/can1357/oh-my-pi/pull/994) to be merged)_

### Performance

- Fixed 13×13 minimap grid (169 cells); oldest row of 13 messages evicted at turn boundary once the grid is full, keeping memory and render cost bounded in long sessions
- `React.memo` on all bubble components (UserBubble, AssistantBubble, ToolCard, AskBubble, CompactRow); only the live streaming tail re-renders per token — stable history bails out
- Stable `_id` stamped on every message object in `live.js`; bubbles keyed by `_id` instead of array index, eliminating remount/fade-in blink when the oldest row is evicted
- `useCallback` on `handleAnnotate` and `handleAskAnswer` in App to stabilize function-prop refs and preserve memo bailouts for AssistantBubble and AskBubble

## [0.1.0] - 2026-05-10

### Added

- Initial Tauri 2 shell: spawns `omp --mode rpc` per tab, no bundler, JSX transpiled in-browser via `@babel/standalone`
- GitHub Actions CI (cargo check + cargo test on win/linux/mac) and release pipeline
- Per-tab omp process isolation — one process per tab, preserved across switches via session snapshots
- Model picker as a separate bridge view with on-load fetch and refresh button
- Markdown rendering with syntax highlighting (marked v12 + highlight.js) in chat
- Plan mode: full intent → drafting → review → running → done lifecycle with inline block annotations
- Slash command palette with arrow-key navigation, fuzzy filter, and Enter execution
- `/new` command to start a fresh omp session in the current tab
- Steer: send a message to the agent mid-turn without waiting for completion
- Compact tool cards: full expand/collapse card showing live progress and final result
- Task/quick_task tool cards: collapsible subagent panel with live-stream view on row click
- Eval cell tool cards: stream code and output live; syntax highlight on completion
- Auto-scroll chat to bottom as the agent streams output
- Minimap: dense grid heatmap with chat-bubble cross-highlight and per-kind tooltips
- Long paste collapse into `[paste #N +K lines]` inline tokens in the composer
- macOS-style traffic light window controls on Windows (DWM frameless)
- Autosave toggle button in the status bar
- Font size slider in the tweaks panel (75–150%, step 5)
- Git branch chip in the title bar via `gix` + `notify`
- OMP icon pack v1 as app icons across all platforms
- MIT license

### Fixed

- Black screen on startup — disable Tauri CSP hash injection, remove Google Fonts CDN link
- Git HEAD watcher — watch `.git/` directory instead of `HEAD` file to survive atomic rename on Linux/macOS
- Window drag — replaced custom handler with `data-tauri-drag-region`
- Diff block overflow — contained within chat column width
- Composer textarea: single-line default via `field-sizing: content`; focus restored after send; textarea stays enabled during streaming for steer input
- Phantom textarea scrollbar hidden at min-height
- Window control symbols: always colored red/yellow/green, no hover background bleed
- Tweaks panel: persist settings to `localStorage`; retheme to use app CSS variables
- Token and context gauge percentages truncated to one decimal place
- Stream line accumulation — handle in-place growing lines without duplication
- ToolCard: remove duplicate `return` statement; expand individual subagent rows, not the card header
- Plan annotations always reaching the prompt; `sendFeedback` working with annotations and no body text
- Plan running→done state transition
- Message history preserved across tab switches
- Tab name retained from folder path when `omp sessionName` is absent
- `_handleResponse` in `live.js` — missing closing brace caused silent IIFE syntax error
- Thinking level values aligned to valid RPC set (`off | minimal | low | medium | high | xhigh`)
- Rust agent: race-safe sessions, lock-free per-session stdin writes, no orphan child processes on hot-reload

### Changed

- Project renamed from `omp-desktop` to `Oh My Pi Desktop`
- Split large files into focused modules: `agent.rs` → `agent/`, `app.jsx` → `app-live.jsx` + `src/app/`, monolithic CSS and chat/UI/tweaks components into dedicated directories
- Plan mode moved from a dedicated side panel into the chat timeline
