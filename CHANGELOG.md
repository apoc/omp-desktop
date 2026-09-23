# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Usage statistics panel (#22) — a status-bar button surfaces cost/token telemetry for the active tab's profile, sourced from `omp stats --json` (requests, error rate, cost, cache rate, tokens in/out, avg throughput/TTFT), broken down by model, by project folder, and by agent type (main/subagent/advisor). Covers a rolling last-24-hours window and the active tab's own profile only — omp's `--json` output has no flag for a wider time range, and resolves against one profile per invocation the same as every other per-tab omp spawn — so switching tabs to a different profile and reopening the panel shows that profile's own last-24h usage, not a merge across profiles.

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
